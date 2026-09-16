"use strict";
/**
 * Sealing — the server half of `@domain/crucible/seal`.
 *
 * The client asks for a seal and supplies nothing but a case id. Everything that ends up
 * signed is read from Firestore and computed here, because a seal's whole claim is that the
 * head it names was arrived at independently of the device. A function that signed a head
 * the caller sent would be a signing oracle: point it at any digest and it returns an
 * attestation for that digest, which is precisely the forgery the key exists to prevent.
 *
 * The chain itself is not reimplemented. `buildAuditChain` is cross-compiled into
 * `lib/domain` from the same source the app renders from (see `tsconfig.domain.json`), so
 * "the head the server signed" and "the head the audit screen shows" are one computation.
 */
const {randomUUID} = require("node:crypto");
const {problem, ID} = require("./contracts");
const {buildAuditChain} = require("../lib/domain/analysis/audit-chain");
const {assertSealable, signSealContents, publicKeyFor, SealRefused,
  latestSeal, substantiveEntriesSince, stillCoveredBy} = require("../lib/domain/crucible/seal");
const {SEAL_PUBLIC_KEYS} = require("../lib/domain/crucible/keys");

const ALGORITHM = "ed25519";

/**
 * Which published key this deployment is holding, by asking the key itself.
 *
 * The id is derived from the secret rather than configured beside it, and rather than taken
 * from the caller, because those are the two ways a seal gets stamped with an id that does
 * not verify it. Deriving makes the mislabelling impossible: the id written on a seal is by
 * construction the id of the key that signed it.
 *
 * Returning `null` — a secret whose public half is in no published registry entry — is a
 * refusal to sign, not a fallback to `v1`. A signature nothing can check is not a seal; it
 * is an unverifiable blob that would report as a forgery to every reader.
 */
function keyIdFor(secretKeyHex) {
  const publicKey = publicKeyFor(secretKeyHex);
  return Object.keys(SEAL_PUBLIC_KEYS).find((id) => SEAL_PUBLIC_KEYS[id] === publicKey) ?? null;
}

function assertOwner(snapshot, uid) {
  if (!snapshot.exists || snapshot.data().ownerId !== uid || snapshot.data().deletedAt) {
    throw problem("not-found", "This case is unavailable for your account.");
  }
}

function scoped(db, collection, uid, caseId) {
  return db.collection(collection).where("caseId", "==", caseId).where("ownerId", "==", uid);
}

function auditEntry(id, uid, caseId, now, contents, signature) {
  return {
    id, ownerId: uid, caseId, createdAt: now, updatedAt: now,
    action: "SEAL_CREATED", actorId: uid, entityRefs: [],
    // Names what was signed, so the trail carries its own pointer to the attestation
    // covering it. No adjective: "sealed" is a fact about a signature, and the summary is
    // read by the person being audited.
    summary: `Sealed ${contents.entryCount} ${contents.entryCount === 1 ? "entry" : "entries"} of history.`,
    metadata: {executor: "server", chainHead: contents.chainHead, signature},
  };
}

/**
 * Signs the current audit chain of one case.
 *
 * Idempotent in the way that matters: a second request with nothing new to cover returns the
 * existing seal rather than minting a duplicate. Two signatures over the same history are
 * not twice the evidence, and a ladder padded with them makes the real rungs harder to read.
 */
async function sealCase(db, uid, data, secretKeyHex, now = Date.now()) {
  if (!data || !ID.test(data.caseId || "")) throw problem("invalid-argument", "A valid case identifier is required.");
  const caseId = data.caseId;
  const key = typeof secretKeyHex === "string" ? secretKeyHex.trim() : "";
  // Checked before anything is read so a misconfigured deployment fails as a configuration
  // error, not as a case that mysteriously cannot be sealed.
  if (!/^[a-f0-9]{64}$/.test(key)) throw problem("failed-precondition", "Sealing is not configured on this deployment.");
  const keyId = keyIdFor(key);
  if (keyId === null) throw problem("failed-precondition", "Sealing is not configured on this deployment.");

  const sealRef = db.collection("seals").doc(`seal_${randomUUID().replaceAll("-", "")}`);
  return db.runTransaction(async (transaction) => {
    const [caseDoc, auditSnapshot, sealSnapshot] = await Promise.all([
      transaction.get(db.collection("cases").doc(caseId)),
      transaction.get(scoped(db, "auditLogs", uid, caseId)),
      transaction.get(scoped(db, "seals", uid, caseId)),
    ]);
    assertOwner(caseDoc, uid);

    const chain = buildAuditChain(auditSnapshot.docs.map((doc) => doc.data()));
    if (chain.head === null) throw problem("failed-precondition", "There is nothing recorded in this case to seal yet.");

    const previous = latestSeal(sealSnapshot.docs.map((doc) => doc.data()));
    // Checked before anything else about `previous`, because "the sealed history no longer
    // matches" outranks "there is nothing new to seal". The two orderings differ exactly when
    // it matters: a case whose sealed entries have been deleted has nothing *new* either, and
    // deciding idempotency first would answer such a request with a cheerful "already sealed".
    if (previous && stillCoveredBy(chain, previous) === false) {
      throw problem("failed-precondition", "The recorded history no longer matches an existing seal of this case, so it cannot be sealed again.");
    }
    if (previous && substantiveEntriesSince(chain, previous.entryCount) === 0) {
      return {sealId: previous.id, chainHead: previous.chainHead, entryCount: previous.entryCount, sealedAt: previous.sealedAt, created: false};
    }

    const contents = {
      caseId, chainHead: chain.head, entryCount: chain.length, sealedAt: now,
      previousSealSignature: previous ? previous.signature : null,
    };
    let signature;
    try {
      assertSealable(contents);
      signature = signSealContents(contents, key);
    } catch (error) {
      // `SealRefused` means the domain layer declined to sign what was assembled — a bug
      // here or corrupt data there, never something the caller did or can fix.
      if (error instanceof SealRefused) throw problem("internal", "The record could not be sealed.");
      throw error;
    }

    const seal = {
      ...contents, id: sealRef.id, ownerId: uid, signature,
      keyId, algorithm: ALGORITHM, createdAt: now, updatedAt: now,
    };
    transaction.set(sealRef, seal);
    transaction.set(db.collection("auditLogs").doc(`aud_${sealRef.id}`), auditEntry(`aud_${sealRef.id}`, uid, caseId, now, contents, signature));
    return {sealId: seal.id, chainHead: seal.chainHead, entryCount: seal.entryCount, sealedAt: seal.sealedAt, created: true};
  });
}

module.exports = {sealCase, keyIdFor};
