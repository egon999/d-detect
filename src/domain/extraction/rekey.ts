import type { AmountField, DateField, Extraction, TextField, TextFieldKey } from '../models';
import { TEXT_FIELD_KEYS } from '../models';

/**
 * Re-pointing a person's corrections when the reading they were made against is replaced.
 *
 * ## The instability this closes
 *
 * `evidence.confirmedFields` is keyed by a field path, and a path for a list value is
 * `<listKey>.<index>` — an index into whatever *one* extraction run happened to find. The map
 * is carried across reprocessing deliberately (`persistEvidenceExtraction` leaves `confirmedAt`
 * and the CONFIRMED state alone, because a correction still applies to a re-read of the same
 * document), which is right. What was missing is the other half of it: an index is only
 * meaningful against the list it indexes, so replacing the list without touching the map leaves
 * every key pointing at a position rather than at a value.
 *
 * Three things follow from that, in rising order of seriousness:
 *
 * 1. A cleaner re-read that finds fewer values leaves keys past the end of the new list.
 *    `effectiveExtraction` fills those positions rather than compacting them, which is what
 *    keeps the screen from crashing and keeps a typed value where its key says it is.
 * 2. A re-read that finds the same values in a different order leaves each correction on
 *    whatever now sits at its old position — so a correction is silently detached from the
 *    reading it was about.
 * 3. **A re-read that finds a *different* value at that position has the correction override
 *    it.** The extraction says one thing, the person typed another about something else, and
 *    the screen renders their words over a value they never saw. That is the failure that
 *    matters: it puts words in someone's mouth about their own evidence, and nothing in the
 *    record shows it happened.
 *
 * ## What identifies a correction
 *
 * The anchor is the **machine reading the person was correcting** — the value that stood at
 * that index in the extraction they were looking at — and not the value they typed. Matching on
 * what they typed looks attractive and is the trap: a later pass that independently finds that
 * string somewhere else in the document would pick up their correction and attach it to a
 * different reading, which is exactly defect 3 arriving by another route. The old reading is
 * what the key was a pointer to, so the old reading is what is followed.
 *
 * "The same reading" is decided by the identity `mergeAiExtraction` already uses to decide that
 * an AI-proposed value duplicates a deterministic one — normalized text, `iso` plus role for a
 * date, currency plus minor units for an amount. One definition of sameness for both directions
 * is worth more than a second one tuned here.
 *
 * ## What happens to a correction whose reading is gone
 *
 * It is kept, with no position claim: re-keyed past the end of the new list, where
 * `effectiveExtraction` renders it as a `MANUAL` field with no `sourceQuote` — a value a person
 * entered, asserting nothing about any passage of the document. It is not dropped and it is not
 * re-attached to whatever occupies its old index.
 *
 * That choice is argued rather than assumed, because all three of the obvious options lose
 * something:
 *
 * - **Dropping it** is defensible on the grounds that a correction to a reading that no longer
 *   exists is a correction to nothing. But `confirmedFields` is the only place the typed value
 *   is held, so dropping destroys a person's own words about their own evidence, and it does so
 *   on the strength of the machine's *second* opinion. A re-read finds less for boring reasons —
 *   a worse scan, a transcription that fell back, a page that failed — and "the extractor no
 *   longer sees it" is not evidence that the person was wrong.
 * - **Keeping the index** is what happens today and is defect 3.
 * - **Keeping the value without the index** loses only the claim the app can no longer support,
 *   which is the claim about *position*. The list grows by one entry per stranded correction,
 *   bounded by how many corrections a person made, and every one of those entries is something
 *   they typed and can still see and delete.
 *
 * For `dates` and `amounts` there is a real cost to be honest about. `effectiveExtraction`
 * applies those two by mapping the extracted list, so it deliberately does not grow them, and a
 * stranded date correction is therefore preserved in storage but not rendered. The alternative
 * would be for the write to append a fabricated `DateField` to the extraction — machine output,
 * carrying `extractorVersion`, containing a value no extractor produced. Keeping a person's
 * value dormant is a smaller harm than filing it as something the document was read to say.
 *
 * Nothing here is silent: `persistEvidenceExtraction` records what moved and what was stranded
 * in the audit entry for that reprocess, in counts, with no field values.
 */

/** Paths that name a whole record rather than a position, and so never need re-keying. */
const WHOLE_RECORD_PATHS = new Set(['documentType', 'title', 'summary']);

/**
 * The lists a path can index into, which is exactly the set `effectiveExtraction` applies
 * overrides to. A path naming anything else — `parties.0`, or a key from a build that is not
 * this one — is carried through untouched: it overrides nothing at read time, so moving it
 * could only turn an inert key into an active one pointing somewhere nobody chose.
 */
const POSITIONAL_KEYS = [...TEXT_FIELD_KEYS, 'dates', 'amounts'] as const;
type PositionalKey = (typeof POSITIONAL_KEYS)[number];

const IS_POSITIONAL: ReadonlySet<string> = new Set<string>(POSITIONAL_KEYS);

/** Splits `phones.3` into its list and its index. `null` for anything that is not one. */
function parsePath(path: string): { key: PositionalKey; index: number } | null {
  const dot = path.lastIndexOf('.');
  if (dot <= 0 || WHOLE_RECORD_PATHS.has(path)) return null;
  const key = path.slice(0, dot);
  const digits = path.slice(dot + 1);
  if (!IS_POSITIONAL.has(key) || !/^\d+$/.test(digits)) return null;
  return { key: key as PositionalKey, index: Number(digits) };
}

/**
 * What makes two readings the same reading.
 *
 * Deliberately the identity `mergeAiExtraction` dedupes on. A `TextField` is its `normalized`
 * form, which is the whole point of storing one — `INV-2024/018` and `inv 2024 018` are one
 * reading. A date carries its role because "issued 12 March" and "due 12 March" are two
 * different readings of the same day, and a correction to one is not a correction to the other.
 */
function identityOf(key: PositionalKey, field: TextField | DateField | AmountField): string {
  if (key === 'dates') {
    const date = field as DateField;
    return `${date.iso ?? ''}|${date.role ?? ''}`;
  }
  if (key === 'amounts') {
    const amount = field as AmountField;
    return `${amount.currency}:${amount.minorUnits}`;
  }
  return (field as TextField).normalized;
}

function identitiesOf(extraction: Extraction | null, key: PositionalKey): string[] {
  if (!extraction) return [];
  if (key === 'dates') return extraction.dates.map((field) => identityOf(key, field));
  if (key === 'amounts') return extraction.amounts.map((field) => identityOf(key, field));
  return extraction[key as TextFieldKey].map((field) => identityOf(key, field));
}

export interface RekeyOutcome {
  /** The map to store: every value that went in comes out, under the key that now names it. */
  confirmedFields: Record<string, string>;
  /**
   * Corrections whose key changed — the reading moved, or a value the extractor never found
   * had to be re-anchored to the end of a list that is now a different length.
   */
  moved: number;
  /**
   * Corrections whose reading is not in the new extraction at all. Kept, with no position
   * claim, and counted separately because this is the one outcome a person might want to act
   * on: the app no longer has a machine reading to show their correction against.
   */
  stranded: number;
}

/**
 * Re-keys `confirmedFields` from the positions of `previous` onto the positions of `next`.
 *
 * Pure, and total: every value in equals a value out. Never reached by a caller that is not
 * replacing an extraction in the same write, because the map and the extraction are only ever
 * consistent when they are written together.
 */
export function rekeyConfirmedFields(
  previous: Extraction | null,
  next: Extraction | null,
  confirmedFields: Readonly<Record<string, string>>,
): RekeyOutcome {
  const unchanged = (): RekeyOutcome => ({
    confirmedFields: { ...confirmedFields },
    moved: 0,
    stranded: 0,
  });

  /*
    A write that carries no extraction re-keys nothing, and this is load-bearing rather than an
    early return for speed.

    A failed or unreadable re-read stores `extraction: null` — the record's honest state, and
    `effectiveExtraction` returns null for it, so no correction is applied to anything. Re-keying
    against the empty lists that a null extraction presents would append every correction at
    0, 1, 2… and destroy the one thing that lets them be re-anchored later: which reading each
    one was about. The last good positions are kept instead, so a document that reads correctly
    on the next attempt gets its corrections back exactly where they were.
  */
  if (!next) return unchanged();
  const paths = Object.keys(confirmedFields);
  if (paths.length === 0) return unchanged();

  const result: Record<string, string> = {};
  let moved = 0;
  let stranded = 0;

  /** Positional paths, grouped by the list they index. Everything else passes straight through. */
  const byKey = new Map<PositionalKey, Array<{ index: number; value: string }>>();
  for (const path of paths) {
    const value = confirmedFields[path];
    if (value === undefined) continue;
    const parsed = parsePath(path);
    if (!parsed) {
      result[path] = value;
      continue;
    }
    const bucket = byKey.get(parsed.key);
    if (bucket) bucket.push({ index: parsed.index, value });
    else byKey.set(parsed.key, [{ index: parsed.index, value }]);
  }

  for (const key of POSITIONAL_KEYS) {
    const corrections = byKey.get(key);
    if (!corrections) continue;
    // Ascending, so the outcome does not depend on the order the map's keys happen to arrive
    // in, and so that when two corrections compete for one position the earlier one wins.
    corrections.sort((a, b) => a.index - b.index);

    const before = identitiesOf(previous, key);
    const after = identitiesOf(next, key);
    const claimed = new Set<number>();
    const settled = new Map<number, number>();
    const strandedIndices = new Set<number>();

    // Pass one: a correction whose position still holds the same reading does not move. Run
    // before any search so that an unchanged re-read rewrites nothing at all — reprocessing a
    // document that reads the same way must leave this map byte for byte as it was.
    for (const correction of corrections) {
      const identity = before[correction.index];
      if (identity === undefined) continue;
      if (after[correction.index] === identity && !claimed.has(correction.index)) {
        claimed.add(correction.index);
        settled.set(correction.index, correction.index);
      }
    }

    // Pass two: the reading moved. Follow it. This is the common real case — a second pass
    // that finds the same four values in a different order, or drops one from the middle.
    for (const correction of corrections) {
      if (settled.has(correction.index)) continue;
      const identity = before[correction.index];
      if (identity === undefined) continue;
      for (let candidate = 0; candidate < after.length; candidate += 1) {
        if (claimed.has(candidate) || after[candidate] !== identity) continue;
        claimed.add(candidate);
        settled.set(correction.index, candidate);
        break;
      }
    }

    /*
      Pass three: everything left has no reading to sit against, for one of two reasons, and
      both land in the same place.

      Either the correction was a value the extractor never found — a person adding a second
      phone number, whose key was already past the end of the old list — or the reading it named
      is not in the new extraction. Neither one may keep a position in a list it has no claim
      on: leaving an addition at `phones.4` when the new pass found five phone numbers would put
      a person's typed value on top of a machine reading they have never seen.

      Appended compactly from the end of the new list, in the order their old keys ran, so the
      relative order a person entered values in survives and `effectiveExtraction` has no holes
      to fill for a record this function has touched.
    */
    let appendAt = after.length;
    for (const correction of corrections) {
      if (settled.has(correction.index)) continue;
      // Stranded means "the reading this named is gone", which is only sayable about a
      // correction that had a reading. A value past the end of the old list never had one.
      if (correction.index < before.length) strandedIndices.add(correction.index);
      settled.set(correction.index, appendAt);
      appendAt += 1;
    }

    for (const correction of corrections) {
      const position = settled.get(correction.index);
      if (position === undefined) continue;
      // Counted as one thing or the other, never both: a stranded correction has almost always
      // changed position too, and reporting it twice would tell a reader of the audit entry
      // that two things happened to it.
      if (strandedIndices.has(correction.index)) stranded += 1;
      else if (position !== correction.index) moved += 1;
      result[`${key}.${position}`] = correction.value;
    }
  }

  return { confirmedFields: result, moved, stranded };
}
