import type { Evidence, Extraction, TextField } from '../models';
import { TEXT_FIELD_KEYS } from '../models';
import { normalizeDate } from '../normalize/dates';
import { normalizeAmount } from '../normalize/money';
import { normalizeIdentifier, normalizeText } from '../normalize/text';

/**
 * Precedence between human and machine values.
 *
 * A user who corrects an OCR misread of an invoice number must not have that
 * correction undone the next time processing runs. Corrections therefore live in
 * `evidence.confirmedFields`, keyed by a field path, and are layered *over* the raw
 * machine extraction at read time rather than written into it.
 *
 * The rest of the app reads `effectiveExtraction(evidence)` and never
 * `evidence.extraction` directly.
 */

/** Field paths are `documentType`, `title`, or `<listKey>.<index>` e.g. `invoiceNumbers.0`. */
export function fieldPath(key: string, index?: number): string {
  return index === undefined ? key : `${key}.${index}`;
}

function overrideTextField(field: TextField, value: string): TextField {
  return {
    ...field,
    original: value,
    normalized: normalizeIdentifier(value) || normalizeText(value),
    method: 'MANUAL',
    sourceQuote: field.sourceQuote,
  };
}

/**
 * Applies confirmed overrides to a raw extraction.
 * Returns `null` when the evidence has never been processed and has no manual values.
 */
export function effectiveExtraction(evidence: Pick<Evidence, 'extraction' | 'confirmedFields'>): Extraction | null {
  const base = evidence.extraction;
  if (!base) return null;

  const overrides = evidence.confirmedFields;
  if (!overrides || Object.keys(overrides).length === 0) return base;

  const result: Extraction = { ...base };

  if (overrides.documentType) result.documentType = overrides.documentType;
  if (overrides.title) result.title = overrides.title;
  if (overrides.summary) result.summary = overrides.summary;

  for (const key of TEXT_FIELD_KEYS) {
    const list = base[key];
    if (!list.length) continue;
    result[key] = list.map((field, index) => {
      const override = overrides[fieldPath(key, index)];
      return override === undefined ? field : overrideTextField(field, override);
    });
  }

  result.dates = base.dates.map((field, index) => {
    const override = overrides[fieldPath('dates', index)];
    if (override === undefined) return field;
    const parsed = normalizeDate(override);
    return {
      ...field,
      original: override,
      iso: parsed.iso,
      precision: parsed.precision,
      // A human-entered date is authoritative, so it is no longer treated as ambiguous.
      ambiguous: false,
      method: 'MANUAL',
    };
  });

  result.amounts = base.amounts.map((field, index) => {
    const override = overrides[fieldPath('amounts', index)];
    if (override === undefined) return field;
    const parsed = normalizeAmount(override, field.currency);
    if (!parsed) return field;
    return { ...field, original: override, minorUnits: parsed.minorUnits, method: 'MANUAL' };
  });

  return result;
}

/** True when a human has confirmed the specific field at this path. */
export function isFieldConfirmed(evidence: Pick<Evidence, 'confirmedFields'>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(evidence.confirmedFields ?? {}, path);
}

/**
 * Counts how much of an extraction a human has actually reviewed. Drives the
 * "evidence health" indicator on the case screen.
 */
export function confirmationStats(evidence: Pick<Evidence, 'extraction' | 'confirmedFields'>): {
  total: number;
  confirmed: number;
} {
  const base = evidence.extraction;
  if (!base) return { total: 0, confirmed: 0 };
  const total =
    base.dates.length + base.amounts.length + TEXT_FIELD_KEYS.reduce((sum, key) => sum + base[key].length, 0);
  return { total, confirmed: Object.keys(evidence.confirmedFields ?? {}).length };
}

/**
 * Merges an AI-proposed extraction into a deterministic one.
 *
 * Deliberately additive: AI values are only appended where the deterministic pass
 * found nothing for that field, and they keep `method: 'AI'` plus their provenance so
 * the UI can render them differently and the user can reject them. AI never edits or
 * removes a deterministic value.
 */
export function mergeAiExtraction(
  deterministic: Extraction,
  ai: Partial<Extraction>,
  provenance: { model: string; extractionVersion: string },
): Extraction {
  const merged: Extraction = { ...deterministic };

  for (const key of TEXT_FIELD_KEYS) {
    const proposed = ai[key];
    if (!proposed?.length) continue;
    const existing = new Set(merged[key].map((field) => field.normalized));
    const additions = proposed
      .filter((field) => !existing.has(field.normalized))
      .map((field) => ({ ...field, method: 'AI' as const, ...provenance }));
    merged[key] = [...merged[key], ...additions];
  }

  if (ai.dates?.length) {
    const existing = new Set(merged.dates.map((field) => `${field.iso}|${field.role ?? ''}`));
    merged.dates = [
      ...merged.dates,
      ...ai.dates
        .filter((field) => !existing.has(`${field.iso}|${field.role ?? ''}`))
        .map((field) => ({ ...field, method: 'AI' as const, ...provenance })),
    ];
  }

  if (ai.amounts?.length) {
    const existing = new Set(merged.amounts.map((field) => `${field.currency}:${field.minorUnits}`));
    merged.amounts = [
      ...merged.amounts,
      ...ai.amounts
        .filter((field) => !existing.has(`${field.currency}:${field.minorUnits}`))
        .map((field) => ({ ...field, method: 'AI' as const, ...provenance })),
    ];
  }

  // A generic deterministic classification defers to the model; a specific one does not.
  if (ai.documentType && merged.documentType === 'Document') merged.documentType = ai.documentType;
  if (ai.summary && !merged.summary) merged.summary = ai.summary;

  return merged;
}
