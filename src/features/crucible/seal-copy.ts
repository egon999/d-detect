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
 */

import type { CaseSealState } from '@domain/crucible/case-seal-state';
import type { SealBreak } from '@domain/crucible/seal';
// Both type-only, so this stays a plain module a Node test can import: `@ui/icon` pulls in
// the native icon font at runtime, and a `import type` is erased before that can happen.
import type { IconName } from '@ui/icon';
import type { Tone } from '@ui/tokens';

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
  /** `false` for a device-only session, which has no server to sign anything. */
  serverBacked: boolean;
}

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
 * Ordered by what a reader most needs to know: a break outranks everything, then coverage,
 * then the absence of a seal. `ok` is reserved for a signature that actually checked out —
 * never for the mere existence of a seal, which is the reading a hostile counterparty would
 * be right to reject.
 */
export function sealHeadline({ state, serverBacked }: SealCopyInput): SealHeadline {
  const { latest, unsealedEntries, chain } = state;
  const faults = sealFaults(state);

  if (faults.length > 0) {
    return {
      tone: 'danger',
      chip: 'Does not match',
      sentence: 'A seal on this record no longer matches its history.',
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
    return {
      tone: 'ok',
      chip: 'Server-sealed',
      sentence:
        since === 0
          ? `All ${covered} recorded ${covered === 1 ? 'entry is' : 'entries are'} covered by a server signature.`
          : `A server signature covers ${covered === 1 ? 'the entry' : `the ${covered} entries`} recorded before it; ${since === 1 ? 'the one entry since is the record of the sealing itself' : `the ${since} entries since only record sealing`}.`,
    };
  }
  if (latest) {
    return {
      tone: 'info',
      chip: `Sealed to ${latest.entryCount}`,
      sentence: `${unsealedEntries} ${unsealedEntries === 1 ? 'entry has' : 'entries have'} been recorded since the last seal, and no signature covers ${unsealedEntries === 1 ? 'it' : 'them'} yet.`,
    };
  }
  if (!serverBacked || chain.head === null) {
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
export function sealNotice({ state, serverBacked }: SealCopyInput): SealNotice | null {
  const { latest, chain } = state;
  const faults = sealFaults(state);

  if (faults.length > 0) {
    return {
      tone: 'danger',
      icon: 'alert-circle-outline',
      title: faults.length === 1 ? 'The seal does not match this history' : 'The seals do not match this history',
      message: `${faults.map(describeBreak).join(' ')} A seal is a signature over one specific history, and this is not that one. That can mean a record was changed after sealing, or that this copy of the case is incomplete. On its own it is not evidence of who changed it, or why.`,
    };
  }
  if (latest) {
    const n = latest.entryCount;
    return {
      tone: 'neutral',
      icon: 'information-outline',
      title: 'What the seal establishes',
      message: `The signature was made with a key held on the server, not on this device, and it checks out against the public key published in this build. That makes it an existence proof: ${n} ${n === 1 ? 'entry' : 'entries'} existed, in this order, by the time shown above, and any later change to ${n === 1 ? 'it' : 'them'} breaks the check. It is tamper-evident — it reveals an edit rather than preventing one. It says nothing about whether the records are true, and it is not a legal attestation.`,
    };
  }
  if (!serverBacked) {
    return {
      tone: 'neutral',
      icon: 'cloud-off-outline',
      title: 'Not available for this case',
      message: 'This case is stored only on this device. Sealing means a server reading the record and signing it with a key this device does not hold, so there is nothing here for it to sign. Signing in and syncing the case makes sealing available.',
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
export function sealActionLabel({ state, serverBacked }: SealCopyInput): string | null {
  if (!serverBacked || !state.sealable) return null;
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
