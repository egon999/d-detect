/**
 * The seal ribbon's copy.
 *
 * Two jobs. The first is ordinary: each sealing state produces the right chip, tone and
 * sentence, and the plurals read correctly at one and at many.
 *
 * The second is the reason this file exists. §9 of the Crucible concept is a list of claims
 * this product must never make — *tamper-proof*, *immutable*, *blockchain*, an unqualified
 * *verified*, a prediction of an outcome, silence read as an admission. Those rules live in a
 * document and in doc comments, which means nothing stops the next person from writing
 * "tamper-proof" into a Notice and shipping it. `forbidden vocabulary` below reads every
 * string the module can produce across every state and fails if one of those words appears.
 * A rule about wording that no test enforces is a preference, not a constraint.
 */

import { describe, expect, it } from 'vitest';

import { buildAuditChain } from '@domain/analysis/audit-chain';
import { caseSealState } from '@domain/crucible/case-seal-state';
import { SEAL_PUBLIC_KEYS } from '@domain/crucible/keys';
import { publicKeyFor, signSealContents, type SealBreak } from '@domain/crucible/seal';
import { emptyWorkspace, type AuditLog, type Case, type Seal, type Workspace } from '@domain/models';
import {
  SEAL_UNCHANGED_MESSAGE,
  describeBreak,
  sealActionLabel,
  sealFaults,
  sealHeadline,
  sealNotice,
  sealOutcomeMessage,
} from '@features/crucible/seal-copy';

const OWNER = 'usr_copy';
const CASE_ID = 'case_copy';

// Not 'v1'. Registering under the real published id would overwrite a live registry entry
// for the rest of the process — see the same note in `tests/crucible-seal.test.ts`.
const KEY_ID = 'copytest';
const SECRET = 'a'.repeat(63) + '1';
(SEAL_PUBLIC_KEYS as Record<string, string>)[KEY_ID] = publicKeyFor(SECRET);

const entry = (id: string, at: number, action: string, summary: string): AuditLog =>
  ({
    id, ownerId: OWNER, caseId: CASE_ID, createdAt: at, updatedAt: at,
    action, actorId: OWNER, entityRefs: [], summary, metadata: {},
  }) as unknown as AuditLog;

const caseRow = {
  id: CASE_ID, ownerId: OWNER, title: 'Copy check', status: 'OPEN',
  createdAt: 1, updatedAt: 1, deletedAt: null,
} as unknown as Case;

function sealOver(entries: AuditLog[], at: number): Seal {
  const chain = buildAuditChain(entries);
  const contents = {
    caseId: CASE_ID, chainHead: chain.head!, entryCount: chain.length,
    sealedAt: at, previousSealSignature: null,
  };
  return {
    ...contents, id: 'seal_copy', ownerId: OWNER, createdAt: at, updatedAt: at,
    signature: signSealContents(contents, SECRET), keyId: KEY_ID, algorithm: 'ed25519',
  } as Seal;
}

const workspaceOf = (auditLogs: AuditLog[], seals: Seal[]): Workspace =>
  ({ ...emptyWorkspace(), cases: [caseRow], auditLogs, seals }) as Workspace;

const three = [
  entry('aud_1', 1_757_000_000_000, 'CASE_CREATED', 'Case created.'),
  entry('aud_2', 1_757_000_100_000, 'EVIDENCE_UPLOADED', 'Uploaded invoice.pdf.'),
  entry('aud_3', 1_757_000_200_000, 'CLAIM_ADDED', 'Added a claim.'),
];
const goodSeal = sealOver(three, 1_757_000_300_000);
const sealEntry = entry('aud_4', 1_757_000_300_000, 'SEAL_CREATED', 'Sealed 3 entries of history.');
const laterEntry = entry('aud_5', 1_757_000_400_000, 'CLAIM_ADDED', 'Added another claim.');
const rewritten = [three[0]!, entry('aud_2', 1_757_000_100_000, 'EVIDENCE_UPLOADED', 'Uploaded something else.'), three[2]!];

/** Every state the ribbon can be in, so the vocabulary sweep can be exhaustive. */
const STATES = {
  unsealed: { workspace: workspaceOf(three, []), serverBacked: true },
  sealed: { workspace: workspaceOf([...three, sealEntry], [goodSeal]), serverBacked: true },
  behind: { workspace: workspaceOf([...three, sealEntry, laterEntry], [goodSeal]), serverBacked: true },
  altered: { workspace: workspaceOf([...rewritten, sealEntry], [goodSeal]), serverBacked: true },
  unknownKey: { workspace: workspaceOf([...three, sealEntry], [{ ...goodSeal, keyId: 'v99' }]), serverBacked: true },
  truncated: { workspace: workspaceOf([three[0]!], [goodSeal]), serverBacked: true },
  deviceOnly: { workspace: workspaceOf(three, []), serverBacked: false },
  empty: { workspace: workspaceOf([], []), serverBacked: true },
  singleSealed: {
    workspace: workspaceOf(
      [three[0]!, entry('aud_s', 1_757_000_100_000, 'SEAL_CREATED', 'Sealed 1 entry of history.')],
      [sealOver([three[0]!], 1_757_000_100_000)],
    ),
    serverBacked: true,
  },
} as const;

const input = (name: keyof typeof STATES) => ({
  state: caseSealState(STATES[name].workspace, CASE_ID),
  serverBacked: STATES[name].serverBacked,
});

describe('sealHeadline', () => {
  it('reserves the ok tone for a signature that actually checked out', () => {
    const headline = sealHeadline(input('sealed'));
    expect(headline.tone).toBe('ok');
    expect(headline.chip).toBe('Server-sealed');
    // Three entries covered out of four recorded, and the sentence says so. It used to say
    // "All 4 recorded entries are covered", which was false and visibly so: the detail line
    // under it reads "Covers 3 entries". The fourth is the `SEAL_CREATED` record, which is
    // written after the head it names and so cannot be inside it.
    expect(headline.sentence).toBe(
      'A server signature covers the 3 entries recorded before it; the one entry since is the record of the sealing itself.',
    );
  });

  it('says how far the seal reaches when entries have been added since', () => {
    const headline = sealHeadline(input('behind'));
    expect(headline.tone).toBe('info');
    // The number on the chip is coverage, not a total: a reader comparing it to the entry
    // count below can see the gap without being told to.
    expect(headline.chip).toBe('Sealed to 3');
    expect(headline.sentence).toBe('1 entry has been recorded since the last seal, and no signature covers it yet.');
  });

  it('leads with the mismatch when a seal no longer matches, whatever else is true', () => {
    for (const name of ['altered', 'truncated'] as const) {
      const headline = sealHeadline(input(name));
      expect(headline.tone, name).toBe('danger');
      expect(headline.chip, name).toBe('Does not match');
    }
  });

  it('reports an uncheckable key as a mismatch of the chip but not as a verdict in the copy', () => {
    // The chip cannot say "checked out", because it did not. The sentence beneath it must
    // still not call the seal wrong — see the UNKNOWN_KEY branch of `describeBreak`.
    expect(sealHeadline(input('unknownKey')).tone).toBe('danger');
    expect(sealNotice(input('unknownKey'))!.message).toMatch(/not the same as it being wrong/);
  });

  it('states the absence of a seal without implying a fault, and offers the reason', () => {
    expect(sealHeadline(input('unsealed'))).toEqual({
      tone: 'neutral',
      chip: 'Not sealed',
      sentence: 'A server can sign this history, producing a timestamped record that it existed in this exact order.',
    });
    expect(sealHeadline(input('deviceOnly')).sentence).toBe('Nothing outside this device has vouched for this history.');
    expect(sealHeadline(input('empty')).sentence).toBe('Nothing outside this device has vouched for this history.');
  });

  it('agrees in number with one covered entry', () => {
    expect(sealHeadline(input('singleSealed')).sentence).toBe(
      'A server signature covers the entry recorded before it; the one entry since is the record of the sealing itself.',
    );
    expect(sealNotice(input('singleSealed'))!.message).toMatch(/existence proof: 1 entry existed/);
  });

  it('never claims coverage the seal does not have', () => {
    // The invariant the wording exists to hold: the figure in the sentence is the seal's own
    // `entryCount`, never the length of the history it sits in.
    for (const name of ['sealed', 'singleSealed'] as const) {
      const arg = input(name);
      const covered = arg.state.latest!.entryCount;
      expect(arg.state.chain.length, name).toBeGreaterThan(covered);
      expect(sealHeadline(arg).sentence, name).not.toMatch(new RegExp(`\\b${arg.state.chain.length}\\b`));
      expect(sealHeadline(arg).sentence, name).toMatch(new RegExp(`\\b${covered}\\b|\\bthe entry\\b`));
    }
  });
});

describe('sealNotice', () => {
  it('qualifies the good case, which is the one that needs it', () => {
    const notice = sealNotice(input('sealed'))!;
    expect(notice.title).toBe('What the seal establishes');
    expect(notice.message).toMatch(/existence proof/);
    expect(notice.message).toMatch(/tamper-evident/);
    expect(notice.message).toMatch(/reveals an edit rather than preventing one/);
    expect(notice.message).toMatch(/says nothing about whether the records are true/);
    expect(notice.message).toMatch(/not a legal attestation/);
  });

  it('describes a mismatch without naming a culprit', () => {
    const notice = sealNotice(input('altered'))!;
    expect(notice.tone).toBe('danger');
    // `HEAD_MISMATCH`, not `ENTRY_ALTERED`, and that is the honest answer here. Localising
    // an alteration needs the per-entry digests as they were *before* it, which a screen
    // reading the current records does not have — see the note in `case-seal-state.ts`. So
    // the copy says the history does not add up and admits it cannot say where.
    expect(notice.message).toMatch(/does not add up to what was sealed/);
    expect(notice.message).toMatch(/cannot be identified from this copy alone/);
    // Two readings, both offered. An incomplete copy is at least as likely as an edit, and
    // this app cannot tell them apart.
    expect(notice.message).toMatch(/or that this copy of the case is incomplete/);
    expect(notice.message).toMatch(/not evidence of who changed it/);
  });

  it('explains the device-only case as a missing server, not a missing feature', () => {
    const notice = sealNotice(input('deviceOnly'))!;
    expect(notice.icon).toBe('cloud-off-outline');
    expect(notice.message).toMatch(/stored only on this device/);
    expect(notice.message).toMatch(/nothing here for it to sign/);
  });

  it('declines to offer a signature over an empty record', () => {
    expect(sealNotice(input('empty'))!.message).toMatch(/not a claim worth making/);
  });

  it('always has something to say', () => {
    for (const name of Object.keys(STATES) as Array<keyof typeof STATES>) {
      expect(sealNotice(input(name)), name).not.toBeNull();
    }
  });
});

describe('sealActionLabel', () => {
  it('offers a first seal, then names how many entries a later one would add', () => {
    expect(sealActionLabel(input('unsealed'))).toBe('Seal this record');
    expect(sealActionLabel(input('behind'))).toBe('Seal the 1 new entry');
  });

  it('offers nothing where the server would refuse', () => {
    // Each of these is a refusal `sealCase` makes on the server. Showing a button that
    // cannot succeed is worse than showing none: on `altered` it would read as an offer to
    // sign over the alteration.
    for (const name of ['sealed', 'altered', 'truncated', 'unknownKey', 'deviceOnly', 'empty'] as const) {
      expect(sealActionLabel(input(name)), name).toBeNull();
    }
  });
});

describe('describeBreak', () => {
  // `sealId` is on every break and used by none of these sentences, on purpose: a reader is
  // being told which of *their* records does not match, and a seal document id is not a
  // handle they have. The id is in the export for anyone who needs it.
  const SEAL = 'seal_copy';

  it('names the entry that does not match, and its position', () => {
    expect(describeBreak({ kind: 'ENTRY_ALTERED', sealId: SEAL, index: 4, entryId: 'aud_x' })).toBe(
      'Entry aud_x, at position 5 in the history, is not the one that was sealed.',
    );
    // A break with no id still has a position, which is the only handle a reader has.
    expect(describeBreak({ kind: 'ENTRY_ALTERED', sealId: SEAL, index: 0, entryId: null })).toBe(
      'Entry #1, at position 1 in the history, is not the one that was sealed.',
    );
  });

  it('counts removed entries in agreeing numbers', () => {
    expect(describeBreak({ kind: 'ENTRIES_MISSING', sealId: SEAL, sealed: 3, found: 2 })).toBe(
      'A seal covers 3 entries and only 2 are present, so 1 has been removed since it was made.',
    );
    expect(describeBreak({ kind: 'ENTRIES_MISSING', sealId: SEAL, sealed: 4, found: 1 })).toBe(
      'A seal covers 4 entries and only 1 is present, so 3 have been removed since it was made.',
    );
  });

  it('separates "cannot be checked here" from "is wrong"', () => {
    const text = describeBreak({ kind: 'UNKNOWN_KEY', sealId: SEAL, keyId: 'v9' });
    expect(text).toMatch(/cannot be checked here/);
    expect(text).toMatch(/not the same as it being wrong/);
    expect(text).toMatch(/Updating the app may add the key/);
  });

  it('admits when it cannot localise the change', () => {
    expect(
      describeBreak({ kind: 'HEAD_MISMATCH', sealId: SEAL, sealed: 'a'.repeat(64), recomputed: 'b'.repeat(64) }),
    ).toMatch(/cannot be identified from this copy alone/);
  });
});

describe('sealFaults', () => {
  it('does not present the absence of a seal as a fault', () => {
    const state = caseSealState(STATES.unsealed.workspace, CASE_ID);
    expect(state.verification.breaks.map((item) => item.kind)).toEqual(['NOT_SEALED']);
    expect(sealFaults(state)).toEqual([]);
  });

  it('passes real breaks through', () => {
    // `HEAD_MISMATCH` is what an altered record looks like from a screen: `caseSealState`
    // has no pre-alteration digests to compare against, so the break it can report is that
    // the whole history no longer adds up. `describeBreak`'s `ENTRY_ALTERED` sentence is
    // reached by a verifier that does hold them — the export bundle records them.
    expect(sealFaults(caseSealState(STATES.altered.workspace, CASE_ID)).map((item) => item.kind)).toEqual(['HEAD_MISMATCH']);
  });
});

describe('outcome messages', () => {
  it('counts what was covered', () => {
    expect(sealOutcomeMessage(1)).toBe('A server signed this history, covering 1 entry.');
    expect(sealOutcomeMessage(7)).toBe('A server signed this history, covering 7 entries.');
  });

  it('does not report an unchanged record as a success', () => {
    expect(SEAL_UNCHANGED_MESSAGE).toMatch(/no new signature was made/);
    expect(SEAL_UNCHANGED_MESSAGE).not.toMatch(/\bsealed\b/i);
  });
});

/**
 * The §9 sweep.
 *
 * Reads every sentence the module can produce, in every state and for every break kind, and
 * checks none of the forbidden claims appears. This is the test that has to keep passing;
 * everything above it is about whether the copy is *right*, and this is about whether it is
 * *allowed*.
 */
describe('forbidden vocabulary', () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    // It reveals an edit; it does not prevent one. The whole point of the seal is that the
    // records remain editable and the edit becomes visible.
    ['tamper-proof', /tamper[\s-]?proof/i],
    ['tamper-resistant', /tamper[\s-]?resistant/i],
    // The records are plainly mutable. Firestore rules make the audit log append-only on the
    // server; nothing here makes anything immutable.
    ['immutable', /immutab/i],
    // There is no chain of blocks and no distributed consensus. There is one server with one
    // key, which is a smaller and honest claim.
    ['blockchain', /block[\s-]?chain/i],
    ['ledger', /\bledger\b/i],
    // No outcome is predicted and no chance is scored, here or anywhere.
    ['a prediction', /\b(likel(y|ihood)|chance|odds|probab|will win|guarantee)/i],
    // A legal claim this product is not entitled to make.
    ['legal proof', /legally binding|legal proof|court[\s-]?admissible|admissible in court/i],
    // Certification language, which implies an accreditation nobody granted.
    ['certified', /\bcertif/i],
  ];

  /** Every string the module produces, across every state and every break kind. */
  function allCopy(): string[] {
    const strings: string[] = [SEAL_UNCHANGED_MESSAGE, sealOutcomeMessage(1), sealOutcomeMessage(9)];
    for (const name of Object.keys(STATES) as Array<keyof typeof STATES>) {
      const arg = input(name);
      const headline = sealHeadline(arg);
      strings.push(headline.chip, headline.sentence);
      const notice = sealNotice(arg);
      if (notice) strings.push(notice.title, notice.message);
      const action = sealActionLabel(arg);
      if (action) strings.push(action);
    }
    const breaks: SealBreak[] = [
      { kind: 'NOT_SEALED' },
      { kind: 'UNKNOWN_KEY', sealId: 'seal_copy', keyId: 'v9' },
      { kind: 'BAD_SIGNATURE', sealId: 'seal_copy' },
      { kind: 'LADDER_BROKEN', sealId: 'seal_copy', expected: 'a'.repeat(128), found: 'b'.repeat(128) },
      { kind: 'ENTRIES_MISSING', sealId: 'seal_copy', sealed: 3, found: 1 },
      { kind: 'ENTRY_ALTERED', sealId: 'seal_copy', index: 2, entryId: 'aud_z' },
      { kind: 'HEAD_MISMATCH', sealId: 'seal_copy', sealed: 'a'.repeat(64), recomputed: 'b'.repeat(64) },
    ];
    for (const item of breaks) strings.push(describeBreak(item));
    return strings;
  }

  it('produces copy for every state, so the sweep below is not vacuous', () => {
    const strings = allCopy();
    expect(strings.length).toBeGreaterThan(30);
    expect(strings.every((text) => text.trim().length > 0)).toBe(true);
  });

  for (const [claim, pattern] of FORBIDDEN) {
    it(`never says ${claim}`, () => {
      const offenders = allCopy().filter((text) => pattern.test(text));
      expect(offenders, `forbidden by §9: ${claim}`).toEqual([]);
    });
  }

  it('never calls anything verified without saying against what', () => {
    // "verified" alone invites the reader to supply their own object for the verb. Where the
    // word is wanted, the copy says what was checked against what instead.
    for (const text of allCopy()) {
      const matches = text.match(/verif\w*/gi) ?? [];
      for (const match of matches) {
        expect(
          /checks out against the public key|cannot be checked/.test(text),
          `"${match}" in: ${text}`,
        ).toBe(true);
      }
    }
  });
});
