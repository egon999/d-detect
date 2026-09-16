import { describe, expect, it } from 'vitest';
import {
  dateSortKey,
  datesConflict,
  daysBetween,
  formatDate,
  normalizeDate,
} from '@domain/normalize/dates';

describe('normalizeDate', () => {
  it('parses ISO dates and discards any time component', () => {
    expect(normalizeDate('2024-03-15')).toMatchObject({ iso: '2024-03-15', precision: 'DAY' });
    expect(normalizeDate('2024-03-15T18:30:00Z').iso).toBe('2024-03-15');
  });

  it('reads bare numeric dates day-first by default', () => {
    expect(normalizeDate('15/03/2024').iso).toBe('2024-03-15');
    expect(normalizeDate('15.03.2024').iso).toBe('2024-03-15');
    expect(normalizeDate('15-3-24').iso).toBe('2024-03-15');
  });

  it('falls back to the only valid reading when one is impossible', () => {
    // 25 cannot be a month, so this is unambiguously 25 March even under MDY.
    expect(normalizeDate('25/03/2024', 'MDY').iso).toBe('2024-03-25');
    expect(normalizeDate('25/03/2024', 'MDY').ambiguous).toBe(false);
  });

  it('flags dates where both readings are valid instead of silently picking one', () => {
    const dmy = normalizeDate('03/04/2024', 'DMY');
    const mdy = normalizeDate('03/04/2024', 'MDY');
    expect(dmy.iso).toBe('2024-04-03');
    expect(mdy.iso).toBe('2024-03-04');
    expect(dmy.ambiguous).toBe(true);
    expect(mdy.ambiguous).toBe(true);
  });

  it('does not flag ambiguity when day and month are the same number', () => {
    expect(normalizeDate('05/05/2024').ambiguous).toBe(false);
  });

  it('treats a four-digit leading number as a year', () => {
    expect(normalizeDate('2024/03/15').iso).toBe('2024-03-15');
  });

  it('parses named months in both orders', () => {
    expect(normalizeDate('15 March 2024').iso).toBe('2024-03-15');
    expect(normalizeDate('March 15, 2024').iso).toBe('2024-03-15');
    expect(normalizeDate('15th Mar 2024').iso).toBe('2024-03-15');
    expect(normalizeDate('Sept 3 2024').iso).toBe('2024-09-03');
  });

  it('records coarser precision rather than inventing a day', () => {
    expect(normalizeDate('March 2024')).toMatchObject({ iso: '2024-03', precision: 'MONTH' });
    expect(normalizeDate('2024-03')).toMatchObject({ iso: '2024-03', precision: 'MONTH' });
    expect(normalizeDate('2024')).toMatchObject({ iso: '2024', precision: 'YEAR' });
  });

  it('rejects impossible and unparseable values instead of guessing', () => {
    expect(normalizeDate('32/13/2024').iso).toBeNull();
    expect(normalizeDate('2024-02-30').iso).toBeNull();
    expect(normalizeDate('invoice total').iso).toBeNull();
    expect(normalizeDate('').iso).toBeNull();
  });

  it('always preserves the original text', () => {
    expect(normalizeDate('  15 March 2024  ').original).toBe('  15 March 2024  ');
  });
});

describe('datesConflict', () => {
  it('reports a genuine disagreement between two day-precision dates', () => {
    expect(datesConflict(normalizeDate('12 March 2024'), normalizeDate('15 March 2024'))).toBe(true);
  });

  it('compares at the coarser precision, so a month never contradicts a day inside it', () => {
    expect(datesConflict(normalizeDate('March 2024'), normalizeDate('15 March 2024'))).toBe(false);
    expect(datesConflict(normalizeDate('2024'), normalizeDate('15 March 2024'))).toBe(false);
  });

  it('still reports a conflict when the coarser date points elsewhere', () => {
    expect(datesConflict(normalizeDate('April 2024'), normalizeDate('15 March 2024'))).toBe(true);
  });

  it('abstains when either side could not be parsed', () => {
    expect(datesConflict(normalizeDate('nonsense'), normalizeDate('15 March 2024'))).toBe(false);
  });
});

describe('date helpers', () => {
  it('sorts coarse dates alongside the period they describe', () => {
    const keys = ['15 March 2024', 'March 2024', '2024', '2023'].map((value) =>
      dateSortKey(normalizeDate(value)),
    );
    expect([...keys].sort()).toEqual(['2023-00-00', '2024-00-00', '2024-03-00', '2024-03-15']);
  });

  it('counts whole days only between two day-precision dates', () => {
    expect(daysBetween(normalizeDate('2024-03-12'), normalizeDate('2024-03-26'))).toBe(14);
    expect(daysBetween(normalizeDate('2024-03-26'), normalizeDate('2024-03-12'))).toBe(-14);
    expect(daysBetween(normalizeDate('March 2024'), normalizeDate('2024-03-26'))).toBeNull();
  });

  it('formats without implying more precision than was recorded', () => {
    expect(formatDate(normalizeDate('2024-03-15'))).toBe('15 March 2024');
    expect(formatDate(normalizeDate('March 2024'))).toBe('March 2024');
    expect(formatDate(normalizeDate('2024'))).toBe('2024');
    expect(formatDate(normalizeDate('not a date'))).toBe('not a date');
  });

  it('names every month, including the ones whose abbreviation is also their full name', () => {
    // The display name used to be searched for in the month *parsing* table, which maps
    // several spellings onto one month number. May has no long spelling to find, so it
    // fell through to the two-digit month and every May date read "15 05 2024"; September
    // matched the abbreviation first and read "3 Sept 2024". Both strings are written into
    // finding explanations and stored on the finding, so a wrong one is not just cosmetic —
    // it is persisted. All twelve are asserted because the failure was silent per-month.
    const expected = [
      ['01', 'January'],
      ['02', 'February'],
      ['03', 'March'],
      ['04', 'April'],
      ['05', 'May'],
      ['06', 'June'],
      ['07', 'July'],
      ['08', 'August'],
      ['09', 'September'],
      ['10', 'October'],
      ['11', 'November'],
      ['12', 'December'],
    ] as const;

    for (const [month, name] of expected) {
      expect(formatDate(normalizeDate(`2024-${month}-15`))).toBe(`15 ${name} 2024`);
      expect(formatDate(normalizeDate(`2024-${month}`))).toBe(`${name} 2024`);
    }
  });
});
