"use strict";
const {z} = require("zod");
const {isDeepStrictEqual} = require("node:util");
const {createHash} = require("node:crypto");
const {ID, problem} = require("./contracts");
const identifier = z.string().regex(ID);
const timestamp = z.number().int().nonnegative();
const base = {id: identifier, ownerId: identifier, createdAt: timestamp, updatedAt: timestamp};
const scoped = {...base, caseId: identifier};
const ref = z.object({kind: z.enum(["claim", "event", "evidence"]), id: identifier});
const deletedAt = timestamp.nullable().default(null);
const schema = {
  cases: z.object({...base, title: z.string().trim().min(1).max(160), description: z.string().max(4000).default(""), category: z.string().max(80).default(""), status: z.enum(["OPEN", "IN_REVIEW", "CLOSED", "ARCHIVED"]), priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"), participants: z.array(z.object({id: identifier, name: z.string().max(120), role: z.string().max(80), contact: z.string().max(160).optional()})).max(100).default([]), tags: z.array(z.string().max(60)).max(30).default([]), incidentDate: z.string().max(60).nullable().default(null), lastAnalyzedAt: timestamp.nullable().default(null), deletedAt}),
  claims: z.object({...scoped, statement: z.string().trim().min(1).max(2000), detail: z.string().max(4000).default(""), requiredEventIds: z.array(identifier).max(100).default([]), state: z.string().max(40).default("UNSUPPORTED"), deletedAt}),
  events: z.object({...scoped, title: z.string().trim().min(1).max(160), description: z.string().max(4000).default(""), occurredAt: z.object({original: z.string().max(120), iso: z.string().max(10).nullable(), precision: z.enum(["DAY", "MONTH", "YEAR", "UNKNOWN"]), ambiguous: z.boolean(), evidenceId: identifier, method: z.literal("MANUAL")}).nullable(), claimIds: z.array(identifier).max(100).default([]), deletedAt}),
  evidence: z.object({...scoped, title: z.string().min(1).max(200), kind: z.enum(["PDF", "IMAGE", "TEXT", "EMAIL", "NOTE", "SPREADSHEET", "AUDIO", "VIDEO", "DOCUMENT", "OTHER"]), state: z.string().max(40), note: z.string().max(4000).default(""), sourceLabel: z.string().max(240).default(""), capturedAt: z.string().max(120).default(""), fileName: z.string().max(260).nullable().default(null), mimeType: z.string().max(160).nullable().default(null), sizeBytes: z.number().int().min(0).max(104857600).nullable().default(null), storagePath: z.string().max(600).nullable().default(null), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null), extraction: z.unknown().nullable().default(null), confirmedFields: z.record(z.string().max(100), z.string().max(4000)).default({}), confirmedAt: timestamp.nullable().default(null), failureReason: z.string().max(600).nullable().default(null), deletedAt}),
  relationships: z.object({...scoped, from: ref, to: ref, type: z.enum(["SUPPORTS", "CONTRADICTS", "RELATED_TO", "DERIVED_FROM", "DUPLICATE_OF", "ATTACHED_TO_EVENT", "RELEVANT_TO_CLAIM", "CORROBORATES", "INVOLVES", "MENTIONS"]), origin: z.literal("USER"), material: z.boolean().default(false), note: z.string().max(2000).default(""), createdByRuleId: z.null().default(null)}),
  auditLogs: z.object({...scoped, action: z.enum(["CASE_CREATED", "CASE_UPDATED", "CASE_STATUS_CHANGED", "CLAIM_CREATED", "CLAIM_UPDATED", "CLAIM_DELETED", "EVENT_CREATED", "EVENT_UPDATED", "EVENT_DELETED", "EVIDENCE_UPLOADED", "EVIDENCE_CONFIRMED", "EVIDENCE_DELETED", "EVIDENCE_LINKED", "EVIDENCE_UNLINKED", "FINDING_REVIEWED", "FINDING_DISMISSED"]), actorId: identifier, entityRefs: z.array(ref).max(100).default([]), summary: z.string().max(400), metadata: z.record(z.string().max(100), z.string().max(1000)).default({})}),
};
const profileSchema = z.object({...base, email: z.string().max(255), displayName: z.string().max(120), photoURL: z.string().max(1000).nullable().default(null)});
const equal = (a, b) => isDeepStrictEqual(a ?? null, b ?? null);
const contents = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !["createdAt", "updatedAt"].includes(key)));

async function commitChanges(db, uid, changes, options = {}) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 400) throw problem("invalid-argument", "A nonempty batch of at most 400 changes is required.");
  return db.runTransaction(async (transaction) => {
    if (options.expectedAbsentCaseId !== undefined) {
      if (!ID.test(options.expectedAbsentCaseId) || !changes.some((change) => change.op === "put" && change.collection === "cases" && change.record?.id === options.expectedAbsentCaseId)) throw problem("invalid-argument", "The import must identify the new case it creates.");
      const existingCase = await transaction.get(db.collection("cases").doc(options.expectedAbsentCaseId));
      if (existingCase.exists) throw problem("failed-precondition", "This case already exists. Import cannot overwrite it.");
    }
    const digest = createHash("sha256").update(uid).update(JSON.stringify(changes)).digest("hex");
    const receiptRef = db.collection("mutationReceipts").doc(digest);
    const receipt = await transaction.get(receiptRef);
    if (receipt.exists && receipt.data().ownerId === uid) return {ok: true};
    const staged = new Map();
    const originals = new Map();
    const read = async (collection, id) => {
      const key = `${collection}/${id}`;
      if (staged.has(key)) return staged.get(key);
      if (!originals.has(key)) { const snap = await transaction.get(db.collection(collection).doc(id)); originals.set(key, snap.exists ? snap.data() : null); }
      return originals.get(key);
    };
    for (const change of changes) {
      if (!schema[change.collection] || !["put", "delete"].includes(change.op)) throw problem("permission-denied", "This record is managed by the processing service.");
      const id = change.op === "put" ? change.record?.id : change.id;
      if (!ID.test(id || "")) throw problem("invalid-argument", "The record identifier is invalid.");
      const existing = await read(change.collection, id);
      if (options.expectedAbsentCaseId !== undefined && existing) throw problem("failed-precondition", "An imported record already exists. Import cannot overwrite existing data.");
      if (options.expectedAbsentCaseId !== undefined && (change.op !== "put" || (change.collection === "cases" ? id !== options.expectedAbsentCaseId : change.record?.caseId !== options.expectedAbsentCaseId))) throw problem("invalid-argument", "An import may only create records for its new case.");
      if (existing && existing.ownerId !== uid) throw problem("permission-denied", "This record is unavailable for your account.");
      if (change.op === "delete") {
        if (change.collection !== "relationships" || existing?.origin !== "USER") throw problem("permission-denied", "Use the case or evidence archive action to preserve history.");
        staged.set(`${change.collection}/${id}`, null); continue;
      }
      const parsed = schema[change.collection].safeParse(change.record);
      if (!parsed.success) throw problem("invalid-argument", `The ${change.collection} record contains invalid or incomplete fields.`);
      const record = parsed.data;
      if (record.ownerId !== uid || (existing && record.caseId !== existing.caseId)) throw problem("permission-denied", "Record ownership and case membership cannot be changed.");
      if (change.collection === "auditLogs") {
        if (record.actorId !== uid || (existing && !equal(contents(record), contents(existing)))) throw problem("permission-denied", "Audit entries cannot be replaced.");
        if (existing) { staged.set(`${change.collection}/${id}`, existing); continue; }
      }
      if (change.collection === "cases" && !equal(record.lastAnalyzedAt, existing?.lastAnalyzedAt)) throw problem("permission-denied", "Analysis status is managed by the processing service.");
      if (change.collection === "claims") record.state = existing?.state || "UNSUPPORTED";
      if (change.collection === "evidence") {
        for (const field of ["extraction", "sha256", "storagePath", "failureReason"]) {
          if (!equal(record[field], existing?.[field])) throw problem("permission-denied", "Evidence originals and extracted results are managed by the processing service.");
        }
        if (existing) {
          if (existing.storagePath || existing.extraction) {
            for (const field of ["kind", "fileName", "mimeType", "sizeBytes"]) if (!equal(record[field], existing[field])) throw problem("permission-denied", "The stored original file metadata cannot be rewritten.");
          }
          if (existing.extraction && record.note !== existing.note) throw problem("failed-precondition", "Processed source text is preserved. Add a correction as a new evidence item.");
          if (record.state !== existing.state) throw problem("permission-denied", "Processing status is managed by the service.");
          if (["QUEUED", "PROCESSING"].includes(existing.state) && (record.note !== existing.note || record.deletedAt !== existing.deletedAt)) throw problem("failed-precondition", "Wait for processing to finish before changing this evidence.");
        } else if (!["UPLOADING", "QUEUED"].includes(record.state)) throw problem("invalid-argument", "New evidence must be uploaded or queued for processing.");
      }
      record.updatedAt = existing && equal(contents(record), contents(existing)) ? existing.updatedAt : Date.now();
      record.createdAt = existing?.createdAt || record.updatedAt;
      staged.set(`${change.collection}/${id}`, record);
    }
    // Check the final batch image so a case and its first claim/audit can be created together.
    for (const [key, record] of staged) {
      if (!record) continue;
      if (record.caseId) {
        const parent = await read("cases", record.caseId);
        if (!parent || parent.ownerId !== uid || parent.deletedAt) throw problem("permission-denied", "Every record must belong to an available case in your account.");
      }
      const collection = key.split("/")[0];
      const refs = collection === "relationships" ? [record.from, record.to] : collection === "claims" ? record.requiredEventIds.map((id) => ({kind: "event", id})) : collection === "events" ? record.claimIds.map((id) => ({kind: "claim", id})) : [];
      for (const link of refs) {
        const target = await read({evidence: "evidence", claim: "claims", event: "events"}[link.kind], link.id);
        if (!target || target.ownerId !== uid || target.caseId !== record.caseId || target.deletedAt) throw problem("permission-denied", "Relationships can only reference live records in the same case.");
      }
    }
    const nextCases = new Map(Object.values(db.data.cases || {}).filter((item) => item.ownerId === uid).map((item) => [item.id, item]));
    for (const [key, record] of staged) if (key.startsWith("cases/") && record) nextCases.set(record.id, record);
    if (nextCases.size > 500) throw problem("resource-exhausted", "Your account has reached the 500-case limit for this server.");
    const evidenceCounts = new Map();
    const allEvidence = new Map(Object.values(db.data.evidence || {}).filter((item) => item.ownerId === uid).map((item) => [item.id, item]));
    for (const [key, record] of staged) if (key.startsWith("evidence/") && record) allEvidence.set(record.id, record);
    for (const item of allEvidence.values()) evidenceCounts.set(item.caseId, (evidenceCounts.get(item.caseId) || 0) + 1);
    if ([...evidenceCounts.values()].some((count) => count > 500)) throw problem("resource-exhausted", "This case has reached its 500-evidence-item limit.");
    for (const [key, record] of staged) {
      const [collection, id] = key.split("/");
      const reference = db.collection(collection).doc(id);
      if (record) transaction.set(reference, record); else transaction.delete(reference);
    }
    transaction.set(receiptRef, {ownerId: uid, createdAt: Date.now()});
    // Receipts contain no evidence content; keep recent retries without unbounded growth.
    const expired = Object.entries(db.data.mutationReceipts || {}).filter(([, item]) => item.createdAt < Date.now() - 7 * 86400000);
    for (const [id] of expired) transaction.delete(db.collection("mutationReceipts").doc(id));
    return {ok: true};
  });
}
module.exports = {commitChanges, profileSchema};
