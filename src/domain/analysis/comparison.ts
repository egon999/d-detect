/**
 * The comparison table: several documents about one thing, put side by side.
 *
 * ## What this is for
 *
 * A person hands over a ₹100 mall bill and a Google Pay screenshot of the same payment.
 * The rule engine can already tell them whether the two figures disagree, and it says so
 * in a sentence. What it cannot do is answer the question they actually arrived with —
 * *what does each of these documents say, and where do they line up?*
 *
 * That question needs a table, not a sentence. Findings are the exceptions: they fire when
 * something is wrong. Silence from the engine is ambiguous, because "nothing disagrees" and
 * "nothing was comparable" produce exactly the same empty list, and those two are the
 * opposite of each other. This module makes agreement visible, which is most of what a
 * reader is looking for and none of what a findings list can show.
 *
 * ## It reports, it does not conclude
 *
 * Every row states what each document said and whether those statements match. None of it
 * decides whether the documents are honest, whether the transaction happened, or what the
 * difference between two figures means. A row marked `DIFFERS` is an observation about two
 * pieces of text, and a partial payment, a tip, a tax line or an OCR misread are all
 * ordinary explanations for one.
 *
 * ## Grounding is inherited, never invented
 *
 * The table never decides for itself that two documents belong together. It is built on a
 * {@link ComparisonGroup}, which carries both the ground for the comparison and how much
 * that ground is worth, and it repeats them. A table that silently compared any two
 * uploaded files would manufacture agreement between unrelated documents — a worse error
 * than missing a real conflict, because the user has no way to see it happening.
 *
 * ## Thresholds are shared, not re-stated
 *
 * Amounts agree or differ according to `amountsMateriallyDiffer`, the same function the
 * `amount-mismatch` rule uses. Re-implementing the tolerance here would eventually let the
 * table mark two figures as differing on a screen where the analysis reports no discrepancy
 * between them, and the user would have no way to tell which was right.
 */

import type { ExtractionMethod } from '../enums';
import type { AmountField, DateField, Evidence, Extraction, TextField } from '../models';
import { formatDate } from '../normalize/dates';
import { amountsMateriallyDiffer, formatAmount } from '../normalize/money';
import type { ComparisonGroup } from '../rules/support';

/** What one document had to say on one row. */
export interface ComparisonCell {
  evidenceId: string;
  /**
   * The value as the reader should see it — formatted, not raw. Null when this document
   * says nothing on this row, which is a distinct outcome from disagreeing.
   */
  display: string | null;
  /** How the value was obtained. Null alongside a null `display`. */
  method: ExtractionMethod | null;
  /** The text the value was read from, when the extractor kept it. */
  sourceQuote: string | null;
  /**
   * The value as the *document* wrote it, before `formatAmount` or `formatDate` reshaped it
   * for a reader.
   *
   * Carried so the UI can mark the value inside `sourceQuote` exactly rather than searching
   * for a string the document does not contain. `display` is the app's wording — `₹1,80,000`,
   * `14 March 2024` — and neither appears in a quote that reads `Rs. 1,80,000.00` or
   * `14/03/2024`. This is the extractor's own match, so locating it is a substring search and
   * not an inference. See `markInQuote`.
   *
   * Null alongside a null `display`, and equal to the raw field text otherwise — including
   * where a person corrected the value, since a correction is what the document says as far
   * as this app is concerned.
   */
  sourceValue: string | null;
}

/**
 * What a row means once every document has had its say.
 *
 * `UNCOMPARED` is deliberately separate from `AGREES`. One document stating a reference
 * number that the other simply does not carry is not corroboration, and a table that
 * coloured it the same green as a genuine match would be claiming support that does not
 * exist. It is the single most important distinction on this screen.
 */
export type RowAgreement = 'AGREES' | 'DIFFERS' | 'UNCOMPARED';

export type ComparisonField = 'amount' | 'date' | 'organization' | 'person' | 'identifier';

export interface ComparisonRow {
  /** Stable key within a table, e.g. `identifier:invoiceNumbers`. */
  key: string;
  /** What to call this row, e.g. "Amount", "Invoice number". */
  label: string;
  field: ComparisonField;
  agreement: RowAgreement;
  /** One cell per document in the group, in the group's own order. Never sparse. */
  cells: ComparisonCell[];
  /** One sentence saying what this row shows. Written for a reader, not a developer. */
  note: string;
}

export interface ComparisonTable {
  group: ComparisonGroup;
  /** The documents being compared, in the group's id-sorted order. */
  documents: Evidence[];
  rows: ComparisonRow[];
  agreeing: number;
  differing: number;
  uncompared: number;
}

/** Reads an amount the way the rules do: a labelled total first, then the largest figure. */
function headlineAmount(amounts: readonly AmountField[]): AmountField | null {
  return (
    amounts.find((amount) => amount.role === 'total') ??
    amounts.find((amount) => amount.role === 'paid') ??
    [...amounts].sort((a, b) => Math.abs(b.minorUnits) - Math.abs(a.minorUnits))[0] ??
    null
  );
}

/**
 * The date that best represents a document.
 *
 * Day precision is required. A document dated only to a month cannot be said to agree or
 * disagree with one dated to a day, and showing "September 2026" next to "12 September 2026"
 * under a verdict would force the table to pick one, which it has no grounds to do.
 */
function headlineDate(dates: readonly DateField[]): DateField | null {
  const days = dates.filter((date) => date.precision === 'DAY' && date.iso);
  return days.find((date) => date.role === 'issued') ?? days.find((date) => date.role === 'paid') ?? days[0] ?? null;
}

/**
 * The text field's representative value.
 *
 * Position, not importance. `TEXT_FIELD_KEYS` fields are populated in document order by
 * the extractor, so the first entry is simply the earliest one in the source — an email
 * address printed in a letterhead outranks the one in the "From:" line for no reason
 * other than where it sits on the page. Nothing in the extraction records a ranking, and
 * inventing one here would put a value in a comparison cell on the strength of a score
 * the reader cannot see. The row therefore shows where the value came from and leaves the
 * question of which one matters to the person reading it.
 */
function firstText(fields: readonly TextField[]): TextField | null {
  return fields[0] ?? null;
}

function quoteOf(field: { sourceQuote?: string | undefined }): string | null {
  const quote = field.sourceQuote?.trim();
  return quote ? quote : null;
}

/** An empty cell: this document had nothing to say here. */
function absent(evidenceId: string): ComparisonCell {
  return { evidenceId, display: null, method: null, sourceQuote: null, sourceValue: null };
}

/**
 * Decides a row from the values that were actually present.
 *
 * `allAgree` is passed in rather than assumed, because agreement means different things per
 * field, and — more importantly — is not always transitive. Two dates agree when they are the
 * same day and two identifiers when their normalised forms are identical, both of which chain:
 * if A matches B and B matches C then A matches C, so checking each against the first is
 * sound. Amounts do not chain. Under a tolerance, ₹100.00 agrees with ₹100.90 and ₹100.90
 * agrees with ₹101.80 while the two ends disagree, so a predicate that checked each figure
 * against whichever document happened to be listed first would return a different verdict
 * depending on upload order. Each field supplies the test that is correct for it.
 */
function decide<T>(
  present: readonly T[],
  documentCount: number,
  allAgree: (values: readonly T[]) => boolean,
): { agreement: RowAgreement; note: string } {
  if (present.length < 2) {
    return {
      agreement: 'UNCOMPARED',
      note: `Only one of the ${documentCount} documents carries this. It is not corroborated, and it is not contradicted either.`,
    };
  }

  return allAgree(present)
    ? {
        agreement: 'AGREES',
        note:
          present.length === documentCount
            ? 'Every document states the same value.'
            : `The ${present.length} documents that carry this state the same value.`,
      }
    : {
        agreement: 'DIFFERS',
        note: 'These documents state different values. Open both and confirm which is correct.',
      };
}

/** Agreement for fields whose equality chains: check every value against the first. */
function allEqual<T>(values: readonly T[], same: (a: T, b: T) => boolean): boolean {
  const [anchor, ...rest] = values as [T, ...T[]];
  return rest.every((value) => same(anchor, value));
}

/**
 * Builds the table for one group of documents.
 *
 * `extractionOf` is passed in rather than a workspace, so this works identically against the
 * rule engine's effective extractions (with human corrections applied) and against a raw
 * store. It returns null for a document that has not been extracted yet, and such a document
 * still gets a column — showing it as empty is honest, dropping it would quietly narrow the
 * comparison the user asked for.
 */
export function buildComparisonTable(
  group: ComparisonGroup,
  extractionOf: (evidenceId: string) => Extraction | null,
): ComparisonTable {
  const documents = group.items;
  const extractions = new Map<string, Extraction | null>(
    documents.map((item) => [item.id, extractionOf(item.id)]),
  );

  const rows: ComparisonRow[] = [];

  // --- Amount ---------------------------------------------------------------
  {
    const values = documents.map((item) => {
      const extraction = extractions.get(item.id) ?? null;
      const amount = extraction ? headlineAmount(extraction.amounts) : null;
      return { item, amount };
    });

    const present = values.filter(
      (entry): entry is { item: Evidence; amount: AmountField } => entry.amount !== null,
    );

    if (present.length > 0) {
      const verdict = decide(
        present.map((entry) => entry.amount),
        documents.length,
        // Sorted, then the extremes compared — exactly what `amount-mismatch` does. Under a
        // tolerance that is the only order-independent test: the widest gap in the set is
        // what decides it, so three near-identical figures that drift past the threshold
        // end to end are reported as differing rather than passed as a chain of matches.
        (amounts) => {
          if (amounts.some((entry) => entry.currency !== amounts[0]!.currency)) return false;
          const sorted = [...amounts].sort((a, b) => a.minorUnits - b.minorUnits);
          return !amountsMateriallyDiffer(sorted[0]!, sorted[sorted.length - 1]!);
        },
      );

      rows.push({
        key: 'amount',
        label: 'Amount',
        field: 'amount',
        agreement: verdict.agreement,
        note:
          verdict.agreement === 'DIFFERS' && present.some((e) => e.amount.currency !== present[0]!.amount.currency)
            ? 'These figures are in different currencies. Detact holds no exchange rates and will not convert between them — compare them yourself.'
            : verdict.note,
        cells: values.map(({ item, amount }) =>
          amount
            ? {
                evidenceId: item.id,
                display: formatAmount(amount),
                method: amount.method,
                sourceQuote: quoteOf(amount),
                sourceValue: amount.original,
              }
            : absent(item.id),
        ),
      });
    }
  }

  // --- Date -----------------------------------------------------------------
  {
    const values = documents.map((item) => {
      const extraction = extractions.get(item.id) ?? null;
      const date = extraction ? headlineDate(extraction.dates) : null;
      return { item, date };
    });

    const present = values.filter(
      (entry): entry is { item: Evidence; date: DateField } => entry.date !== null,
    );

    if (present.length > 0) {
      const verdict = decide(
        present.map((entry) => entry.date),
        documents.length,
        (dates) => allEqual(dates, (a, b) => a.iso === b.iso),
      );

      // A date that reads two ways still compares — both documents normalise it the same
      // way — but the reader is told, because two systems configured differently could
      // write the same characters for different days.
      const ambiguous = present.some((entry) => entry.date.ambiguous);

      rows.push({
        key: 'date',
        label: 'Date',
        field: 'date',
        agreement: verdict.agreement,
        note:
          ambiguous && verdict.agreement === 'AGREES'
            ? `${verdict.note} That date is written in a form that can be read two ways, so check both documents use the same convention.`
            : verdict.note,
        cells: values.map(({ item, date }) =>
          date
            ? {
                evidenceId: item.id,
                display: formatDate(date),
                method: date.method,
                sourceQuote: quoteOf(date),
                sourceValue: date.original,
              }
            : absent(item.id),
        ),
      });
    }
  }

  // --- Identifiers and parties ----------------------------------------------
  const TEXT_ROWS: ReadonlyArray<{
    key: keyof Pick<Extraction, 'invoiceNumbers' | 'orderNumbers' | 'transactionIds' | 'organizations' | 'people'>;
    label: string;
    field: ComparisonField;
  }> = [
    { key: 'invoiceNumbers', label: 'Invoice number', field: 'identifier' },
    { key: 'orderNumbers', label: 'Order number', field: 'identifier' },
    { key: 'transactionIds', label: 'Transaction reference', field: 'identifier' },
    { key: 'organizations', label: 'Organisation', field: 'organization' },
    { key: 'people', label: 'Person', field: 'person' },
  ];

  for (const row of TEXT_ROWS) {
    const values = documents.map((item) => {
      const extraction = extractions.get(item.id) ?? null;
      const field = extraction ? firstText(extraction[row.key]) : null;
      return { item, field };
    });

    const present = values.filter(
      (entry): entry is { item: Evidence; field: TextField } => entry.field !== null,
    );

    if (present.length === 0) continue;

    const verdict = decide(
      present.map((entry) => entry.field),
      documents.length,
      (fields) => allEqual(fields, (a, b) => a.normalized === b.normalized),
    );

    rows.push({
      key: `text:${row.key}`,
      label: row.label,
      field: row.field,
      agreement: verdict.agreement,
      note:
        // Two payment systems issuing unrelated reference numbers is the normal case, not a
        // discrepancy. Saying "these differ" about a bill number and a UPI reference would
        // be the table inventing a conflict out of two systems that never shared a scheme.
        row.field === 'identifier' && verdict.agreement === 'DIFFERS'
          ? 'Each document carries its own reference. Different systems issue their own numbers, so this is usually expected rather than a conflict.'
          : verdict.note,
      cells: values.map(({ item, field }) =>
        field
          ? {
              evidenceId: item.id,
              display: field.original || field.normalized,
              method: field.method,
              sourceQuote: quoteOf(field),
              sourceValue: field.original,
            }
          : absent(item.id),
      ),
    });
  }

  return {
    group,
    documents,
    rows,
    agreeing: rows.filter((row) => row.agreement === 'AGREES').length,
    // Identifier rows are excluded from the differing count. They are marked `DIFFERS`
    // because the values are not equal, which is true and worth showing, but counting them
    // as discrepancies would report a conflict on almost every real pair of documents and
    // make the number meaningless.
    differing: rows.filter((row) => row.agreement === 'DIFFERS' && row.field !== 'identifier').length,
    uncompared: rows.filter((row) => row.agreement === 'UNCOMPARED').length,
  };
}

/**
 * Every comparable set in a case, strongest grounding first.
 *
 * A thin wrapper, kept so screens never have to know that grouping and tabulation are two
 * steps. Groups that produce no rows at all are dropped: an empty table tells the reader
 * nothing and takes up the space where a real one would be.
 */
export function buildComparisonTables(
  groups: readonly ComparisonGroup[],
  extractionOf: (evidenceId: string) => Extraction | null,
): ComparisonTable[] {
  return groups
    .map((group) => buildComparisonTable(group, extractionOf))
    .filter((table) => table.rows.length > 0);
}
