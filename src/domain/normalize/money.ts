import { normalizeText } from './text';

/**
 * Monetary normalization.
 *
 * Amounts are stored as integer **minor units** (paise, cents) with an explicit
 * currency. Floating point is never used for money: `0.1 + 0.2 !== 0.3` would make
 * the amount-mismatch rule report conflicts that do not exist.
 */
export interface NormalizedAmount {
  /** The text exactly as it appeared in the source. */
  original: string;
  /** Integer value in the currency's smallest unit. */
  minorUnits: number;
  /** ISO 4217 code. */
  currency: string;
}

/** Minor-unit exponent per ISO 4217. Most currencies use 2; a few do not. */
const CURRENCY_EXPONENT: Record<string, number> = {
  INR: 2, USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, SGD: 2, AED: 2, CHF: 2, CNY: 2, NZD: 2, ZAR: 2,
  JPY: 0, KRW: 0,
  BHD: 3, KWD: 3, OMR: 3,
};

const SYMBOL_TO_CURRENCY: Record<string, string> = {
  '₹': 'INR',
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₩': 'KRW',
  '₽': 'RUB',
};

export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENT[currency.toUpperCase()] ?? 2;
}

export function isKnownCurrency(currency: string): boolean {
  return currency.toUpperCase() in CURRENCY_EXPONENT;
}

/**
 * Separates the thousands separator from the decimal separator.
 *
 * Ambiguity is real: `1.234` is one thousand two hundred thirty-four in Germany and
 * one point two three four elsewhere. The heuristic below resolves it structurally —
 * whichever separator appears *last* is the decimal one, and a group of exactly three
 * digits after a lone separator is read as a thousands group.
 *
 * Indian grouping (`1,00,000`) is handled because the separators are simply removed
 * once identified as grouping characters.
 */
function parseDecimalString(raw: string): { negative: boolean; whole: string; fraction: string } | null {
  let text = raw.trim();
  let negative = false;

  // Accounting notation: (1,200.00) means negative.
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1).trim();
  }
  if (text.startsWith('+')) text = text.slice(1).trim();

  if (!/^[\d.,\s]+$/.test(text) || !/\d/.test(text)) return null;
  text = text.replace(/\s/g, '');

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');

  let decimalSeparator: '.' | ',' | null = null;
  if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastComma > lastDot ? ',' : '.';
  } else if (lastComma >= 0 || lastDot >= 0) {
    const only = lastComma >= 0 ? ',' : '.';
    const tail = text.slice((lastComma >= 0 ? lastComma : lastDot) + 1);
    const occurrences = text.split(only).length - 1;
    // A single separator followed by exactly three digits is grouping, not a decimal,
    // unless it is the only separator in a short number like "1,50" — but "1,500" is
    // far more common than a two-decimal comma in the same corpus, so three digits wins.
    decimalSeparator = occurrences === 1 && tail.length !== 3 ? only : null;
  }

  const whole = decimalSeparator
    ? text.slice(0, text.lastIndexOf(decimalSeparator)).replace(/[.,]/g, '')
    : text.replace(/[.,]/g, '');
  const fraction = decimalSeparator ? text.slice(text.lastIndexOf(decimalSeparator) + 1) : '';

  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || (!whole && !fraction)) return null;
  return { negative, whole: whole || '0', fraction };
}

/**
 * Converts a numeric string into minor units for the given currency.
 * Returns `null` for anything it cannot parse exactly — a wrong amount is far worse
 * than a missing one.
 */
export function normalizeAmount(input: string, currency: string): NormalizedAmount | null {
  const code = currency.toUpperCase();
  const exponent = currencyExponent(code);

  // Strip a leading or trailing currency code / symbol before parsing digits.
  const stripped = normalizeText(input)
    .replace(/\b(INR|USD|EUR|GBP|AUD|CAD|SGD|AED|CHF|CNY|NZD|ZAR|JPY|KRW|BHD|KWD|OMR|Rs\.?)\b/gi, '')
    .replace(/[₹$€£¥₩₽]/g, '')
    .replace(/\b(only|\/-)\b/gi, '')
    .trim();

  const parsed = parseDecimalString(stripped);
  if (!parsed) return null;

  // More decimal places than the currency supports means this is not an amount
  // (usually a version number or an identifier that slipped through).
  if (parsed.fraction.length > exponent) return null;

  const minor = Number(parsed.whole) * 10 ** exponent + Number(parsed.fraction.padEnd(exponent, '0') || '0');
  if (!Number.isSafeInteger(minor)) return null;

  return { original: input, minorUnits: parsed.negative ? -minor : minor, currency: code };
}

/**
 * Detects the currency stated in a fragment of text. Returns `null` rather than
 * defaulting, so an amount is never silently attributed to the wrong currency.
 */
export function detectCurrency(text: string): string | null {
  const code = /\b(INR|USD|EUR|GBP|AUD|CAD|SGD|AED|CHF|CNY|NZD|ZAR|JPY|KRW|BHD|KWD|OMR)\b/i.exec(text);
  if (code) return code[1]!.toUpperCase();
  if (/\bRs\.?\b/i.test(text)) return 'INR';
  for (const [symbol, currency] of Object.entries(SYMBOL_TO_CURRENCY)) {
    if (text.includes(symbol)) return currency;
  }
  return null;
}

export function formatAmount(amount: NormalizedAmount): string {
  const exponent = currencyExponent(amount.currency);
  const negative = amount.minorUnits < 0;
  const absolute = Math.abs(amount.minorUnits);
  const whole = Math.floor(absolute / 10 ** exponent);
  const fraction = absolute % 10 ** exponent;
  const grouped = whole.toLocaleString('en-US');
  const body = exponent === 0 ? grouped : `${grouped}.${String(fraction).padStart(exponent, '0')}`;
  return `${negative ? '-' : ''}${amount.currency} ${body}`;
}

/**
 * Relative difference between two amounts of the same currency, as a fraction of the
 * larger one. Returns `null` for mismatched currencies: CaseGraph does not hold
 * exchange rates and will not invent a comparison across them.
 */
export function relativeDifference(a: NormalizedAmount, b: NormalizedAmount): number | null {
  if (a.currency !== b.currency) return null;
  const largest = Math.max(Math.abs(a.minorUnits), Math.abs(b.minorUnits));
  if (largest === 0) return a.minorUnits === b.minorUnits ? 0 : 1;
  return Math.abs(a.minorUnits - b.minorUnits) / largest;
}
