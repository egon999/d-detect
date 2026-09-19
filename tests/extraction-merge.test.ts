import { beforeEach, describe, expect, it } from 'vitest';

import { confirmationStats, effectiveExtraction } from '@domain/extraction/merge';

import { evidence, resetIds } from './helpers';

/**
 * The read path that applies a person's corrections to a machine reading.
 *
 * Split out of `provenance.test.ts`, which covers what a confirmed value *means* — that it
 * folds the way the extractor folds, that it is never attributed to a passage it did not come
 * from. This file covers the shape of the array that comes back, because the merge could
 * return an `Extraction` that its own type said was impossible.
 */
beforeEach(resetIds);

/**
 * A correction that outlives the reading it corrected.
 *
 * `confirmedFields` is keyed by a field's position in whatever the extractor happened to find
 * on the run that was on screen when the user typed, and the map is deliberately carried
 * across reprocessing untouched — `mutations.ts` says `confirmedFields` and `confirmedAt` are
 * never touched, and means it. So a re-read that finds fewer values than the last one leaves
 * keys pointing past the end of their list, and that is ordinary rather than exotic: a noisy
 * scan finds four phone numbers, the user corrects the fourth, a cleaner pass finds one.
 *
 * `effectiveExtraction` built those leftovers into an array by index, which made it sparse,
 * and spreading a sparse array yields `undefined` at every hole instead of skipping it. The
 * result was an `Extraction` whose `phones` held `undefined` while its type said
 * `TextField[]` — `noUncheckedIndexedAccess` cannot see a hole inside an array — and the
 * evidence screen reads `field.original` off each entry during render. A render-phase
 * `TypeError` is past any try/catch, so it reached the navigation ErrorBoundary and replaced
 * the app with an error screen. Because the only control that deletes the offending correction
 * sits on the screen that now threw, the record was unreachable for good.
 *
 * Both halves are pinned below: that no hole survives, and that filling them did not become
 * compacting. The second matters more, and is why this block is long.
 */
describe('a confirmed field whose position no longer exists', () => {
  /** Every fixture here starts from exactly one extracted phone number. */
  const onePhone = () => {
    const source = evidence('Phone: +91 98765 43210');
    expect(source.extraction!.phones).toHaveLength(1);
    return source;
  };

  it('does not put undefined in a TextField list', () => {
    // The shape that crashed: one extracted phone, a correction left over at index 3. The two
    // positions in between have neither an extracted value nor a confirmed one.
    const corrected = effectiveExtraction({
      ...onePhone(),
      confirmedFields: { 'phones.3': '+91 90000 33333' },
    })!;

    expect(corrected.phones).toHaveLength(4);
    // Asserted over every entry rather than by reading one index: the defect was a hole
    // anywhere in the array, and a test that probed a single position would pass while the
    // screen still crashed on a different one.
    for (const [index, field] of corrected.phones.entries()) {
      expect(field, `phones.${index}`).toBeDefined();
      expect(typeof field.original, `phones.${index}`).toBe('string');
    }
  });

  it('leaves the typed value at the index its key names, rather than compacting it', () => {
    /*
      The assertion the whole fix turns on.

      `updated.length === list.length`, and an addition taken from stale index `i` is stored at
      `i - list.length`, so it lands back at `i` once the two are spread together. The sparse
      array was positionally correct; only its gaps were wrong. The screen derives a field's
      path from its position, so compacting the array — the obvious fix — would move this value
      to index 1, the screen would derive `phones.1`, find no confirmation under that key, and
      render something a person typed as an unconfirmed machine reading, while `phones.3`
      stayed stale forever. No crash and a worse outcome, so it is pinned here.
    */
    const corrected = effectiveExtraction({
      ...onePhone(),
      confirmedFields: { 'phones.3': '+91 90000 33333' },
    })!;

    expect(corrected.phones[3]!.normalized).toBe('+919000033333');
    expect(corrected.phones[3]!.method).toBe('MANUAL');
    expect(corrected.phones[1]!.original).toBe('');
    expect(corrected.phones[2]!.original).toBe('');
  });

  it('claims nothing about the document for a position that holds no value', () => {
    // A filled gap is not a reading. No value, and no `sourceQuote` to point at text that
    // never said anything — the same rule the appended-field case already follows.
    const corrected = effectiveExtraction({
      ...onePhone(),
      confirmedFields: { 'phones.3': '+91 90000 33333' },
    })!;

    const filler = corrected.phones[1]!;
    expect(filler.original).toBe('');
    expect(filler.sourceQuote).toBeUndefined();
    // `MANUAL`, so nothing downstream can attribute this slot to the extractor.
    expect(filler.method).toBe('MANUAL');
  });

  it('handles a gap between two leftover corrections', () => {
    // The second route in, needing no shrinkage at all: two confirmed paths past the end with
    // a position between them that neither names.
    const corrected = effectiveExtraction({
      ...onePhone(),
      confirmedFields: { 'phones.1': '+91 90000 11111', 'phones.3': '+91 90000 33333' },
    })!;

    expect(corrected.phones).toHaveLength(4);
    for (const field of corrected.phones) expect(field).toBeDefined();
    expect(corrected.phones[1]!.normalized).toBe('+919000011111');
    expect(corrected.phones[2]!.original).toBe('');
    expect(corrected.phones[3]!.normalized).toBe('+919000033333');
  });

  it('is unchanged in the contiguous case', () => {
    // The behaviour the existing tests cover, re-pinned so hole filling cannot quietly alter
    // the ordinary path on its way to fixing the rare one.
    const corrected = effectiveExtraction({
      ...onePhone(),
      confirmedFields: { 'phones.0': '+91 90000 11111', 'phones.1': '+91 90000 22222' },
    })!;

    expect(corrected.phones.map((field) => field.normalized)).toEqual([
      '+919000011111',
      '+919000022222',
    ]);
  });
});

/**
 * The "evidence health" fraction, which could not be read as a fraction.
 *
 * `total` was counted over the raw extraction's lists and `confirmed` over every key in
 * `confirmedFields`, and those are different sets twice over: `documentType`, `title` and
 * `summary` are confirmable and belong to no list, and a stale path is counted against a list
 * that no longer has that position. Both inflate the numerator only, so the indicator could
 * report more reviewed than there was to review.
 */
describe('counting what a person has reviewed', () => {
  it('never reports more confirmed than total', () => {
    const source = evidence('Phone: +91 98765 43210');
    const stats = confirmationStats({
      ...source,
      confirmedFields: {
        documentType: 'RECEIPT',
        title: 'Receipt',
        summary: 'A receipt',
        'phones.0': '+91 90000 11111',
        // Left over from a longer earlier extraction. Still the user's input, so it stays in
        // storage; it is not a review of anything currently on screen.
        'phones.9': '+91 90000 99999',
      },
    });

    expect(stats.confirmed).toBeLessThanOrEqual(stats.total);
  });

  it('counts a corrected title, which had nowhere to be counted before', () => {
    const source = evidence('Phone: +91 98765 43210');
    const before = confirmationStats({ ...source, confirmedFields: {} });
    const after = confirmationStats({ ...source, confirmedFields: { title: 'Corrected title' } });

    expect(after.total).toBe(before.total);
    expect(after.confirmed).toBe(before.confirmed + 1);
  });

  it('counts a confirmation that extends a list, because the reviewer can see it', () => {
    // `effectiveExtraction` renders four phone slots for this record, so four is what the
    // denominator has to be. Counting against the raw list would report a review of a field
    // the denominator says does not exist.
    const source = evidence('Phone: +91 98765 43210');
    const before = confirmationStats({ ...source, confirmedFields: {} });
    const after = confirmationStats({
      ...source,
      confirmedFields: { 'phones.3': '+91 90000 33333' },
    });

    expect(after.total).toBe(before.total + 3);
    expect(after.confirmed).toBe(1);
  });
});
