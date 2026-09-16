/**
 * How long a reader still has to approach the forum their letter is addressed to.
 *
 * Every redressal scheme in this app's four sectors closes its door after a stated period. The
 * escalation module already computes the *other* side of that window — the reply period an
 * organisation gets before a silence is worth mentioning — and the filing draft writes a letter
 * on the strength of it. Neither of them looks at the far end. So a case can produce a complete,
 * well-cited letter addressed to an Ombudsman who is required to reject it as out of time, and
 * nothing on the screen says so.
 *
 * That is the failure this module exists to prevent, and it is worse than a missing feature:
 * the app spent the user's afternoon drafting something, printed a scheme citation beside it,
 * and never mentioned the one fact that decided the outcome.
 *
 * ## What this is not
 *
 * This is arithmetic over dates the user can see, against a published number quoted with its
 * clause. It is not legal advice, and three deliberate restraints keep it from drifting into
 * looking like advice:
 *
 * 1. **Nothing here is described as expired.** A closed window is reported as `CLOSED`, and the
 *    copy beside it says what is still available: condonation where the scheme provides for it,
 *    and the consumer route where it does not. Whether delay can be forgiven is a per-scheme
 *    fact, not a general one — the RBI scheme attaches no condonation power to its
 *    maintainability bar, while the insurance rules and the Consumer Protection Act both do.
 *    Assuming the generous case everywhere would send a banking complainant to argue for an
 *    indulgence the Ombudsman cannot grant, while their consumer-route clock ran down.
 * 2. **Every number carries its clause.** `provision` is never blank, and the UI shows it with
 *    the number, on the same principle as {@link ForumProfile.scheme}.
 * 3. **Silence when unsure.** A forum whose limitation trigger this app cannot determine
 *    returns `UNKNOWN` with a reason, not a guess. `UNKNOWN` is a real answer here — "check
 *    this yourself, and here is what to check" is useful, and a wrong deadline is not.
 *
 * @see escalation.ts — the reply window at the near end of the same clock
 * @see filing-draft.ts — the letter this window is reported beside
 */

import type { NormalizedDate } from '../normalize/dates';
import { daysBetween, formatDate } from '../normalize/dates';
import type { ForumProfile, NowDate, RedressalForum } from './escalation';
import { nowAsDate } from './escalation';

// ---------------------------------------------------------------------------
// The windows
// ---------------------------------------------------------------------------

/**
 * Where a complaint sits relative to its forum's limitation period.
 *
 * `CLOSING` exists because a window with three weeks left and one with eleven months left are
 * not the same situation, and a single boolean would render them identically. The threshold is
 * a display concern — nothing in any scheme says 60 days is special — so it lives here beside
 * the type it grades rather than in the UI, where two screens would drift apart.
 */
export type LimitationState = 'OPEN' | 'CLOSING' | 'CLOSED' | 'UNKNOWN';

/** Days remaining at or below which a window is reported as closing rather than open. */
const CLOSING_SOON_DAYS = 60;

/**
 * A scheme's limitation rule, as published.
 *
 * `days` is the whole period from the trigger, already including any waiting period the scheme
 * folds in. The RBI scheme is the reason this is a single number rather than a base plus an
 * offset: its clause states "one year and 30 days" as one quantity measured from the date of
 * the complaint, and splitting that into arithmetic this module performs would make the number
 * shown on screen something this app computed rather than something it quoted.
 */
interface LimitationRule {
  /** Whole days from the trigger date, as the clause states them. */
  days: number;
  /** The clause, rule or section. Shown with the number, never without it. */
  provision: string;
  /** What the clock runs from, in the reader's words. */
  runsFrom: string;
  /**
   * The provision under which the forum may still hear a late complaint, or `null` where the
   * scheme gives it no such power.
   *
   * Nullable because the RBI scheme is exactly that case, and it is the one that made this
   * field worth getting right. Clause 10(2)(a)(ii) is a maintainability condition with no
   * condonation attached — the Ombudsman cannot waive it. A default of "some forum can always
   * be persuaded" would have told a user with a two-year-old banking complaint to go and ask
   * anyway, which wastes the months they have left for the route that would still hear them.
   */
  condonation: string | null;
  /**
   * What is actually still available once the window has passed.
   *
   * Every scheme needs its own sentence here. Where delay can be condoned, this says so; where
   * it cannot, this names the separate ladder that is still open rather than leaving the reader
   * with a dead end. Consumer commissions hear disputes from every sector on their own two-year
   * clock, which is why a closed banking window is not the end of the matter.
   */
  whenClosed: string;
}

/**
 * The published limitation windows, one per ladder.
 *
 * Each entry is a quotation. The `days` figures are the schemes' own periods expressed in days
 * so that {@link daysBetween} can work with them; a year is taken as 365 days, which is the
 * approximation this module makes and the reason {@link LimitationWindow.approximate} exists
 * to disclose it. A window that lands within a day or two of its edge should be checked against
 * the scheme, and the copy says so.
 *
 * TELECOM is absent by design — see {@link TELECOM_UNCERTAINTY}.
 */
const LIMITATION_RULES: Partial<Record<RedressalForum, LimitationRule>> = {
  BANKING: {
    // Clause 10(2)(a)(ii): "within one year and 30 days from the date of the complaint" where
    // no reply is received. This module only ever computes the no-reply branch, because
    // `longestSilence` returns nothing when the case holds anything dated after the complaint —
    // so the "one year from the reply" branch is unreachable from here and is not modelled.
    days: 395,
    provision: "Clause 10(2)(a)(ii) of the Reserve Bank's Integrated Ombudsman Scheme, 2021",
    runsFrom: 'the date you complained to the bank or payments provider',
    // The scheme attaches no condonation power to this bar. Clause 17's 30-day extension is for
    // appeals against an Award, which is a different thing at a different stage.
    condonation: null,
    whenClosed:
      'The Ombudsman is not given power to overlook this particular time limit. A consumer commission works to its own two-year limit under the Consumer Protection Act, 2019 and hears banking disputes, so that route may still be open.',
  },
  INSURANCE: {
    // Rule 14(3)(b)(iii): one year from the expiry of one month from the date the written
    // representation was *sent* — not received, which is where this differs from the RBI
    // scheme. One month is taken as 30 days, matching the reply window quoted elsewhere.
    days: 395,
    provision: 'Rule 14(3) of the Insurance Ombudsman Rules, 2017',
    runsFrom: 'a month after the date you sent your representation to the insurer',
    condonation: 'Rule 14(4), under which the Ombudsman may condone the delay',
    whenClosed:
      'Under Rule 14(4) the Ombudsman may condone the delay, after asking the insurer for its objections and recording reasons.',
  },
  CONSUMER: {
    // Section 69(1): two years from the date on which the cause of action arose. The cause of
    // action is a question of fact this app cannot settle, so the complaint date stands in for
    // it and `anchorIsAssumed` says so. It is the conservative direction: the cause of action
    // generally arises no later than the complaint about it, so measuring from the complaint
    // reports *more* time remaining than measuring from the underlying event — never less.
    days: 730,
    provision: 'Section 69(1) of the Consumer Protection Act, 2019',
    runsFrom: 'the date the cause of action arose',
    condonation: 'Section 69(2), on showing sufficient cause for the delay',
    whenClosed:
      'Under Section 69(2) a Commission may still admit a complaint if you show sufficient cause for the delay, and it must record its reasons for doing so.',
  },
};

/**
 * Why the telecom ladder reports `UNKNOWN`.
 *
 * Regulation 9(3) of TRAI's 2012 redressal regulations gives thirty days to appeal to the
 * Appellate Authority — but it runs from the expiry of the period in Regulation 8, and
 * Regulation 8 does not state one. It defers to the Quality of Service regulations, which set
 * different periods for different complaint types, and only falls back to three days where
 * those are silent. So the trigger is a per-complaint-type date held in a separate instrument
 * and not present in any document this app holds.
 *
 * Reporting thirty days from the complaint would be arithmetic from the wrong day. Reporting
 * three months would be worse: that figure is the outer limit for a *condoned* late appeal,
 * not the ordinary window, and quoting it as the deadline would tell someone they had three
 * times the time they actually have as of right.
 */
const TELECOM_UNCERTAINTY =
  'The appeal window is thirty days, but it runs from your provider’s own deadline for resolving the original complaint — which depends on the type of complaint and is not stated in your documents.';

/** What a telecom user can do instead of being given a date this app cannot compute. */
const TELECOM_GUIDANCE =
  'Ask your provider when the complaint was closed or was due to be resolved, and count thirty days from there. An Appellate Authority can allow a late appeal up to three months from that same date, on sufficient cause.';

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export interface LimitationWindow {
  state: LimitationState;
  /** The forum this window belongs to, so a caller cannot pair it with the wrong letter. */
  forum: RedressalForum;
  /**
   * Days left before the window closes. Negative once it has closed, `null` when unknown.
   *
   * Signed rather than clamped: "closed 533 days ago" is a materially different situation from
   * "closed yesterday", and a caller that clamped at zero could not tell them apart.
   */
  daysRemaining: number | null;
  /** The last day the forum is generally required to entertain it, rendered for display. */
  closesOn: string | null;
  /** The clause this window comes from, or `null` when the state is `UNKNOWN`. */
  provision: string | null;
  /** What the clock runs from, in the reader's words. */
  runsFrom: string | null;
  /**
   * The provision under which a late complaint may still be heard, or `null` where the scheme
   * gives the forum no power to overlook the limit.
   */
  condonation: string | null;
  /**
   * What remains available once the window has passed — condonation where the scheme allows
   * it, and otherwise the other ladder that is still open. Never an empty string for a known
   * forum, so the closed state always has something to offer.
   */
  whenClosed: string | null;
  /**
   * Set when the window was measured from the complaint date standing in for a trigger the
   * scheme defines differently — currently the consumer route's cause of action.
   */
  anchorIsAssumed: boolean;
  /** Set when a year was taken as 365 days, so a reader near the edge knows to check. */
  approximate: boolean;
  /** Why the window is unknown. Present only when the state is `UNKNOWN`. */
  unknownBecause: string | null;
}

/**
 * The limitation window for a complaint, measured from its own date.
 *
 * `complaintDate` must be the DAY-precision date the escalation module anchored on — the same
 * one the letter prints — so that the two numbers on screen are measured from the same day. A
 * coarser date yields `UNKNOWN`: a complaint known only to the month could close anywhere in a
 * 31-day range, and the whole point of the figure is that the reader can check it.
 */
export function limitationWindow(
  forum: ForumProfile,
  complaintDate: NormalizedDate,
  now: NowDate,
): LimitationWindow {
  const base = {
    forum: forum.forum,
    daysRemaining: null,
    closesOn: null,
    provision: null,
    runsFrom: null,
    condonation: null,
    whenClosed: null,
    anchorIsAssumed: false,
    approximate: false,
    unknownBecause: null,
  };

  const rule = LIMITATION_RULES[forum.forum];
  if (!rule) {
    return {
      ...base,
      state: 'UNKNOWN',
      unknownBecause: TELECOM_UNCERTAINTY,
      whenClosed: TELECOM_GUIDANCE,
    };
  }

  const known = {
    provision: rule.provision,
    runsFrom: rule.runsFrom,
    condonation: rule.condonation,
    whenClosed: rule.whenClosed,
  };

  const elapsed = daysBetween(complaintDate, nowAsDate(now));
  if (elapsed === null) {
    return {
      ...base,
      ...known,
      state: 'UNKNOWN',
      unknownBecause:
        'The complaint is not dated to a particular day, so there is no day to count from.',
    };
  }

  // A complaint dated in the future is a typo or a clock skew, not a window. Reported as
  // unknown rather than as a very wide window, on the same reasoning `longestSilence` uses
  // when it declines to speak about a negative elapsed count.
  if (elapsed < 0) {
    return {
      ...base,
      ...known,
      state: 'UNKNOWN',
      unknownBecause: 'The complaint is dated in the future, so the date needs correcting first.',
    };
  }

  const daysRemaining = rule.days - elapsed;
  const state: LimitationState =
    daysRemaining < 0 ? 'CLOSED' : daysRemaining <= CLOSING_SOON_DAYS ? 'CLOSING' : 'OPEN';

  return {
    ...base,
    ...known,
    state,
    daysRemaining,
    closesOn: formatDate(addDays(complaintDate, rule.days)),
    anchorIsAssumed: forum.forum === 'CONSUMER',
    approximate: true,
  };
}

/**
 * A day-precision date `days` after `from`.
 *
 * Kept local rather than added to the date helpers: this is the only caller, and the helpers
 * module is shared by the extraction path where a date-producing function that invents a date
 * no document contains would be a hazard.
 */
function addDays(from: NormalizedDate, days: number): NormalizedDate {
  const parsed = Date.parse(`${from.iso}T00:00:00Z`);
  const moved = new Date(parsed + days * 86_400_000);
  const iso = `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`;
  return { original: iso, iso, precision: 'DAY', ambiguous: false };
}

/**
 * One sentence stating where the window stands, for the line directly under the letter's
 * heading.
 *
 * The wording is the careful part. A closed window never says the claim is finished: it states
 * the date and then hands over to `whenClosed`, which is the scheme's own answer — condonation
 * where the rules allow it, and the consumer route where they do not. What it must never do is
 * assert that some forum will hear a late complaint as a general truth, because under the RBI
 * scheme that is not so, and a reader who is told to go and ask anyway spends months on a door
 * that is required to stay shut instead of the one that is open.
 */
export function describeLimitation(window: LimitationWindow): string {
  switch (window.state) {
    case 'UNKNOWN':
      return (
        window.unknownBecause ??
        'This scheme’s time limit could not be worked out from your documents.'
      );
    case 'CLOSED': {
      const late = Math.abs(window.daysRemaining ?? 0);
      const opening = `The usual window for this route closed about ${late} ${late === 1 ? 'day' : 'days'} ago, on ${window.closesOn}.`;
      return window.whenClosed ? `${opening} ${window.whenClosed}` : opening;
    }
    case 'CLOSING':
      return `About ${window.daysRemaining} ${window.daysRemaining === 1 ? 'day' : 'days'} left before the usual window closes on ${window.closesOn}.`;
    case 'OPEN':
      return `The usual window for this route runs to about ${window.closesOn}.`;
  }
}
