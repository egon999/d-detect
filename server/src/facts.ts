import { formatMinorUnits, normalizeCurrency, toEpoch, toMinorUnits } from './money.ts';

export type AmountFact = {
  raw: string;
  minor: number;
  currency: string;
  label: string;

  role: 'total' | 'line';
};
export type DateFact = { raw: string; at: number; precision: 'minute' | 'day' };

export type ReferenceFact = { value: string; labelled: boolean };
export type FactKind = 'amounts' | 'dates' | 'references' | 'statuses';

export type Facts = {
  amounts: AmountFact[];
  dates: DateFact[];
  references: ReferenceFact[];
  statuses: string[];

  partial?: FactKind[];
};

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const LEADING_AMOUNT = /(₹|Rs\.?|INR|\$|US\$|USD|€|EUR|£|GBP|¥|JPY|₨)\s*(\d[\d,]*(?:\.\d{1,3})?)/gi;
const TRAILING_AMOUNT = /(\d[\d,]*(?:\.\d{1,3})?)\s*(INR|USD|EUR|GBP|JPY|rupees?|rs\.?)\b/gi;

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?\b/g;
const NUMERIC_DATE = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/g;
const DAY_MONTH_YEAR = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g;
const MONTH_DAY_YEAR = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;

const REFERENCE =
  /\b(?:UTR|RRN|UPI(?:\s*(?:transaction|ref(?:erence)?))?\s*(?:ID|No\.?|number)?|Transaction\s*(?:ID|No\.?)|Txn\s*(?:ID|No\.?)|Ref(?:erence)?\s*(?:ID|No\.?)?|Invoice\s*(?:No\.?|#)?|Order\s*(?:ID|No\.?|#)?|Cheque\s*No\.?|Receipt\s*No\.?)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9/-]{5,31})/gi;

function sensitiveShape(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== value.length) return false;
  return /^(?:0|91)?[6-9]\d{9}$/.test(digits) || digits.length === 15 || digits.length === 16;
}

const TOTAL_LABEL =
  /((?<!sub)total|grand\s*total|net\s*payable|amount\s*(?:paid|due|payable|charged)|balance\s*due|you\s*paid|paid|sum|payable)\D{0,12}$/i;

const STATUS =
  /\b(completed|successful|success|failed|failure|pending|paid|unpaid|refunded|declined|cancelled|canceled|received|not received|credited|debited|settled|overdue|due|cleared|bounced|dishonoured|dishonored)\b/gi;

const DUE_AS_DATE = /^\s*(?:date|on|by)?\s*[:\-]?\s*(?:date\b|\d{1,4}[/\-.]|\d{1,2}\s+[A-Za-z]{3}|[A-Za-z]{3,9}\.?\s+\d{1,2})/i;

function clean(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function pushAmount(into: AmountFact[], rawAmount: string, rawCurrency: string, role: 'total' | 'line'): void {
  const currency = normalizeCurrency(rawCurrency.replace(/^US\$$/i, 'USD'));
  if (!currency) return;
  const minor = toMinorUnits(rawAmount, currency);
  if (minor === null || minor === 0) return;
  const existing = into.find((entry) => entry.minor === minor && entry.currency === currency);
  if (existing) {

    if (role === 'total') existing.role = 'total';
    return;
  }
  into.push({
    raw: clean(`${rawCurrency} ${rawAmount}`),
    minor,
    currency,
    label: formatMinorUnits(minor, currency),
    role,
  });
}

function roleAt(text: string, index: number): 'total' | 'line' {
  return TOTAL_LABEL.test(text.slice(Math.max(0, index - 32), index)) ? 'total' : 'line';
}

function pushDate(into: DateFact[], at: number, precision: 'minute' | 'day', raw: string): void {
  if (!Number.isFinite(at)) return;
  const year = new Date(at).getFullYear();
  if (year < 1990 || year > 2100) return;
  if (into.some((entry) => entry.at === at)) return;
  into.push({ raw: clean(raw), at, precision });
}

function calendarDate(year: number, month: number, day: number): number {
  return toEpoch(`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`, 'day').at ?? NaN;
}

const KEPT: Record<FactKind, number> = { amounts: 12, dates: 12, references: 12, statuses: 8 };

export function extractFacts(text: string): Facts {
  const amounts: AmountFact[] = [];
  const dates: DateFact[] = [];
  const references: ReferenceFact[] = [];
  const statuses: string[] = [];

  for (const match of text.matchAll(LEADING_AMOUNT)) {
    pushAmount(amounts, match[2] ?? '', match[1] ?? '', roleAt(text, match.index ?? 0));
  }
  for (const match of text.matchAll(TRAILING_AMOUNT)) {
    pushAmount(amounts, match[1] ?? '', match[2] ?? '', roleAt(text, match.index ?? 0));
  }

  for (const match of text.matchAll(ISO_DATE)) {
    const [raw, year, month, day, hour, minute] = match;
    const at = toEpoch(
      hour !== undefined
        ? `${year}-${month}-${day}T${hour}:${minute}:00`
        : `${year}-${month}-${day}T00:00:00`,
      hour !== undefined ? 'minute' : 'day',
    ).at ?? NaN;
    pushDate(dates, at, hour !== undefined ? 'minute' : 'day', raw);
  }

  for (const match of text.matchAll(NUMERIC_DATE)) {
    const first = Number.parseInt(match[1] ?? '', 10);
    const second = Number.parseInt(match[2] ?? '', 10);
    const rawYear = Number.parseInt(match[3] ?? '', 10);
    if (!Number.isFinite(first) || !Number.isFinite(second) || !Number.isFinite(rawYear)) continue;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const dayFirst = second <= 12;
    const day = dayFirst ? first : second;
    const month = dayFirst ? second : first;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    pushDate(dates, calendarDate(year, month - 1, day), 'day', match[0]);
  }

  for (const match of text.matchAll(DAY_MONTH_YEAR)) {
    const month = MONTHS[(match[2] ?? '').slice(0, 4).toLowerCase()] ?? MONTHS[(match[2] ?? '').slice(0, 3).toLowerCase()];
    if (month === undefined) continue;
    const day = Number.parseInt(match[1] ?? '', 10);
    const year = Number.parseInt(match[3] ?? '', 10);
    pushDate(dates, calendarDate(year, month, day), 'day', match[0]);
  }

  for (const match of text.matchAll(MONTH_DAY_YEAR)) {
    const month = MONTHS[(match[1] ?? '').slice(0, 4).toLowerCase()] ?? MONTHS[(match[1] ?? '').slice(0, 3).toLowerCase()];
    if (month === undefined) continue;
    const day = Number.parseInt(match[2] ?? '', 10);
    const year = Number.parseInt(match[3] ?? '', 10);
    pushDate(dates, calendarDate(year, month, day), 'day', match[0]);
  }

  for (const match of text.matchAll(REFERENCE)) {
    const value = (match[1] ?? '').trim();
    if (value.length < 6 || sensitiveShape(value)) continue;
    if (!references.some((entry) => entry.value === value)) {
      references.push({ value, labelled: true });
    }
  }

  for (const match of text.matchAll(STATUS)) {
    let value = (match[0] ?? '').toLowerCase();
    const before = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index);
    if (/\b(?:not|never|wasn't|isn't|hasn't)\s*$/i.test(before)) {
      if (value === 'paid') value = 'unpaid';
      else if (value === 'received') value = 'not received';
      else continue;
    }
    if (value === 'due') {
      const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 24);
      if (DUE_AS_DATE.test(after)) continue;
    }
    if (!statuses.includes(value)) statuses.push(value);
  }

  const found: Record<FactKind, unknown[]> = { amounts, dates, references, statuses };
  const partial = (Object.keys(KEPT) as FactKind[]).filter(
    (kind) => found[kind].length > KEPT[kind],
  );

  return {
    amounts: amounts.slice(0, KEPT.amounts),
    dates: dates.slice(0, KEPT.dates),
    references: references.slice(0, KEPT.references),
    statuses: statuses.slice(0, KEPT.statuses),
    ...(partial.length > 0 ? { partial } : {}),
  };
}

// --------------------------------------------------------------------------------
// Cross-side comparison
// --------------------------------------------------------------------------------

export type Side = 'mine' | 'theirs';

export type FactSource = {
  id: string;
  label: string;
  side: Side;
  hasFile: boolean;
  /** `claim` is what the case owner typed about a side; `item` is material added to it. */
  origin: 'item' | 'claim';
  facts: Facts;
};

export type Signal = {
  kind:
    | 'shared_reference'
    | 'amount_agreement'
    | 'amount_mismatch'
    | 'date_agreement'
    | 'date_conflict'
    | 'status_conflict'
    | 'undocumented_claim'
    | 'your_side_unproven'
    | 'no_opposing_material';
  strength: 'strong' | 'moderate' | 'weak';
  headline: string;
  detail: string;
  itemIds: string[];
};

const SETTLED = ['completed', 'successful', 'success', 'paid', 'credited', 'debited', 'settled', 'cleared', 'received'];
const UNSETTLED = ['failed', 'failure', 'pending', 'unpaid', 'declined', 'cancelled', 'canceled', 'overdue', 'due', 'not received', 'bounced', 'dishonoured', 'dishonored'];

/**
 * The figure a document is actually about.
 *
 * A labelled total wins. Failing that, a document with exactly one amount in it is
 * unambiguous. Anything else — several unlabelled figures — has no identifiable
 * headline, and this returns null rather than picking one, because the previous
 * behaviour (take `amounts[0]`, the first regex match in document order) is what
 * turned a line item into a reported contradiction.
 */
function headlineAmount(facts: Facts): AmountFact | null {
  const totals = facts.amounts.filter((amount) => amount.role === 'total');
  if (totals.length === 1) return totals[0] ?? null;
  if (totals.length > 1) return null;
  return facts.amounts.length === 1 ? (facts.amounts[0] ?? null) : null;
}

/**
 * Collapse repeats, keeping the strongest of each kind.
 *
 * The comparison is a nested loop over every item on one side against every item on
 * the other, so three records each produced up to nine near-identical signals. A
 * report that says the same thing nine times reads as nine findings.
 */
function strongestPerKind(signals: Signal[]): Signal[] {
  const rank: Record<Signal['strength'], number> = { weak: 0, moderate: 1, strong: 2 };
  const best = new Map<string, Signal>();
  for (const signal of signals) {
    const key = `${signal.kind}:${signal.headline}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, { ...signal, itemIds: [...signal.itemIds] });
      continue;
    }
    if (rank[signal.strength] > rank[existing.strength]) existing.strength = signal.strength;
    for (const id of signal.itemIds) if (!existing.itemIds.includes(id)) existing.itemIds.push(id);
  }
  return [...best.values()].sort((a, b) => rank[b.strength] - rank[a.strength]);
}

/** A typed claim is not a document, so nothing compared against one is reported at full strength. */
const WEAKER: Record<Signal['strength'], Signal['strength']> = { strong: 'moderate', moderate: 'weak', weak: 'weak' };

/**
 * The owner's own side, held to the standard the other side is held to.
 *
 * Every other detector here can only fire when there is something on both sides, so a
 * case with a thin own side produced nothing but findings in its owner's favour. A
 * comparison that only ever agrees with the person who uploaded it is worth nothing to
 * them: the gap they cannot see is the one that loses the argument. This is the gap, said
 * in code, from absence that can be checked — no file on their side at all, or files that
 * carry no figure and no reference while their words say the money moved.
 */
function ownSideGap(mine: FactSource[]): Signal | null {
  if (mine.length === 0) return null;
  const files = mine.filter((source) => source.hasFile);
  const saysSettled = mine.some((source) => source.facts.statuses.some((status) => SETTLED.includes(status)));

  if (files.length === 0) {
    return {
      kind: 'your_side_unproven',
      strength: 'moderate',
      headline: saysSettled ? 'Nothing uploaded shows the payment you describe' : 'Your side rests on your own words',
      detail: saysSettled
        ? 'Your side says the money was paid, but nothing has been uploaded for it — no receipt, bank line, screenshot or message. That one document is what would settle this.'
        : 'Nothing has been uploaded on your side, so your account stands on what you have written. A record made at the time carries more weight than an account given afterwards.',
      itemIds: mine.filter((source) => source.origin === 'item').map((source) => source.id),
    };
  }

  const showsFigure = files.some(
    (source) => source.facts.amounts.length > 0 || source.facts.references.length > 0,
  );
  if (saysSettled && !showsFigure) {
    return {
      kind: 'your_side_unproven',
      strength: 'weak',
      headline: 'What you uploaded does not show the payment itself',
      detail: 'Your side says the money was paid. What you have uploaded carries no amount and no reference number, so it sits alongside your account of the payment rather than showing it.',
      itemIds: files.map((source) => source.id),
    };
  }

  return null;
}

export function compareSides(sources: FactSource[]): Signal[] {
  const mine = sources.filter((source) => source.side === 'mine');
  const theirs = sources.filter((source) => source.side === 'theirs');
  const signals: Signal[] = [];

  if (mine.length > 0 && theirs.length === 0) {
    signals.push({
      kind: 'no_opposing_material',
      strength: 'moderate',
      headline: 'Nothing has been added for the other side',
      detail: 'Only your own material is in this case, so there is no opposing account to weigh it against.',
      itemIds: [],
    });
  }

  for (const source of mine) {
    for (const other of theirs) {
      const claimed = source.origin === 'claim' || other.origin === 'claim';
      const add = (signal: Signal): void => {
        signals.push(claimed ? { ...signal, strength: WEAKER[signal.strength] } : signal);
      };

      // A reference the document itself labelled — a UTR, an invoice number — shared
      // across both sides really does tie them to one transaction.
      const sharedLabelled = source.facts.references
        .filter((reference) => reference.labelled)
        .filter((reference) => other.facts.references.some((entry) => entry.value === reference.value && entry.labelled));

      if (sharedLabelled.length > 0) {
        const values = sharedLabelled.map((reference) => reference.value);
        add({
          kind: 'shared_reference',
          strength: 'strong',
          headline: `Both sides name the same reference ${values[0]}`,
          detail: `${source.label} and ${other.label} both carry ${values.join(', ')}. This links their accounts to the same stated reference; it does not authenticate either document or confirm settlement.`,
          itemIds: [source.id, other.id],
        });
      }

      const ourHeadline = headlineAmount(source.facts);
      const theirHeadline = headlineAmount(other.facts);
      const matchedAmount = ourHeadline && theirHeadline
        ? (ourHeadline.minor === theirHeadline.minor && ourHeadline.currency === theirHeadline.currency ? ourHeadline : undefined)
        : source.facts.amounts.find((amount) =>
          other.facts.amounts.some((candidate) => candidate.minor === amount.minor && candidate.currency === amount.currency));

      if (matchedAmount) {
        add({
          kind: 'amount_agreement',
          strength: 'moderate',
          headline: `Both sides state ${matchedAmount.label}`,
          detail: ourHeadline && theirHeadline
            ? `The headline amounts in ${source.label} and ${other.label} match.`
            : `This figure appears in both ${source.label} and ${other.label}; the material does not identify one unambiguous total on each side.`,
          itemIds: [source.id, other.id],
        });
      } else if (ourHeadline && theirHeadline && ourHeadline.currency === theirHeadline.currency) {
        // Both sides have an identifiable headline figure and they differ. This is the
        // only case that supports the claim that the two cannot both be right.
        add({
          kind: 'amount_mismatch',
          strength: 'strong',
          headline: `${ourHeadline.label} against ${theirHeadline.label}`,
          detail: `${source.label} states ${ourHeadline.label}; ${other.label} states ${theirHeadline.label}. The two cannot both be the figure for this transaction.`,
          itemIds: [source.id, other.id],
        });
      } else if (source.facts.amounts.length > 0 && other.facts.amounts.length > 0) {
        add({
          kind: 'amount_mismatch',
          strength: 'weak',
          headline: 'The amounts on the two sides do not line up',
          detail: `No figure in ${source.label} matches any figure in ${other.label}. Neither document marks which of its figures is the total, so this is worth checking by eye rather than treating as a contradiction.`,
          itemIds: [source.id, other.id],
        });
      }

      const closeDate = source.facts.dates.find((date) =>
        other.facts.dates.some((candidate) => new Date(candidate.at).toDateString() === new Date(date.at).toDateString()),
      );
      if (closeDate) {
        add({
          kind: 'date_agreement',
          strength: 'weak',
          headline: 'Both sides point at the same day',
          detail: `${source.label} and ${other.label} refer to ${new Date(closeDate.at).toDateString()}.`,
          itemIds: [source.id, other.id],
        });
      } else if (source.facts.dates.length === 1 && other.facts.dates.length === 1) {
        // One date each and they disagree. With several dates on either side there is
        // no way to know which pair was meant to correspond, so nothing is claimed.
        const ours = source.facts.dates[0];
        const yours = other.facts.dates[0];
        if (ours && yours) {
          add({
            kind: 'date_conflict',
            strength: 'moderate',
            headline: 'The two accounts sit on different dates',
            detail: `${source.label} refers to ${new Date(ours.at).toDateString()}; ${other.label} refers to ${new Date(yours.at).toDateString()}.`,
            itemIds: [source.id, other.id],
          });
        }
      } else if (source.facts.dates.length > 0 && other.facts.dates.length > 0) {
        add({
          kind: 'date_conflict',
          strength: 'weak',
          headline: 'The two sides share no common date',
          detail: `None of the dates in ${source.label} fall within a day of any date in ${other.label}. Both carry several dates, so which ones were meant to correspond is not clear from the documents.`,
          itemIds: [source.id, other.id],
        });
      }

      const mySettled = source.facts.statuses.filter((status) => SETTLED.includes(status));
      const myUnsettled = source.facts.statuses.filter((status) => UNSETTLED.includes(status));
      const theirSettled = other.facts.statuses.filter((status) => SETTLED.includes(status));
      const theirUnsettled = other.facts.statuses.filter((status) => UNSETTLED.includes(status));

      if ((mySettled.length > 0 && theirUnsettled.length > 0) || (myUnsettled.length > 0 && theirSettled.length > 0)) {
        /**
         * A document can carry both kinds of word at once — a receipt that says "paid"
         * and also lists a "pending" delivery. When either side is mixed like that, the
         * two are not cleanly opposed, so this reports the words rather than asserting
         * the contradiction. Stated as strong, it was the single most confident-sounding
         * line in a report and the easiest one to be wrong about.
         */
        const clean = (myUnsettled.length === 0 && theirSettled.length === 0) ||
          (mySettled.length === 0 && theirUnsettled.length === 0);
        add({
          kind: 'status_conflict',
          strength: clean ? 'strong' : 'weak',
          headline: clean
            ? 'One record says settled, the other says it is not'
            : 'The two records use conflicting status words',
          detail: clean
            ? `${source.label} reads ${source.facts.statuses.join(', ')}; ${other.label} reads ${other.facts.statuses.join(', ')}.`
            : `${source.label} contains ${source.facts.statuses.join(', ')}; ${other.label} contains ${other.facts.statuses.join(', ')}. Because at least one of them carries words from both sides, this is not a clean contradiction.`,
          itemIds: [source.id, other.id],
        });
      }
    }
  }

  const myDocuments = mine.filter((source) => source.hasFile);
  if (theirs.length > 0 && !theirs.some((source) => source.hasFile) && myDocuments.length > 0) {
    const onlyClaimed = theirs.every((source) => source.origin === 'claim');
    signals.push({
      kind: 'undocumented_claim',
      strength: 'moderate',
      headline: onlyClaimed
        ? 'The other side is here only as you described it'
        : 'The other side has given a statement, not a document',
      detail: onlyClaimed
        ? `Nothing written or sent by the other side has been added; their position is in this case as you stated it. Your side has ${myDocuments.length} uploaded record(s).`
        : `Your side has ${myDocuments.length} uploaded record(s); everything on the other side is a written assertion with nothing attached.`,
      itemIds: theirs.map((source) => source.id),
    });
  }

  const ownGap = ownSideGap(mine);
  if (ownGap) signals.push(ownGap);

  return strongestPerKind(signals);
}
