/**
 * Text normalization shared by every other normalizer.
 *
 * Rule of the layer: a normalized value is only ever used for *matching*. The
 * original string is always carried alongside it and is what the UI displays, so
 * normalization can never quietly rewrite what a document actually said.
 */

/**
 * Unicode-folds, collapses runs of whitespace and trims. NFKC is used so that
 * full-width characters and ligatures from OCR output compare equal to their
 * ASCII equivalents.
 */
export function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Case-folded form used for keyword and free-text comparison. */
export function normalizeForSearch(value: string): string {
  return normalizeText(value).toLowerCase();
}

/**
 * Strips the punctuation humans sprinkle through reference numbers so that
 * `INV-2024/018`, `inv 2024 018` and `INV2024018` all match.
 */
export function normalizeIdentifier(value: string): string {
  return normalizeText(value)
    .toUpperCase()
    .replace(/[\s._\-/\\#:]+/g, '');
}

export function normalizeEmail(value: string): string {
  return normalizeText(value).toLowerCase();
}

/** Keeps a leading `+` for international numbers and discards all other formatting. */
export function normalizePhone(value: string): string {
  const digits = normalizeText(value).replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? `+${digits.slice(1).replace(/\+/g, '')}` : digits.replace(/\+/g, '');
}

/**
 * Person and organisation names: folded for comparison but word order is preserved,
 * because "Sharma Ravi" and "Ravi Sharma" are not reliably the same person.
 */
export function normalizeName(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(pvt|private|ltd|limited|inc|llc|llp|co|corp|company)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncates long source text for storage while noting that truncation happened. */
export function clampText(value: string, maxLength: number): { text: string; truncated: boolean } {
  if (value.length <= maxLength) return { text: value, truncated: false };
  return { text: value.slice(0, maxLength), truncated: true };
}

/**
 * The first code point of each ten-digit block this app folds to ASCII.
 *
 * Every block listed is ten contiguous code points in ascending value order, which is what
 * makes the arithmetic in `foldDigits` valid; each was checked against Unicode's `Nd`
 * category before being added. The Indic scripts are here because the product is built for
 * Indian evidence — a bill printed in Hindi, Bengali or Tamil states its total in that
 * script's digits — and the two Arabic blocks because AED is a supported currency.
 * Fullwidth digits come out of OCR on scans of CJK-locale documents.
 *
 * Superscripts, circled digits and Roman numerals are deliberately absent: they are not
 * positional decimal digits, so folding them would invent a number the document never
 * stated.
 */
const DIGIT_BLOCK_ZEROS = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Odia
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0xff10, // Fullwidth
] as const;

/**
 * Rewrites non-ASCII decimal digits as `0`-`9`, leaving every other character untouched.
 *
 * JavaScript's `\d` matches ASCII only and NFKC does not transliterate between scripts
 * (verified: `'₹१००'.normalize('NFKC')` is unchanged). So without this, a bill reading
 * `₹१००` produced no amount at all — not a wrong one, simply nothing, which is the worse
 * failure here because the document looks like it was read successfully.
 *
 * **Length and index preserving.** Each digit is one code point in, one code point out, so
 * a match index taken against folded text points at the same character in the original.
 * Callers rely on this to search the folded copy and still quote the source verbatim.
 *
 * Implemented as a code-point loop rather than a `\p{Nd}` regex because this runs on Hermes
 * on-device, where Unicode property escape support is not something to bet a silent
 * extraction failure on.
 */
export function foldDigits(value: string): string {
  let out = '';
  let changed = false;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    // Fast path: ASCII, which is almost every character of almost every document.
    if (code < 0x0660) {
      out += char;
      continue;
    }
    const zero = DIGIT_BLOCK_ZEROS.find((base) => code >= base && code <= base + 9);
    if (zero === undefined) {
      out += char;
      continue;
    }
    out += String(code - zero);
    changed = true;
  }
  return changed ? out : value;
}
