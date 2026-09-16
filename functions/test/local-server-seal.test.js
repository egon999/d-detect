"use strict";
/**
 * Tests for `POST /api/cases/{caseId}/seal` — the local server's route onto `sealCase`.
 *
 * `seal.test.js` already proves the signature arithmetic and the idempotency rules against the
 * same `LocalStore` this server runs on. What is unproven until here is the wiring: that the
 * route reaches the right case, that a refusal arrives as the status a client can branch on
 * rather than a 500, that an unconfigured deployment says so without echoing key material,
 * and that the seal it writes is actually in the workspace the app reads back.
 *
 * The signing key is generated here and registered in the published map, exactly as a key
 * rotation does, and injected through the `sealKey` option. The project's real key lives in
 * Secret Manager and is not involved: a test needing it could not run on a fresh clone.
 */
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {ed25519} = require("@noble/curves/ed25519.js");
const {bytesToHex} = require("@noble/hashes/utils.js");

const {createLocalServer} = require("../local-server");
const {SEAL_PUBLIC_KEYS} = require("../lib/domain/crucible/keys");
const {publicKeyFor} = require("../lib/domain/crucible/seal");

const KEY_ID = "test";
const secretKey = bytesToHex(ed25519.utils.randomSecretKey());
SEAL_PUBLIC_KEYS[KEY_ID] = publicKeyFor(secretKey);
const PREFIX = "seal-route-test-";
const HEX_RUN = /[0-9a-f]{16}/i;
const TITLE = "Payment dispute";

const audit = (id, createdAt, action = "EVIDENCE_UPLOADED", caseId = "case_a") => ({
  id, ownerId: "user_a", caseId, createdAt, updatedAt: createdAt,
  action, actorId: "user_a", entityRefs: [], summary: `Entry ${id}.`, metadata: {},
});
const seals = async (db) => (await db.collection("seals").get()).docs.map((doc) => doc.data());
const auditLogs = async (db) => (await db.collection("auditLogs").get()).docs.map((doc) => doc.data());

async function seedCase(db, caseId, entries) {
  await db.collection("cases").doc(caseId).set({id: caseId, ownerId: "user_a", title: TITLE, status: "OPEN", createdAt: 1000, updatedAt: 1000, deletedAt: null});
  for (const entry of entries) await db.collection("auditLogs").doc(entry.id).set(entry);
}

/** A listening server over a throwaway store, holding `sealKey`, with one case of history. */
async function harness(t, {sealKey} = {sealKey: secretKey}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), PREFIX));
  const {server, db} = await createLocalServer({directory, sealKey, authenticate: async (token) => { if (!["user_a", "user_b"].includes(token)) throw new Error(); return {uid: token}; }});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (!path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), PREFIX))) throw new Error("Refusing cleanup outside test directory.");
    await fs.rm(directory, {recursive: true, force: true});
  });
  await seedCase(db, "case_a", [audit("aud_a", 1000, "CASE_CREATED"), audit("aud_b", 2000)]);
  const address = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, options = {}, uid = "user_a") => {
    const headers = {...(uid === null ? {} : {Authorization: `Bearer ${uid}`}), ...options.headers};
    const result = await fetch(`${address}${route}`, {...options, headers});
    return {status: result.status, body: await result.json()};
  };
  return {db, request};
}

test("sealing a case returns the head the server computed, and nothing else", async (t) => {
  const {db, request} = await harness(t);
  const before = Date.now();
  // A body naming a head, an entry count and another case. None of it may reach the
  // signature: a route that signed what it was handed would be a signing oracle.
  const sealed = await request("/api/cases/case_a/seal", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({caseId: "case_missing", chainHead: "f".repeat(64), entryCount: 99, keyId: "v1"})});

  assert.equal(sealed.status, 200, JSON.stringify(sealed.body));
  assert.deepEqual(Object.keys(sealed.body).sort(), ["chainHead", "created", "entryCount", "sealId", "sealedAt"], "the receipt must be returned unwrapped and carry nothing more");
  assert.equal(sealed.body.created, true);
  assert.match(sealed.body.chainHead, /^[a-f0-9]{64}$/);
  assert.equal(sealed.body.entryCount, 2, "the caller's entryCount must be ignored in favour of the recorded history");
  assert.ok(sealed.body.sealedAt >= before && sealed.body.sealedAt <= Date.now());

  const [stored] = await seals(db);
  assert.equal(stored.id, sealed.body.sealId);
  assert.equal(stored.chainHead, sealed.body.chainHead);
  assert.notEqual(stored.chainHead, "f".repeat(64));
  assert.equal(stored.keyId, KEY_ID);
  assert.equal(stored.caseId, "case_a", "the case comes from the path, never the body");
});

test("the seal and its SEAL_CREATED audit entry are persisted", async (t) => {
  const {db, request} = await harness(t);
  const sealed = await request("/api/cases/case_a/seal", {method: "POST"});
  assert.equal(sealed.status, 200, JSON.stringify(sealed.body));

  const [stored] = await seals(db);
  assert.equal(stored.ownerId, "user_a");
  assert.equal(stored.algorithm, "ed25519");
  assert.match(stored.signature, /^[a-f0-9]{128}$/);
  assert.equal(stored.sealedAt, sealed.body.sealedAt);

  const entry = (await auditLogs(db)).find((item) => item.action === "SEAL_CREATED");
  assert.ok(entry, "sealing must be visible in the history it covers");
  assert.equal(entry.id, `aud_${sealed.body.sealId}`);
  assert.equal(entry.caseId, "case_a");
  assert.equal(entry.metadata.chainHead, sealed.body.chainHead);
  assert.equal(entry.metadata.executor, "server");
});

test("a repeat request with nothing new returns created:false without minting a second seal", async (t) => {
  const {db, request} = await harness(t);
  const first = await request("/api/cases/case_a/seal", {method: "POST"});
  // The first seal added a SEAL_CREATED entry, so the head has moved. Every tap of a button
  // wired to this route must still be one seal, and `created:false` is a receipt, not an error.
  const again = await request("/api/cases/case_a/seal", {method: "POST"});

  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.created, false);
  assert.equal(again.body.sealId, first.body.sealId);
  assert.equal(again.body.sealedAt, first.body.sealedAt);
  assert.equal(again.body.chainHead, first.body.chainHead);
  assert.equal((await seals(db)).length, 1);
  assert.equal((await auditLogs(db)).filter((item) => item.action === "SEAL_CREATED").length, 1);
});

test("a case with nothing recorded is refused as 409, in the server's own words", async (t) => {
  const {db, request} = await harness(t);
  await seedCase(db, "case_empty", []);
  const refused = await request("/api/cases/case_empty/seal", {method: "POST"});

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "There is nothing recorded in this case to seal yet.");
  assert.equal(refused.body.code, "failed-precondition");
  assert.equal((await seals(db)).length, 0);
});

test("another user's case is indistinguishable from one that does not exist", async (t) => {
  const {db, request} = await harness(t);
  const foreign = await request("/api/cases/case_a/seal", {method: "POST"}, "user_b");
  const missing = await request("/api/cases/case_nothere/seal", {method: "POST"}, "user_b");

  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, missing.body, "a case someone else owns must read exactly like a case that was never created");
  assert.doesNotMatch(JSON.stringify(foreign.body), new RegExp(TITLE), "the refusal must not disclose the case it declined to reach");
  assert.equal((await seals(db)).length, 0);
});

test("an unsigned request never reaches the key", async (t) => {
  const {db, request} = await harness(t);
  const anonymous = await request("/api/cases/case_a/seal", {method: "POST"}, null);
  const expired = await request("/api/cases/case_a/seal", {method: "POST"}, "user_gone");

  assert.equal(anonymous.status, 401);
  assert.equal(expired.status, 401);
  assert.equal((await seals(db)).length, 0);
});

test("an unconfigured deployment refuses to sign, and the refusal carries no key material", async (t) => {
  // The option is named and left undefined rather than omitted, because that is exactly what
  // an unset `CRUCIBLE_SEAL_KEY` delivers to `createLocalServer`.
  const {db, request} = await harness(t, {sealKey: undefined});
  const refused = await request("/api/cases/case_a/seal", {method: "POST"});

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "Sealing is not configured on this deployment.");
  // Not even a truncated key: any long hex run in a configuration error is key material
  // that has escaped the process it was handed to.
  assert.doesNotMatch(JSON.stringify(refused.body), HEX_RUN);
  assert.equal((await seals(db)).length, 0);
  assert.equal((await auditLogs(db)).filter((item) => item.action === "SEAL_CREATED").length, 0);
});

test("the workspace returns the seal it just wrote", async (t) => {
  const {request} = await harness(t);
  assert.deepEqual((await request("/api/workspace")).body.seals, [], "seals must be a collection the workspace knows about even when empty");
  const sealed = await request("/api/cases/case_a/seal", {method: "POST"});

  // Without `seals` in COLLECTIONS the app verifies an empty list no matter what was signed,
  // and reports an unsealed case back to the person holding the seal.
  const workspace = await request("/api/workspace");
  assert.equal(workspace.body.seals.length, 1);
  assert.equal(workspace.body.seals[0].id, sealed.body.sealId);
  assert.equal(workspace.body.seals[0].chainHead, sealed.body.chainHead);
  assert.match(workspace.body.seals[0].signature, /^[a-f0-9]{128}$/);
  assert.deepEqual((await request("/api/workspace", {}, "user_b")).body.seals, [], "seals are scoped to their owner like every other collection");
});
