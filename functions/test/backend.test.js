"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {createLocalServer} = require("../local-server");
const {LocalStore} = require("../src/local-store");
const {validateReport} = require("../src/contracts");
const {segmentText, extractEvidence} = require("../src/extraction");
const {analyzeCase} = require("../src/analysis");
const {providerFetch} = require("../src/provider");
const {commitChanges} = require("../src/local-api-validation");
const {createJob, processJob} = require("../src/jobs");
const {parseDocument} = require("../src/parse-document");

const base = (id, ownerId = "user_a") => ({id, ownerId, createdAt: 1000, updatedAt: 1000});
const caseRecord = () => ({...base("case_a"), title: "Payment dispute", status: "OPEN"});
const noteRecord = () => ({...base("ev_note"), caseId: "case_a", title: "Witness statement", kind: "NOTE", state: "QUEUED", note: "Payment failed. Reference TX1001."});
const put = (collection, record) => ({op: "put", collection, record});
const support = {evidenceId: "ev_a", segmentId: "seg_1", quote: "Payment failed.", startOffset: 0, endOffset: 15, stance: "CONTRADICTS"};
const sources = [{id: "ev_a", extraction: {...segmentText([{text: "Payment failed."}]), limitations: []}}];
const claims = [{id: "claim_a", statement: "Payment succeeded."}];
const report = () => ({summary: "The provided record reports failure.", claims: [{claimId: "claim_a", statement: "Payment succeeded.", status: "CONTRADICTED", explanation: "The record reports failure.", citations: [support], missingInformation: [], limitations: []}], agreements: [], contradictions: [], timeline: [], limitations: []});

test("citations must quote the exact identified source and satisfy their conclusion", () => {
  assert.equal(validateReport(report(), sources, claims).claims[0].status, "CONTRADICTED");
  const foreign = report(); foreign.claims[0].citations[0] = {...support, evidenceId: "ev_foreign"};
  assert.throws(() => validateReport(foreign, sources, claims), /outside/);
  const invented = report(); invented.claims[0].citations[0] = {...support, quote: "Payment settled"};
  assert.throws(() => validateReport(invented, sources, claims), /quotation/);
  const unsupported = report(); unsupported.claims[0].status = "SUPPORTED";
  assert.throws(() => validateReport(unsupported, sources, claims), /missing the evidence/);
  const missing = report(); missing.claims = [];
  assert.throws(() => validateReport(missing, sources, claims), /every submitted claim/);
  const miscounted = report(); miscounted.claims[0].citations[0] = {...support, startOffset: 800, endOffset: 815};
  assert.equal(validateReport(miscounted, sources, claims).claims[0].citations[0].startOffset, 0);
  const duplicateAgreement = report();
  duplicateAgreement.agreements = [{statement: "Independent records agree.", citations: [support, {...support, evidenceId: "ev_copy"}]}];
  const duplicates = [{...sources[0], sha256: "same-original"}, {...sources[0], id: "ev_copy", sha256: "same-original"}];
  const checked = validateReport(duplicateAgreement, duplicates, claims);
  assert.equal(checked.agreements.length, 0);
  assert.match(checked.limitations[0], /one original/);
});

test("bounded extraction preserves exact offsets and discloses truncation", async () => {
  const extracted = segmentText([{text: "a".repeat(41000), page: 1}]);
  assert.equal(extracted.sourceText.length, 40000);
  assert.equal(extracted.sourceTextTruncated, true);
  for (const segment of extracted.segments) assert.equal(extracted.sourceText.slice(segment.startOffset, segment.endOffset), segment.text);
  const note = await extractEvidence(noteRecord(), null);
  assert.match(note.extraction.limitations[0], /user statement/);
  await assert.rejects(extractEvidence({kind: "IMAGE", mimeType: "image/png", title: "Fake", fileName: "fake.png"}, Buffer.from("not an image")), /declared file type/);
});

test("entity names cannot match a substring of another person or transaction", () => {
  const text = "Joanne referenced TX-10010.";
  const evidence = [{id: "ev_name", extraction: segmentText([{text}])}];
  const raw = {summary: "", claims: [], agreements: [], contradictions: [], timeline: [], limitations: [], entities: [{name: "Ann", type: "PERSON", citations: [{evidenceId: "ev_name", segmentId: "seg_1", quote: text, stance: "CONTEXT"}]}]};
  assert.equal(validateReport(raw, evidence, []).entities.length, 0);
  assert.match(validateReport(raw, evidence, []).limitations[0], /omitted/);
  raw.entities[0].name = "TX-1001";
  assert.equal(validateReport(raw, evidence, []).entities.length, 0);
  raw.entities[0].name = "Joanne";
  assert.equal(validateReport(raw, evidence, []).entities.length, 1);
  raw.entities[0].citations[0].quote = "Joanne invented this quotation.";
  raw.entities[0].citations[0].startOffset = 0;
  raw.entities[0].citations[0].endOffset = text.length;
  assert.throws(() => validateReport(raw, evidence, []), /outside|quotation/);
});

test("missing Android MIME types still reach validating image and recording processors", async () => {
  await assert.rejects(extractEvidence({kind: "IMAGE", mimeType: "application/octet-stream", fileName: "screenshot.PNG"}, Buffer.from("not an image")), /declared file type/);
  await assert.rejects(extractEvidence({kind: "AUDIO", mimeType: "application/octet-stream", fileName: "recording.wav"}, Buffer.alloc(26 * 1024 * 1024), "test-key-never-sent"), /25 MB/);
  const email = "From: Asha <asha@example.test>\nSubject: Meeting\n\nThe meeting was scheduled for 18:30.";
  const result = await extractEvidence({kind: "TEXT", mimeType: "application/octet-stream", fileName: "meeting.eml", id: "ev_email", title: "Email original"}, Buffer.from(email));
  assert.equal(result.extraction.sourceText, email);
});

test("case analysis preserves excluded source coverage and source limits", async () => {
  const available = {...sources[0], deletedAt: null};
  const pending = {id: "ev_pending", extraction: null};
  const result = await analyzeCase(caseRecord(), [available, pending], claims, "test", async () => ({model: "test-model", data: report()}));
  assert.deepEqual(result.coverage.excludedEvidenceIds, ["ev_pending"]);
  assert.equal(result.coverage.truncated, true);
  assert.match(result.limitations[0], /incomplete/);
});

test("provider failures never expose provider response or key", async () => {
  await assert.rejects(providerFetch("/chat/completions", {}, async () => ({ok: false, status: 401, json: () => ({secret: "DO_NOT_EXPOSE"})})), (error) => error.code === "provider-configuration" && !error.message.includes("DO_NOT_EXPOSE"));
});

function tinyPdf() {
  const stream = "BT /F1 12 Tf 50 750 Td (Payment FAILED TX1001) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test("isolated PDF processor reads real page text and rejects malformed documents", async () => {
  const result = await parseDocument(tinyPdf(), "pdf");
  assert.match(result.parts[0].text, /Payment FAILED TX1001/);
  assert.equal(result.parts[0].page, 1);
  await assert.rejects(parseDocument(Buffer.from("%PDF-1.4 corrupt"), "pdf"), /could not be read safely/);
});

test("atomic commits reject cross-case links and forged extraction; durable queue resumes and throttles", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-backend-test-"));
  t.after(async () => {
    if (!path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "evidence-backend-test-"))) throw new Error("Invalid test cleanup path.");
    await fs.rm(directory, {recursive: true, force: true});
  });
  let db = await new LocalStore(directory).open();
  const intake = [put("cases", caseRecord()), put("claims", {...base("claim_a"), caseId: "case_a", statement: "A payment succeeded."}), put("auditLogs", {...base("audit_a"), caseId: "case_a", actorId: "user_a", action: "CASE_CREATED", summary: "Created case."}), put("evidence", noteRecord())];
  await commitChanges(db, "user_a", intake);
  const beforeReplay = (await db.collection("cases").doc("case_a").get()).data();
  await commitChanges(db, "user_a", intake);
  assert.equal((await db.collection("cases").doc("case_a").get()).data().updatedAt, beforeReplay.updatedAt);
  assert.equal((await db.collection("auditLogs").get()).docs.length, 1);
  await assert.rejects(commitChanges(db, "user_a", [put("auditLogs", {...base("audit_a"), caseId: "case_a", actorId: "user_a", action: "CASE_CREATED", summary: "Changed audit history"})]), /cannot be replaced/);
  await assert.rejects(commitChanges(db, "user_a", [put("cases", caseRecord())], {expectedAbsentCaseId: "case_a"}), /already exists/);
  await assert.rejects(commitChanges(db, "user_a", [put("cases", {...caseRecord(), id: "case_import"}), put("claims", {...base("claim_a"), caseId: "case_import", statement: "Collision"})], {expectedAbsentCaseId: "case_import"}), /already exists/);
  assert.equal((await db.collection("cases").doc("case_import").get()).exists, false);
  const storedCase = (await db.collection("cases").doc("case_a").get()).data();
  await commitChanges(db, "user_a", [put("cases", {...storedCase, createdAt: 1000, title: "Updated immediately"})]);
  assert.equal((await db.collection("cases").doc("case_a").get()).data().createdAt, storedCase.createdAt);
  await assert.rejects(commitChanges(db, "user_a", [put("evidence", {...noteRecord(), id: "ev_forged", extraction: {sourceText: "AI says true"}})]), /managed by the processing service/);
  await commitChanges(db, "user_a", [put("cases", {...caseRecord(), id: "case_b"}), put("claims", {...base("claim_b"), caseId: "case_b", statement: "Other case"})]);
  await assert.rejects(commitChanges(db, "user_a", [put("relationships", {...base("rel_bad"), caseId: "case_a", from: {kind: "evidence", id: "ev_note"}, to: {kind: "claim", id: "claim_b"}, type: "SUPPORTS", origin: "USER"})]), /same case/);
  const receipt = await createJob(db, "user_a", "EVIDENCE", {caseId: "case_a", evidenceId: "ev_note"});
  db = await new LocalStore(directory).open();
  await processJob({db, bucket: {}, apiKey: null}, receipt.jobId);
  assert.equal((await db.collection("processingJobs").doc(receipt.jobId).get()).data().state, "EXTRACTED");
  const extracted = (await db.collection("evidence").doc("ev_note").get()).data();
  await assert.rejects(commitChanges(db, "user_a", [put("evidence", {...extracted, note: "Rewritten source"})]), /preserved/);
  const firstSource = extracted.extraction.sourceText;
  await commitChanges(db, "user_a", intake);
  assert.equal((await db.collection("evidence").doc("ev_note").get()).data().state, "EXTRACTED", "Lost-response intake retry must not reset finished processing");
  const retry = await createJob(db, "user_a", "EVIDENCE", {caseId: "case_a", evidenceId: "ev_note"});
  await processJob({db, bucket: {}, apiKey: null}, retry.jobId);
  assert.equal((await db.collection("evidence").doc("ev_note").get()).data().extraction.sourceText, firstSource);
  await db.collection("processingQuotas").doc("user_a").set({windowStart: Date.now(), count: 30});
  await assert.rejects(createJob(db, "user_a", "CASE", {caseId: "case_a"}), /processing limit/);
  await db.collection("processingQuotas").doc("user_a").set({windowStart: Date.now(), count: 0});
  const analysis = await createJob(db, "user_a", "CASE", {caseId: "case_a"});
  await processJob({db, bucket: {}, apiKey: null}, analysis.jobId);
  const failure = (await db.collection("processingJobs").doc(analysis.jobId).get()).data();
  assert.equal(failure.state, "FAILED");
  assert.match(failure.lastError, /has not been configured/);
});

test("HTTP case creation, private upload, real processing, authorization, and durable restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-backend-test-"));
  const {server, db} = await createLocalServer({directory, authenticate: async (token) => { if (!["user_a", "user_b"].includes(token)) throw new Error(); return {uid: token}; }});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const allowed = path.join(path.resolve(os.tmpdir()), "evidence-backend-test-");
    if (!path.resolve(directory).startsWith(allowed)) throw new Error("Refusing cleanup outside test directory.");
    await fs.rm(directory, {recursive: true, force: true});
  });
  const address = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, options = {}, uid = "user_a") => {
    const result = await fetch(`${address}${route}`, {...options, headers: {Authorization: `Bearer ${uid}`, "Content-Type": "application/json", ...options.headers}});
    return {status: result.status, body: await result.json()};
  };
  assert.equal((await fetch(`${address}/api/workspace`)).status, 401);
  const initial = await request("/api/commit", {method: "POST", body: JSON.stringify({changes: [put("cases", caseRecord()), put("evidence", noteRecord())]})});
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal((await request("/api/workspace", {}, "user_b")).body.cases.length, 0);
  const forged = {...noteRecord(), id: "ev_foreign", ownerId: "user_b"};
  assert.equal((await request("/api/commit", {method: "POST", body: JSON.stringify({changes: [put("evidence", forged)]})}, "user_b")).status, 403);
  assert.equal((await request("/api/commit", {method: "POST", body: JSON.stringify({changes: [put("processingJobs", {...base("job_fake"), state: "ANALYZED"})]})})).status, 403);
  const fileRecord = {...noteRecord(), id: "ev_file", kind: "TEXT", state: "UPLOADING", note: "", fileName: "payment.txt", mimeType: "text/plain"};
  assert.equal((await request("/api/commit", {method: "POST", body: JSON.stringify({changes: [put("evidence", fileRecord)]})})).status, 200);
  const bytes = Buffer.from("Payment status: FAILED. Reference TX1001.");
  const uploaded = await request("/api/cases/case_a/evidence/ev_file/file", {method: "PUT", headers: {"Content-Type": "text/plain"}, body: bytes});
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(uploaded.body.storagePath, "users/user_a/cases/case_a/ev_file/original.txt");
  assert.equal((await request("/api/cases/case_a/evidence/ev_file/file", {}, "user_b")).status, 404);
  assert.equal((await request("/api/cases/case_a/evidence/ev_file/file", {method: "PUT", headers: {"Content-Type": "text/plain"}, body: "changed"})).status, 409);
  const queued = await request("/api/cases/case_a/evidence/ev_file/process", {method: "POST", body: "{}"});
  assert.equal(queued.status, 202);
  const duplicate = await request("/api/cases/case_a/evidence/ev_file/process", {method: "POST", body: "{}"});
  assert.equal(duplicate.body.jobId, queued.body.jobId);
  for (let attempt = 0; attempt < 30; attempt++) {
    const job = await db.collection("processingJobs").doc(queued.body.jobId).get();
    if (job.data()?.state === "EXTRACTED") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const completed = await db.collection("processingJobs").doc(queued.body.jobId).get();
  assert.equal(completed.data().state, "EXTRACTED", completed.data().lastError);
  const saved = (await request("/api/workspace")).body.evidence.find((item) => item.id === "ev_file");
  assert.equal(saved.extraction.sourceText, bytes.toString());
  assert.ok(saved.extraction.segments.length > 0);
  const emailRecord = {...fileRecord, id: "ev_email", fileName: "meeting.eml", mimeType: "message/rfc822"};
  assert.equal((await request("/api/commit", {method: "POST", body: JSON.stringify({changes: [put("evidence", emailRecord)]})})).status, 200);
  const emailUpload = await request("/api/cases/case_a/evidence/ev_email/file", {method: "PUT", headers: {"Content-Type": "message/rfc822"}, body: "Subject: Meeting\n\nMeeting at 18:30."});
  assert.equal(emailUpload.status, 201);
  const reopened = await new LocalStore(directory).open();
  assert.equal((await reopened.collection("evidence").doc("ev_file").get()).data().sha256, uploaded.body.sha256);
});
