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
