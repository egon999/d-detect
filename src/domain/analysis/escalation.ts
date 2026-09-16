import type { DateField, Evidence, Extraction } from '../models';
import { daysBetween, formatDate, type NormalizedDate } from '../normalize/dates';

/**
 * Redressal-ladder knowledge: what a complaint's silence means, and what usually comes next.
 *
 * ## The problem this exists for
 *
 * The rest of this app reasons about whether a set of documents agrees with itself. That is
 * necessary and it is not sufficient, because the most common way a consumer dispute in
 * India is lost has nothing to do with the evidence. It is lost by *waiting*. Someone
 * complains to their bank, hears nothing, waits, follows up, waits, and by the time anyone
 * tells them there was an ombudsman they could have gone to, the year is gone.
 *
 * Every redressal scheme in this space has the same two-part shape: the organisation gets a
 * period to reply, and if it does not, a named external forum opens up. Both halves are
 * public and written down. Neither is knowable to the person holding the complaint, which is
 * exactly why they are still holding it.
 *
 * ## The line this module will not cross
 *
 * There is a real way to do harm here: state a deadline. "You have 41 days left to file"
 * sounds helpful and is unfalsifiable to the reader, and if the scheme, the sector or the
 * starting date is wrong, it is advice that costs someone their claim.
 *
 * So the split is strict, and it is the whole design:
 *
 * - **Computed, and certain.** Elapsed days between a date in the user's own document and
 *   today. This is arithmetic over a value the user can see, and the finding always shows
 *   both ends so it can be checked.
 * - **Quoted, and attributed.** The reply window and the forum name. These are stated as
 *   what a named scheme generally provides, with the scheme named so the reader can go and
 *   read it, and with an explicit instruction to check the current rules before acting.
 *
 * Nothing here computes a filing deadline, a limitation date, or the time remaining in one.
 * The output is "a next step may be open to you, here is who to ask" — which fails safe: a
 * reader who checks and finds it is not yet open has lost a phone call. The opposite framing,
 * a countdown that is wrong, loses the case.
 *
 * ## Why detection is deliberately shy
 *
 * `detectForum` returns `null` far more readily than `classifyDocumentType` returns
 * "Document". A misrouted sector does not produce a vague finding; it produces a confident
 * pointer to the wrong regulator. Silence is the better failure, so a forum is only named
 * when the document's own words put it in that sector, and the generic consumer route is
 * used when a complaint is clear but its sector is not.
 *
 * Pure: no I/O, no clock, no randomness. `now` arrives as a parameter, exactly as it does
 * for the rule engine.
 */

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

/**
 * Which redressal ladder a complaint sits on.
 *
 * `CONSUMER` is the fallback rather than a detection result: consumer commissions hear
 * disputes from every sector, so a complaint whose sector is unclear still has somewhere to
 * go. The other three are named only when the document says so itself.
 */
export type RedressalForum = 'BANKING' | 'INSURANCE' | 'TELECOM' | 'CONSUMER';

export interface ForumProfile {
  forum: RedressalForum;
  /** How this sector is described to the reader. Lowercase, fits mid-sentence. */
  sector: string;
  /**
   * Days the scheme generally gives the organisation to reply.
   *
   * Quoted from the scheme named in `scheme`, never computed, and never presented as the
   * user's own deadline. Used only to decide when a silence is long enough to mention.
   */
  replyWindowDays: number;
  /** The forum a reader would approach next, named so they can search for it. */
  nextStep: string;
  /** Where the reply window comes from, so the reader can check it rather than trust it. */
  scheme: string;
  /** The official route, when the scheme publishes one. */
  where: string;
}

/**
 * The ladders, as published by each scheme.
 *
 * Every number here is a quotation with a citation beside it, and the UI always shows the
 * citation with the number. These schemes are amended; the copy that carries them says so.
 */
const FORUM_PROFILES: Record<RedressalForum, ForumProfile> = {
  BANKING: {
    forum: 'BANKING',
    sector: 'banking or payments',
    replyWindowDays: 30,
    nextStep: 'the RBI Ombudsman',
    scheme: "the Reserve Bank's Integrated Ombudsman Scheme, 2021",
    where: 'cms.rbi.org.in, or the RBI contact centre on 14448',
  },
  INSURANCE: {
    forum: 'INSURANCE',
    sector: 'insurance',
    replyWindowDays: 30,
    nextStep: 'the Insurance Ombudsman',
    scheme: 'the Insurance Ombudsman Rules, 2017',
    where: 'cioins.co.in, or the IRDAI grievance portal at bimabharosa.irdai.gov.in',
  },
  TELECOM: {
    forum: 'TELECOM',
    sector: 'telecom or broadband',
    replyWindowDays: 30,
    nextStep: "the provider's Appellate Authority",
    scheme: "TRAI's consumer complaint redressal regulations",
    where: "the Appellate Authority details published on your provider's own website",
  },
  CONSUMER: {
    forum: 'CONSUMER',
    sector: 'consumer',
    replyWindowDays: 30,
    nextStep: 'a District Consumer Disputes Redressal Commission',
    scheme: 'the Consumer Protection Act, 2019',
    where: 'e-daakhil.nic.in, or the District Commission for your area',
  },
};

export function forumProfile(forum: RedressalForum): ForumProfile {
  return FORUM_PROFILES[forum];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Words that place a document in a sector.
 *
 * Each list is deliberately made of terms that are near-useless outside their sector. "IFSC"
 * and "UPI" appear in banking documents and almost nowhere else; "policy" alone would have
 * matched every privacy notice and terms page ever written, so insurance is keyed on
 * "policy number", "premium" and "sum assured" instead. Two independent hits are required
 * below, which is what stops a single stray word from routing someone to a regulator who
 * does not handle their sector.
 */
const SECTOR_SIGNALS: Record<Exclude<RedressalForum, 'CONSUMER'>, RegExp[]> = {
  BANKING: [
    /\bifsc\b/i,
    /\b(?:neft|imps|rtgs|upi)\b/i,
    /\b(?:savings|current)\s+account\b/i,
    /\baccount\s*(?:no\.?|number)\b/i,
    /\b(?:debit|credit)\s+card\b/i,
    /\b(?:utr|transaction\s+reference)\b/i,
    /\b(?:bank|banking)\s+(?:statement|ombudsman|branch)\b/i,
    /\b(?:phonepe|paytm|google\s*pay|gpay|bhim)\b/i,
  ],
  INSURANCE: [
    /\bpolicy\s*(?:no\.?|number)\b/i,
    /\b(?:premium|sum\s+assured|sum\s+insured)\b/i,
    /\b(?:claim\s+(?:no\.?|number|rejected|repudiat)|repudiation)\w*/i,
    /\b(?:insurer|insurance\s+company|irdai|policyholder)\b/i,
    /\b(?:mediclaim|third[- ]party\s+administrator|tpa)\b/i,
  ],
  TELECOM: [
    /\b(?:broadband|landline|postpaid|prepaid)\b/i,
    /\b(?:mobile|telephone)\s+(?:no\.?|number|connection)\b/i,
    /\b(?:trai|dot|telecom)\b/i,
    /\b(?:data\s+pack|recharge|sim\s+card|network\s+coverage)\b/i,
  ],
};

/**
 * How many distinct sector words a document must use before it has said which sector it is
 * about. One is noise: a tiling invoice that mentions a UPI payment is not a banking dispute.
 */
const MIN_SECTOR_SIGNALS = 2;

/**
 * Which ladder a document's own words put it on, or `null` when they do not.
 *
 * A sector is named only when it is the **only** one that clears the bar — not merely the
 * one that clears it highest. A document speaking two sectors' vocabularies fluently has not
 * told us which regulator hears it, and the highest score is a bad tiebreaker for that: an
 * insurance premium paid by NEFT reads as three banking words and two insurance ones, and is
 * an insurance matter. Picking the leader there sends someone to the wrong ombudsman with
 * confidence, where `null` sends them to the consumer route, which hears both.
 */
export function detectForum(text: string): RedressalForum | null {
  if (!text.trim()) return null;

  const clearing = (Object.keys(SECTOR_SIGNALS) as Exclude<RedressalForum, 'CONSUMER'>[])
    .map((forum) => ({
      forum,
      // Distinct patterns matched, not total occurrences: a statement repeating "IFSC" on
      // every page is one signal about its sector, not forty.
      score: SECTOR_SIGNALS[forum].filter((pattern) => pattern.test(text)).length,
    }))
    .filter((entry) => entry.score >= MIN_SECTOR_SIGNALS);

  return clearing.length === 1 ? clearing[0]!.forum : null;
}

/**
 * Phrases that mean "this document is a complaint that was raised", as distinct from the
 * bill or screenshot it was raised about.
 *
 * A reference number is treated as the strongest signal, because organisations issue one
 * precisely when a complaint enters their system — its presence is the organisation's own
 * record that something was filed, which is a far better signal than the word "complaint"
 * appearing in a sentence.
 */
const COMPLAINT_REFERENCE =
  /\b(?:complaint|grievance|ticket|docket|service\s+request|sr|case|reference|ref)\s*(?:id|no\.?|number|#)?\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9/_-]{3,30})/i;

const COMPLAINT_PHRASES = [
  /\b(?:complaint|grievance)\s+(?:has\s+been\s+)?(?:registered|lodged|raised|filed|received)\b/i,
  /\bwe\s+(?:have\s+)?(?:received|registered)\s+your\s+(?:complaint|grievance|request)\b/i,
  /\b(?:i|we)\s+(?:am|are)\s+writing\s+to\s+(?:complain|raise|report)\b/i,
  /\bthis\s+is\s+to\s+(?:complain|bring\s+to\s+your\s+notice)\b/i,
  /\b(?:nodal|grievance)\s+officer\b/i,
  /\b(?:kindly|please)\s+(?:resolve|redress|refund|reverse)\b/i,
  /\bescalat(?:e|ing|ion)\b/i,
];

export interface ComplaintSignal {
  /** The organisation's own reference for the complaint, when it printed one. */
  reference: string | null;
  /** How many independent phrases pointed at this being a complaint. */
  strength: number;
}

/**
 * Whether a document reads as a complaint that was raised with someone.
 *
 * Returns `null` rather than a zero-strength result, so a caller cannot accidentally treat
 * "not a complaint" as "a weak complaint".
 */
export function complaintSignal(text: string): ComplaintSignal | null {
  if (!text.trim()) return null;

  const reference = text.match(COMPLAINT_REFERENCE)?.[1] ?? null;
  const phrases = COMPLAINT_PHRASES.filter((pattern) => pattern.test(text)).length;
  // A printed reference counts double: it is the organisation's own acknowledgement that a
  // complaint exists, which no amount of complaining language is equivalent to.
  const strength = phrases + (reference ? 2 : 0);

  return strength >= 2 ? { reference, strength } : null;
}

// ---------------------------------------------------------------------------
// The silence
// ---------------------------------------------------------------------------

/**
 * A complaint document and the day it carries.
 *
 * Only DAY precision is admitted. "March 2024" could start the clock anywhere in a
 * thirty-one-day range, and the entire value of this module is that the number it reports
 * is one the reader can check.
 */
export interface ComplaintDocument {
  evidenceId: string;
  title: string;
  date: DateField;
  signal: ComplaintSignal;
  forum: RedressalForum;
}

/**
 * The latest DAY-precision date in an extraction: when the complaint was, at the earliest,
 * raised.
 *
 * Latest, not earliest, and the reasoning is about which direction to be wrong in. A
 * complaint quotes the things it is about — the transaction, the statement period, an earlier
 * follow-up — and a document cannot mention a date that had not happened when it was written.
 * So the latest date it carries is a lower bound on its own age, and anchoring there
 * *understates* elapsed time.
 *
 * Understating is the safe direction: it makes the rule speak later and more quietly. Taking
 * the earliest date would overstate the silence — a complaint sent in March quoting a January
 * transaction would be reported as five months old when it is three — and the one number this
 * module exists to provide would be wrong on screen.
 */
function complaintAnchor(extraction: Extraction): DateField | null {
  const days = extraction.dates.filter((date) => date.precision === 'DAY' && date.iso);
  if (days.length === 0) return null;
  return days.reduce((best, date) => ((date.iso ?? '') > (best.iso ?? '') ? date : best));
}

/**
 * Every complaint-shaped document in a set of evidence, with the ladder it sits on.
 *
 * `extractionOf` is passed in rather than read off the evidence, so the caller supplies the
 * *effective* extraction — the one with the user's own corrections already applied. A date
 * the user has fixed by hand is the one this reasons from.
 */
export function complaintDocuments(
  evidence: readonly Evidence[],
  extractionOf: (evidenceId: string) => Extraction | null,
): ComplaintDocument[] {
  const found: ComplaintDocument[] = [];

  for (const item of evidence) {
    const extraction = extractionOf(item.id);
    if (!extraction) continue;

    const text = extraction.sourceText;
    const signal = complaintSignal(text);
    if (!signal) continue;

    const date = complaintAnchor(extraction);
    if (!date) continue;

    found.push({
      evidenceId: item.id,
      title: item.title,
      date,
      signal,
      // Sector from the complaint's own words, falling back to the consumer route, which
      // hears every sector and is therefore never the wrong answer — only a less specific one.
      forum: detectForum(text) ?? 'CONSUMER',
    });
  }

  return found.sort((a, b) => (a.date.iso ?? '').localeCompare(b.date.iso ?? '') || a.evidenceId.localeCompare(b.evidenceId));
}

/**
 * The most recent DAY-precision date in the case's evidence, ignoring the items named in
 * `exclude`.
 *
 * This is how the module decides whether a silence is real. If any *other* document in the
 * case is dated after the complaint, something happened after it — a reply, a follow-up, a
 * bill — and the clock is not running from the complaint any more. The test is deliberately
 * indifferent to *what* that document is: reading a PDF to decide whether it constitutes a
 * "reply" is exactly the kind of judgement that gets made wrong, and getting it wrong here
 * means telling someone nobody answered them when somebody did.
 *
 * `exclude` exists because the complaint must not answer itself. A complaint quotes the
 * transaction, the statement period and the earlier follow-up it is chasing, so its own
 * extraction is full of dates — and scanning it alongside the rest would let the most
 * thoroughly written complaints, the ones whose owners most need the prompt, silently
 * suppress their own finding.
 */
export function latestDatedDay(
  evidence: readonly Evidence[],
  extractionOf: (evidenceId: string) => Extraction | null,
  exclude: ReadonlySet<string> = new Set(),
): { evidenceId: string; date: DateField } | null {
  let best: { evidenceId: string; date: DateField } | null = null;

  for (const item of evidence) {
    if (exclude.has(item.id)) continue;
    const extraction = extractionOf(item.id);
    if (!extraction) continue;
    for (const date of extraction.dates) {
      if (date.precision !== 'DAY' || !date.iso) continue;
      if (!best || date.iso > (best.date.iso ?? '')) best = { evidenceId: item.id, date };
    }
  }

  return best;
}

export interface Silence {
  complaint: ComplaintDocument;
  profile: ForumProfile;
  /** Whole days from the complaint's date to `now`. Arithmetic, and checkable. */
  daysElapsed: number;
  /** The most recent thing dated after the complaint, when there is one. */
  latestAfter: { evidenceId: string; date: DateField } | null;
}

/**
 * A complaint that has been sitting longer than its scheme's reply window, with nothing in
 * the case dated since.
 *
 * Returns the single longest-running one rather than a list. A case usually holds one
 * complaint and its attachments, and a screen that says "and also, and also" about the same
 * silence three times reads as noise rather than as a prompt.
 *
 * `null` in every uncertain case: no complaint, no day-precision date, a date in the future
 * (a typo, or a clock skew — either way not a silence), or something dated after the
 * complaint. Each of those is a reason to say nothing, not a reason to hedge.
 */
export function longestSilence(
  evidence: readonly Evidence[],
  extractionOf: (evidenceId: string) => Extraction | null,
  now: NowDate,
): Silence | null {
  const complaints = complaintDocuments(evidence, extractionOf);
  if (complaints.length === 0) return null;

  const today = nowAsDate(now);
  let longest: Silence | null = null;

  for (const complaint of complaints) {
    const daysElapsed = daysBetween(complaint.date, today);
    if (daysElapsed === null || daysElapsed < 0) continue;

    const profile = FORUM_PROFILES[complaint.forum];
    if (daysElapsed < profile.replyWindowDays) continue;

    // Anything *else* dated after the complaint means the case did not go quiet. Checked
    // across all other evidence rather than only complaint documents, because the reply is
    // precisely the thing that is not a complaint. The complaint itself is excluded: its own
    // quoted dates are part of what it is chasing, not an answer to it.
    const latest = latestDatedDay(evidence, extractionOf, new Set([complaint.evidenceId]));
    const latestAfter =
      latest && (latest.date.iso ?? '') > (complaint.date.iso ?? '') ? latest : null;
    if (latestAfter) continue;

    if (!longest || daysElapsed > longest.daysElapsed) {
      longest = { complaint, profile, daysElapsed, latestAfter: null };
    }
  }

  return longest;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/** Epoch milliseconds, as the engine already passes around. */
export type NowDate = number;

/**
 * Today, in the shape the date helpers compare.
 *
 * A `NormalizedDate`, not a `DateField`: today is the clock, not a value read out of a
 * document, and it has no evidence item and no provenance to claim. `DateField` is
 * structurally a `NormalizedDate` plus provenance, so `daysBetween` accepts both and the
 * narrower type is the one that cannot be mistaken for an extracted value — in particular it
 * can never reach `unconfirmedReadsOf` and quarantine a finding on account of the calendar.
 *
 * UTC, matching `daysBetween`, which parses both its arguments as UTC midnight. Local
 * components here would make the elapsed count printed on screen jump by one either side of
 * midnight depending on the device's timezone.
 */
export function nowAsDate(now: NowDate): NormalizedDate {
  const date = new Date(now);
  const iso = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  return { original: iso, iso, precision: 'DAY', ambiguous: false };
}

/** Renders a complaint's date the way the rest of the app renders dates. */
export function describeComplaintDate(complaint: ComplaintDocument): string {
  return formatDate(complaint.date);
}
