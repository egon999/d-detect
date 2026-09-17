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
 *
 * ## Three availability answers, not two
 *
 * `serverBacked: boolean` used to stand in for "can this be sealed", and it answered a
 * different question: where the case is stored. A Firebase workspace stores on a server and
 * has no `sealCase` deployed in front of it, so the ribbon offered a primary button that could
 * only ever produce a warning toast, over a notice claiming the case was on this phone alone.
 * `SealAvailability` splits the two unsealable cases apart, and the states below carry the
 * three answers so the sweep sees all of them.
 */

import { describe, expect, it } from 'vitest';

import { buildAuditChain } from '@domain/analysis/audit-chain';
import { caseSealState } from '@domain/crucible/case-seal-state';
import { DEVELOPMENT_SEAL_KEY_IDS, SEAL_PUBLIC_KEYS } from '@domain/crucible/keys';
import { publicKeyFor, signSealContents, type SealBreak } from '@domain/crucible/seal';
import { emptyWorkspace, type AuditLog, type Case, type Seal, type Workspace } from '@domain/models';
import {
  SEAL_UNCHANGED_MESSAGE,
  describeBreak,
  sealActionLabel,
  sealFaults,
  sealHeadline,
  sealMismatches,
  sealNotice,
  sealUncheckable,
  sealOutcomeMessage,
} from '@features/crucible/seal-copy';
import type { SealAvailability } from '@services/crucible/request-seal';

const OWNER = 'usr_copy';
const CASE_ID = 'case_copy';

// Not 'v1'. Registering under the real published id would overwrite a live registry entry
// for the rest of the process — see the same note in `tests/crucible-seal.test.ts`.
const KEY_ID = 'copytest';
const SECRET = 'a'.repeat(63) + '1';
(SEAL_PUBLIC_KEYS as Record<string, string>)[KEY_ID] = publicKeyFor(SECRET);

/**
 * A second registered id, marked as a development signer.
 *
 * Signing as the real `dev1` is not an option and the reason is worth stating, because the
 * obvious shortcut produces a test that passes while checking the wrong branch entirely.
 * `dev1`'s published public key is real and this file cannot produce signatures for it, so a
 * seal claiming that id would fail verification, land in `sealFaults`, and be described by the
 * mismatch copy — never reaching the development wording these tests are about.
 *
 * Registering an id of our own under the same secret keeps the signature valid and the seal
 * development-signed at once, which is the combination the production code has to handle: a
 * correct signature that attests to less than a server one.
 */
const DEV_KEY_ID = 'copytestdev';
(SEAL_PUBLIC_KEYS as Record<string, string>)[DEV_KEY_ID] = publicKeyFor(SECRET);
(DEVELOPMENT_SEAL_KEY_IDS as string[]).push(DEV_KEY_ID);

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
  unsealed: { workspace: workspaceOf(three, []), availability: 'available' },
  sealed: { workspace: workspaceOf([...three, sealEntry], [goodSeal]), availability: 'available' },
  behind: { workspace: workspaceOf([...three, sealEntry, laterEntry], [goodSeal]), availability: 'available' },
  altered: { workspace: workspaceOf([...rewritten, sealEntry], [goodSeal]), availability: 'available' },
  unknownKey: { workspace: workspaceOf([...three, sealEntry], [{ ...goodSeal, keyId: 'v99' }]), availability: 'available' },
  /**
   * The same records and the same signature as `sealed`; only the key id differs.
   *
   * That is the whole shape of what the copy has to notice. The bytes are identical, the
   * verification passes identically, and the one thing that has changed is which family of key
   * made it — which is the only thing carrying the claim about independence.
   */
  devSealed: {
    workspace: workspaceOf([...three, sealEntry], [{ ...goodSeal, keyId: DEV_KEY_ID }]),
    availability: 'available',
  },
  /**
   * A seal naming a signature scheme this build cannot run.
   *
   * The same fact as `unknownKey` one level down, and it needs its own state because the two
   * arrive from different branches of `verifySealedHistory` - the scheme is read before the
   * key, and both `continue` before anything is compared. A fixture for one would leave the
   * other free to regress back into the mismatch copy.
   */
  badAlgorithm: {
    workspace: workspaceOf([...three, sealEntry], [{ ...goodSeal, algorithm: 'ed25519-v2' } as unknown as Seal]),
    availability: 'available',
  },
  /**
   * One seal that does not match, and one this build cannot check, on the same case.
   *
   * The state that decides the branch order. Reported as uncheckable it would bury a real
   * mismatch; reported as a mismatch with the uncheckable seal folded into the same list it
   * would extend the verdict over a seal nothing compared. The ladder is kept intact - the
   * second seal points at the first - so the only breaks here are the two being argued about.
   */
  mixedBreaks: {
    workspace: workspaceOf(
      [...rewritten, sealEntry],
      [goodSeal, { ...goodSeal, id: 'seal_copy_b', keyId: 'v99', previousSealSignature: goodSeal.signature } as Seal],
    ),
    availability: 'available',
  },
  truncated: { workspace: workspaceOf([three[0]!], [goodSeal]), availability: 'available' },
  deviceOnly: { workspace: workspaceOf(three, []), availability: 'device-only' },
  /**
   * Records on a server, and no signer deployed in front of them.
   *
   * The same workspace as `unsealed` — a perfectly ordinary, perfectly sealable case — so the
   * only thing separating them here is the availability answer. That is the shape of the bug
   * this state was added for: the ribbon read "the data is on a server" as "a signer can be
   * reached", offered a primary button on exactly this case, and every tap came back as a
   * toast saying there was nothing to ask.
   */
  noService: { workspace: workspaceOf(three, []), availability: 'no-service' },
  /** No signer and nothing recorded, which is the branch order these two states argue over. */
  noServiceEmpty: { workspace: workspaceOf([], []), availability: 'no-service' },
  empty: { workspace: workspaceOf([], []), availability: 'available' },
  singleSealed: {
    workspace: workspaceOf(
      [three[0]!, entry('aud_s', 1_757_000_100_000, 'SEAL_CREATED', 'Sealed 1 entry of history.')],
      [sealOver([three[0]!], 1_757_000_100_000)],
    ),
    availability: 'available',
  },
} as const satisfies Record<string, { workspace: Workspace; availability: SealAvailability }>;

const input = (name: keyof typeof STATES) => ({
  state: caseSealState(STATES[name].workspace, CASE_ID),
  availability: STATES[name].availability,
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

  it('does not spend the ok tone on a key no server holds', () => {
    // `devSealed` is `sealed` with one field changed, so this pair is the whole claim in two
    // assertions: a correct signature made by a development key does not get the green chip or
    // the word *server*, because both assert an independence that key cannot have. `dev1` is
    // defined in `@domain/crucible/keys` as a key whose private half no deployed server holds,
    // so the signer may be the very machine that produced the records.
    const headline = sealHeadline(input('devSealed'));
    expect(headline.tone).toBe('info');
    expect(headline.chip).toBe('Development seal');
    expect(headline.sentence).toBe(
      'A development-key signature covers the 3 entries recorded before it; the one entry since is the record of the sealing itself.',
    );
    expect(headline.sentence).not.toMatch(/server/i);
  });

  it('does not read a development key as a fault', () => {
    // The other half, and the easier mistake to make. Demoting the tone must not slide into
    // calling the seal wrong: the signature checks out, and `keys.ts` is explicit that such a
    // signature "is a correct signature; it simply attests to less".
    expect(sealFaults(input('devSealed').state)).toEqual([]);
    expect(sealHeadline(input('devSealed')).tone).not.toBe('danger');
    expect(input('devSealed').state.latest).not.toBeNull();
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

  it('does not reach a verdict on a seal it never compared', () => {
    // The regression this pair of assertions exists for, and it was reachable by ordinary key
    // rotation: an app too old to hold the key that signed a seal got the danger chip and the
    // sentence "A seal on this record no longer matches its history" — a comparison it had not
    // performed, stated as a finding. The chip still cannot say "checked out", because it did
    // not; it now says which of the two it means.
    for (const name of ['unknownKey', 'badAlgorithm'] as const) {
      const headline = sealHeadline(input(name));
      expect(headline.tone, name).not.toBe('danger');
      expect(headline.chip, name).toBe('Cannot be checked');
      expect(headline.sentence, name).toBe(
        'A seal on this record cannot be checked by this version of the app, so nothing has been compared.',
      );
      expect(headline.sentence, name).not.toMatch(/no longer matches/);
      expect(sealNotice(input(name))!.message, name).toMatch(/not the same as it being wrong/);
    }
  });

  it('does not let an uncheckable seal earn the green chip either', () => {
    // The other half of the same overclaim, and the reason this branch sits above the coverage
    // ones rather than below them. `latest` is set for an unknown-key seal exactly as it is for
    // a good one, and `unsealedEntries` is 0 in both — so merely dropping the fault from the
    // danger branch would have dropped this state straight into `ok` / 'Server-sealed'.
    for (const name of ['unknownKey', 'badAlgorithm'] as const) {
      expect(input(name).state.latest, name).not.toBeNull();
      expect(input(name).state.unsealedEntries, name).toBe(0);
      expect(sealHeadline(input(name)).tone, name).not.toBe('ok');
      expect(sealHeadline(input(name)).chip, name).not.toBe('Server-sealed');
    }
  });

  it('leads with the mismatch when one seal does not match and another cannot be checked', () => {
    // A mismatch outranks an uncheckable seal, because the reader can act on the first and
    // not on the second. The uncheckable one is not dropped: it is described after the
    // verdict, in its own words, which already say it is not evidence of anything.
    const headline = sealHeadline(input('mixedBreaks'));
    expect(headline.tone).toBe('danger');
    expect(headline.chip).toBe('Does not match');

    const notice = sealNotice(input('mixedBreaks'))!;
    expect(notice.message).toMatch(/does not add up to what was sealed/);
    expect(notice.message).toMatch(/not the same as it being wrong/);
    // The verdict sentence sits between the two, so it reads as a claim about what precedes
    // it. Reversing that order is the quiet way to extend it over the uncheckable seal.
    expect(notice.message.indexOf('this is not that one')).toBeLessThan(
      notice.message.indexOf('not the same as it being wrong'),
    );
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

  it('does not offer a signing server to a state that has none', () => {
    // `unsealed` and `noService` are the same records; only the availability differs. The
    // offer sentence is reserved for the state that can honour it, and the other gets the
    // sentence about what has vouched so far — which is "nothing", and is as true of a
    // Firestore case with no signer as of one that never left the phone. Storage is not
    // vouching, so this is not the device-only claim wearing a different hat.
    const headline = sealHeadline(input('noService'));
    expect(headline.chip).toBe('Not sealed');
    expect(headline.sentence).toBe('Nothing outside this device has vouched for this history.');
    expect(headline.sentence).not.toMatch(/A server can sign/);
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

  it('says which key signed, and what that key cannot establish', () => {
    const notice = sealNotice(input('devSealed'))!;
    expect(notice.title).toBe('Signed by a development key');
    // The id itself, quoted, because that is what travels into an export and what a stranger's
    // verifier will report back — a description of the key family would not survive the trip.
    expect(notice.message).toMatch(new RegExp(`"${DEV_KEY_ID}"`));
    expect(notice.message).toMatch(/private half is not held by a deployed server/);
    expect(notice.message).toMatch(/can have been produced on the same machine as these records/);
    expect(notice.message).toMatch(/not evidence that this history existed anywhere but here/);
  });

  it('keeps the production sentence away from a development seal, and the reverse', () => {
    // The exact line that was wrong before this branch existed. A `dev1` seal was described
    // with "a key held on the server, not on this device" — whose second clause is backwards
    // for a signer that may be this machine, and whose first is the claim the split key
    // registry exists to stop the app from manufacturing.
    expect(sealNotice(input('devSealed'))!.message).not.toMatch(/key held on the server, not on this device/);
    expect(sealNotice(input('devSealed'))!.message).not.toMatch(/existence proof/);
    expect(sealNotice(input('sealed'))!.message).toMatch(/key held on the server, not on this device/);
    expect(sealNotice(input('sealed'))!.title).not.toBe('Signed by a development key');
  });

  it('weakens only the independence claim, never the tamper-evidence', () => {
    // What a development key costs is precisely one thing. The check still fails on any later
    // edit, because that property comes from the signature covering the chain rather than from
    // who holds the key — so the caveats a reader needs are identical in both notices, and the
    // shared `SEAL_LIMITS` constant is what stops them drifting apart.
    for (const name of ['sealed', 'devSealed'] as const) {
      const { message } = sealNotice(input(name))!;
      expect(message, name).toMatch(/any later change to them breaks the check/);
      expect(message, name).toMatch(/tamper-evident — it reveals an edit rather than preventing one/);
      expect(message, name).toMatch(/says nothing about whether the records are true/);
      expect(message, name).toMatch(/not a legal attestation/);
      expect(message, name).toMatch(/3 entries existed, in this order, by the time shown above/);
    }
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

  it('keeps the device-only sentences out of every other state', () => {
    // The specific falsehood this split exists to prevent. Told to a signed-in user whose
    // records are on a server, "This case is stored only on this device" is untrue, and
    // "Signing in and syncing the case makes sealing available" is an instruction that cannot
    // work — there is nothing on the far end to sync towards.
    for (const name of Object.keys(STATES) as Array<keyof typeof STATES>) {
      if (name === 'deviceOnly') continue;
      const message = sealNotice(input(name))?.message ?? '';
      expect(message, name).not.toMatch(/stored only on this device/);
      expect(message, name).not.toMatch(/Signing in and syncing/);
    }
  });

  it('says a build with no signer has no signer, and does not dress it as a fault', () => {
    const notice = sealNotice(input('noService'))!;
    expect(notice.title).toBe('No sealing service in this build');
    // What is absent, and that it is absent for every case rather than this one.
    expect(notice.message).toMatch(/No such server is part of this build/);
    expect(notice.message).toMatch(/for this case or any other/);
    // Not a finding about the record.
    expect(notice.message).toMatch(/Nothing is wrong with the record/);
    expect(notice.message).toMatch(/nothing has read it, and nothing has judged it/);
    // What the reader still has: the integrity panel directly above the ribbon, in that
    // panel's own words, and stopping exactly where the panel stops.
    expect(notice.message).toMatch(/hash chain is recomputed from these entries on this device/);
    expect(notice.message).toMatch(/internally consistent with one another and nothing beyond that/);
  });

  it('promises the reader neither a seal nor an action they cannot take', () => {
    const { message, title } = sealNotice(input('noService'))!;
    const text = `${title} ${message}`;
    // No future seal. "Soon", "yet", "once ... is deployed" would all be this file's
    // characteristic failure: a claim about something that has not happened.
    expect(text).not.toMatch(/\b(soon|shortly|coming|will be|once .* deployed|not yet|for now)\b/i);
    // No instruction, because there is nothing the reader can do about a missing deployment.
    expect(text).not.toMatch(/\b(sign in|sync|upgrade|retry|try again|contact)\b/i);
  });

  it('gives the two unavailable states different sentences', () => {
    const deviceOnly = sealNotice(input('deviceOnly'))!;
    const noService = sealNotice(input('noService'))!;
    expect(noService.title).not.toBe(deviceOnly.title);
    expect(noService.message).not.toBe(deviceOnly.message);
    // Neither is reachable from the other's state, which is the whole point of splitting
    // `serverBacked` into three answers.
    for (const name of Object.keys(STATES) as Array<keyof typeof STATES>) {
      const notice = sealNotice(input(name))!;
      if (notice.title === deviceOnly.title) expect(STATES[name].availability, name).toBe('device-only');
      if (notice.title === noService.title) expect(STATES[name].availability, name).toBe('no-service');
    }
  });

  it('answers the missing signer before the empty history, because one outranks the other', () => {
    // A case with nothing in it and no signer gets the signer sentence. "There is no history
    // to seal" is true but implies that recording something would change the answer, and in
    // this build it would not.
    const notice = sealNotice(input('noServiceEmpty'))!;
    expect(notice.title).toBe('No sealing service in this build');
    // And it drops the closing sentence about the check above, because with nothing recorded
    // there is no chain on that panel to point at. Describing one would be inventing the
    // reassurance the sentence exists to avoid inventing.
    expect(notice.message).not.toMatch(/hash chain is recomputed/);
    expect(sealNotice(input('noService'))!.message).toMatch(/hash chain is recomputed/);
  });

  it('declines to offer a signature over an empty record', () => {
    expect(sealNotice(input('empty'))!.message).toMatch(/not a claim worth making/);
  });

  it('says that nothing was compared, rather than what the comparison found', () => {
    for (const name of ['unknownKey', 'badAlgorithm'] as const) {
      const notice = sealNotice(input(name))!;
      expect(notice.tone, name).not.toBe('danger');
      expect(notice.title, name).toBe('This version cannot check the seal');
      expect(notice.message, name).toMatch(/Nothing was compared/);
      expect(notice.message, name).toMatch(/has not been judged either way/);
      // The specifics come from `describeBreak`, so a reader is told which key or which
      // scheme rather than that something unnamed went unread.
      expect(notice.message, name).toMatch(name === 'unknownKey' ? /"v99"/ : /"ed25519-v2"/);
      expect(notice.message, name).not.toMatch(/is not that one|was changed after sealing/);
    }
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

  it('offers a button only where a signer can be reached', () => {
    // One sealable case, three availability answers. This is the defect in one assertion:
    // `no-service` used to return 'Seal this record' and render it as the primary action,
    // because the input it was given said "server-backed" and meant "stored on a server".
    expect(sealActionLabel(input('unsealed')), 'available').toBe('Seal this record');
    expect(sealActionLabel(input('deviceOnly')), 'device-only').toBeNull();
    expect(sealActionLabel(input('noService')), 'no-service').toBeNull();
    // Same records in all three, so nothing but the availability moved.
    expect(input('noService').state.sealable).toBe(true);
    expect(input('deviceOnly').state.sealable).toBe(true);
  });

  it('offers nothing where the server would refuse', () => {
    // Each of these is a refusal `sealCase` makes on the server. Showing a button that
    // cannot succeed is worse than showing none: on `altered` it would read as an offer to
    // sign over the alteration.
    for (const name of ['sealed', 'altered', 'truncated', 'unknownKey', 'badAlgorithm', 'mixedBreaks', 'deviceOnly', 'empty'] as const) {
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

describe('sealMismatches and sealUncheckable', () => {
  it('splits "did not check out" from "could not be checked"', () => {
    for (const name of ['unknownKey', 'badAlgorithm'] as const) {
      expect(sealMismatches(input(name).state), name).toEqual([]);
      expect(sealUncheckable(input(name).state).map((item) => item.kind), name).toEqual([
        name === 'unknownKey' ? 'UNKNOWN_KEY' : 'UNSUPPORTED_ALGORITHM',
      ]);
    }
    for (const name of ['altered', 'truncated'] as const) {
      expect(sealUncheckable(input(name).state), name).toEqual([]);
      expect(sealMismatches(input(name).state).length, name).toBeGreaterThan(0);
    }
  });

  it('partitions the faults rather than filtering them', () => {
    // Every fault lands in exactly one of the two. A kind that fell through both would be
    // dropped from the copy silently, which is the failure mode a `SealBreak` added later is
    // most likely to produce.
    for (const name of Object.keys(STATES) as Array<keyof typeof STATES>) {
      const { state } = input(name);
      expect(
        [...sealMismatches(state), ...sealUncheckable(state)].map((item) => item.kind).sort(),
        name,
      ).toEqual(sealFaults(state).map((item) => item.kind).sort());
    }
    expect(sealFaults(input('mixedBreaks').state).length).toBe(2);
  });

  it('is what the copy actually calls', () => {
    // The finding this fix closes was not a wrong helper; it was two correct helpers with no
    // callers, written against the same bug and never wired in. A screen state is the only
    // proof that they are reachable.
    expect(sealHeadline(input('unknownKey')).tone).not.toBe(sealHeadline(input('altered')).tone);
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
      { kind: 'UNSUPPORTED_ALGORITHM', sealId: 'seal_copy', algorithm: 'ed25519-v2' },
      { kind: 'SEAL_FOREIGN', sealId: 'seal_copy', sealed: 'case_a', found: 'case_b' },
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

  it('sweeps every availability answer, not just the ones that existed first', () => {
    // A sweep that enumerates states by hand goes stale the moment a branch is added, and the
    // branch that was added here is a whole new message. So: every value `SealAvailability`
    // can take has at least one entry in `STATES`, and the new state's own message is in the
    // swept set rather than merely adjacent to it.
    const covered = new Set<SealAvailability>(Object.values(STATES).map((entry) => entry.availability));
    const all: SealAvailability[] = ['available', 'device-only', 'no-service'];
    expect(all.filter((value) => !covered.has(value))).toEqual([]);

    const strings = allCopy();
    expect(strings).toContain(sealNotice(input('noService'))!.message);
    expect(strings).toContain(sealNotice(input('deviceOnly'))!.message);
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
