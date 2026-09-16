import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAuditChain } from '@domain/analysis/audit-chain';
import { caseSealState } from '@domain/crucible/case-seal-state';
import { SEAL_PUBLIC_KEYS } from '@domain/crucible/keys';
import {
  GENESIS_SEAL_SIGNATURE,
  SEAL_PAYLOAD_VERSION,
  SealRefused,
  assertSealable,
  publicKeyFor,
  sealPayload,
  signSealContents,
  verifySealSignature,
  verifySealedHistory,
  type SealContents,
  type SealedAttestation,
} from '@domain/crucible/seal';
import { hashText } from '@domain/hashing';
import type { AuditLog, Seal } from '@domain/models';

import { CASE_ID, OWNER, workspace } from './helpers';

/**
 * Tests for the seal — the signature layer over the audit chain.
 *
 * The claim being tested is narrow: a seal proves a record's history existed by a signed
 * moment and has not moved since, and a verifier that does not hold the signing key can
 * check both. So the tests are, in order: the payload recipe is what it says it is; a real
 * signature round-trips and a forged one does not; and a sealed history reports the exact
 * way it was tampered with rather than a bare "failed".
 *
 * Signatures are never hardcoded. Ed25519 is deterministic, but a literal 128-hex string in
 * a test asserts nothing a reader can check and breaks the moment the payload recipe
 * changes — which is the moment the test should still be explaining *why*.
 */

// Deliberately not a real key id. `caseSealState` checks against the published registry in
// `@domain/crucible/keys`, so naming this 'v1' would make the seals below collide with the
// project's actual published key — the tests would then silently overwrite a live registry
// entry, and the one asserting that an unpublished key reports UNKNOWN_KEY would instead be
// testing a bad signature against the real key.
const KEY_ID = 'test';

// One throwaway keypair for the whole file. Generated, not hardcoded: the test proves the
// round trip, and a committed private key — even a toy one — is a habit worth not forming.
const secretKey = bytesToHex(ed25519.utils.randomSecretKey());
const publicKey = publicKeyFor(secretKey);
const keys = { [KEY_ID]: publicKey };

let counter = 0;

function entry(overrides: Partial<AuditLog> = {}): AuditLog {
  const id = overrides.id ?? `aud_${(counter += 1)}`;
  return {
    id,
    ownerId: OWNER,
    caseId: CASE_ID,
    createdAt: 1_000,
    updatedAt: 1_000,
    action: 'EVIDENCE_UPLOADED',
    actorId: OWNER,
    entityRefs: [],
    summary: 'Added Invoice INV-2024-018.',
    metadata: {},
    ...overrides,
  };
}

function history(): AuditLog[] {
  return [
    entry({ id: 'aud_a', createdAt: 1_000, action: 'CASE_CREATED', summary: 'Created the case.' }),
    entry({ id: 'aud_b', createdAt: 2_000, summary: 'Added Invoice INV-2024-018.' }),
    entry({ id: 'aud_c', createdAt: 3_000, action: 'ANALYSIS_RUN', summary: 'Ran analysis: 3 findings.' }),
  ];
}

/** Signs the head of a set of entries into a stored seal, the way the server would. */
function seal(
  entries: readonly AuditLog[],
  overrides: Partial<SealedAttestation & { id: string }> = {},
): SealedAttestation & { id: string } {
  const chain = buildAuditChain(entries);
  const contents: SealContents = {
    caseId: CASE_ID,
    chainHead: chain.head!,
    entryCount: chain.length,
    sealedAt: 1_700_000_000_000,
    previousSealSignature: null,
    ...overrides,
  };
  const signature = overrides.signature ?? signSealContents(contents, secretKey);
  return {
    id: overrides.id ?? `seal_${(counter += 1)}`,
    ...contents,
    signature,
    keyId: overrides.keyId ?? KEY_ID,
    algorithm: 'ed25519',
  };
}

describe('sealPayload', () => {
  const contents: SealContents = {
    caseId: CASE_ID,
    chainHead: 'a'.repeat(64),
    entryCount: 3,
    sealedAt: 1_700_000_000_000,
    previousSealSignature: null,
  };

  it('is the declared fields in a fixed order, unit-separated', () => {
    // Restated in full here rather than imported, so a change to the field order or the
    // separator has to be made twice, deliberately, instead of once by accident — the same
    // discipline the audit-chain test uses on its digest recipe.
    const SEP = '\u001F';
    expect(sealPayload(contents)).toBe(
      [SEAL_PAYLOAD_VERSION, CASE_ID, 'a'.repeat(64), '3', '1700000000000', GENESIS_SEAL_SIGNATURE].join(SEP),
    );
  });

  it('writes the genesis word where there is no previous seal', () => {
    expect(sealPayload(contents)).toContain(`\u001F${GENESIS_SEAL_SIGNATURE}`);
    expect(sealPayload({ ...contents, previousSealSignature: 'f'.repeat(128) })).toContain(
      `\u001F${'f'.repeat(128)}`,
    );
  });

  it('changes when any signed field changes', () => {
    const base = sealPayload(contents);
    expect(sealPayload({ ...contents, caseId: 'case_other' })).not.toBe(base);
    expect(sealPayload({ ...contents, chainHead: 'b'.repeat(64) })).not.toBe(base);
    expect(sealPayload({ ...contents, entryCount: 4 })).not.toBe(base);
    expect(sealPayload({ ...contents, sealedAt: contents.sealedAt + 1 })).not.toBe(base);
    expect(sealPayload({ ...contents, previousSealSignature: 'f'.repeat(128) })).not.toBe(base);
  });

  it('cannot be fooled by a field boundary, because entryCount is signed with the head', () => {
    // A head of "aa…a" over 33 entries and a head of "aa…a3" over 3 entries must not
    // serialise alike. The count field is exactly what stops a truncated history from
    // borrowing a longer history's signed head.
    const long = sealPayload({ ...contents, chainHead: 'a'.repeat(64), entryCount: 33 });
    const short = sealPayload({ ...contents, chainHead: 'a'.repeat(64), entryCount: 3 });
    expect(long).not.toBe(short);
  });
});

describe('assertSealable', () => {
  const ok: SealContents = {
    caseId: CASE_ID,
    chainHead: 'a'.repeat(64),
    entryCount: 1,
    sealedAt: 1_700_000_000_000,
    previousSealSignature: null,
  };

  it('accepts a well-formed seal', () => {
    expect(() => assertSealable(ok)).not.toThrow();
  });

  it('refuses to seal an empty history, the way the chain refuses to head one', () => {
    // buildAuditChain returns head: null for nothing; sealing "nothing happened" with a
    // signature would be worse than the reassuring-looking hash it already refuses to show.
    expect(() => assertSealable({ ...ok, entryCount: 0 })).toThrow(SealRefused);
  });

  it('refuses a head that is not a 64-hex digest', () => {
    expect(() => assertSealable({ ...ok, chainHead: 'not-a-digest' })).toThrow(SealRefused);
    expect(() => assertSealable({ ...ok, chainHead: 'A'.repeat(64) })).toThrow(SealRefused);
  });

  it('refuses a missing or non-positive signing time', () => {
    expect(() => assertSealable({ ...ok, sealedAt: 0 })).toThrow(SealRefused);
    expect(() => assertSealable({ ...ok, sealedAt: -1 })).toThrow(SealRefused);
  });

  it('refuses a malformed previous-seal signature but allows null', () => {
    expect(() => assertSealable({ ...ok, previousSealSignature: 'short' })).toThrow(SealRefused);
    expect(() => assertSealable({ ...ok, previousSealSignature: null })).not.toThrow();
    expect(() => assertSealable({ ...ok, previousSealSignature: 'a'.repeat(128) })).not.toThrow();
  });
});

describe('signSealContents / verifySealSignature', () => {
  const contents: SealContents = {
    caseId: CASE_ID,
    chainHead: hashText('anything'),
    entryCount: 2,
    sealedAt: 1_700_000_000_000,
    previousSealSignature: null,
  };

  it('produces a 128-hex signature that verifies against the matching public key', () => {
    const signature = signSealContents(contents, secretKey);
    expect(signature).toMatch(/^[a-f0-9]{128}$/);

    const attestation: SealedAttestation = { ...contents, signature, keyId: KEY_ID, algorithm: 'ed25519' };
    expect(verifySealSignature(attestation, publicKey)).toBe(true);
  });

  it('fails verification against a different public key', () => {
    const signature = signSealContents(contents, secretKey);
    const attestation: SealedAttestation = { ...contents, signature, keyId: KEY_ID, algorithm: 'ed25519' };
    const otherKey = publicKeyFor(bytesToHex(ed25519.utils.randomSecretKey()));

    expect(verifySealSignature(attestation, otherKey)).toBe(false);
  });

  it('fails verification when any signed field is changed after signing', () => {
    // The whole point: a seal is a signature over specific contents, so editing the
    // contents and keeping the signature must break the check.
    const signature = signSealContents(contents, secretKey);
    const attestation: SealedAttestation = { ...contents, signature, keyId: KEY_ID, algorithm: 'ed25519' };

    expect(verifySealSignature({ ...attestation, entryCount: 3 }, publicKey)).toBe(false);
    expect(verifySealSignature({ ...attestation, chainHead: hashText('else') }, publicKey)).toBe(false);
    expect(verifySealSignature({ ...attestation, sealedAt: contents.sealedAt + 1 }, publicKey)).toBe(false);
    expect(verifySealSignature({ ...attestation, caseId: 'case_other' }, publicKey)).toBe(false);
  });

  it('returns false rather than throwing on a malformed signature or key', () => {
    // A verifier meets whatever a stranger uploaded; "not a valid seal" and "does not
    // verify" are the same answer, and a page that threw on a truncated file would crash
    // instead of reporting.
    const attestation: SealedAttestation = {
      ...contents,
      signature: 'nonsense',
      keyId: KEY_ID,
      algorithm: 'ed25519',
    };
    expect(verifySealSignature(attestation, publicKey)).toBe(false);
    expect(verifySealSignature({ ...attestation, signature: 'a'.repeat(128) }, 'bad-key')).toBe(false);
  });

  it('refuses to verify a non-ed25519 algorithm rather than ignoring the field', () => {
    const signature = signSealContents(contents, secretKey);
    const attestation = { ...contents, signature, keyId: KEY_ID, algorithm: 'rsa' } as unknown as SealedAttestation;
    expect(verifySealSignature(attestation, publicKey)).toBe(false);
  });

  it('rejects a signing key of the wrong length before it signs', () => {
    expect(() => signSealContents(contents, 'abcd')).toThrow(SealRefused);
  });
});

describe('verifySealedHistory', () => {
  it('verifies a single honest seal over an unchanged history', () => {
    const entries = history();
    const result = verifySealedHistory({ entries, seals: [seal(entries)], publicKeys: keys });

    expect(result.ok).toBe(true);
    expect(result.breaks).toEqual([]);
    expect(result.sealsChecked).toBe(1);
    expect(result.entriesCovered).toBe(3);
    expect(result.firstSealedAt).toBe(1_700_000_000_000);
  });

  it('reports NOT_SEALED for a history nobody has sealed, and OK for an empty one', () => {
    expect(verifySealedHistory({ entries: history(), seals: [], publicKeys: keys })).toMatchObject({
      ok: false,
      breaks: [{ kind: 'NOT_SEALED' }],
    });
    // An empty, unsealed case is the ordinary starting state — but "ordinary" is carried by
    // `NOT_SEALED` being the only break, not by `ok`. `ok: true` is reserved for something
    // that was actually attested to, so an emptied bundle — every entry and every seal
    // stripped — cannot present itself as a clean pass. See the note in `verifySealedHistory`.
    expect(verifySealedHistory({ entries: [], seals: [], publicKeys: keys })).toMatchObject({
      ok: false,
      breaks: [{ kind: 'NOT_SEALED' }],
    });
  });

  it('flags a seal signed by a key the verifier does not hold, and does not trust it', () => {
    const entries = history();
    const foreign = seal(entries, { keyId: 'v2' });
    const result = verifySealedHistory({ entries, seals: [foreign], publicKeys: keys });

    expect(result.ok).toBe(false);
    expect(result.breaks).toEqual([{ kind: 'UNKNOWN_KEY', sealId: foreign.id, keyId: 'v2' }]);
    expect(result.entriesCovered).toBe(0);
  });

  it('flags a forged signature', () => {
    const entries = history();
    const forged = seal(entries, { signature: 'a'.repeat(128) });
    const result = verifySealedHistory({ entries, seals: [forged], publicKeys: keys });

    expect(result.ok).toBe(false);
    expect(result.breaks).toEqual([{ kind: 'BAD_SIGNATURE', sealId: forged.id }]);
  });

  it('detects that entries were deleted below the count the seal covers', () => {
    const entries = history();
    const attestation = seal(entries); // sealed over 3 entries
    const truncated = [entries[0]!, entries[1]!]; // now only 2 survive

    const result = verifySealedHistory({ entries: truncated, seals: [attestation], publicKeys: keys });

    expect(result.ok).toBe(false);
    expect(result.breaks).toEqual([
      { kind: 'ENTRIES_MISSING', sealId: attestation.id, sealed: 3, found: 2 },
    ]);
  });

  it('names the exact entry that changed when the recorded digests are supplied', () => {
    // The demo. A reader edits one entry in an exported bundle; the page must say which one,
    // not merely that something moved.
    const entries = history();
    const attestation = seal(entries);
    const recordedLinkDigests = buildAuditChain(entries).links.map((link) => link.digest);

    const tampered = history();
    tampered[1] = entry({ ...tampered[1]!, summary: 'Added Invoice INV-2024-999.' });

    const result = verifySealedHistory({
      entries: tampered,
      seals: [attestation],
      publicKeys: keys,
      recordedLinkDigests,
    });

    expect(result.ok).toBe(false);
    expect(result.breaks).toEqual([
      { kind: 'ENTRY_ALTERED', sealId: attestation.id, index: 1, entryId: 'aud_b' },
    ]);
  });

  it('falls back to an unlocalised head mismatch when no recorded digests are given', () => {
    const entries = history();
    const attestation = seal(entries);

    const tampered = history();
    tampered[1] = entry({ ...tampered[1]!, summary: 'Added Invoice INV-2024-999.' });

    const result = verifySealedHistory({ entries: tampered, seals: [attestation], publicKeys: keys });

    expect(result.ok).toBe(false);
    expect(result.breaks[0]?.kind).toBe('HEAD_MISMATCH');
  });

  it('cannot be fooled by recorded digests that agree with the forger, because the head is signed first', () => {
    // A forger rewrites entry 1 and recomputes every digest to match their rewrite. The
    // bundle is now internally consistent — but it rolls up to a head that was never signed,
    // so the signature check fails before the digests are ever consulted.
    const entries = history();
    const attestation = seal(entries);

    const tampered = history();
    tampered[1] = entry({ ...tampered[1]!, summary: 'Rewritten.' });
    const forgedDigests = buildAuditChain(tampered).links.map((link) => link.digest);

    const result = verifySealedHistory({
      entries: tampered,
      seals: [attestation],
      publicKeys: keys,
      recordedLinkDigests: forgedDigests,
    });

    // The head over the rewrite differs from the signed head; localisation never runs.
    expect(result.ok).toBe(false);
    expect(result.breaks[0]?.kind).toBe('HEAD_MISMATCH');
  });

  describe('the ladder of seals', () => {
    /** Two honest seals: one over the first two entries, one over all three, correctly chained. */
    function ladder(entries: AuditLog[]) {
      const firstTwo = [entries[0]!, entries[1]!];
      const first = seal(firstTwo, { id: 'seal_1', entryCount: 2, sealedAt: 1_700_000_000_000 });
      const second = seal(entries, {
        id: 'seal_2',
        entryCount: 3,
        sealedAt: 1_700_000_001_000,
        previousSealSignature: first.signature,
      });
      return { first, second };
    }

    it('verifies a correctly chained ladder and reports the earliest sealing time first', () => {
      const entries = history();
      const { first, second } = ladder(entries);

      const result = verifySealedHistory({ entries, seals: [second, first], publicKeys: keys });

      expect(result.ok).toBe(true);
      expect(result.sealsChecked).toBe(2);
      expect(result.entriesCovered).toBe(3);
      // The tightest upper bound on when the covered history existed is the earliest seal.
      expect(result.firstSealedAt).toBe(1_700_000_000_000);
      expect(result.lastSealedAt).toBe(1_700_000_001_000);
    });

    it('flags a seal that does not point at the one before it', () => {
      const entries = history();
      const { first, second } = ladder(entries);
      const detached = { ...second, previousSealSignature: 'f'.repeat(128) };

      const result = verifySealedHistory({ entries, seals: [first, detached], publicKeys: keys });

      expect(result.ok).toBe(false);
      expect(result.breaks.some((b) => b.kind === 'LADDER_BROKEN' && b.sealId === 'seal_2')).toBe(true);
    });

    it('still credits an older seal when a newer one is broken', () => {
      // A ladder exists so that rewriting recent history cannot erase what an older seal
      // already established. The first seal must keep standing.
      const entries = history();
      const { first, second } = ladder(entries);

      const tampered = history();
      tampered[2] = entry({ ...tampered[2]!, summary: 'Rewritten third entry.' });

      const result = verifySealedHistory({
        entries: tampered,
        seals: [first, { ...second, previousSealSignature: first.signature }],
        publicKeys: keys,
      });

      expect(result.ok).toBe(false);
      // The second seal covers the rewritten entry and breaks; the first still verifies.
      expect(result.entriesCovered).toBe(2);
      expect(result.firstSealedAt).toBe(1_700_000_000_000);
    });
  });
});

describe('caseSealState', () => {
  /**
   * The workspace-level read the audit screen does.
   *
   * These tests use the *published* key registry rather than the throwaway keypair above,
   * because `caseSealState` deliberately takes no key argument — it checks against whatever
   * this build shipped with, which is the whole point of it. So a seal made here with a test
   * key is expected to report `UNKNOWN_KEY`, and the tests that need a *passing* seal
   * register their key in the registry the way a rotation would.
   */
  function stateFor(entries: AuditLog[], seals: Seal[]) {
    return caseSealState(workspace({ auditLogs: entries, seals }), CASE_ID);
  }

  /** A stored seal record, as the server writes it. */
  function stored(entries: readonly AuditLog[], overrides: Partial<Seal> = {}): Seal {
    const attestation = seal(entries, overrides as Partial<SealedAttestation & { id: string }>);
    return {
      ...attestation,
      ownerId: OWNER,
      createdAt: attestation.sealedAt,
      updatedAt: attestation.sealedAt,
      ...overrides,
    } as Seal;
  }

  it('reports an unsealed case as sealable, without calling it a failure', () => {
    const state = stateFor(history(), []);

    expect(state.latest).toBeNull();
    expect(state.unsealedEntries).toBe(3);
    expect(state.sealable).toBe(true);
    // NOT_SEALED is the only break, and it is a statement about what has not happened yet.
    expect(state.verification.breaks).toEqual([{ kind: 'NOT_SEALED' }]);
  });

  it('reports an empty case as not sealable and not broken', () => {
    const state = stateFor([], []);

    expect(state.sealable).toBe(false);
    expect(state.unsealedEntries).toBe(0);
    // "Not broken" means no tampering break — not `ok`, which an unsealed case never gets.
    // The distinction is what keeps a new case off the alarming branch in the UI.
    expect(state.verification.breaks).toEqual([{ kind: 'NOT_SEALED' }]);
  });

  it('checks signatures against the published registry, not against a key the data supplies', () => {
    // The test keypair is not published, so a seal made with it is something this build
    // cannot check — reported as unknown, never as authentic.
    const entries = history();
    const state = stateFor(entries, [stored(entries)]);

    expect(state.verification.ok).toBe(false);
    expect(state.verification.breaks[0]?.kind).toBe('UNKNOWN_KEY');
    expect(state.verification.entriesCovered).toBe(0);
  });

  describe('with the signing key published', () => {
    // Registering a key in the registry is exactly what rotation does, so doing it here
    // exercises the real path rather than a test-only seam.
    beforeAll(() => {
      (SEAL_PUBLIC_KEYS as Record<string, string>)[KEY_ID] = publicKey;
    });
    afterAll(() => {
      delete (SEAL_PUBLIC_KEYS as Record<string, string>)[KEY_ID];
    });

    it('reports a sealed, unchanged case as covered and with nothing left to seal', () => {
      const entries = history();
      const state = stateFor(entries, [stored(entries)]);

      expect(state.verification.ok).toBe(true);
      expect(state.verification.entriesCovered).toBe(3);
      expect(state.latest?.entryCount).toBe(3);
      expect(state.unsealedEntries).toBe(0);
      expect(state.sealable).toBe(false);
    });

    it('does not count a SEAL_CREATED entry as something new to seal', () => {
      // The entry recording a seal is written after the head it names, so the head always
      // moves the instant a seal lands. Counting it would make the button ratchet forever.
      const entries = history();
      const attestation = stored(entries);
      const withRecord = [
        ...entries,
        entry({ id: 'aud_seal', createdAt: 4_000, action: 'SEAL_CREATED', summary: 'Sealed 3 entries of history.' }),
      ];

      const state = stateFor(withRecord, [attestation]);

      expect(state.unsealedEntries).toBe(0);
      expect(state.sealable).toBe(false);
      expect(state.chain.length).toBe(4);
    });

    it('counts a real change and offers to seal again', () => {
      const entries = history();
      const attestation = stored(entries);
      const grown = [...entries, entry({ id: 'aud_d', createdAt: 5_000, summary: 'Added a bank statement.' })];

      const state = stateFor(grown, [attestation]);

      expect(state.unsealedEntries).toBe(1);
      expect(state.sealable).toBe(true);
      // The old seal still verifies over its own prefix; growth is not tampering.
      expect(state.verification.ok).toBe(true);
      expect(state.verification.entriesCovered).toBe(3);
    });

    it('refuses to offer a seal over a history that no longer matches its seal', () => {
      const entries = history();
      const attestation = stored(entries);

      const tampered = history();
      tampered[1] = entry({ ...tampered[1]!, summary: 'Added Invoice INV-2024-999.' });
      // Something genuinely new as well, so `unsealedEntries > 0` cannot be what decides it.
      tampered.push(entry({ id: 'aud_d', createdAt: 5_000, summary: 'Added a bank statement.' }));

      const state = stateFor(tampered, [attestation]);

      expect(state.sealable).toBe(false);
      expect(state.unsealedEntries).toBeGreaterThan(0);
      expect(state.verification.ok).toBe(false);
    });

    it('ignores seals belonging to another case', () => {
      const entries = history();
      const foreign = { ...stored(entries), id: 'seal_foreign', caseId: 'case_other' } as Seal;

      const state = stateFor(entries, [foreign]);

      expect(state.seals).toEqual([]);
      expect(state.latest).toBeNull();
      // Filtered out rather than left to fail its own signature check: a break shown because
      // of a scoping mistake is the screen crying wolf.
      expect(state.verification.breaks).toEqual([{ kind: 'NOT_SEALED' }]);
    });
  });
});
