import { effectiveExtraction } from '../extraction/merge';
import type {
  AmountField,
  DateField,
  Evidence,
  Extraction,
  TextField,
  UnconfirmedRead,
  Workspace,
} from '../models';
import { formatDate } from '../normalize/dates';
import { isUnconfirmedReading, unconfirmedReadsOf } from '../rules/provenance';
import {
  longestSilence,
  nowAsDate,
  type ComplaintDocument,
  type ForumProfile,
  type NowDate,
} from './escalation';
import { limitationWindow, type LimitationWindow } from './limitation';

/**
 * The filing draft: the letter the user actually has to write.
 *
 * ## The gap this closes
 *
 * The rest of this app reads documents and reports what they say. `escalation.ts` goes one
 * step further and reports that a complaint has gone unanswered long enough that another
 * forum will usually hear it. Both stop at the same place — the point where the user has to
 * *do* something.
 *
 * What they have to do is fill in a grievance form. Every one of them asks for the same
 * things: who you are, what your account or reference number is, what happened and when, how
 * much is in dispute, what you already did about it, how long ago, and what you want. That
 * is a page of facts, and every fact on it is already sitting in this case, spread across
 * documents the user uploaded weeks ago and no longer remembers the detail of.
 *
 * So they retype it from memory, get the reference number slightly wrong, forget which date
 * the complaint actually carried, and attach the wrong statement. Or — far more often — they
 * look at the form, decide they will do it at the weekend, and never file at all.
 *
 * This module assembles that page from the case's own extracted values.
 *
 * ## The rules it works under
 *
 * Assembling a document that a person will sign and send to a regulator is the most
 * consequential thing this app does, so it is also the most tightly constrained:
 *
 * 1. **Every factual line names the document it came from.** A `DraftLine` of kind `FACT`
 *    carries an `evidenceId`. The user can check any sentence against the page it was read
 *    from, and the UI can offer that as a tap.
 *
 * 2. **Nothing is invented.** Where the case does not contain a value, the draft emits a
 *    `BLANK` with a prompt rather than a plausible guess. A letter to an ombudsman with a
 *    fabricated account number is worse than no letter.
 *
 * 3. **No legal argument, no characterisation of conduct.** The draft states what happened
 *    and what the documents record. It does not say anyone was negligent, deficient, unfair
 *    or in breach — those are conclusions for the forum, and putting them in the user's mouth
 *    on the strength of an OCR read would be indefensible.
 *
 * 4. **The relief sought is always the user's to write.** The app does not know whether
 *    someone wants their money back, their connection restored, or an apology. It asks.
 *
 * 5. **Unconfirmed readings are surfaced before filing, not buried.** A value read off a scan
 *    is used — refusing to would leave the form empty — but the line is marked and the draft
 *    carries a checklist of every such value, so the user checks four numbers against the
 *    originals rather than proofreading the whole letter.
 *
 * 6. **It says what is missing.** The gaps are computed from the evidence, and only ones that
 *    can be determined from the data: no reference number, no amount, nothing dated. It does
 *    not speculate about which forms a particular forum wants — that is knowledge this app
 *    does not have, and being wrong about it sends someone to a counter for nothing.
 *
 * ## Why it is deterministic, and not a model call
 *
 * No network, no model, no key. Three consequences that matter more than the convenience:
 * it works on a train with no signal, it costs nothing to run, and — the real reason — it
 * cannot hallucinate a fact into a document a regulator will read. Every sentence below is
 * either a literal value pulled from the user's own file, or a fixed template string that
 * says nothing about the case. There is no third category, which is exactly why the output
 * can be trusted enough to sign.
 *
 * Pure: no I/O, no clock of its own, no randomness.
 */

/** Where one line of the draft came from, which decides how the UI must present it. */
export type LineKind =
  /** Assembled from a value in the user's own evidence. Carries `evidenceId`. */
  | 'FACT'
  /** Fixed wording that says nothing about this case. Safe, and says nothing. */
  | 'TEMPLATE'
  /** The app does not know this. The user must supply it before sending. */
  | 'BLANK';

export interface DraftLine {
  text: string;
  kind: LineKind;
  /** The document this sentence was assembled from. Always set for `FACT`, never otherwise. */
  evidenceId: string | null;
  /**
   * True when a value in this line was read from an image or proposed by a model and no
   * person has confirmed it. The line is still emitted — an empty form helps nobody — but it
   * is flagged here and listed in `checkBeforeFiling`.
   */
  needsCheck: boolean;
  /**
   * Which answer fills this line. Always set for `BLANK`, never otherwise.
   *
   * Lines are keyed by slot rather than by position so that one answer fills every line that
   * needs it: a person writes their name once and it appears on both the From line and the
   * signature. Asking the same question twice on the same page is how a form gets abandoned.
   */
  slot: DraftSlot | null;
  /** For `BLANK`: what the user has to write, in the words the form would use. */
  placeholder?: string;
}

/**
 * The things only the user can supply.
 *
 * A closed union rather than free strings, so a line cannot refer to an answer no screen
 * collects, and a screen cannot collect an answer no line consumes.
 *
 * `name`, `address` and `contact` are facts about the person and are identical on every
 * letter they will ever send; the rest belong to this dispute. `PERSONAL_SLOTS` draws that
 * line once, so the split is stated here rather than re-derived by each caller.
 */
export type DraftSlot =
  | 'name'
  | 'address'
  | 'contact'
  | 'accountNumber'
  | 'organisation'
  | 'amount'
  | 'relief'
  | 'place';

/** What the user has written so far. Absent or blank means unanswered. */
export type DraftAnswers = Partial<Record<DraftSlot, string>>;

/**
 * The slots that describe the person rather than the dispute.
 *
 * Worth carrying between letters: someone filing a second complaint should not retype their
 * own address. The rest are case-specific and deliberately start empty every time, because
 * carrying a previous dispute's account number into a new letter is a way to file the wrong
 * one.
 */
export const PERSONAL_SLOTS: readonly DraftSlot[] = ['name', 'address', 'contact'];

export interface DraftSection {
  heading: string;
  lines: DraftLine[];
}

/**
 * One attachment, numbered as the letter refers to it.
 *
 * The hash is printed because it is the only identifier in this app that means anything
 * outside it. It does not establish that a document is genuine — see the closing wording of
 * the draft, which says so plainly rather than letting a hex string imply otherwise.
 */
export interface Annexure {
  serial: number;
  title: string;
  /** The document's own date, when it carried a day-precision one. */
  date: string | null;
  sha256: string | null;
}

/** Something the letter would be stronger with, that the case does not currently contain. */
export interface Gap {
  what: string;
  /** Why a reader of the letter would want it. Never a claim about the law. */
  why: string;
}

export interface FilingDraft {
  /** The ladder this letter is addressed to, with its scheme cited. */
  forum: ForumProfile;
  complaint: ComplaintDocument;
  /** Whole days from the complaint to `now`. Arithmetic over the user's own dates. */
  daysElapsed: number;
  /**
   * How long is left to approach this forum, measured from the same complaint date.
   *
   * Carried on the draft rather than computed by the screen, so that a letter and the window
   * shown beside it can never be measured from two different days.
   */
  limitation: LimitationWindow;
  subject: string;
  sections: DraftSection[];
  annexures: Annexure[];
  gaps: Gap[];
  /** Every unconfirmed reading that reached the letter, to check against the originals. */
  checkBeforeFiling: UnconfirmedRead[];
}

// ---------------------------------------------------------------------------
// Picking the values
// ---------------------------------------------------------------------------

const line = (
  text: string,
  kind: LineKind,
  evidenceId: string | null = null,
  needsCheck = false,
): DraftLine => ({ text, kind, evidenceId, needsCheck, slot: null });

/**
 * A line the user has to complete.
 *
 * `text` must contain exactly one bracketed span — `[your full name]` — which is what gets
 * replaced once an answer exists. The brackets are load-bearing rather than decorative: they
 * are how `fillLine` finds the gap, and they are what makes an unfilled letter impossible to
 * send by accident.
 */
const blank = (text: string, slot: DraftSlot, placeholder: string): DraftLine => ({
  text,
  kind: 'BLANK',
  evidenceId: null,
  needsCheck: false,
  slot,
  placeholder,
});

/**
 * The amount in dispute, taken from the complaint document and nowhere else.
 *
 * The complaint is the user's own statement of what they are disputing, so the figure it
 * names is the figure they mean. Scanning the whole case instead would be guessing: a case
 * holds an invoice total, a tax component, a partial payment and a bank balance, and picking
 * the largest — or the first — would put a number in front of an ombudsman that the user
 * never chose.
 *
 * Returns `null` rather than reaching further, which becomes a BLANK the user fills in.
 */
function disputedAmount(extraction: Extraction | null): AmountField | null {
  if (!extraction || extraction.amounts.length === 0) return null;
  // One unambiguous figure, or none. Two different figures in a complaint is a question for
  // the person who wrote it, not something to resolve by picking one.
  const distinct = new Map(extraction.amounts.map((amount) => [`${amount.currency}:${amount.minorUnits}`, amount]));
  return distinct.size === 1 ? [...distinct.values()][0]! : null;
}

/**
 * The reference numbers a form will ask for, drawn from the complaint document.
 *
 * Transaction, invoice and order references are kept together because a grievance form asks
 * for "the reference number" without caring which kind it is, and the user knows which of
 * theirs is which.
 */
function referenceNumbers(extraction: Extraction | null): TextField[] {
  if (!extraction) return [];
  return [...extraction.transactionIds, ...extraction.invoiceNumbers, ...extraction.orderNumbers];
}

/**
 * The respondent, resolved to just what the letter needs.
 *
 * Deliberately not a `TextField`. A name pulled off an addressee line was never an extracted
 * field, so it has no `evidenceId` and no `sourceQuote` of the shape an extraction produces —
 * and manufacturing those, with an empty id and a borrowed method, is how a value ends up
 * looking more solid than it is. This type can hold only what was actually observed.
 */
interface ResolvedName {
  /** The name exactly as the document wrote it, for printing. */
  name: string;
  /** How the document's text was obtained, so the letter knows whether to add a caveat. */
  method: string;
  /** The passage it was read from, so the user can find the line on the page. */
  quote: string | null;
}

/** The organisation complained against, preferring the extractor's own reading. */
function respondent(extraction: Extraction | null): ResolvedName | null {
  const field = extraction?.organizations[0];
  if (field) {
    return { name: field.original, method: field.method, quote: field.sourceQuote ?? null };
  }
  return extraction ? addresseeOrganization(extraction) : null;
}

/**
 * Words that make a name read as an organisation rather than a person, when it appears in an
 * addressee line.
 *
 * Sector words rather than company names, deliberately. A list of Indian brand names would
 * be stale within a year and would quietly stop matching; sector words are what these
 * organisations are called in the documents themselves — "State Bank", "HDFC Bank", "ICICI
 * Lombard", "Bajaj Finance". A part of the line that matches none of them is left alone and
 * the draft asks the user, which is the right answer for "To: Ramesh".
 */
const ORGANISATION_WORD =
  /\b(bank|banking|insurance|insurer|assurance|finance|financial|capital|investments?|securities|telecom|broadband|cellular|mobile|communications?|networks?|housing|credit|cards?|payments?|wallet|fintech|hospital|clinic|diagnostics|society|co-?op(?:erative)?|builder|developers?|constructions?|infra|properties|apartments?|estates?|motors?|automobiles?|travels?|airlines?|courier|logistics|energy|power|electricity|gas|water|municipal|corporation|authority|limited|ltd|pvt|private|inc|llp|co\.)\b/i;

/**
 * Job titles that are never the organisation.
 *
 * "To: Grievance Officer, State Bank" is a person's role followed by the body they work for.
 * Without this check the *first* part of the line would be taken as the respondent, and the
 * letter would be addressed against "Grievance Officer" — a job title, not a party.
 */
const JOB_TITLE =
  /^(the\s+)?(grievance|nodal|appellate|compliance|branch|regional|zonal|divisional|senior|chief|general|deputy|assistant|managing|relationship)?\s*(officer|manager|head|director|executive|supervisor|in-?charge|representative|agent|team|department|cell|desk|division|authority|sir|madam)s?$/i;

/**
 * The addressee line of the complaint, which in this market is where the respondent's name
 * usually lives.
 *
 * ## Why this does not just read `extraction.organizations`
 *
 * Because on real complaints that field is empty, and a letter to a regulator that cannot
 * name the party complained against is not usable. People write:
 *
 *     To: Grievance Officer, State Bank
 *
 * The extractor reads that line as a *party*, labelled `to`. `to` is deliberately not one of
 * its commercial labels — "To: Ramesh" is addressed to a person — and "State Bank" carries
 * none of the legal-form words (`pvt`, `ltd`, `inc`, …), so the whole line is filed under
 * `people` and `organizations` comes back empty.
 *
 * Widening the extractor instead would move findings across the entire engine: `people` and
 * `organizations` feed shared-party matching, orphan detection and corroboration. An
 * addressee line is a fact about a *letter*, so it is resolved here, where the only thing
 * that changes is the letter.
 *
 * ## The shape being read
 *
 * Indian business correspondence writes "Role, Organisation" — role first, organisation after
 * the comma. So the line is split, job titles are skipped, and the first part that contains
 * a sector word is the respondent. If nothing qualifies this returns `null` and the draft
 * asks the user, because putting the wrong name at the top of a letter to an ombudsman is
 * not a lesser error than leaving it blank.
 */
function addresseeOrganization(extraction: Extraction): ResolvedName | null {
  const text = extraction.sourceText;
  if (!text) return null;

  for (const match of text.matchAll(/^[ \t]*(?:to|from)\s*:\s*(.{2,120})$/gim)) {
    const parts = match[1]!
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length >= 3 && !part.includes('@'));

    let afterTitle = false;
    for (const part of parts) {
      if (JOB_TITLE.test(part)) {
        afterTitle = true;
        continue;
      }

      /*
        Two ways a part earns the top of the letter, and the second is why this is not just a
        keyword list.

        Structure: "Role, Organisation" is how Indian business correspondence is addressed, so
        a part that follows a job title *is* the body that role belongs to. This is what lets
        "To: The Manager, Airtel" resolve — no sector word appears anywhere in that line, and a
        keyword list alone would leave a common complaint with a blank where the respondent
        goes.

        Vocabulary, for the one-part case: "To: State Bank" has no comma and no role to lean
        on, so a sector word is the only thing separating it from "To: Ramesh", which is a
        person and must be asked about rather than assumed.
      */
      if (afterTitle || ORGANISATION_WORD.test(part)) {
        return { name: part, method: documentReadMethod(extraction), quote: match[0].trim() };
      }
    }
  }

  return null;
}

/**
 * How this document's text was obtained, as far as its own segments record it.
 *
 * Used for values resolved out of `sourceText` rather than out of an extracted field, which
 * have no per-field provenance of their own. A scanned complaint whose segments were all read
 * by OCR has an addressee line that was read by OCR too, and the letter must say so — the
 * same reasoning as `nowAsDate` returning a `NormalizedDate` rather than inventing a
 * `DateField`: a value with no real provenance should not be dressed up as one that has it.
 */
function documentReadMethod(extraction: Extraction): string {
  const methods = new Set(extraction.segments.map((segment) => segment.method));
  if (methods.size === 1) return [...methods][0]!;
  // Mixed methods: the strictest wins. Claiming DETERMINISTIC for a document that was partly
  // read by a machine would understate what needs checking.
  return [...methods].some((method) => isUnconfirmedReading(method)) ? 'OCR' : 'DETERMINISTIC';
}

/** A document's own day-precision date, for the annexure table. */
function documentDate(extraction: Extraction | null): DateField | null {
  const days = (extraction?.dates ?? []).filter((date) => date.precision === 'DAY' && date.iso);
  if (days.length === 0) return null;
  return days.reduce((best, date) => ((date.iso ?? '') > (best.iso ?? '') ? date : best));
}

// ---------------------------------------------------------------------------
// The gaps
// ---------------------------------------------------------------------------

/**
 * What the letter is missing, limited strictly to what the evidence can settle.
 *
 * Every gap below is derived from a value being absent in the case. None of them asserts
 * what a particular forum requires: this app does not know which annexures the Insurance
 * Ombudsman wants this year, and a confident list of the wrong ones sends someone to a
 * counter with the wrong paperwork.
 */
function findGaps(
  complaint: ComplaintDocument,
  complaintExtraction: Extraction | null,
  amount: AmountField | null,
  references: readonly TextField[],
  evidence: readonly Evidence[],
  limitation: LimitationWindow,
): Gap[] {
  const gaps: Gap[] = [];

  // Listed first when it applies, because it is the one gap that decides whether the forum
  // reaches the merits at all. Phrased as something to write rather than as a warning: by the
  // time a reader is on this list they have already been told the window closed, and what they
  // need here is the missing paragraph, not the bad news again. It says "wherever you send it"
  // rather than naming this forum, because under some schemes — the RBI's among them — this
  // particular forum has no power to overlook the delay, and the explanation is for whichever
  // one does.
  if (limitation.state === 'CLOSED') {
    gaps.push({
      what: 'A short explanation of why this is being brought now',
      why: `The usual window under ${limitation.provision} has passed, and wherever you send this, you will be asked what caused the delay. The months spent waiting for a reply are themselves part of the explanation, and only you can say what else happened.`,
    });
  }

  if (!complaint.signal.reference && references.length === 0) {
    gaps.push({
      what: 'A reference or acknowledgement number for the original complaint',
      why: 'Grievance forms ask for it, and it is how the organisation locates what you already sent them.',
    });
  }

  if (!amount) {
    gaps.push({
      what: 'The amount in dispute, as a single figure',
      why:
        complaintExtraction && complaintExtraction.amounts.length > 1
          ? 'Your complaint names more than one figure, so this draft does not choose between them.'
          : 'Your complaint does not state one, and the form will ask what sum is at stake.',
    });
  }

  if (!respondent(complaintExtraction)) {
    gaps.push({
      what: 'The full name of the organisation you are complaining about',
      why: 'The draft could not read a company name from your complaint, and the letter is addressed against them.',
    });
  }

  // Everything else in the case is a candidate attachment. A case holding only the complaint
  // itself has nothing to show for what it asserts.
  const supporting = evidence.filter((item) => item.id !== complaint.evidenceId);
  if (supporting.length === 0) {
    gaps.push({
      what: 'A document showing what happened — a statement, receipt, screenshot or bill',
      why: 'This case contains your complaint and nothing else, so the letter has nothing to attach in support of it.',
    });
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/**
 * Assembles the escalation letter for the longest-running unanswered complaint in a case.
 *
 * Returns `null` in exactly the cases `longestSilence` does — no complaint, nothing dated,
 * still inside the reply window, or something in the case dated after the complaint. A draft
 * escalation for a complaint that was answered last week is not a lesser output; it is a
 * wrong one.
 */
export function buildFilingDraft(
  evidence: readonly Evidence[],
  extractionOf: (evidenceId: string) => Extraction | null,
  now: NowDate,
): FilingDraft | null {
  const silence = longestSilence(evidence, extractionOf, now);
  if (!silence) return null;

  const { complaint, profile, daysElapsed } = silence;
  const extraction = extractionOf(complaint.evidenceId);

  const amount = disputedAmount(extraction);
  const references = referenceNumbers(extraction);
  const organisation = respondent(extraction);
  const complaintRef = complaint.signal.reference ?? references[0]?.original ?? null;

  const softDate = isUnconfirmedReading(complaint.date.method);
  const softAmount = amount ? isUnconfirmedReading(amount.method) : false;
  const softRef = references[0] ? isUnconfirmedReading(references[0].method) : false;
  const softOrg = organisation ? isUnconfirmedReading(organisation.method) : false;
  const on = formatDate(complaint.date);
  const today = formatDate(nowAsDate(now));

  const subject = complaintRef
    ? `Complaint reference ${complaintRef} — no reply received in ${daysElapsed} days`
    : `Complaint dated ${on} — no reply received in ${daysElapsed} days`;

  const sections: DraftSection[] = [
    {
      heading: 'Addressed to',
      lines: [
        line(`To: ${profile.nextStep}`, 'TEMPLATE'),
        line(profile.where, 'TEMPLATE'),
        blank('From: [your full name]', 'name', 'Your full name'),
        blank('[your address]', 'address', 'Your postal address'),
        blank(
          '[your phone number and email]',
          'contact',
          'A phone number and email they can reach you on',
        ),
        line(`Date: ${today}`, 'TEMPLATE'),
      ],
    },
    {
      heading: 'Subject',
      lines: [line(subject, complaintRef ? 'FACT' : 'TEMPLATE', complaintRef ? complaint.evidenceId : null, softRef)],
    },
    {
      heading: 'What this is about',
      lines: [
        organisation
          ? line(
              `I am writing about a complaint I raised with ${organisation.name}, which has not been answered.`,
              'FACT',
              complaint.evidenceId,
              softOrg,
            )
          : blank(
              'I am writing about a complaint I raised with [organisation name], which has not been answered.',
              'organisation',
              'The full name of the organisation',
            ),
        amount
          ? line(`The amount in dispute is ${amount.original}.`, 'FACT', complaint.evidenceId, softAmount)
          : blank('The amount in dispute is [amount].', 'amount', 'The sum in dispute, as one figure'),
        blank(
          'My account, policy or connection number is [number].',
          'accountNumber',
          'The account, policy or connection number this concerns',
        ),
      ],
    },
    {
      heading: 'What I already did',
      lines: [
        line(
          complaintRef
            ? `I raised this complaint on ${on}, under reference ${complaintRef}.`
            : `I raised this complaint on ${on}.`,
          'FACT',
          complaint.evidenceId,
          softDate || softRef,
        ),
        line(
          `${daysElapsed} days have passed since then and I have had no reply.`,
          'FACT',
          complaint.evidenceId,
          softDate,
        ),
        line(
          `Under ${profile.scheme}, a ${profile.sector} provider is generally expected to respond within ` +
            `${profile.replyWindowDays} days. I am therefore bringing this to you.`,
          'TEMPLATE',
        ),
      ],
    },
    {
      heading: 'What I am asking for',
      lines: [
        blank(
          '[Say plainly what you want — for example: the amount refunded, the service restored, ' +
            'the charge withdrawn, or the record corrected.]',
          'relief',
          'What outcome you want',
        ),
      ],
    },
    {
      heading: 'Declaration',
      lines: [
        line(
          'The documents listed below are copies of what I hold. The facts stated above are to the best of my knowledge.',
          'TEMPLATE',
        ),
        // The name is deliberately not re-asked here: it is the `name` slot again, so writing
        // it once at the top signs the letter too. Only the place is new.
        blank('Signed: [your name]', 'name', 'Your full name'),
        blank(`Place: [city]    Date: ${today}`, 'place', 'The town or city you are writing from'),
      ],
    },
  ];

  // The complaint is always annexure 1 — it is the document the whole letter is about.
  // The rest follow in the order the case holds them, which is id order and therefore stable.
  const ordered = [
    ...evidence.filter((item) => item.id === complaint.evidenceId),
    ...evidence.filter((item) => item.id !== complaint.evidenceId),
  ];

  const annexures: Annexure[] = ordered.map((item, index) => {
    const date = documentDate(extractionOf(item.id));
    return {
      serial: index + 1,
      title: item.title,
      date: date ? formatDate(date) : null,
      sha256: item.sha256 || null,
    };
  });

  // Only the readings that actually reached the letter. The complaint document may hold a
  // dozen unconfirmed values; four of them are in the text above, and asking the user to
  // check those four is a task they will finish.
  const used = new Set<string>();
  if (softDate) used.add(complaint.date.original);
  if (softAmount && amount) used.add(amount.original);
  if (softRef && references[0]) used.add(references[0].original);

  const checkBeforeFiling = unconfirmedReadsOf(complaint.evidenceId, extraction).filter((read) =>
    used.has(read.reading),
  );

  // The respondent is the one value that may not have come from an extracted field at all:
  // `respondent` falls back to reading the addressee line out of `sourceText`, and
  // `unconfirmedReadsOf` only walks the extraction's typed fields — so a bank's name read off
  // a scan would never appear in the list above. It is added by hand, or the one value the
  // whole letter is addressed against would be the one value never flagged.
  const orgFromAddressee = organisation !== null && !extraction?.organizations[0];
  if (softOrg && organisation && orgFromAddressee) {
    checkBeforeFiling.push({
      evidenceId: complaint.evidenceId,
      path: 'addressee.organisation',
      label: 'Organisation',
      reading: organisation.name,
    });
  }

  // Computed once and passed to both the draft and the gap list: the window decides whether
  // the gaps include an explanation for the delay, and two separate calls could in principle
  // straddle midnight and disagree.
  const limitation = limitationWindow(profile, complaint.date, now);

  return {
    forum: profile,
    complaint,
    daysElapsed,
    limitation,
    subject,
    sections,
    annexures,
    gaps: findGaps(complaint, extraction, amount, references, evidence, limitation),
    checkBeforeFiling,
  };
}

// ---------------------------------------------------------------------------
// Answering it
// ---------------------------------------------------------------------------

/**
 * The bracketed gap in a `BLANK` line — exactly one per line, by construction.
 *
 * Matching a span rather than a known token is what lets the surrounding sentence stay
 * readable while it is still unanswered: "From: [your full name]" reads as a letter with a
 * gap in it, which is what the user is looking at, rather than as a template with a variable
 * in it, which is what a developer would be looking at.
 */
const GAP = /\[[^\]]*\]/;

/** True when the user has actually written something, rather than opened the field. */
function isAnswered(slot: DraftSlot, answers: DraftAnswers): boolean {
  return (answers[slot] ?? '').trim().length > 0;
}

/**
 * One line of the letter with the user's answer substituted, or unchanged if they have not
 * written one yet.
 *
 * An unanswered line keeps its brackets. That is deliberate and slightly uncomfortable to
 * look at, which is the point: `[your full name]` sitting in the middle of an otherwise
 * finished letter cannot be missed, whereas a blank space or a neutral underscore is
 * something a person sends by accident.
 */
export function fillLine(item: DraftLine, answers: DraftAnswers): string {
  if (item.kind !== 'BLANK' || !item.slot) return item.text;
  const answer = answers[item.slot]?.trim();
  return answer ? item.text.replace(GAP, answer) : item.text;
}

/** One question to put to the user, and what answering it completes. */
export interface DraftQuestion {
  slot: DraftSlot;
  /** What to write, in the words a form would use. */
  placeholder: string;
  /** How many lines of the letter this single answer fills. */
  lines: number;
  /** True for the answers that describe the person rather than this dispute. */
  personal: boolean;
}

/**
 * The questions the letter needs answered, deduplicated, in the order they are first asked.
 *
 * Deduplicated is the whole point. A person's name appears on the From line and again over
 * the signature, and a form that asks for it twice is a form that gets abandoned halfway
 * down. The screen renders one field per question here and every line bound to that slot
 * fills at once.
 */
export function draftQuestions(draft: FilingDraft): DraftQuestion[] {
  const questions: DraftQuestion[] = [];
  const bySlot = new Map<DraftSlot, DraftQuestion>();

  for (const section of draft.sections) {
    for (const item of section.lines) {
      if (item.kind !== 'BLANK' || !item.slot) continue;

      const existing = bySlot.get(item.slot);
      if (existing) {
        existing.lines += 1;
        continue;
      }

      const question: DraftQuestion = {
        slot: item.slot,
        placeholder: item.placeholder ?? '',
        lines: 1,
        personal: PERSONAL_SLOTS.includes(item.slot),
      };
      bySlot.set(item.slot, question);
      questions.push(question);
    }
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The draft as plain text, ready to paste into an email or a web form.
 *
 * Answers are substituted where they exist; every remaining gap keeps its brackets, for the
 * reason `fillLine` explains. Passing no answers renders the empty letter, which is what the
 * preview shows before the user has written anything.
 */
export function renderDraftText(draft: FilingDraft, answers: DraftAnswers = {}): string {
  const body = draft.sections
    .map((section) => {
      const lines = section.lines.map((item) => fillLine(item, answers)).join('\n');
      return `${section.heading.toUpperCase()}\n${lines}`;
    })
    .join('\n\n');

  const annexures = draft.annexures
    .map((item) => {
      const date = item.date ? ` · ${item.date}` : '';
      const hash = item.sha256 ? `\n     File fingerprint (SHA-256): ${item.sha256}` : '';
      return `  ${item.serial}. ${item.title}${date}${hash}`;
    })
    .join('\n');

  return (
    `${body}\n\nANNEXURES\n${annexures}\n\n` +
    'The fingerprint recorded against each document identifies the bytes held in the app. ' +
    'It does not establish that a document is genuine or that it came from the person it names.\n'
  );
}

/**
 * How ready the draft is to send, as counts rather than a verdict.
 *
 * Returned as the two numbers a user acts on — what they still have to write, and what they
 * should check against the original documents — rather than a percentage or a traffic light.
 * "72% complete" invites someone to send a letter with their name missing from it.
 *
 * `blanks` counts unanswered *questions*, not unanswered lines, so writing a name once takes
 * the count down by one rather than by two. Counting lines would make the number jump
 * unpredictably as the user types and would overstate how much work is left.
 */
export function draftReadiness(
  draft: FilingDraft,
  answers: DraftAnswers = {},
): { blanks: number; toCheck: number } {
  const blanks = draftQuestions(draft).filter((question) => !isAnswered(question.slot, answers)).length;
  return { blanks, toCheck: draft.checkBeforeFiling.length };
}

// ---------------------------------------------------------------------------
// Reading it out of a workspace
// ---------------------------------------------------------------------------

/**
 * The draft for one case, read straight out of the workspace.
 *
 * ## Why the *effective* extraction and not the stored one
 *
 * `effectiveExtraction` re-applies every field the user has confirmed or corrected by hand,
 * which is the difference between a letter built from what a camera guessed and a letter built
 * from what the person holding the document says it says. A user who has already fixed a
 * misread date gets that fix in the letter — and the caveat disappears with it, without any
 * separate bookkeeping: the corrected field reads as MANUAL, so `isUnconfirmedReading` stops
 * flagging it and it drops out of `checkBeforeFiling` on its own.
 *
 * ## Why the same filter and sort as the rule engine
 *
 * Soft-deleted evidence is excluded and the list is ordered by id, matching `buildRuleContext`
 * exactly. Two consequences worth having: the annexure numbering agrees with the order the
 * rest of the app lists these documents in, and the letter is assembled from precisely the
 * evidence the RESPONSE_OVERDUE finding was computed over — so the screen cannot offer to
 * draft a letter about a silence the analysis does not report, or refuse one it does.
 */
export function filingDraftForCase(
  workspace: Readonly<Workspace>,
  caseId: string,
  now: NowDate,
): FilingDraft | null {
  // No case, no letter — rather than a letter about nothing. Deliberately not a throw: a
  // screen calls this on every render, including the render that happens while the case is
  // being deleted underneath it.
  const parentCase = workspace.cases.find((item) => item.id === caseId && !item.deletedAt);
  if (!parentCase) return null;

  const evidence = workspace.evidence
    .filter((item) => item.caseId === caseId && !item.deletedAt)
    .sort((a, b) => a.id.localeCompare(b.id));

  const byId = new Map(evidence.map((item) => [item.id, item]));
  const cache = new Map<string, Extraction | null>();

  // Memoised for the same reason the engine memoises it: `longestSilence` asks for every
  // item's extraction, then the draft asks again for the complaint and once per annexure, and
  // `effectiveExtraction` rebuilds the merge each time it is called.
  const extractionOf = (evidenceId: string): Extraction | null => {
    if (cache.has(evidenceId)) return cache.get(evidenceId) ?? null;
    const item = byId.get(evidenceId);
    const result = item ? effectiveExtraction(item) : null;
    cache.set(evidenceId, result);
    return result;
  };

  return buildFilingDraft(evidence, extractionOf, now);
}
