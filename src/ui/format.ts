/**
 * Display formatting.
 *
 * Pure functions, no React Native import, so they are unit tested directly.
 *
 * These sit *above* the domain's own `formatAmount` / `formatDate` rather than replacing
 * them. The domain formatters answer "what is this value"; these answer "how should this
 * value be shown to a person who is deciding whether to trust it". That distinction
 * matters for dates especially, where the honest answer is often two strings — what the
 * document said, and what the system read it as.
 */

import { currencyExponent, formatAmount } from '@domain/normalize/money';
import { formatDate } from '@domain/normalize/dates';
import type { NormalizedDate } from '@domain/normalize/dates';
import type { AmountField, DateField } from '@domain/models';
import type { ExtractionMethod } from '@domain/enums';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Symbols for the currencies the normalizer recognises. A currency with no entry here
 * falls back to its ISO code, which is the correct behaviour: `AED 4,000` is clearer
 * than a symbol the reader may not know.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  AED: 'AED ',
  SGD: 'S$',
  AUD: 'A$',
  CAD: 'C$',
};

/**
 * A compact amount for tables and dense lists — symbol plus grouped digits, no decimals
 * when the value is whole. `formatAmount` from the domain is authoritative and always
 * includes the currency code; this is the display variant for places where the currency
 * is already established by context (a column header, a case with one currency).
 */
export function formatMoneyCompact(minorUnits: number, currency: string): string {
  // The domain owns the currency table — deliberately not duplicated here, since a
  // currency with a non-2 exponent (JPY, KWD, BHD) would otherwise be rendered 100x wrong.
  const exponent = currencyExponent(currency);
  const negative = minorUnits < 0;
  const absolute = Math.abs(minorUnits);
  const whole = Math.floor(absolute / 10 ** exponent);
  const fraction = absolute % 10 ** exponent;
  // `en-IN` grouping (12,34,567) suits the primary audience; the fallback for readers
  // elsewhere is acceptable because the digits are identical, only separators differ.
  const grouped = whole.toLocaleString('en-IN');
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const body = exponent === 0 || fraction === 0
    ? grouped
    : `${grouped}.${String(fraction).padStart(exponent, '0')}`;
  return `${negative ? '-' : ''}${symbol}${body}`;
}

/**
 * The fully-qualified form, e.g. "INR 40,000.00". Used where no column context exists.
 *
 * `formatAmount` needs an `original` string for its signature, but never reads it — the
 * value it prints is derived entirely from `minorUnits` and `currency`. Passing the
 * rendered form keeps that contract honest rather than inventing a source string.
 */
export function formatMoneyFull(amount: AmountField): string {
  const rendered = formatMoneyCompact(amount.minorUnits, amount.currency);
  return formatAmount({
    original: rendered,
    minorUnits: amount.minorUnits,
    currency: amount.currency,
  });
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export interface DateDisplay {
  /** What the document actually said, verbatim. */
  original: string;
  /** The parsed reading, e.g. "3 April 2024"; empty when nothing was parsed. */
  normalized: string;
  /** True when a `03/04/2024` reading could go either way. */
  ambiguous: boolean;
  /** Extra context to show beside the date, if any. */
  hint: string | null;
}

/**
 * Renders a date for display, preserving uncertainty.
 *
 * The ambiguity signal is the important part. A date the system had to guess at is shown
 * as a guess, with the original beside it, so a user reviewing a case never sees a
 * confident-looking date that the system inferred from an ambiguous source.
 */
export function describeDate(field: DateField): DateDisplay {
  const normalized = {
    original: field.original,
    iso: field.iso,
    precision: field.precision,
    ambiguous: field.ambiguous,
  } satisfies NormalizedDate;

  const rendered = field.iso ? formatDate(normalized) : '';

  let hint: string | null = null;
  if (field.ambiguous) {
    hint = 'Ambiguous — day and month could be read either way';
  } else if (field.precision === 'MONTH') {
    hint = 'Month only — the exact day is not stated';
  } else if (field.precision === 'YEAR') {
    hint = 'Year only — the exact date is not stated';
  } else if (!field.iso) {
    hint = 'No date could be read from the source';
  }

  return { original: field.original, normalized: rendered, ambiguous: field.ambiguous, hint };
}

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Relative time for recency indicators ("2 days ago", "just now").
 *
 * Only ever used for *system* timestamps — upload time, last analysis run, audit entries.
 * Never for evidence dates: "3 months ago" is the wrong register for a date on an
 * invoice, and this function deliberately does not accept a precision-less date.
 *
 * Beyond a month it switches to an absolute date, because "7 weeks ago" is harder to
 * place than "12 Aug".
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const delta = now - timestamp;
  if (delta < 0) return 'Just now';
  if (delta < MINUTE) return 'Just now';
  if (delta < HOUR) {
    const minutes = Math.floor(delta / MINUTE);
    return `${minutes} min ago`;
  }
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(delta / DAY);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  return formatAbsoluteDate(timestamp);
}

/** Short absolute date, e.g. "12 Aug" or "12 Aug 2025" if not the current year. */
export function formatAbsoluteDate(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  const month = date.toLocaleString('en-GB', { month: 'short' });
  const sameYear = new Date(now).getFullYear() === date.getFullYear();
  return sameYear
    ? `${date.getDate()} ${month}`
    : `${date.getDate()} ${month} ${date.getFullYear()}`;
}

/** Full timestamp for audit entries, to the minute. */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const day = date.getDate();
  const month = date.toLocaleString('en-GB', { month: 'short' });
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${day} ${month} ${date.getFullYear()}, ${time}`;
}

// ---------------------------------------------------------------------------
// Files and counts
// ---------------------------------------------------------------------------

/** Byte size, e.g. "1.4 MB". Uses decimal units, which is what file managers report. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${rounded} ${units[unitIndex]}`;
}

/** `1 item` / `4 items`. Used everywhere a count appears, so no screen writes "1 items". */
export function pluralize(count: number, singular: string, plural?: string): string {
  if (count === 1) return `${count} ${singular}`;
  return `${count} ${plural ?? `${singular}s`}`;
}

/** Count without the noun, for tight spaces like a tab badge. */
export function formatCount(count: number): string {
  if (count > 999) return `${Math.floor(count / 100) / 10}k`;
  return String(count);
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * A short, human sentence for a provenance method — used in the value popover that
 * answers "where did this come from?".
 *
 * `sourceQuote` is truncated rather than shown in full: it appears on a card, and the
 * full surrounding text is available on the evidence detail screen.
 */
export function describeProvenance(
  method: ExtractionMethod,
  sourceQuote?: string,
  maxQuoteLength = 140,
): string {
  const source = sourceQuote?.trim();
  const quoted =
    source && source.length > 0
      ? `"${source.length > maxQuoteLength ? `${source.slice(0, maxQuoteLength).trimEnd()}…` : source}"`
      : null;

  switch (method) {
    case 'MANUAL':
      return 'Entered by hand and confirmed by a person.';
    case 'DETERMINISTIC':
      return quoted ? `Read directly from the document text: ${quoted}` : 'Read directly from the document text.';
    case 'OCR':
      // Says "an image", never "the document": these characters were guessed at from
      // pixels, and the reader is told so plainly rather than left to infer it from a
      // colour. The nudge to check is the point — a misread digit here is the failure
      // mode the whole provenance system exists to catch.
      return quoted
        ? `Read from an image on this device. Characters can be misread, so check it against the original: ${quoted}`
        : 'Read from an image on this device. Characters can be misread, so check it against the original.';
    case 'AI':
      return quoted ? `Suggested by a language model: ${quoted}` : 'Suggested by a language model, not yet confirmed.';
  }
}

/** Truncates a string to `max` characters on a word boundary where possible. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const clipped = value.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');
  const body = lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}…`;
}

/** Sentence case for a SCREAMING_CASE enum value, as a fallback. Prefer the label maps. */
export function humanizeEnum(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Initials for an avatar, max two characters. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]!}${parts[parts.length - 1]![0]!}`.toUpperCase();
}
