/**
 * The comparison table, tested.
 *
 * The failure this file exists to prevent is the table claiming agreement that is not there.
 * A row where one document is silent must never read the same as a row where both documents
 * said the same thing — that difference is the whole value of the screen, and it is the
 * easiest thing in the module to get wrong.
 */

import { describe, expect, it } from 'vitest';

import { buildComparisonTable, buildComparisonTables } from '../src/domain/analysis/comparison';
import type { AmountField, DateField, Evidence, Extraction, TextField } from '../src/domain/models';
import type { ComparisonGroup } from '../src/domain/rules/support';

function evidence(id: string, title: string): Evidence {
  return {
    id,
    ownerId: 'u1',
    caseId: 'c1',
    title,
    fileName: `${id}.pdf`,
    kind: 'PDF',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sha256: id.repeat(8),
    storagePath: null,
    remoteUrl: null,
    capturedAt: null,
    processingState: 'PROCESSED',
    processingError: null,
    note: '',
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Evidence;
}

function amount(minorUnits: number, currency = 'INR'): AmountField {
  return {
    evidenceId: 'e',
    method: 'DETERMINISTIC',
    original: String(minorUnits / 100),
    minorUnits,
    currency,
  };
}

function date(iso: string, ambiguous = false): DateField {
  return {
    evidenceId: 'e',
    method: 'DETERMINISTIC',
    original: iso,
    iso,
    precision: 'DAY',
    ambiguous,
  };
}

function text(value: string): TextField {
  return { evidenceId: 'e', method: 'DETERMINISTIC', original: value, normalized: value.toUpperCase() };
}

function extraction(over: Partial<Extraction> = {}): Extraction {
  return {
    segments: [],
    limitations: [],
    documentType: 'Receipt',
    title: 'A document',
    summary: '',
    dates: [],
    amounts: [],
    parties: [],
    people: [],
    organizations: [],
    emails: [],
    phones: [],
    invoiceNumbers: [],
    orderNumbers: [],
    transactionIds: [],
    addresses: [],
    keywords: [],
    chatMessages: [],
    transactionStatus: 'UNKNOWN',
    disputedPoints: [],
    sourceText: '',
    sourceTextTruncated: false,
    extractorVersion: 'test',
    ...over,
  };
}

const bill = evidence('a', 'Mall bill');
const screenshot = evidence('b', 'Google Pay screenshot');

function group(items: Evidence[] = [bill, screenshot]): ComparisonGroup {
  return {
    basis: 'SHARED_PARTY_AND_DATE',
    key: 'SHARED_PARTY_AND_DATE:BIGMALL:2024-05-12',
    reason: 'both name BIGMALL and are dated 12 May 2024',
    confidence: 'STRONG_MATCH',
    items,
  };
}

/** Builds a table from a map of evidence id to extraction. */
function table(byId: Record<string, Extraction | null>, items?: Evidence[]) {
  return buildComparisonTable(group(items), (id) => byId[id] ?? null);
}

/** Every ordering of a list. Only ever called with three documents, so six orders. */
function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

describe('buildComparisonTable', () => {
  it('reports agreement when two documents state the same amount', () => {
    const result = table({
      a: extraction({ amounts: [amount(10_000)] }),
      b: extraction({ amounts: [amount(10_000)] }),
    });

    const row = result.rows.find((entry) => entry.key === 'amount');
    expect(row?.agreement).toBe('AGREES');
    expect(row?.cells.map((cell) => cell.display)).toEqual(['INR 100.00', 'INR 100.00']);
    expect(result.agreeing).toBe(1);
    expect(result.differing).toBe(0);
  });

  it('reports a difference the rules would also raise', () => {
    const result = table({
      a: extraction({ amounts: [amount(10_000)] }),
      b: extraction({ amounts: [amount(15_000)] }),
    });

    const row = result.rows.find((entry) => entry.key === 'amount');
    expect(row?.agreement).toBe('DIFFERS');
    expect(result.differing).toBe(1);
  });

  it('uses the same tolerance as the amount-mismatch rule', () => {
    // ₹100.00 against ₹100.50: half a rupee is under the 100-minor-unit floor, so the rule
    // stays silent. The table has to stay silent with it, or the screen contradicts the
    // analysis printed beside it.
    const result = table({
      a: extraction({ amounts: [amount(10_000)] }),
      b: extraction({ amounts: [amount(10_050)] }),
    });

    expect(result.rows.find((entry) => entry.key === 'amount')?.agreement).toBe('AGREES');
  });

  it('does not treat one document going quiet as agreement', () => {
    // The defect this whole module exists to avoid. One receipt quoting an amount the other
    // never mentions corroborates nothing, and must not be coloured like a match.
    const result = table({
      a: extraction({ amounts: [amount(10_000)] }),
      b: extraction({ amounts: [] }),
    });

    const row = result.rows.find((entry) => entry.key === 'amount');
    expect(row?.agreement).toBe('UNCOMPARED');
    expect(row?.note).toContain('not corroborated');
    expect(result.agreeing).toBe(0);
  });

  it('keeps a column for a document that has no extraction at all', () => {
    // Dropping it would quietly narrow the comparison the user asked for.
    const result = table({ a: extraction({ amounts: [amount(10_000)] }), b: null });

    const row = result.rows.find((entry) => entry.key === 'amount');
    expect(row?.cells).toHaveLength(2);
    expect(row?.cells[1]).toEqual({
      evidenceId: 'b',
      display: null,
      method: null,
      sourceQuote: null,
      sourceValue: null,
    });
  });

  it('refuses to call two currencies a discrepancy in figures', () => {
    const result = table({
      a: extraction({ amounts: [amount(10_000, 'INR')] }),
      b: extraction({ amounts: [amount(10_000, 'USD')] }),
    });

    const row = result.rows.find((entry) => entry.key === 'amount');
    expect(row?.agreement).toBe('DIFFERS');
    expect(row?.note).toContain('will not convert');
  });

  it('compares dates on the resolved day rather than the written form', () => {
    const result = table({
      a: extraction({ dates: [{ ...date('2024-05-12'), original: '12/05/2024' }] }),
      b: extraction({ dates: [{ ...date('2024-05-12'), original: 'May 12, 2024' }] }),
    });

    expect(result.rows.find((entry) => entry.key === 'date')?.agreement).toBe('AGREES');
  });

  it('warns when an agreeing date could be read two ways', () => {
    const result = table({
      a: extraction({ dates: [date('2024-05-12', true)] }),
      b: extraction({ dates: [date('2024-05-12')] }),
    });

    const row = result.rows.find((entry) => entry.key === 'date');
    expect(row?.agreement).toBe('AGREES');
    expect(row?.note).toContain('read two ways');
  });

  it('ignores month-precision dates, which cannot agree or disagree with a day', () => {
    const result = table({
      a: extraction({ dates: [{ ...date('2024-05-12'), precision: 'MONTH', iso: '2024-05' }] }),
      b: extraction({ dates: [date('2024-05-12')] }),
    });

    const row = result.rows.find((entry) => entry.key === 'date');
    expect(row?.agreement).toBe('UNCOMPARED');
  });

  it('does not call two unrelated reference numbers a conflict', () => {
    // A shop's bill number and a UPI reference come from unrelated schemes. Reporting that
    // as a discrepancy would fire on essentially every real pair of documents.
    const result = table({
      a: extraction({ transactionIds: [text('TXN-1')] }),
      b: extraction({ transactionIds: [text('UPI-9')] }),
    });

    const row = result.rows.find((entry) => entry.key === 'text:transactionIds');
    expect(row?.agreement).toBe('DIFFERS');
    expect(row?.note).toContain('usually expected');
    expect(result.differing).toBe(0);
  });

  it('matches identifiers on their normalized form', () => {
    const result = table({
      a: extraction({ invoiceNumbers: [{ ...text('inv-2024-018'), normalized: 'INV2024018' }] }),
      b: extraction({ invoiceNumbers: [{ ...text('INV 2024 018'), normalized: 'INV2024018' }] }),
    });

    const row = result.rows.find((entry) => entry.key === 'text:invoiceNumbers');
    expect(row?.agreement).toBe('AGREES');
    // The reader sees what the document printed, not the normalised key.
    expect(row?.cells.map((cell) => cell.display)).toEqual(['inv-2024-018', 'INV 2024 018']);
  });

  it('omits a row no document has anything to say on', () => {
    const result = table({ a: extraction({ amounts: [amount(1)] }), b: extraction() });
    expect(result.rows.some((entry) => entry.key === 'text:people')).toBe(false);
  });

  it('carries provenance through to every cell', () => {
    const result = table({
      a: extraction({ amounts: [{ ...amount(10_000), method: 'OCR', sourceQuote: 'Total 100.00' }] }),
      b: extraction({ amounts: [{ ...amount(10_000), method: 'MANUAL' }] }),
    });

    const row = result.rows.find((entry) => entry.key === 'amount');
    expect(row?.cells.map((cell) => cell.method)).toEqual(['OCR', 'MANUAL']);
    expect(row?.cells[0]?.sourceQuote).toBe('Total 100.00');
    expect(row?.cells[1]?.sourceQuote).toBeNull();
  });

  it('repeats the grounds it was given rather than inventing its own', () => {
    const result = table({ a: extraction({ amounts: [amount(1)] }), b: extraction() });
    expect(result.group.reason).toBe('both name BIGMALL and are dated 12 May 2024');
    expect(result.group.confidence).toBe('STRONG_MATCH');
  });

  it('says so when three documents agree and a fourth is silent', () => {
    const four = [bill, screenshot, evidence('c', 'Bank line'), evidence('d', 'Note')];
    const result = table(
      {
        a: extraction({ amounts: [amount(10_000)] }),
        b: extraction({ amounts: [amount(10_000)] }),
        c: extraction({ amounts: [amount(10_000)] }),
        d: extraction(),
      },
      four,
    );

    const row = result.rows.find((entry) => entry.key === 'amount');
    expect(row?.agreement).toBe('AGREES');
    expect(row?.note).toContain('3 documents that carry this');
    expect(row?.cells).toHaveLength(4);
  });

  it('reports a difference when any document in a set of three disagrees', () => {
    const three = [bill, screenshot, evidence('c', 'Bank line')];
    const result = table(
      {
        a: extraction({ amounts: [amount(10_000)] }),
        b: extraction({ amounts: [amount(10_000)] }),
        c: extraction({ amounts: [amount(25_000)] }),
      },
      three,
    );

    expect(result.rows.find((entry) => entry.key === 'amount')?.agreement).toBe('DIFFERS');
  });

  it('agrees on each neighbouring pair of a drifting chain of amounts', () => {
    // Establishes the premise of the test below, and guards it against passing for the wrong
    // reason. ₹100.00 / ₹100.90 / ₹101.80 is a real chain only while each adjacent pair is
    // under the tolerance; if someone tightens the threshold later these two start failing
    // and say so, rather than leaving the order-independence test quietly checking nothing.
    for (const pair of [
      [10_000, 10_090],
      [10_090, 10_180],
    ] as const) {
      const result = table({
        a: extraction({ amounts: [amount(pair[0])] }),
        b: extraction({ amounts: [amount(pair[1])] }),
      });
      expect(result.rows.find((entry) => entry.key === 'amount')?.agreement).toBe('AGREES');
    }
  });

  it('reads a chain of amounts the same way whichever document was uploaded first', () => {
    // The tolerance is not transitive: ₹100.00 agrees with ₹100.90 and ₹100.90 agrees with
    // ₹101.80, but the two ends do not. A predicate that checked every figure against
    // whichever document happened to be listed first would therefore return AGREES or
    // DIFFERS depending purely on upload order — the same three files, two different
    // verdicts. The widest gap in the set is what decides it, in every ordering.
    const documents = [
      [evidence('a', 'Bill'), 10_000],
      [evidence('b', 'Screenshot'), 10_090],
      [evidence('c', 'Bank line'), 10_180],
    ] as const;

    const byId = Object.fromEntries(
      documents.map(([item, minorUnits]) => [item.id, extraction({ amounts: [amount(minorUnits)] })]),
    );

    const orders = permutations(documents.map(([item]) => item));
    expect(orders).toHaveLength(6);

    for (const order of orders) {
      const result = table(byId, order);
      expect(
        result.rows.find((entry) => entry.key === 'amount')?.agreement,
        `order ${order.map((item) => item.id).join('')}`,
      ).toBe('DIFFERS');
    }
  });
});

describe('buildComparisonTables', () => {
  it('drops a group that produced no rows', () => {
    const tables = buildComparisonTables([group()], () => extraction());
    expect(tables).toEqual([]);
  });

  it('keeps a group that produced at least one row', () => {
    const tables = buildComparisonTables([group()], () => extraction({ amounts: [amount(500)] }));
    expect(tables).toHaveLength(1);
    expect(tables[0]?.rows).toHaveLength(1);
  });

  it('preserves the order it was given, which is strongest grounding first', () => {
    const weaker: ComparisonGroup = { ...group(), key: 'SHARED_PARTY:BIGMALL', basis: 'SHARED_PARTY' };
    const tables = buildComparisonTables([group(), weaker], () =>
      extraction({ amounts: [amount(500)] }),
    );
    expect(tables.map((entry) => entry.group.basis)).toEqual(['SHARED_PARTY_AND_DATE', 'SHARED_PARTY']);
  });
});
