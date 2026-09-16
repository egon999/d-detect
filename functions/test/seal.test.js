"use strict";
/**
 * Tests for `sealCase` — the server half of sealing.
 *
 * `tests/crucible-seal.test.ts` already covers the signature arithmetic. What is unproven
 * until here is everything the *server* is responsible for: that the head it signs is the one
 * it computed from Firestore rather than anything the caller said, that the ladder chains,
 * that a repeat request does not mint a duplicate, and that a deployment holding a key nobody
 * published refuses to sign rather than writing an unverifiable blob.
 *
 * The signing key is generated here and registered in the published map, which is exactly
 * what a key rotation does. The project's real key is in Secret Manager and is not involved:
 * a test that needed it would be a test that could not run on a fresh clone.
 */
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {ed25519} = require("@noble/curves/ed25519.js");
const {bytesToHex} = require("@noble/hashes/utils.js");

const {LocalStore} = require("../src/local-store");
const {sealCase, keyIdFor} = require("../src/seal");
const {SEAL_PUBLIC_KEYS} = require("../lib/domain/crucible/keys");
const {publicKeyFor, verifySealedHistory} = require("../lib/domain/crucible/seal");
const {buildAuditChain} = require("../lib/domain/analysis/audit-chain");

const KEY_ID = "test";
const secretKey = bytesToHex(ed25519.utils.randomSecretKey());
SEAL_PUBLIC_KEYS[KEY_ID] = publicKeyFor(secretKey);
const publicKeys = {[KEY_ID]: SEAL_PUBLIC_KEYS[KEY_ID]};

const audit = (id, createdAt, action = "EVIDENCE_UPLOADED") => ({
  id, ownerId: "user_a", caseId: "case_a", createdAt, updatedAt: createdAt,
  action, actorId: "user_a", entityRefs: [], summary: `Entry ${id}.`, metadata: {},
});

async function store(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "crucible-seal-test-"));
  t.after(async () => {
    if (!path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "crucible-seal-test-"))) throw new Error("Invalid test cleanup path.");
    await fs.rm(directory, {recursive: true, force: true});
  });
  const db = await new LocalStore(directory).open();
  await db.collection("cases").doc("case_a").set({id: "case_a", ownerId: "user_a", title: "Payment dispute", status: "OPEN", createdAt: 1000, updatedAt: 1000, deletedAt: null});
  return db;
}

const auditLogs = async (db) => (await db.collection("auditLogs").get()).docs.map((doc) => doc.data());
const seals = async (db) => (await db.collection("seals").get()).docs.map((doc) => doc.data());

test("the key id is derived from the key, so a seal can never be stamped with an id that does not verify it", () => {
  assert.equal(keyIdFor(secretKey), KEY_ID);
  // A key the registry does not publish yields no id at all, which is what makes the
  // refusal to sign possible. Falling back to a default here would produce a seal that
  // reads as a forgery to every verifier.
  assert.equal(keyIdFor(bytesToHex(ed25519.utils.randomSecretKey())), null);
});

test("seals the head the server computed, not the one the caller sent", async (t) => {
  const db = await store(t);
  await db.collection("auditLogs").doc("aud_a").set(audit("aud_a", 1000, "CASE_CREATED"));
  await db.collection("auditLogs").doc("aud_b").set(audit("aud_b", 2000));
  const expected = buildAuditChain(await auditLogs(db));

  // A caller naming a head of their choosing. If any of it reached the signature this
  // function would be a signing oracle, and the key would prove nothing at all.
  const receipt = await sealCase(db, "user_a", {caseId: "case_a", chainHead: "f".repeat(64), entryCount: 99, keyId: "v1"}, secretKey, 1_700_000_000_000);

  assert.equal(receipt.created, true);
  assert.equal(receipt.chainHead, expected.head);
  assert.equal(receipt.entryCount, 2);

  const [stored] = await seals(db);
  assert.equal(stored.chainHead, expected.head);
  assert.equal(stored.entryCount, 2);
  assert.equal(stored.keyId, KEY_ID, "the caller's keyId must be ignored in favour of the key actually held");
  assert.equal(stored.previousSealSignature, null);
  assert.match(stored.signature, /^[a-f0-9]{128}$/);
  assert.equal(stored.ownerId, "user_a");

  // The same verifier a stranger's browser would run.
  const verified = verifySealedHistory({entries: await auditLogs(db), seals: [stored], publicKeys});
  assert.equal(verified.breaks.length, 0);
  assert.equal(verified.entriesCovered, 2);
  assert.equal(verified.firstSealedAt, 1_700_000_000_000);
});

test("records the seal in the audit trail, naming what was signed", async (t) => {
  const db = await store(t);
  await db.collection("auditLogs").doc("aud_a").set(audit("aud_a", 1000, "CASE_CREATED"));
  const receipt = await sealCase(db, "user_a", {caseId: "case_a"}, secretKey, 1_700_000_000_000);

  const entry = (await auditLogs(db)).find((item) => item.action === "SEAL_CREATED");
  assert.ok(entry, "sealing must be visible in the history it covers");
  assert.equal(entry.id, `aud_${receipt.sealId}`);
  assert.equal(entry.metadata.chainHead, receipt.chainHead);
  assert.equal(entry.metadata.executor, "server");
  assert.equal(entry.summary, "Sealed 1 entry of history.");
});

test("a repeat request with nothing new returns the existing seal instead of minting another", async (t) => {
  const db = await store(t);
  await db.collection("auditLogs").doc("aud_a").set(audit("aud_a", 1000, "CASE_CREATED"));
  const first = await sealCase(db, "user_a", {caseId: "case_a"}, secretKey, 1_700_000_000_000);

  // The seal it just wrote added a SEAL_CREATED entry, so the head has moved. A naive
  // "has the head changed?" check would seal again here, and every tap of the button would
  // attest to the existence of the seal before it.
  const again = await sealCase(db, "user_a", {caseId: "case_a"}, secretKey, 1_700_000_005_000);

  assert.equal(again.created, false);
  assert.equal(again.sealId, first.sealId);
  assert.equal(again.sealedAt, first.sealedAt);
  assert.equal((await seals(db)).length, 1);
  assert.equal((await auditLogs(db)).filter((item) => item.action === "SEAL_CREATED").length, 1);
});

test("a real change earns a second seal, chained onto the first", async (t) => {
  const db = await store(t);
  await db.collection("auditLogs").doc("aud_a").set(audit("aud_a", 1000, "CASE_CREATED"));
  const first = await sealCase(db, "user_a", {caseId: "case_a"}, secretKey, 1_700_000_000_000);
  await db.collection("auditLogs").doc("aud_b").set(audit("aud_b", 3_000_000));
  const second = await sealCase(db, "user_a", {caseId: "case_a"}, secretKey, 1_700_000_009_000);

  assert.equal(second.created, true);
  assert.notEqual(second.sealId, first.sealId);
  const stored = await seals(db);
  const older = stored.find((item) => item.id === first.sealId);
  const newer = stored.find((item) => item.id === second.sealId);
  assert.equal(newer.previousSealSignature, older.signature, "the ladder must point at the rung below it");
  assert.ok(newer.entryCount > older.entryCount);

  const verified = verifySealedHistory({entries: await auditLogs(db), seals: stored, publicKeys});
  assert.equal(verified.breaks.length, 0);
  assert.equal(verified.sealsChecked, 2);
  assert.equal(verified.firstSealedAt, 1_700_000_000_000, "the tightest bound on when the covered history existed is the earliest seal");
});

test("editing a sealed entry afterwards is detected, and named", async (t) => {
  const db = await store(t);
  await db.collection("auditLogs").doc("aud_a").set(audit("aud_a", 1000, "CASE_CREATED"));
  await db.collection("auditLogs").doc("aud_b").set(audit("aud_b", 2000));
  await sealCase(db, "user_a", {caseId: "case_a"}, secretKey, 1_700_000_000_000);

  const before = await auditLogs(db);
  const recordedLinkDigests = buildAuditChain(before).links.map((link) => link.digest);
  // Firestore rules refuse this write; the point is that the seal catches it even where the
  // rules cannot reach — an exported bundle, or a database someone else administers.
  const tampered = before.map((item) => (item.id === "aud_b" ? {...item, summary: "Entry rewritten."} : item));

  const verified = verifySealedHistory({entries: tampered, seals: await seals(db), publicKeys, recordedLinkDigests});
  assert.equal(verified.ok, false);
  assert.deepEqual(verified.breaks.map((item) => [item.kind, item.entryId]), [["ENTRY_ALTERED", "aud_b"]]);
});

test("refuses an empty case, another user's case, and an unpublished key", async (t) => {
  const db = await store(t);
  await assert.rejects(sealCase(db, "user_a", {caseId: "case_a"}, secretKey), /nothing recorded/);

  await db.collection("auditLogs").doc("aud_a").set(audit("aud_a", 1000, "CASE_CREATED"));
  await assert.rejects(sealCase(db, "user_b", {caseId: "case_a"}, secretKey), /unavailable for your account/);
  await assert.rejects(sealCase(db, "user_a", {caseId: "case_missing"}, secretKey), /unavailable for your account/);
  await assert.rejects(sealCase(db, "user_a", {}, secretKey), /valid case identifier/);

  // A deployment holding a key the registry does not publish must refuse to sign rather
  // than write a signature nothing in the app can check.
  await assert.rejects(sealCase(db, "user_a", {caseId: "case_a"}, bytesToHex(ed25519.utils.randomSecretKey())), /not configured/);
  await assert.rejects(sealCase(db, "user_a", {caseId: "case_a"}, "not-a-key"), /not configured/);
  await assert.rejects(sealCase(db, "user_a", {caseId: "case_a"}, undefined), /not configured/);
  assert.equal((await seals(db)).length, 0);
});

test("refuses to seal again over a history that no longer matches an existing seal", async (t) => {
  const db = await store(t);
  await db.collection("auditLogs").doc("aud_a").set(audit("aud_a", 1000, "CASE_CREATED"));
  await db.collection("auditLogs").doc("aud_b").set(audit("aud_b", 2000));
  await sealCase(db, "user_a", {caseId: "case_a"}, secretKey, 1_700_000_000_000);

  // A second signature over an altered prefix would not merely be useless: both seals would
  // verify, and a reader comparing them could only conclude the signer attests to two
  // different versions of the same history. Editing and deleting are the same refusal
  // because they move the same digest.
  await db.collection("auditLogs").doc("aud_b").set({...audit("aud_b", 2000), summary: "Entry rewritten."});
  await db.collection("auditLogs").doc("aud_c").set(audit("aud_c", 3_000_000));
  await assert.rejects(sealCase(db, "user_a", {caseId: "case_a"}, secretKey, 1_700_000_009_000), /no longer matches an existing seal/);
  assert.equal((await seals(db)).length, 1);
});

test("refuses to re-seal a case that has lost entries an existing seal covers", async (t) => {
  const db = await store(t);
  await db.collection("auditLogs").doc("aud_a").set(audit("aud_a", 1000, "CASE_CREATED"));
  await db.collection("auditLogs").doc("aud_b").set(audit("aud_b", 2000));
  await sealCase(db, "user_a", {caseId: "case_a"}, secretKey, 1_700_000_000_000);

  // The deletion leaves nothing *new* to seal either, so this is also the case that pins the
  // order of the two checks: answered idempotency-first, a truncated record would be told it
  // was already sealed and fine.
  // Deleted through a transaction because the local store, like the Security Rules, offers
  // no way for anything but an administrator to remove an audit entry.
  await db.runTransaction(async (transaction) => {
    transaction.delete(db.collection("auditLogs").doc("aud_a"));
    transaction.delete(db.collection("auditLogs").doc("aud_b"));
  });
  await assert.rejects(sealCase(db, "user_a", {caseId: "case_a"}, secretKey, 1_700_000_009_000), /no longer matches an existing seal/);
  assert.equal((await seals(db)).length, 1);
});
