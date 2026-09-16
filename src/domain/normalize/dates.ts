import type { DatePrecision } from '../enums';
import { normalizeText } from './text';

/**
 * Date normalization.
 *
 * Evidence dates arrive in every format humans use. The goal is a single comparable
 * ISO value *plus* an honest record of how much the system actually knows:
 *
 * - `iso` is `null` when nothing parseable was found. Downstream rules skip these
 *   rather than guessing.
 * - `precision` distinguishes "5 March 2024" from "March 2024" from "2024". A
 *   conflict rule must not report a disagreement between a day and the month that
 *   contains it.
 * - `ambiguous` marks the `03/04/2024` problem, where day-first and month-first
 *   readings are both valid. Detact refuses to silently pick one: ambiguous
 *   dates are parsed under the configured locale order but flagged so the UI can
 *   ask, and so conflict rules can downgrade their severity.
 */
export interface NormalizedDate {
  /** Exactly as it appeared in the source. Never modified. */
  original: string;
  /** `YYYY-MM-DD`, `YYYY-MM` or `YYYY` depending on precision; `null` if unparseable. */
  iso: string | null;
  precision: DatePrecision;
  /** True when day-first and month-first readings would both be valid. */
  ambiguous: boolean;
}

/** Which reading wins for a bare numeric date like `03/04/2024`. */
export type DateOrder = 'DMY' | 'MDY';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const unparsed = (original: string): NormalizedDate => ({
  original,
  iso: null,
  precision: 'UNKNOWN',
  ambiguous: false,
});

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const pad = (value: number, width: number) => String(value).padStart(width, '0');

function toDay(year: number, month: number, day: number, original: string, ambiguous: boolean): NormalizedDate {
  if (!isRealDate(year, month, day)) return unparsed(original);
  return { original, iso: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`, precision: 'DAY', ambiguous };
}

/**
 * Parses a single date string. Returns an unparsed result rather than throwing,
 * because extraction runs over noisy OCR text where most candidates are not dates.
 */
export function normalizeDate(input: string, order: DateOrder = 'DMY'): NormalizedDate {
  const original = input;
  const text = normalizeText(input).replace(/^(on|dated|date)\s*[:\-]?\s*/i, '');
  if (!text) return unparsed(original);

  // ISO 8601, optionally with a time component we deliberately discard.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+.*)?$/.exec(text);
  if (iso) return toDay(Number(iso[1]), Number(iso[2]), Number(iso[3]), original, false);

  const isoMonth = /^(\d{4})-(\d{2})$/.exec(text);
  if (isoMonth) {
    const month = Number(isoMonth[2]);
    if (month < 1 || month > 12) return unparsed(original);
    return { original, iso: `${isoMonth[1]}-${pad(month, 2)}`, precision: 'MONTH', ambiguous: false };
  }

  // Slash / dot / dash separated numerics: 15-03-2024, 03.15.2024, 15/3/24.
  const numeric = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(text);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const third = Number(numeric[3]);

    // A four digit leading number can only be a year: 2024/03/15.
    if (String(numeric[1]).length === 4) return toDay(first, second, third, original, false);

    const year = third < 100 ? 2000 + third : third;
    const dayFirstValid = isRealDate(year, second, first);
    const monthFirstValid = isRealDate(year, first, second);

    if (dayFirstValid && monthFirstValid && first !== second) {
      // Both readings are real dates, e.g. 03/04/2024. Honour the configured order
      // but record that the source itself is ambiguous.
      return order === 'DMY'
        ? toDay(year, second, first, original, true)
        : toDay(year, first, second, original, true);
    }
    if (dayFirstValid) return toDay(year, second, first, original, false);
    if (monthFirstValid) return toDay(year, first, second, original, false);
    return unparsed(original);
  }

  // Named months: "15 March 2024", "March 15, 2024", "Mar 15 2024", "15th Mar 2024".
  const cleaned = text.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, '');
  const dayMonthYear = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{2,4})$/.exec(cleaned);
  if (dayMonthYear) {
    const month = MONTHS[dayMonthYear[2]!.toLowerCase()];
    if (month) {
      const rawYear = Number(dayMonthYear[3]);
      return toDay(rawYear < 100 ? 2000 + rawYear : rawYear, month, Number(dayMonthYear[1]), original, false);
    }
  }

  const monthDayYear = /^([A-Za-z]+)\s+(\d{1,2})\s+(\d{2,4})$/.exec(cleaned);
  if (monthDayYear) {
    const month = MONTHS[monthDayYear[1]!.toLowerCase()];
    if (month) {
      const rawYear = Number(monthDayYear[3]);
      return toDay(rawYear < 100 ? 2000 + rawYear : rawYear, month, Number(monthDayYear[2]), original, false);
    }
  }

  // Month precision: "March 2024".
  const monthYear = /^([A-Za-z]+)\s+(\d{4})$/.exec(cleaned);
  if (monthYear) {
    const month = MONTHS[monthYear[1]!.toLowerCase()];
    if (month) {
      return { original, iso: `${monthYear[2]}-${pad(month, 2)}`, precision: 'MONTH', ambiguous: false };
    }
  }

  const yearOnly = /^(19|20)\d{2}$/.exec(cleaned);
  if (yearOnly) return { original, iso: cleaned, precision: 'YEAR', ambiguous: false };

  return unparsed(original);
}

/** Sort key that keeps coarser dates adjacent to the period they describe. */
export function dateSortKey(value: NormalizedDate): string {
  if (!value.iso) return '9999-99-99';
  if (value.precision === 'YEAR') return `${value.iso}-00-00`;
  if (value.precision === 'MONTH') return `${value.iso}-00`;
  return value.iso;
}

/**
 * Whether two dates genuinely disagree.
 *
 * Comparison happens at the coarser of the two precisions, so "March 2024" does not
 * contradict "15 March 2024" — a month-precision source simply cannot disagree about
 * a day. This is what stops the conflict rule from generating noise.
 */
export function datesConflict(a: NormalizedDate, b: NormalizedDate): boolean {
  if (!a.iso || !b.iso) return false;
  if (a.precision === 'UNKNOWN' || b.precision === 'UNKNOWN') return false;
  const width = Math.min(a.iso.length, b.iso.length);
  return a.iso.slice(0, width) !== b.iso.slice(0, width);
}

/** Whole days between two day-precision dates; `null` when either is coarser. */
export function daysBetween(a: NormalizedDate, b: NormalizedDate): number | null {
  if (a.precision !== 'DAY' || b.precision !== 'DAY' || !a.iso || !b.iso) return null;
  const first = Date.parse(`${a.iso}T00:00:00Z`);
  const second = Date.parse(`${b.iso}T00:00:00Z`);
  if (Number.isNaN(first) || Number.isNaN(second)) return null;
  return Math.round((second - first) / 86_400_000);
}

/**
 * Month names for display, indexed by month number minus one.
 *
 * Held separately from `MONTHS` rather than derived from it. `MONTHS` is a parsing table:
 * it maps every spelling a document might use onto a number, and several months have more
 * than one entry. Searching it backwards for "the long spelling of month 5" cannot work —
 * May has no long spelling, so the search found nothing and the date rendered as the digit
 * `05`, and September matched the abbreviation `sept` before its full name. Those strings
 * are not only shown on screen: they are written into finding explanations and into the
 * `Compared because` line stored on a finding, so a May transaction was permanently
 * recorded as "15 05 2024".
 *
 * A separate list has one entry per month and no choice to get wrong.
 */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Renders a normalized date for display, preserving stated uncertainty. */
export function formatDate(value: NormalizedDate): string {
  if (!value.iso) return value.original || 'Undated';
  if (value.precision === 'YEAR') return value.iso;

  const [year, month, day] = value.iso.split('-');
  // A stored ISO string always carries a real month, but this reads a persisted record
  // and must not produce `undefined` in a report if one is ever malformed.
  const label = MONTH_NAMES[Number(month) - 1] ?? month;

  if (value.precision === 'MONTH') return `${label} ${year}`;
  return `${Number(day)} ${label} ${year}`;
}
