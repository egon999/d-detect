import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { buildAuditChain } from '../analysis/audit-chain';
import type { AuditLog, Seal } from '../models';

/**
 * Seals: signing an audit chain so a third party can check it.
 *
 * `@domain/analysis/audit-chain` states its own honesty boundary out loud — *"Nothing is
 * signed: there is no key, so no one can be shown to have authored a chain."* This module
 * is the key. It does not touch the chain derivation; it wraps it.
 *
 * ## What a seal proves, and what it does not
 *
 * A seal is an Ed25519 signature, produced by a server-held key the user does not have,
 * over five values: the case, the chain head, how many entries the head covers, the
 * server's clock at signing time, and the signature of the seal before it.
 *
 * **It proves the record existed by a given moment.** The signed time comes from a machine
 * the user cannot set. That is an *upper bound* on when the sealed entries were written,
 * attested by someone other than their author, and it is the only thing in this app that
 * answers "you wrote all of this last night". It is an existence proof and nothing more.
 *
 * **It proves nothing has moved since.** The head covers every entry transitively, so a
 * signature that still verifies against a re-derived head means no entry has been altered,
 * inserted, reordered or dropped in the covered prefix.
 *
 * **It does not prove the contents are true.** A sealed lie is a lie with a timestamp. It
 * does not prove a photograph was not staged, a screenshot not edited before import, or a
 * typed statement not invented. Any UI built on this must say so; see §9 of the concept
 * document, which forbids the words "tamper-proof", "immutable" and "verified" unqualified.
 *
 * **It does not prove the signer is honest.** The key belongs to this project's server. A
 * verifier who does not trust that server has a signature from a party they do not trust,
 * which is worth exactly as much as they think it is. Saying this plainly is the difference
 * between an existence proof and a notary claim, and this app makes only the first.
 *
 * ## Why one implementation, on every runtime
 *
 * Signing and verification both go through `@noble/curves` — including on the server, where
 * Node 22's built-in `node:crypto` Ed25519 was the obvious alternative. `@domain/hashing`
 * already made this call for SHA-256 and gave the reason: *"so the same function runs
 * unchanged in React Native, in Node tests and in Cloud Functions — a hash that differed
 * between environments would break duplicate detection silently."* The same argument is
 * stronger here. A signer and a verifier that drift apart produce the one failure this
 * module cannot tolerate: a valid record reported as broken, or a broken one reported as
 * valid. One implementation cannot drift from itself.
 */

/**
 * Tags the payload format.
 *
 * Inside the signed bytes rather than beside them, so a signature made under one recipe can
 * never be replayed as though it were made under another. A future change to which fields
 * are signed gets a new tag, and old seals keep verifying under the old one instead of
 * silently failing.
 */
export const SEAL_PAYLOAD_VERSION = 'crucible-seal/v1';

/**
 * Stands in for the previous signature at the first seal of a case.
 *
 * A fixed word rather than an empty string, for the same reason `audit-chain` uses a
 * genesis seed rather than `''`: the first seal's payload should be a signature over
 * something specific, and an empty field is indistinguishable from a field that was
 * dropped.
 */
export const GENESIS_SEAL_SIGNATURE = 'genesis';

/**
 * Separates fields inside the signed payload. ASCII 0x1F, the unit separator — the same
 * choice, for the same reason, as `audit-chain`'s digest payload: a control character
 * cannot occur in a case id, a hex digest or a decimal number, so the concatenation is
 * unambiguous and no field's contents can shift a boundary.
 */
const FIELD_SEPARATOR = '\u001F';

/** A 64-character lowercase hex SHA-256, which is what a chain head always is. */
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** A 128-character lowercase hex Ed25519 signature (64 bytes). */
const SIGNATURE_PATTERN = /^[a-f0-9]{128}$/;

/** A 64-character lowercase hex Ed25519 key (32 bytes), public or secret. */
const KEY_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The five values a signature covers.
 *
 * Kept separate from the stored `Seal` record so that the exact bytes being signed can be
 * stated, read and tested on their own — and so the Cloud Function can build a payload
 * before it has a document to put it in.
 *
 * `ownerId` is deliberately **not** signed. Binding the seal to a user would add nothing a
 * third party could check — a stranger holding an exported bundle has no way to know who
 * the owner should have been — while putting an account identifier inside a payload that
 * is, by design, published on a page anyone can open. The case id already scopes the seal
 * to one record.
 */
export interface SealContents {
  caseId: string;
  /** The audit chain head this seal attests to: 64 lowercase hex characters. */
  chainHead: string;
  /** How many entries that head covers. The seal attests to a prefix of this length. */
  entryCount: number;
  /** The signing server's clock, epoch milliseconds. Never the client's. */
  sealedAt: number;
  /** The signature of the previous seal for this case, or `null` at the first. */
  previousSealSignature: string | null;
}

/** A seal as it is signed and stored, without the record-keeping fields. */
export interface SealedAttestation extends SealContents {
  /** 128 lowercase hex characters: the Ed25519 signature over `sealPayload(contents)`. */
  signature: string;
  /** Which key signed. An unknown id is a verification failure, never a pass. */
  keyId: string;
  algorithm: 'ed25519';
}

/**
 * Compile-time proof that the stored record is exactly what this module verifies.
 *
 * `sealSchema` in `@domain/models` is the persistence contract and `SealedAttestation` is
 * the verification contract. They describe the same thing and are written in two places,
 * which is a drift waiting to happen: drop a field from the schema, or rename one, and the
 * signer would keep signing while the verifier silently checked different bytes. This line
 * turns that into a build error instead of a seal nobody can verify.
 */
type AssertSealMatchesSchema = Seal extends SealedAttestation ? true : never;
const _sealMatchesSchema: AssertSealMatchesSchema = true;
void _sealMatchesSchema;

/**
 * The exact string that gets signed.
 *
 * Order is fixed and declared here, never derived from `Object.keys` — whose order is not
 * something to depend on across a JSON round trip, and which would make a signature
 * verifiable on one runtime and not another.
 *
 * `entryCount` is signed alongside the head even though the head already depends on every
 * entry. Without it, a seal states "the history hashes to X" but not "the history is this
 * long", and a verifier handed a longer history whose prefix happens to hash to X would
 * have no count to check it against. With it, truncation and extension are both arithmetic
 * rather than guesswork.
 */
export function sealPayload(contents: SealContents): string {
  return [
    SEAL_PAYLOAD_VERSION,
    contents.caseId,
    contents.chainHead,
    String(contents.entryCount),
    String(contents.sealedAt),
    contents.previousSealSignature ?? GENESIS_SEAL_SIGNATURE,
  ].join(FIELD_SEPARATOR);
}

/** Raised when a seal is asked for over something that cannot honestly be sealed. */
export class SealRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealRefused';
  }
}

/**
 * Checks that contents are sealable, and says why not when they are not.
 *
 * Called by the signer before it signs and by the verifier before it trusts, so a malformed
 * seal is refused at both ends rather than produced at one and puzzled over at the other.
 *
 * The empty-chain case is the one worth naming. `buildAuditChain` returns `head: null` for
 * a history with nothing in it and documents why: *"A chain over nothing has no head, and
 * inventing one would let an empty history display a reassuring-looking hash."* Sealing
 * that would be the same mistake with a signature on top — a cryptographic attestation
 * that nothing happened, displayed with all the authority of one that something did.
 */
export function assertSealable(contents: SealContents): void {
  if (!contents.caseId) throw new SealRefused('A seal must name the case it covers.');
  if (contents.entryCount <= 0) {
    throw new SealRefused('Nothing to seal: this case has no recorded history yet.');
  }
  if (!DIGEST_PATTERN.test(contents.chainHead)) {
    throw new SealRefused('A seal must cover a chain head: 64 lowercase hex characters.');
  }
  if (!Number.isSafeInteger(contents.entryCount)) {
    throw new SealRefused('Entry count must be a whole number.');
  }
  if (!Number.isSafeInteger(contents.sealedAt) || contents.sealedAt <= 0) {
    throw new SealRefused('A seal must carry the signing time in epoch milliseconds.');
  }
  if (
    contents.previousSealSignature !== null
    && !SIGNATURE_PATTERN.test(contents.previousSealSignature)
  ) {
    throw new SealRefused('A previous seal signature must be 128 lowercase hex characters.');
  }
}

/**
 * Signs a seal payload. Server only — the secret key never reaches a device.
 *
 * Takes the key as hex rather than bytes so the caller reads it straight out of Secret
 * Manager without a decoding step of its own, and so a key of the wrong length is caught
 * here by one regex instead of producing a signature nothing can verify.
 */
export function signSealContents(contents: SealContents, secretKeyHex: string): string {
  assertSealable(contents);
  if (!KEY_PATTERN.test(secretKeyHex)) {
    throw new SealRefused('The signing key must be 64 lowercase hex characters (32 bytes).');
  }

  const message = new TextEncoder().encode(sealPayload(contents));
  return bytesToHex(ed25519.sign(message, hexToBytes(secretKeyHex)));
}

/** Derives the published public key from a secret key. Used at key generation, not at runtime. */
export function publicKeyFor(secretKeyHex: string): string {
  if (!KEY_PATTERN.test(secretKeyHex)) {
    throw new SealRefused('The signing key must be 64 lowercase hex characters (32 bytes).');
  }
  return bytesToHex(ed25519.getPublicKey(hexToBytes(secretKeyHex)));
}

/**
 * Checks one signature against one public key.
 *
 * Returns `false` rather than throwing on malformed input. A verifier meets whatever a
 * stranger uploaded, and "this file is not a valid seal" and "this seal does not verify"
 * are the same answer to the only question being asked. Distinguishing them would mean a
 * page that crashes on a truncated file instead of reporting it.
 */
export function verifySealSignature(seal: SealedAttestation, publicKeyHex: string): boolean {
  if (seal.algorithm !== 'ed25519') return false;
  if (!SIGNATURE_PATTERN.test(seal.signature)) return false;
  if (!KEY_PATTERN.test(publicKeyHex)) return false;

  try {
    assertSealable(seal);
    const message = new TextEncoder().encode(sealPayload(seal));
    return ed25519.verify(hexToBytes(seal.signature), message, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Verifying a whole sealed history
// ---------------------------------------------------------------------------

/**
 * One specific reason a sealed history did not check out.
 *
 * Every member names the thing that broke, because "verification failed" is not a useful
 * sentence to show anyone. The public verify page turns each of these into one line of
 * plain English, and the demo depends on it: a reader who changes a character in an
 * exported bundle should be told which entry they changed, not merely that they changed
 * something.
 */
export type SealBreak =
  /** The history has entries but nothing has ever been sealed. Not tampering — an absence. */
  | { kind: 'NOT_SEALED' }
  /** A seal names a key this verifier does not hold, so its signature means nothing here. */
  | { kind: 'UNKNOWN_KEY'; sealId: string; keyId: string }
  /**
   * A seal names a signature scheme this verifier cannot run.
   *
   * Separate from `BAD_SIGNATURE`, and the distinction is the whole reason this member
   * exists. `verifySealSignature` answers `false` for an algorithm it cannot run, which is
   * correct for its own question but arrives at the reader as "carries a signature that does
   * not match its own contents" — an accusation about bytes nothing ever compared. A scheme
   * added after this build shipped is the same category of fact as a key added after it
   * shipped: unable to check, which is not evidence either way.
   */
  | { kind: 'UNSUPPORTED_ALGORITHM'; sealId: string; algorithm: string }
  /**
   * A seal names a different case than the history it is being checked against.
   *
   * The break that closes a portable seal. Nothing here used to compare `seal.caseId` to
   * anything, so a seal was transferable between any two histories whose hashed fields
   * agreed: copy a sealed case's entries into a new case and the old seal verified over
   * them, presenting January's existence proof for a record created in June. The signature
   * was never the obstacle — it is made over the seal's *own* case id and verifies happily.
   */
  | { kind: 'SEAL_FOREIGN'; sealId: string; sealed: string; found: string }
  /** The signature does not verify: these contents were not signed by that key. */
  | { kind: 'BAD_SIGNATURE'; sealId: string }
  /** A seal does not point at the one before it — a seal was inserted, dropped or reordered. */
  | { kind: 'LADDER_BROKEN'; sealId: string; expected: string; found: string }
  /** Fewer entries survive than the seal covers: entries were deleted. */
  | { kind: 'ENTRIES_MISSING'; sealId: string; sealed: number; found: number }
  /** An entry inside the sealed prefix has changed. Named exactly when digests are supplied. */
  | { kind: 'ENTRY_ALTERED'; sealId: string; index: number; entryId: string | null }
  /** The prefix hashes to something other than what was signed, and cannot be localised. */
  | { kind: 'HEAD_MISMATCH'; sealId: string; sealed: string; recomputed: string };

export interface SealVerification {
  /** True only when every seal checked out and nothing broke. */
  ok: boolean;
  /** Empty when `ok`. Ordered oldest seal first, so the first break is the earliest one. */
  breaks: SealBreak[];
  /** How many seals were examined. */
  sealsChecked: number;
  /** How many entries the newest verified seal covers. `0` when nothing verified. */
  entriesCovered: number;
  /**
   * The signed time of the **earliest** seal that verified, or `null`.
   *
   * The earliest, not the latest, because this is the number the existence proof rests on:
   * it is the tightest upper bound the seals establish on when the covered history was
   * written. A later seal proves less about the same entries.
   */
  firstSealedAt: number | null;
  /** The signed time of the newest seal that verified, or `null`. */
  lastSealedAt: number | null;
}

export interface VerifySealedHistoryInput {
  /** The audit entries as they now stand. Order is not trusted; the chain sorts them. */
  entries: readonly AuditLog[];
  /** Every seal for the case. Order is not trusted; they are sorted by coverage. */
  seals: readonly (SealedAttestation & { id: string })[];
  /** Public keys this verifier holds, by `keyId`. An id not present here fails closed. */
  publicKeys: Readonly<Record<string, string>>;
  /**
   * The case the caller believes it is verifying.
   *
   * Optional, because a verifier reading a bundle may only know what the bundle claims. When
   * supplied it is the authority a seal's own `caseId` is checked against; when omitted the
   * entries supply it instead. Passing it matters for a history with nothing in it, where
   * there are no entries to disagree with a seal borrowed from somewhere else.
   */
  caseId?: string;
  /**
   * The per-entry digests as recorded when the bundle was exported, oldest first.
   *
   * Optional, and purely a localisation aid. Verification is sound without it — the head
   * alone already covers every entry — but the head cannot say *which* entry moved. With
   * the recorded digests, the first index where the re-derived chain diverges is the
   * altered entry, named. These digests are not trusted on their own: they are only
   * consulted once the signature over the head has been checked, which is what stops a
   * forger from supplying digests that agree with their own rewrite.
   */
  recordedLinkDigests?: readonly string[];
}

/**
 * Verifies a case's seals against its audit entries.
 *
 * Runs unchanged in the app, in a Cloud Function and in the browser on the public verify
 * page, which is the point: a verifier that shared no code with the signer would be a
 * second implementation of the same rules, and the two would eventually disagree about a
 * record somebody cares about.
 *
 * Seals are checked oldest first and each is checked independently, so a case whose recent
 * history was rewritten still reports everything its older seals legitimately established.
 * Losing that would mean a single break erasing every earlier proof — which is the opposite
 * of what a ladder of seals is for.
 */
export function verifySealedHistory(input: VerifySealedHistoryInput): SealVerification {
  const breaks: SealBreak[] = [];
  const chain = buildAuditChain(input.entries);

  // Oldest coverage first. `entryCount` is the ordering key rather than `sealedAt`, because
  // it is the value inside the signature: a clock could be wrong, but a count that
  // disagreed with the signed bytes would already have failed the signature check.
  const seals = [...input.seals].sort(
    (a, b) => a.entryCount - b.entryCount || a.sealedAt - b.sealedAt,
  );

  if (seals.length === 0) {
    // Not a failure of integrity. A case nobody has sealed yet is the ordinary starting
    // state, and reporting it as tampering would teach users to ignore the warning.
    //
    // `ok` is nevertheless `false`, including for a history with nothing in it. It used to be
    // `chain.length === 0`, which made an emptied bundle — every entry stripped *and* every
    // seal stripped — the only input that returned `ok: true, breaks: []`: a clean pass, from
    // a file with nothing left in it to check. Removing the entries alone reported
    // `ENTRIES_MISSING` and removing the seals alone reported `NOT_SEALED`; doing both was
    // rewarded. Nothing attested to nothing is not an attestation, so it does not get the
    // word reserved for one.
    return {
      ok: false,
      breaks: [{ kind: 'NOT_SEALED' }],
      sealsChecked: 0,
      entriesCovered: 0,
      firstSealedAt: null,
      lastSealedAt: null,
    };
  }

  // What the seals are supposed to be about. The caller's answer wins where it has one,
  // because a verifier that was asked about a specific case knows something the file does
  // not; otherwise the entries themselves are the only available authority.
  const historyCaseId = input.caseId ?? chain.links[0]?.entry.caseId ?? null;

  let previousSignature: string | null = null;
  let entriesCovered = 0;
  let firstSealedAt: number | null = null;
  let lastSealedAt: number | null = null;

  for (const seal of seals) {
    // --- The ladder ------------------------------------------------------
    // Checked before the signature, because a seal that points at the wrong predecessor is
    // wrong even if it is perfectly signed: the signature proves the server wrote it, not
    // that it belongs where it was filed.
    const expectedPrevious = previousSignature ?? GENESIS_SEAL_SIGNATURE;
    const foundPrevious = seal.previousSealSignature ?? GENESIS_SEAL_SIGNATURE;
    if (foundPrevious !== expectedPrevious) {
      breaks.push({
        kind: 'LADDER_BROKEN',
        sealId: seal.id,
        expected: expectedPrevious,
        found: foundPrevious,
      });
    }
    previousSignature = seal.signature;

    // --- The scheme --------------------------------------------------------
    // Read through `String` rather than compared against the literal type, because the type
    // describes what this project writes and this function reads what a stranger sent.
    const algorithm = String((seal as { algorithm?: unknown }).algorithm ?? '');
    if (algorithm !== 'ed25519') {
      breaks.push({ kind: 'UNSUPPORTED_ALGORITHM', sealId: seal.id, algorithm });
      continue;
    }

    // --- The signature ---------------------------------------------------
    const publicKey = input.publicKeys[seal.keyId];
    if (publicKey === undefined) {
      // Fails closed. A seal signed by a key this verifier does not hold is not a seal it
      // can say anything about, and treating an unrecognised key as acceptable would make
      // the whole check decorative.
      breaks.push({ kind: 'UNKNOWN_KEY', sealId: seal.id, keyId: seal.keyId });
      continue;
    }
    if (!verifySealSignature(seal, publicKey)) {
      breaks.push({ kind: 'BAD_SIGNATURE', sealId: seal.id });
      continue;
    }

    // --- The case it is about ---------------------------------------------
    // After the signature, because an unsigned seal's `caseId` is not worth comparing, and
    // before everything else, because "this seal is not about this case" outranks any
    // observation about how well it fits a history it was never a seal of.
    //
    // Every entry inside the covered prefix is checked, not just the first, so a history
    // assembled from two cases is caught by the same test as a seal lifted from one.
    if (historyCaseId !== null && seal.caseId !== historyCaseId) {
      breaks.push({ kind: 'SEAL_FOREIGN', sealId: seal.id, sealed: seal.caseId, found: historyCaseId });
      continue;
    }
    const foreign = chain.links.slice(0, seal.entryCount).find((link) => link.entry.caseId !== seal.caseId);
    if (foreign) {
      breaks.push({ kind: 'SEAL_FOREIGN', sealId: seal.id, sealed: seal.caseId, found: foreign.entry.caseId });
      continue;
    }

    // --- The entries the signature covers ---------------------------------
    if (chain.length < seal.entryCount) {
      breaks.push({
        kind: 'ENTRIES_MISSING',
        sealId: seal.id,
        sealed: seal.entryCount,
        found: chain.length,
      });
      continue;
    }

    const recomputedHead = chain.links[seal.entryCount - 1]!.digest;
    if (recomputedHead !== seal.chainHead) {
      const alteredIndex = firstDivergentIndex(chain, input.recordedLinkDigests, seal.entryCount);
      if (alteredIndex === null) {
        breaks.push({
          kind: 'HEAD_MISMATCH',
          sealId: seal.id,
          sealed: seal.chainHead,
          recomputed: recomputedHead,
        });
      } else {
        breaks.push({
          kind: 'ENTRY_ALTERED',
          sealId: seal.id,
          index: alteredIndex,
          entryId: chain.links[alteredIndex]?.entry.id ?? null,
        });
      }
      continue;
    }

    // This seal checked out end to end.
    entriesCovered = Math.max(entriesCovered, seal.entryCount);
    if (firstSealedAt === null) firstSealedAt = seal.sealedAt;
    lastSealedAt = seal.sealedAt;
  }

  return {
    ok: breaks.length === 0,
    breaks,
    sealsChecked: seals.length,
    entriesCovered,
    firstSealedAt,
    lastSealedAt,
  };
}

/**
 * Finds the first entry whose digest differs from the one recorded at export.
 *
 * Returns `null` when there is nothing to compare against, or when the recorded digests
 * agree with the re-derived ones all the way through the sealed prefix — in which case the
 * head moved for a reason these digests cannot explain, and the caller reports the
 * unlocalised mismatch rather than inventing a culprit.
 *
 * The comparison is safe to make only because the caller has already verified the
 * signature over the head. The recorded digests are an untrusted convenience: a forger who
 * rewrote an entry and recomputed the digests to match would produce a bundle that is
 * internally consistent and still fails the signature check, because the head it rolls up
 * to is not the one that was signed.
 */
function firstDivergentIndex(
  chain: ReturnType<typeof buildAuditChain>,
  recorded: readonly string[] | undefined,
  limit: number,
): number | null {
  if (!recorded || recorded.length === 0) return null;

  const span = Math.min(limit, chain.links.length, recorded.length);
  for (let index = 0; index < span; index += 1) {
    if (chain.links[index]!.digest !== recorded[index]) return index;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading a case's sealing state
//
// Both the server (deciding whether to sign) and the app (deciding what to show) need these
// three answers, and they must agree: a button that offers to seal what the server will
// refuse, or reports covered what the server considers altered, is worse than no button. So
// they live here and are cross-compiled into the functions codebase rather than written
// twice — see `functions/tsconfig.domain.json`.
// ---------------------------------------------------------------------------

/**
 * The seal a new one must chain onto: the one covering the most entries.
 *
 * Ordered by coverage rather than by `sealedAt`, because coverage is what the ladder is
 * about and two seals written in the same millisecond would order arbitrarily by clock.
 * `verifySealedHistory` sorts by `entryCount` for the same reason, so the two agree by
 * construction.
 */
export function latestSeal<T extends { entryCount: number }>(seals: readonly T[]): T | null {
  return seals.reduce<T | null>(
    (best, item) => (best === null || item.entryCount > best.entryCount ? item : best),
    null,
  );
}

/**
 * Entries recorded since a seal that are not themselves records of sealing.
 *
 * Sealing writes a `SEAL_CREATED` entry, so every successful seal changes the audit log and
 * the head moves the instant a seal lands. A plain "has the head changed?" test would
 * therefore always say yes, and the seal button would ratchet forever — each new seal
 * solemnly attesting to the existence of the one before it. What makes another signature
 * worth making is that something happened *to the case*, so that is what gets counted.
 */
export function substantiveEntriesSince(
  chain: ReturnType<typeof buildAuditChain>,
  sealedCount: number,
): number {
  return chain.links.slice(sealedCount).filter((link) => link.entry.action !== 'SEAL_CREATED').length;
}

/**
 * Whether a history still rolls up to what an existing seal signed.
 *
 * The chain is a running digest, so the digest at index `n - 1` *is* the head over the first
 * `n` entries — no rebuild needed, and no separate test for each way a prefix can change.
 * Entries deleted, an entry edited, entries reordered: all of them move that digest, and all
 * of them are the same answer.
 *
 * The server refuses to add a seal when this is false, and the reason is worth stating
 * plainly: a second signature over an altered prefix would be a genuine signature over a
 * record that a genuine earlier signature contradicts. Both would verify. A reader comparing
 * them could only conclude that the signer attests to two versions of the same history —
 * which is worse than an unsealed record, because it spends the key's credibility on the
 * alteration.
 */
export function stillCoveredBy(
  chain: ReturnType<typeof buildAuditChain>,
  seal: { entryCount: number; chainHead: string },
): boolean {
  if (seal.entryCount < 1 || seal.entryCount > chain.links.length) return false;
  return chain.links[seal.entryCount - 1]!.digest === seal.chainHead;
}
