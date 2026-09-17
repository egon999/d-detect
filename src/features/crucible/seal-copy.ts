/**
 * Every sentence the seal ribbon shows, in one file with no React in it.
 *
 * Separated from the component for one reason: §9 of the Crucible concept is a list of things
 * this product must never say, and a rule about wording is only real if it can be tested.
 * Here the copy is a pure function of the sealing state, so `tests/crucible-seal-copy.test.ts`
 * can enumerate every state, read every string, and fail the build if a forbidden word ever
 * reappears in one. Left inline in the `.tsx` the same strings would be unreachable from a
 * Node test — importing the component pulls in the whole Expo native runtime.
 *
 * ## The vocabulary this file is required to keep
 *
 * A seal is **server-sealed**, **tamper-evident**, and an **existence proof** over the entries
 * it covers. It is never *tamper-proof* (it reveals an edit, it does not prevent one), never
 * *immutable* (the records are plainly mutable — that is the entire premise), never
 * *blockchain*-anything, and never *verified* without saying verified against what. A missing
 * or failing seal is reported as the specific thing that does not line up, never as an
 * accusation: this app knows that a digest differs, and does not know who changed it or why.
 *
 * ## Which key signed is part of the claim, not a detail
 *
 * `server-sealed` is a claim about independence — that the signature could not have been made
 * on the device holding the records — and it is only true of a key whose private half lives on
 * a deployed server. `@domain/crucible/keys` maintains a second family for exactly this reason:
 * the self-hosted signer in `functions/local-server.js` often runs on the same machine as the
 * app, so it signs with `dev1` instead, and the id travels on the seal into every export.
 *
 * So the wording here turns on `latest.keyId`. A development seal is not a fault and is never
 * rendered as one — the signature is correct, and it still breaks on any later edit — but it
 * does not get the green chip or the word *server*, because those assert the one thing it
 * cannot. Saying otherwise would manufacture the exact claim the split key registry exists to
 * avoid manufacturing, and it would do it in the app's own voice.
 */

import type { CaseSealState } from '@domain/crucible/case-seal-state';
// The one runtime import here, and it earns its place. `keys.ts` separates production from
// development signing ids precisely so the copy can tell a reader which one signed, and says
// so in its own doc; until this import existed the separation was carried on every seal and
// read by nothing.
import { isDevelopmentSealKey } from '@domain/crucible/keys';
import type { SealBreak } from '@domain/crucible/seal';
// Both type-only, so this stays a plain module a Node test can import: `@ui/icon` pulls in
// the native icon font at runtime, and a `import type` is erased before that can happen.
import type { IconName } from '@ui/icon';
import type { Tone } from '@ui/tokens';
// Same discipline, same reason. `@services/crucible/request-seal` reaches Firebase and the
// platform API at runtime; only the name of its three-state answer is wanted here.
import type { SealAvailability } from '@services/crucible/request-seal';

/** The one-line answer, and the chip beside it. */
export interface SealHeadline {
  tone: Tone;
  chip: string;
  sentence: string;
}

/** A bordered explanation under the headline, or `null` when the state needs none. */
export interface SealNotice {
  tone: Tone;
  icon: IconName;
  title: string;
  message: string;
}

/** What the ribbon needs to know, as little of it as possible. */
export interface SealCopyInput {
  state: CaseSealState;
  /**
   * Whether a signer can be reached, which is not the same as where the case is stored.
   *
   * This was `serverBacked: boolean`, and the boolean was the defect. It answered the storage
   * question, so a Firebase workspace — records on a server, no `sealCase` deployed in front
   * of them — read as sealable and got an enabled button that could only ever fail. Three
   * states, because the two unsealable ones need different sentences: one case has never left
   * the device, the other is on a server with nothing to sign it.
   */
  availability: SealAvailability;
}

/**
 * The three things a seal is not, in the order a reader needs to hear them.
 *
 * One copy, shared by both sealed notices, because this sentence is the part §9 of the concept
 * actually governs. Written out twice it would drift: a correction to the production wording
 * would leave the development notice quietly saying last month's version of the caveat, and the
 * vocabulary sweep would pass both because each is separately clean.
 *
 * It is a constant rather than a branch because it is true of every seal this app can make. Key
 * family, transport and coverage all change what a seal establishes; none of them change these.
 */
const SEAL_LIMITS =
  'It is tamper-evident — it reveals an edit rather than preventing one. It says nothing about whether the records are true, and it is not a legal attestation.';

/**
 * Breaks worth showing a reader.
 *
 * `NOT_SEALED` is filtered out: the absence of a seal is reported by the headline, and listing
 * it as a fault would present "nobody has signed this yet" as though something were wrong
 * with the record.
 */
export function sealFaults(state: CaseSealState): SealBreak[] {
  return state.verification.breaks.filter((item) => item.kind !== 'NOT_SEALED');
}

/**
 * Breaks that mean *this build could not check*, as distinct from *this did not check out*.
 *
 * The distinction the copy layer kept losing. An app too old to hold the key that signed a
 * seal, or too old to run the scheme it was signed with, has compared nothing — so every
 * sentence about the record matching or not matching is one it has no standing to write.
 * `describeBreak` has always said this correctly for `UNKNOWN_KEY`; the headline above it
 * said "A seal on this record no longer matches its history" anyway, which is a verdict
 * reached without a comparison, reachable by ordinary key rotation on an older build.
 *
 * Kept as a list of kinds rather than a flag on the break, because the question "can this
 * verifier check this seal" belongs to the verifier, not to the seal.
 */
const UNCHECKABLE: ReadonlySet<SealBreak['kind']> = new Set(['UNKNOWN_KEY', 'UNSUPPORTED_ALGORITHM']);

/** Faults where something was compared and did not agree. These are the ones worth alarm. */
export function sealMismatches(state: CaseSealState): SealBreak[] {
  return sealFaults(state).filter((item) => !UNCHECKABLE.has(item.kind));
}

/** Faults where nothing was compared, because this build lacks what the check needs. */
export function sealUncheckable(state: CaseSealState): SealBreak[] {
  return sealFaults(state).filter((item) => UNCHECKABLE.has(item.kind));
}

/**
 * What a single break means, in a sentence a reader can act on.
 *
 * Each names the specific thing that does not line up, because "verification failed" tells a
 * user nothing they can check and nothing they can fix. `ENTRY_ALTERED` names the entry —
 * that is the whole reason `verifySealedHistory` bothers to localise it. None of these
 * sentences says who did anything.
 */
export function describeBreak(item: SealBreak): string {
  switch (item.kind) {
    case 'NOT_SEALED':
      return 'Nothing has signed this history yet.';
    case 'UNKNOWN_KEY':
      // Explicitly *not* reported as a failure. An app too old to hold the key that signed a
      // seal cannot check it, which is a different fact from the seal being wrong, and
      // collapsing the two would accuse a valid record on the strength of an outdated build.
      return `A seal on this record was made with key "${item.keyId}", which this version of the app does not hold, so it cannot be checked here. That is not the same as it being wrong. Updating the app may add the key.`;
    case 'UNSUPPORTED_ALGORITHM':
      // The same fact one level down. A seal naming a signature scheme this build cannot run
      // used to fall through to `BAD_SIGNATURE`, which told the reader the signature did not
      // match contents that nothing had ever compared it against.
      return `A seal on this record names the signature scheme "${item.algorithm}", which this version of the app cannot run, so it cannot be checked here. That is not the same as it being wrong. Updating the app may add the scheme.`;
    case 'SEAL_FOREIGN':
      // Stated as what it is — a seal about a different record — without guessing how it got
      // here. A copied case and a mis-filed seal look identical from this side.
      return `A seal filed with this case names case "${item.sealed}", not "${item.found}", so it is not a signature over this history at all.`;
    case 'BAD_SIGNATURE':
      return 'A seal on this record carries a signature that does not match its own contents.';
    case 'LADDER_BROKEN':
      return 'A later seal does not point at the seal before it, so the sequence of seals is incomplete.';
    case 'ENTRIES_MISSING':
      return `A seal covers ${item.sealed} ${item.sealed === 1 ? 'entry' : 'entries'} and only ${item.found} ${item.found === 1 ? 'is' : 'are'} present, so ${item.sealed - item.found} ${item.sealed - item.found === 1 ? 'has' : 'have'} been removed since it was made.`;
    case 'ENTRY_ALTERED':
      return `Entry ${item.entryId ?? `#${item.index + 1}`}, at position ${item.index + 1} in the history, is not the one that was sealed.`;
    case 'HEAD_MISMATCH':
      return 'The history does not add up to what was sealed, so something in it has changed since. Which entry cannot be identified from this copy alone.';
  }
}

/**
 * The headline and chip.
 *
 * Ordered by what a reader most needs to know: a mismatch outranks everything, then a seal
 * this build cannot check at all, then coverage, then the absence of a seal. The second rung
 * is the one that was missing, and its absence cost the file both ways at once - an
 * unknown-key seal took the danger chip for a comparison nothing had made, and would have
 * taken the green one the moment that fault was merely filtered out. `ok` is reserved for a signature that actually checked out —
 * never for the mere existence of a seal, which is the reading a hostile counterparty would
 * be right to reject.
 */
export function sealHeadline({ state, availability }: SealCopyInput): SealHeadline {
  const { latest, unsealedEntries, chain } = state;
  const mismatches = sealMismatches(state);
  const uncheckable = sealUncheckable(state);

  if (mismatches.length > 0) {
    return {
      tone: 'danger',
      chip: 'Does not match',
      sentence: 'A seal on this record no longer matches its history.',
    };
  }
  // Second, not first, and the order is load-bearing in both directions.
  //
  // A real mismatch outranks an uncheckable seal, because a case can hold both and burying
  // "this does not add up" under "this build is too old" would lose the one fact the reader
  // has to act on. But this branch has to come before the two below, because `latest` is set
  // for an unknown-key seal exactly as it is for a good one: without it a seal that nothing
  // compared falls straight into the green `Server-sealed` branch, which is the same overclaim
  // as the danger chip was, pointing the other way.
  //
  // `info` rather than `warn`. Nothing is wrong here and nothing needs attention — a key
  // rotation the reader had no part in produces this, and the remedy, if there is one, is an
  // app update rather than anything about their record.
  if (uncheckable.length > 0) {
    const n = uncheckable.length;
    return {
      tone: 'info',
      chip: 'Cannot be checked',
      sentence: `${n === 1 ? 'A seal on this record cannot' : `${n} seals on this record cannot`} be checked by this version of the app, so nothing has been compared.`,
    };
  }
  if (latest && unsealedEntries === 0) {
    // `chain.length` is not the covered count and saying it is would be the exact overclaim
    // this file exists to prevent: the `SEAL_CREATED` entry is recorded *after* the head it
    // announces, so it can never be inside the thing it records. Reading this on a screen made
    // it obvious — the headline said all 4 entries were covered while the detail line directly
    // beneath it said the seal covers 3. So the sentence states the covered figure, and then
    // says what the remainder is, because a reader who can count to four deserves the
    // difference explained rather than papered over.
    const covered = latest.entryCount;
    const since = chain.length - covered;
    // Read off the key the seal carries, never off how the request was made. The id is the
    // only part of this that survives into an export a stranger opens, which is exactly why
    // `keys.ts` puts the distinction in the registry rather than behind an environment flag.
    //
    // `ok` is withheld from a development seal, and the demotion is the point rather than a
    // side effect. A green "Server-sealed" chip asserts an independent signer; `dev1` is
    // defined as a key whose private half no deployed server holds, so the signature may have
    // been made by the same machine that produced the records. The signature is still correct
    // — this is not a fault and must never read as one — it simply attests to less, so it gets
    // the tone for "true, and here is what it means" rather than the one for "checked out".
    const development = isDevelopmentSealKey(latest.keyId);
    const signature = development ? 'development-key signature' : 'server signature';
    return {
      tone: development ? 'info' : 'ok',
      chip: development ? 'Development seal' : 'Server-sealed',
      sentence:
        since === 0
          ? `All ${covered} recorded ${covered === 1 ? 'entry is' : 'entries are'} covered by a ${signature}.`
          : `A ${signature} covers ${covered === 1 ? 'the entry' : `the ${covered} entries`} recorded before it; ${since === 1 ? 'the one entry since is the record of the sealing itself' : `the ${since} entries since only record sealing`}.`,
    };
  }
  if (latest) {
    return {
      tone: 'info',
      chip: `Sealed to ${latest.entryCount}`,
      sentence: `${unsealedEntries} ${unsealedEntries === 1 ? 'entry has' : 'entries have'} been recorded since the last seal, and no signature covers ${unsealedEntries === 1 ? 'it' : 'them'} yet.`,
    };
  }
  // No new branch for `no-service`, and that is a decision rather than an oversight. The
  // sentence below is about what has vouched for the history, not about where the history is
  // kept, and "nothing" is exactly as true for a Firestore case with no signer deployed as it
  // is for one that never left the phone: storage is not vouching. The alternative sentence —
  // "A server can sign this history" — is the one that would be false, because in this build
  // none can, and it is reserved for `available` accordingly. The notice underneath is where
  // the two states stop sounding alike; it says which of them the reader is in.
  if (availability !== 'available' || chain.head === null) {
    return {
      tone: 'neutral',
      chip: 'Not sealed',
      sentence: 'Nothing outside this device has vouched for this history.',
    };
  }
  return {
    tone: 'neutral',
    chip: 'Not sealed',
    sentence: 'A server can sign this history, producing a timestamped record that it existed in this exact order.',
  };
}

/**
 * The explanation under the headline.
 *
 * At most one, and never none where the state needs qualifying. A sealed record gets the
 * limitation note *because* it is the good case: a green chip with no caveat is how a reader
 * ends up believing the seal says more than it does.
 */
export function sealNotice({ state, availability }: SealCopyInput): SealNotice | null {
  const { latest, chain } = state;
  const mismatches = sealMismatches(state);
  const uncheckable = sealUncheckable(state);

  if (mismatches.length > 0) {
    // An uncheckable seal alongside a real mismatch is described *after* the verdict, not
    // folded into the list before it. "A seal is a signature over one specific history, and
    // this is not that one" is a claim about the sentences it follows, and a seal nothing
    // compared cannot be one of them. Each `describeBreak` sentence for an uncheckable kind
    // disclaims wrongness in its own words, so it survives the move intact — and dropping
    // them instead would be the other way to get this wrong, silently narrowing the notice to
    // the faults that happen to fit its title.
    const aside = uncheckable.length > 0 ? ` ${uncheckable.map(describeBreak).join(' ')}` : '';
    return {
      tone: 'danger',
      icon: 'alert-circle-outline',
      title: mismatches.length === 1 ? 'The seal does not match this history' : 'The seals do not match this history',
      message: `${mismatches.map(describeBreak).join(' ')} A seal is a signature over one specific history, and this is not that one. That can mean a record was changed after sealing, or that this copy of the case is incomplete. On its own it is not evidence of who changed it, or why.${aside}`,
    };
  }
  if (uncheckable.length > 0) {
    // The absence of a finding, stated as plainly as a finding would be. `describeBreak`
    // already names the key or the scheme and says an update may add it; the sentence after
    // it adds the one thing a per-break description cannot say, which is that the app has not
    // judged the record either way — precisely what the headline above used to assert it had.
    return {
      tone: 'info',
      icon: 'help-circle-outline',
      title: uncheckable.length === 1 ? 'This version cannot check the seal' : 'This version cannot check these seals',
      message: `${uncheckable.map(describeBreak).join(' ')} Nothing was compared, so nothing here is a finding about the record: the history on this device has not been judged either way.`,
    };
  }
  if (latest) {
    const n = latest.entryCount;
    const entries = `${n} ${n === 1 ? 'entry' : 'entries'}`;
    const them = n === 1 ? 'it' : 'them';

    if (isDevelopmentSealKey(latest.keyId)) {
      // The notice `keys.ts` said already existed. It does not exist yet at the time of
      // writing, which is the whole defect: the registry separates the two key families so
      // that "the copy reads it and says what such a seal does and does not establish", and
      // the copy read nothing. A `dev1` seal was described in the production words — "a key
      // held on the server, not on this device" — whose second clause is precisely backwards
      // for a signer that may be this very machine.
      //
      // The order of the message is the order a reader needs it in: what is weaker, why, and
      // then — at equal length, because this is the part that stays true — what is not
      // weakened at all. A development key loses independence and keeps tamper-evidence
      // entirely: the check still fails on any later edit, because that property comes from
      // the signature covering the chain and not from who holds the key.
      //
      // The id is quoted rather than described, because the id is what travels into an export
      // and what a stranger's verifier will report back.
      return {
        tone: 'info',
        icon: 'flask-outline',
        title: 'Signed by a development key',
        message: `This seal was made with "${latest.keyId}", a development key whose private half is not held by a deployed server — it can have been produced on the same machine as these records. So it is not evidence that this history existed anywhere but here. What it does establish is unaffected: the signature checks out against the public key published in this build, so ${entries} existed, in this order, by the time shown above, and any later change to ${them} breaks the check. ${SEAL_LIMITS}`,
      };
    }

    return {
      tone: 'neutral',
      icon: 'information-outline',
      title: 'What the seal establishes',
      message: `The signature was made with a key held on the server, not on this device, and it checks out against the public key published in this build. That makes it an existence proof: ${entries} existed, in this order, by the time shown above, and any later change to ${them} breaks the check. ${SEAL_LIMITS}`,
    };
  }
  if (availability === 'device-only') {
    // Bound to `device-only` alone, and it has to be. Shown to a signed-in Firebase user it
    // would state two things that are false — that the case is on this phone only, and that
    // syncing it would make sealing possible — and the second is advice the reader cannot act
    // on, which is worse than saying nothing.
    return {
      tone: 'neutral',
      icon: 'cloud-off-outline',
      title: 'Not available for this case',
      message: 'This case is stored only on this device. Sealing means a server reading the record and signing it with a key this device does not hold, so there is nothing here for it to sign. Signing in and syncing the case makes sealing available.',
    };
  }
  if (availability === 'no-service') {
    // The state the ribbon had no words for, which is why it borrowed the device-only ones.
    // In order of what a reader needs: what sealing would be, why none is possible here, and
    // that this is a fact about the build rather than a finding about their record. No
    // sign-in, no sync, no "yet" — there is nothing the reader can do about a missing
    // deployment and no seal on the way, and hinting at either would be this file's
    // characteristic failure.
    //
    // The closing sentence says what they do still have, and only when they have it: it
    // describes the integrity panel directly above this ribbon, in that panel's own term
    // ("internally consistent"), and stops where the panel stops. Omitted for an empty case,
    // where there is no chain on screen and describing one would be inventing a reassurance.
    const check =
      chain.head === null
        ? ''
        : ' The check above is unaffected — the hash chain is recomputed from these entries on this device every time the screen opens, and it shows they are internally consistent with one another and nothing beyond that.';
    return {
      tone: 'neutral',
      icon: 'pen-off',
      title: 'No sealing service in this build',
      message: `Sealing means a server reading this history and signing it with a key this device does not hold. No such server is part of this build, so no signature can be made here — for this case or any other. Nothing is wrong with the record: nothing has read it, and nothing has judged it.${check}`,
    };
  }
  if (chain.head === null) {
    return {
      tone: 'neutral',
      icon: 'information-outline',
      title: 'Nothing recorded yet',
      message: 'There is no history to seal. A signature over an empty record would attest that nothing has happened, which is not a claim worth making.',
    };
  }
  return {
    tone: 'neutral',
    icon: 'information-outline',
    title: 'What sealing does',
    message: 'A server will read this history, recompute its chain and sign the result with a key this device does not hold. The signature is checked here every time the screen opens, so a later change to any covered entry shows up as a mismatch rather than passing unnoticed.',
  };
}

/** The button, or `null` when asking the server now would produce nothing. */
export function sealActionLabel({ state, availability }: SealCopyInput): string | null {
  // `!== 'available'` covers both unsealable states, which is the line that removes the
  // failing button: a Firebase workspace used to pass the old `serverBacked` test and render
  // this as the primary action on every case, where the only thing a tap could produce was a
  // toast. An offer the app knows it cannot honour is not an offer.
  if (availability !== 'available' || !state.sealable) return null;
  if (state.latest === null) return 'Seal this record';
  const n = state.unsealedEntries;
  return `Seal the ${n} new ${n === 1 ? 'entry' : 'entries'}`;
}

/** What the toast says once the server has answered. */
export function sealOutcomeMessage(entryCount: number): string {
  return `A server signed this history, covering ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}.`;
}

/**
 * The reply to a request that changed nothing.
 *
 * Deliberately not phrased as a success. "Sealed" here would be a claim the existing seal's
 * own timestamp contradicts the moment anyone reads it.
 */
export const SEAL_UNCHANGED_MESSAGE =
  'Nothing has changed since the last seal, so no new signature was made.';
