"use strict";
const {randomUUID, createHash} = require("node:crypto");
const {problem, validateRequest} = require("./contracts");
const {extractEvidence, MAX_FILE} = require("./extraction");
const {analyzeCase} = require("./analysis");
const TERMINAL = new Set(["EXTRACTED", "ANALYZED", "FAILED", "REVIEW_REQUIRED"]);

function assertOwner(snapshot, uid, caseId) {
  if (!snapshot.exists || snapshot.data().ownerId !== uid || snapshot.data().deletedAt || (caseId && snapshot.data().caseId !== caseId)) {
    throw problem("not-found", "This case or evidence is unavailable for your account.");
  }
}

async function createJob(db, uid, type, data, now = Date.now()) {
  const {caseId, evidenceId} = validateRequest(data, type);
  const jobRef = db.collection("processingJobs").doc(`job_${randomUUID().replaceAll("-", "")}`);
  const lockRef = db.collection("processingLocks").doc(`${caseId}_${evidenceId || "case"}`);
  const quotaRef = db.collection("processingQuotas").doc(uid);
  return db.runTransaction(async (transaction) => {
    const caseDoc = await transaction.get(db.collection("cases").doc(caseId));
    assertOwner(caseDoc, uid);
    let evidenceState;
    if (evidenceId) {
      const evidenceDoc = await transaction.get(db.collection("evidence").doc(evidenceId));
      assertOwner(evidenceDoc, uid, caseId);
      evidenceState = evidenceDoc.data().state;
      if (evidenceDoc.data().kind !== "NOTE" && !evidenceDoc.data().storagePath) throw problem("failed-precondition", "Upload the original file before processing it.");
    }
    const lock = await transaction.get(lockRef);
    if (lock.exists) {
      const existing = await transaction.get(db.collection("processingJobs").doc(lock.data().jobId));
      if (existing.exists && ((lock.data().expiresAt > now && !TERMINAL.has(existing.data().state)) ||
        (type === "EVIDENCE" && existing.data().state === "EXTRACTED" && ["EXTRACTED", "CONFIRMED", "ANALYZED"].includes(evidenceState)))) return {jobId: existing.id, state: existing.data().state};
    }
    const quota = await transaction.get(quotaRef);
    const old = quota.exists ? quota.data() : {};
    const sameWindow = old.windowStart > now - 3600000;
    const count = sameWindow ? old.count : 0;
    if (count >= 30) throw problem("resource-exhausted", "Your account has reached its processing limit for this hour. Try again later.");
    const job = {id: jobRef.id, ownerId: uid, caseId, evidenceId, type, state: "QUEUED", createdAt: now, updatedAt: now, attempts: 0, fingerprint: null, startedAt: null, finishedAt: null, lastError: null, completedSteps: [], resultPath: null};
    transaction.set(jobRef, job);
    transaction.set(lockRef, {ownerId: uid, jobId: job.id, expiresAt: now + 600000});
    transaction.set(quotaRef, {windowStart: sameWindow ? old.windowStart : now, count: count + 1});
    if (evidenceId) transaction.update(db.collection("evidence").doc(evidenceId), {state: "QUEUED", failureReason: null, updatedAt: now});
    return {jobId: job.id, state: job.state};
  });
}

function scoped(db, collection, job) {
  return db.collection(collection).where("caseId", "==", job.caseId).where("ownerId", "==", job.ownerId);
}
function fingerprint(records) {
  return createHash("sha256").update(JSON.stringify(records.map((item) => [item.id, item.updatedAt, item.deletedAt || null]).sort((a, b) => a[0].localeCompare(b[0])))).digest("hex");
}
function audit(job, now, action, summary) {
  return {id: `aud_${job.id}`, ownerId: job.ownerId, caseId: job.caseId, createdAt: now, updatedAt: now, action, actorId: job.ownerId, entityRefs: job.evidenceId ? [{kind: "evidence", id: job.evidenceId}] : [], summary, metadata: {jobId: job.id, executor: "server"}};
}

async function processJob({db, bucket, apiKey}, jobId) {
  const ref = db.collection("processingJobs").doc(jobId);
  const job = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const record = snapshot.data();
    if (TERMINAL.has(record.state)) return null;
    // A second trigger delivery retries after the lease instead of executing concurrently.
    if (record.state === "PROCESSING" && record.updatedAt > Date.now() - 600000) throw problem("lease-active", "Processing is already running.");
    transaction.update(ref, {state: "PROCESSING", startedAt: Date.now(), updatedAt: Date.now(), attempts: record.attempts + 1});
    return record;
  });
  if (!job) return;
  try {
    const caseRef = db.collection("cases").doc(job.caseId);
    const caseDoc = await caseRef.get();
    assertOwner(caseDoc, job.ownerId);
    if (job.type === "EVIDENCE") {
      const evidenceRef = db.collection("evidence").doc(job.evidenceId);
      const snapshot = await evidenceRef.get();
      assertOwner(snapshot, job.ownerId, job.caseId);
      const evidence = snapshot.data();
      await evidenceRef.update({state: "PROCESSING", updatedAt: Date.now()});
      let bytes = null;
      if (evidence.kind !== "NOTE") {
        const prefix = `users/${job.ownerId}/cases/${job.caseId}/${job.evidenceId}/`;
        if (typeof evidence.storagePath !== "string" || !evidence.storagePath.startsWith(prefix) || evidence.storagePath.includes("..")) throw problem("invalid-file", "The evidence does not reference a private original file for this account.");
        const file = bucket.file(evidence.storagePath);
        const [metadata] = await file.getMetadata();
        if (Number(metadata.size) <= 0 || Number(metadata.size) > MAX_FILE) throw problem("file-limit", "The original file exceeds the supported size limit.");
        if (metadata.contentType !== evidence.mimeType) throw problem("invalid-file", "The uploaded content type does not match its evidence record.");
        [bytes] = await file.download({validation: "crc32c"});
      }
      // Preserve the immutable extraction version already cited by saved case reports.
      // A retry of an unchanged original must not replace quoted text with a new model reading.
      const result = evidence.extraction?.extractorVersion === "server-v1" && evidence.extraction?.segments?.length ?
        {extraction: evidence.extraction, sha256: evidence.sha256} : await extractEvidence(evidence, bytes, apiKey);
      const now = Date.now();
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(evidenceRef);
        assertOwner(current, job.ownerId, job.caseId);
        if (current.data().note !== evidence.note || current.data().storagePath !== evidence.storagePath) throw problem("evidence-changed", "The evidence changed while it was processing. Retry with the latest version.");
        transaction.update(evidenceRef, {...result, state: "EXTRACTED", failureReason: null, updatedAt: now});
        transaction.update(ref, {state: "EXTRACTED", updatedAt: now, finishedAt: now, fingerprint: result.sha256, completedSteps: ["private-file-read", "text-extracted", "segments-anchored"], resultPath: `evidence/${evidence.id}`});
        transaction.set(db.collection("auditLogs").doc(`aud_${job.id}`), audit(job, now, "EVIDENCE_PROCESSED", "Extracted evidence and preserved source references."));
      });
    } else if (job.type === "CASE") {
      const [evidenceSnapshot, claimSnapshot] = await Promise.all([scoped(db, "evidence", job).get(), scoped(db, "claims", job).get()]);
      const evidence = evidenceSnapshot.docs.map((item) => item.data()).filter((item) => !item.deletedAt);
      const claims = claimSnapshot.docs.map((item) => item.data()).filter((item) => !item.deletedAt);
      const inputHash = fingerprint([...evidence, ...claims, caseDoc.data()]);
      const result = await analyzeCase(caseDoc.data(), evidence, claims, apiKey);
      const now = Date.now();
      await db.runTransaction(async (transaction) => {
        const [currentEvidence, currentClaims, currentCase] = await Promise.all([transaction.get(scoped(db, "evidence", job)), transaction.get(scoped(db, "claims", job)), transaction.get(caseRef)]);
        assertOwner(currentCase, job.ownerId);
        const current = [...currentEvidence.docs, ...currentClaims.docs].map((item) => item.data()).filter((item) => !item.deletedAt);
        if (fingerprint([...current, currentCase.data()]) !== inputHash) throw problem("case-changed", "This case changed during analysis. Run analysis again to include the latest evidence.");
        transaction.set(db.collection("caseAnalyses").doc(job.id), {...result, id: job.id, jobId: job.id, ownerId: job.ownerId, caseId: job.caseId, createdAt: now, updatedAt: now});
        transaction.update(caseRef, {lastAnalyzedAt: now, updatedAt: now});
        transaction.update(ref, {state: "ANALYZED", updatedAt: now, finishedAt: now, fingerprint: inputHash, completedSteps: ["evidence-loaded", "claims-compared", "citations-validated"], resultPath: `caseAnalyses/${job.id}`});
        transaction.set(db.collection("auditLogs").doc(`aud_${job.id}`), audit(job, now, "ANALYSIS_RUN", "Compared case claims against processed evidence with verified source citations."));
      });
    } else throw problem("invalid-job", "This processing request is not supported.");
  } catch (error) {
    const safe = error.safe ? error.message : "Processing could not finish. Your original evidence is saved. Retry processing.";
    const now = Date.now();
    const batch = db.batch();
    batch.update(ref, {state: "FAILED", updatedAt: now, finishedAt: now, lastError: safe.slice(0, 600)});
    if (job.evidenceId) batch.update(db.collection("evidence").doc(job.evidenceId), {state: "FAILED", failureReason: safe.slice(0, 600), updatedAt: now});
    await batch.commit();
  }
}
module.exports = {assertOwner, createJob, processJob, fingerprint};
