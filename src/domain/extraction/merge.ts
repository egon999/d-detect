import type { Evidence, Extraction, TextField, TextFieldKey } from '../models';
import { TEXT_FIELD_KEYS } from '../models';
import { normalizeDate } from '../normalize/dates';
import { normalizeAmount } from '../normalize/money';
import {
  normalizeEmail,
  normalizeIdentifier,
  normalizeName,
  normalizePhone,
  normalizeText,
} from '../normalize/text';

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

/** Reads the index back out of a `<listKey>.<index>` path; `null` when the path is not one. */
function parseFieldIndex(path: string): number | null {
  const match = /\.(\d+)$/.exec(path);
  return match ? Number(match[1]) : null;
}

/**
 * The normalizer each kind of text field is measured with.
 *
 * One normalizer for all of them is wrong, and this is the bug it caused: a corrected
 * name was normalized with `normalizeIdentifier`, which uppercases and strips spaces —
 * so a user fixing "Ravi Shrma" to "Ravi Sharma" stored the normalized value
 * `RAVISHARMA`. Any later comparison of that person against the same name read from
 * another document found nothing, and the entity silently stopped linking. The point of
 * a correction is to make the two records agree, so the corrected value has to be folded
 * the same way the extracted one was. This mirrors, key for key, what the extractor does.
 *
 * `keywords` is the exception: the extractor stores keywords already lowercased as
 * `original`, so there is no folding step to reproduce beyond lowercasing.
 */
const NORMALIZER_FOR: Record<TextFieldKey, (value: string) => string> = {
  people: normalizeName,
  organizations: normalizeName,
  emails: normalizeEmail,
  phones: normalizePhone,
  invoiceNumbers: normalizeIdentifier,
  orderNumbers: normalizeIdentifier,
  transactionIds: normalizeIdentifier,
  addresses: normalizeText,
  keywords: (value) => normalizeText(value).toLowerCase(),
};

function overrideTextField(
  field: TextField,
  value: string,
  key: TextFieldKey,
): TextField {
  return {
    ...field,
    original: value,
    normalized: NORMALIZER_FOR[key](value),
    method: 'MANUAL',
    sourceQuote: field.sourceQuote,
  };
}

/**
 * A kind of text field the extractor has a `sourceQuote` convention for. Every key in
 * `TEXT_FIELD_KEYS` is read out of a passage of the document, so a value the user typed
 * has no quote to point at, and the fields that carry one are left empty rather than
 * pointed at text that never said this.
 */
function emptyField(key: TextFieldKey, value: string, evidenceId: string): TextField {
  return {
    evidenceId,
    method: 'MANUAL',
    original: value,
    normalized: NORMALIZER_FOR[key](value),
  };
}

/**
 * Applies confirmed overrides to a raw extraction.
 * Returns `null` when the evidence has never been processed and has no manual values.
 *
 * Takes the evidence `id` because a field the user added that the extractor never found
 * has no extracted field to inherit one from, and a `TextField` whose `evidenceId` is
 * wrong would attribute a manual value to a different document.
 */
export function effectiveExtraction(
  evidence: Pick<Evidence, 'id' | 'extraction' | 'confirmedFields'>,
): Extraction | null {
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
    const additions: TextField[] = [];

    // Walked over the overrides rather than the extracted list, and over both indices in
    // them. A confirmed value whose index is at or past the end of the extracted list —
    // a person adding a second phone number the extractor never found — has no field to
    // attach to. Iterating the list alone discarded it: the user's input was accepted by
    // the form, written to `confirmedFields`, and then never shown again.
    const updated = list.map((field, index) => {
      const override = overrides[fieldPath(key, index)];
      return override === undefined ? field : overrideTextField(field, override, key);
    });

    for (const path of Object.keys(overrides)) {
      if (!path.startsWith(`${key}.`)) continue;
      const index = parseFieldIndex(path);
      if (index === null || index < list.length) continue;
      const value = overrides[path];
      if (value === undefined) continue;
      additions[index - list.length] = emptyField(key, value, evidence.id);
    }

    /*
      `additions` is assigned by index, so it is sparse whenever a confirmed index sits more
      than one place past the end of the list — and spreading a sparse array does not skip its
      holes, it yields `undefined` at each one. `result[key]` could therefore contain
      `undefined` while its type still said `TextField[]`. `noUncheckedIndexedAccess` cannot
      see it: the hole is inside the array, not at an index expression.

      What that cost: the evidence screen maps these fields and reads `field.original` during
      render, so the hole was a `TypeError` in the render phase, past any try/catch, caught by
      the navigation ErrorBoundary and shown as a full-app error screen. And the only control
      that can delete the offending correction lives on the screen that now throws — so the
      record became permanently unreachable with no in-app way back.

      Reached by ordinary shrinkage. `confirmedFields` is deliberately carried across
      reprocessing untouched, so a noisy first pass that finds four phone numbers, a user who
      corrects the fourth, and a cleaner re-run that finds one leaves `phones.3` pointing two
      places past the end. Two stale paths with a gap between them do it as well.

      The holes are FILLED, not compacted, and that distinction is the fix rather than a detail
      of it. `updated.length === list.length`, and an addition assigned from stale index `i`
      lands at `list.length + (i - list.length)`, which is `i` — so the sparse array is
      positionally *correct*, and the path the screen derives from a field's position still
      matches the override key the value came from. Compacting would move the value typed for
      `phones.3` into position 1, where the screen derives `phones.1`, finds no confirmation
      for it, and renders something a person typed as an unconfirmed machine reading, while
      `phones.3` stays stale forever. That trades a crash for silent corruption, which is the
      worse of the two.

      A filled hole carries no value and no `sourceQuote`, so it asserts nothing about the
      document, and `emptyField` marks it `MANUAL` so it can never be attributed to the
      extractor.

      This is a floor, not the cure, and it is still the floor now that the cure exists. A field
      path is an index into whatever one extraction run happened to find, so the durable fix is
      to re-key `confirmedFields` in the same write that replaces an `extraction` — which is
      what `rekeyConfirmedFields` does, applied by `persistEvidenceExtraction`, the funnel every
      extraction replacement in the app goes through.

      That does not make this dead code, and removing it would be a mistake. Records written
      before the re-key existed still carry stale paths and are only rewritten when someone
      reprocesses them; a workspace can arrive from device storage carrying whatever it was
      stored with; and this function is a read path, which has to render whatever it is handed
      rather than assume the write path that produced it. The two agree where they meet: the
      re-key appends compactly from the end of the new list, so for a record it has touched
      there is no hole here to fill.
    */
    const dense = additions.length
      ? Array.from(additions, (field) => field ?? emptyField(key, '', evidence.id))
      : additions;

    result[key] = dense.length ? [...updated, ...dense] : updated;
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
 *
 * Both halves are measured against the same set of fields, which they previously were not.
 * `total` counted the raw extraction's lists while `confirmed` counted every key in
 * `confirmedFields` — and those are different sets twice over: `documentType`, `title` and
 * `summary` are confirmable and belong to no list, and a path left over from a longer earlier
 * extraction is counted against a list that no longer has that position. The indicator could
 * read "6 of 3 reviewed", which is not an off-by-one a reader can discount but a pair of
 * numbers that cannot be interpreted at all.
 *
 * The denominator is the lists as `effectiveExtraction` renders them — what the reviewer is
 * actually looking at, including the positions a confirmed value extends the list to — and the
 * numerator counts only confirmations that resolve to a position in it. The three whole-record
 * fields are counted on both sides, because a user who corrects a document's title has
 * reviewed something and the old `total` gave them nowhere to be counted.
 */
export function confirmationStats(evidence: Pick<Evidence, 'extraction' | 'confirmedFields'>): {
  total: number;
  confirmed: number;
} {
  const base = evidence.extraction;
  if (!base) return { total: 0, confirmed: 0 };
  const overrides = evidence.confirmedFields ?? {};
  const paths = Object.keys(overrides);

  // `dates` and `amounts` are applied by mapping the extracted list, so a confirmation past
  // their end is not materialised and must not be counted as a field. Only `TEXT_FIELD_KEYS`
  // can grow, and only as far as the highest confirmed index reaches.
  const extentOf = (key: string, length: number): number => {
    let extent = length;
    for (const path of paths) {
      if (!path.startsWith(`${key}.`)) continue;
      const index = parseFieldIndex(path);
      if (index !== null && index + 1 > extent) extent = index + 1;
    }
    return extent;
  };

  const lengths = new Map<string, number>([
    ['dates', base.dates.length],
    ['amounts', base.amounts.length],
    ...TEXT_FIELD_KEYS.map((key) => [key, extentOf(key, base[key].length)] as const),
  ]);

  let total = 0;
  for (const length of lengths.values()) total += length;

  const WHOLE_RECORD = ['documentType', 'title', 'summary'] as const;
  total += WHOLE_RECORD.length;

  let confirmed = 0;
  for (const path of paths) {
    if ((WHOLE_RECORD as readonly string[]).includes(path)) {
      confirmed += 1;
      continue;
    }
    const key = path.slice(0, path.indexOf('.'));
    const index = parseFieldIndex(path);
    // A path naming no list, or a position the effective extraction does not reach, is
    // counted against nothing. It is left in storage — it is the user's input, and a
    // reprocess re-keys it (`rekeyConfirmedFields`) rather than discarding it — but it is
    // not a review of a field that is on screen.
    if (index === null || index < 0) continue;
    if (index < (lengths.get(key) ?? 0)) confirmed += 1;
  }

  return { total, confirmed };
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
