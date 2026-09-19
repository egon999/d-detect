import { beforeEach, describe, expect, it } from 'vitest';

import { persistEvidenceExtraction, type MutationContext } from '@data/mutations';
import { extractFromText } from '@domain/extraction/deterministic';
import { effectiveExtraction } from '@domain/extraction/merge';
import { rekeyConfirmedFields } from '@domain/extraction/rekey';
import type { Evidence, Extraction } from '@domain/models';

import { CASE_ID, OWNER, evidence, resetIds, workspace } from './helpers';

/**
 * The write side of a person's corrections.
 *
 * `confirmedFields` is keyed by `<listKey>.<index>`, and an index only means anything against
 * the list it indexes. Reprocessing replaces that list, so unless the map is re-keyed in the
 * same write, a key that used to point at a reading now points at a *position* — and whatever
 * the new pass happened to put there.
 *
 * The failure that matters is not the crash the read side already guards against. It is a
 * correction rendered over a value the person never saw, which is the app putting words in
 * their mouth about their own evidence. Most of what follows is about that.
 */
beforeEach(resetIds);

const READ = (text: string): Extraction =>
  extractFromText({ evidenceId: 'evd_1', title: 'Statement', text, method: 'OCR' });

/** Two phone numbers, in the order the extractor scans them out of the text. */
const TWO_PHONES = 'Call +91 98765 43210 or +91 91234 56789 about this.';
const ONE_PHONE = 'Call +91 98765 43210 about this.';
const OTHER_PHONE = 'Call +91 90000 11111 about this.';

describe('rekeyConfirmedFields', () => {
  it('changes nothing when the document reads the same way twice', () => {
    // The ordinary reprocess, and the one with the strictest requirement: a re-read that finds
    // what it found last time must leave this map exactly as it was. Anything else is churn in
    // a record a person's corrections live in, and it would make every retry a rewrite.
    const before = READ(TWO_PHONES);
    const after = READ(TWO_PHONES);
    const fields = { 'phones.0': '+91 98765 43211', documentType: 'Receipt' };

    const outcome = rekeyConfirmedFields(before, after, fields);

    expect(outcome.confirmedFields).toEqual(fields);
    expect(outcome).toMatchObject({ moved: 0, stranded: 0 });
  });

  it('follows the reading to its new position when the pass finds it elsewhere', () => {
    // The common real case: the same values, read in a different order. The correction was
    // about the second phone number; the second phone number is now first, so the correction
    // is first. Matched on the *machine* reading it was made against, never on what the person
    // typed — a later pass that independently found their text elsewhere would otherwise pick
    // their correction up and attach it to a reading they never saw.
    const before = READ(TWO_PHONES);
    const after = READ('Call +91 91234 56789 or +91 98765 43210 about this.');
    expect(before.phones.map((field) => field.normalized)).toEqual(['+919876543210', '+919123456789']);
    expect(after.phones.map((field) => field.normalized)).toEqual(['+919123456789', '+919876543210']);

    const outcome = rekeyConfirmedFields(before, after, { 'phones.1': '+91 91234 56780' });

    expect(outcome.confirmedFields).toEqual({ 'phones.0': '+91 91234 56780' });
    expect(outcome).toMatchObject({ moved: 1, stranded: 0 });
  });

  it('never leaves a correction sitting on a value it was not typed for', () => {
    /*
      The defect this whole module exists for.

      One phone number is read, the person corrects it, and a later pass reads a *different*
      number at that position — a re-scan of a different page, a transcription that heard
      something else. The key stayed at `phones.0`, so `effectiveExtraction` laid their
      correction over a value they have never seen and marked it MANUAL, which is the app
      asserting that this person said this about that reading. They did not.
    */
    const before = READ(ONE_PHONE);
    const after = READ(OTHER_PHONE);

    const outcome = rekeyConfirmedFields(before, after, { 'phones.0': '+91 98765 43211' });

    expect(outcome.confirmedFields['phones.0']).toBeUndefined();
    expect(outcome.confirmedFields).toEqual({ 'phones.1': '+91 98765 43211' });
    expect(outcome).toMatchObject({ moved: 0, stranded: 1 });

    // Read back the way the screen reads it: the machine value stands as the machine read it,
    // and the person's value is beside it as their own entry.
    const merged = effectiveExtraction({
      id: 'evd_1',
      extraction: after,
      confirmedFields: outcome.confirmedFields,
    })!;
    expect(merged.phones[0]).toMatchObject({ normalized: '+919000011111', method: 'OCR' });
    expect(merged.phones[1]).toMatchObject({ normalized: '+919876543211', method: 'MANUAL' });
    // Their entry points at no passage of the document, because it came from them.
    expect(merged.phones[1]?.sourceQuote).toBeUndefined();
  });

  it('moves a value the extractor never found clear of a list that has grown', () => {
    /*
      The same misattribution, arriving from the other direction. A person adds a phone number
      the extractor never read, which lands past the end of a one-item list as `phones.1`. A
      later pass reads two numbers — so `phones.1` is now a machine reading, and the addition
      was sitting on top of it.
    */
    const before = READ(ONE_PHONE);
    const after = READ(TWO_PHONES);

    const outcome = rekeyConfirmedFields(before, after, { 'phones.1': '+91 90000 22222' });

    expect(outcome.confirmedFields).toEqual({ 'phones.2': '+91 90000 22222' });
    // An addition never had a reading under it, so it is moved rather than stranded.
    expect(outcome).toMatchObject({ moved: 1, stranded: 0 });

    const merged = effectiveExtraction({
      id: 'evd_1',
      extraction: after,
      confirmedFields: outcome.confirmedFields,
    })!;
    expect(merged.phones.map((field) => field.normalized)).toEqual([
      '+919876543210',
      '+919123456789',
      '+919000022222',
    ]);
  });

  it('gives two corrections two positions rather than collapsing them into one', () => {
    // `confirmedFields` is a map, so two corrections re-keyed onto one path would silently
    // discard one of them — the loudest possible version of losing a person's input.
    const before = READ(TWO_PHONES);
    const after = READ(ONE_PHONE);

    const outcome = rekeyConfirmedFields(before, after, {
      'phones.0': '+91 98765 43211',
      'phones.1': '+91 91234 56780',
    });

    expect(Object.values(outcome.confirmedFields).sort()).toEqual([
      '+91 91234 56780',
      '+91 98765 43211',
    ]);
    // The surviving reading keeps its correction in place; the one whose reading is gone is
    // appended past the end, where it claims no position in the list.
    expect(outcome.confirmedFields).toEqual({
      'phones.0': '+91 98765 43211',
      'phones.1': '+91 91234 56780',
    });
    expect(outcome).toMatchObject({ moved: 0, stranded: 1 });
  });

  it('compacts leftovers that used to sit past the end with holes between them', () => {
    // The shape `effectiveExtraction` has to fill holes for. Re-keyed, it does not occur: two
    // stale additions come back adjacent, in the order their keys ran.
    const before = READ(ONE_PHONE);
    const after = READ(ONE_PHONE);

    const outcome = rekeyConfirmedFields(before, after, {
      'phones.3': '+91 90000 33333',
      'phones.6': '+91 90000 66666',
    });

    expect(outcome.confirmedFields).toEqual({
      'phones.1': '+91 90000 33333',
      'phones.2': '+91 90000 66666',
    });
  });

  it('keeps a stranded amount rather than laying it over a figure that is now different', () => {
    /*
      Amounts are the most corrected field on the evidence screen and the one where a wrong
      value does the most damage, because the amount rules compare them across documents.

      `effectiveExtraction` applies amounts by mapping the extracted list, so it deliberately
      does not grow that list: a stranded amount correction is preserved in storage but not
      rendered. That is the accepted cost, and it is chosen over the alternative — appending a
      fabricated `AmountField` to the extraction, which would file a person's figure as
      something a machine read off the document.
    */
    const before = READ('Total: INR 85,000.00');
    const after = READ('Total: INR 95,000.00');

    const outcome = rekeyConfirmedFields(before, after, { 'amounts.0': '87000' });

    expect(outcome.confirmedFields).toEqual({ 'amounts.1': '87000' });
    expect(outcome).toMatchObject({ stranded: 1 });

    const merged = effectiveExtraction({
      id: 'evd_1',
      extraction: after,
      confirmedFields: outcome.confirmedFields,
    })!;
    expect(merged.amounts).toHaveLength(1);
    expect(merged.amounts[0]).toMatchObject({ minorUnits: 9_500_000, method: 'OCR' });
  });

  it('leaves a correction to the whole record alone', () => {
    // `documentType`, `title` and `summary` name the record rather than a position in a list,
    // so there is nothing to re-key and nothing that could go stale.
    const outcome = rekeyConfirmedFields(READ(ONE_PHONE), READ(OTHER_PHONE), {
      documentType: 'Receipt',
      title: 'Payment receipt',
      summary: 'A receipt for the disputed payment.',
    });

    expect(outcome.confirmedFields).toEqual({
      documentType: 'Receipt',
      title: 'Payment receipt',
      summary: 'A receipt for the disputed payment.',
    });
    expect(outcome).toMatchObject({ moved: 0, stranded: 0 });
  });

  it('touches nothing when the re-read produced no extraction at all', () => {
    /*
      A failed or unreadable pass stores `extraction: null`. Re-keying against it would append
      every correction at 0, 1, 2… and throw away the only thing that can re-anchor them later:
      which reading each one was about. Holding the last good positions means a document that
      reads correctly on the next attempt gets its corrections back where they were.
    */
    const fields = { 'phones.0': '+91 98765 43211', 'phones.3': '+91 90000 33333' };

    const outcome = rekeyConfirmedFields(READ(ONE_PHONE), null, fields);

    expect(outcome.confirmedFields).toEqual(fields);
    expect(outcome).toMatchObject({ moved: 0, stranded: 0 });
  });

  it('carries a path it cannot interpret through untouched', () => {
    // `parties.0` is a real extraction list that `effectiveExtraction` does not apply overrides
    // to, so its key is inert. Re-keying it could only turn an inert key into an active one
    // pointing at a position nobody chose.
    const outcome = rekeyConfirmedFields(READ(ONE_PHONE), READ(OTHER_PHONE), {
      'parties.0': 'Acme Pvt Ltd',
      'notAField.2': 'something',
    });

    expect(outcome.confirmedFields).toEqual({
      'parties.0': 'Acme Pvt Ltd',
      'notAField.2': 'something',
    });
  });
});

/**
 * The same thing through the write that every extraction replacement in the app funnels
 * through, because the re-key is only correct if it happens in the same commit as the
 * extraction it is keyed against.
 */
describe('persistEvidenceExtraction and a person’s corrections', () => {
  const NOW = 1_700_000_000_000;
  const CONFIRMED_AT = 1_600_000_000_000;

  const context = (): MutationContext => ({ ownerId: OWNER, now: NOW, nextId: (p) => `${p}_m1` });

  const recordWith = (text: string, confirmedFields: Record<string, string>): Evidence =>
    evidence(text, {
      id: 'evd_1',
      state: 'CONFIRMED',
      confirmedFields,
      confirmedAt: CONFIRMED_AT,
      method: 'OCR',
    });

  const reprocess = (item: Evidence, text: string) =>
    persistEvidenceExtraction(workspace({ evidence: [item] }), context(), 'evd_1', {
      extraction: extractFromText({ evidenceId: 'evd_1', title: item.title, text, method: 'OCR' }),
      state: 'EXTRACTED',
      failureReason: null,
    });

  it('re-keys in the same write that replaces the extraction', () => {
    const item = recordWith(ONE_PHONE, { 'phones.0': '+91 98765 43211' });
    const { workspace: next } = reprocess(item, OTHER_PHONE);
    const stored = next.evidence.find((record) => record.id === 'evd_1')!;

    // The machine reading is the new one, and the correction is no longer on top of it.
    expect(stored.extraction?.phones[0]?.normalized).toBe('+919000011111');
    expect(stored.confirmedFields).toEqual({ 'phones.1': '+91 98765 43211' });
  });

  it('holds the invariants the reprocess already had', () => {
    const item = recordWith(ONE_PHONE, { 'phones.0': '+91 98765 43211', documentType: 'Receipt' });
    const { workspace: next } = reprocess(item, OTHER_PHONE);
    const stored = next.evidence.find((record) => record.id === 'evd_1')!;

    // Re-keying is bookkeeping, not a review: the moment the person confirmed does not move,
    // and a CONFIRMED record is not dragged back to EXTRACTED by having been re-read.
    expect(stored.confirmedAt).toBe(CONFIRMED_AT);
    expect(stored.state).toBe('CONFIRMED');
    // Nothing is dropped: as many corrections out as went in.
    expect(Object.keys(stored.confirmedFields)).toHaveLength(2);
    expect(stored.confirmedFields['documentType']).toBe('Receipt');
  });

  it('says in the audit trail what it did to them, in counts and no values', () => {
    const item = recordWith(TWO_PHONES, {
      'phones.0': '+91 98765 43211',
      'phones.1': '+91 91234 56780',
    });
    const { workspace: next } = reprocess(item, 'Call +91 91234 56789 about this.');
    const entry = next.auditLogs.find((log) => log.action === 'EVIDENCE_PROCESSED')!;

    expect(entry.metadata).toMatchObject({ correctionsMoved: '1', correctionsStranded: '1' });
    expect(entry.summary).toMatch(/One correction now points at the same value in its new place/);
    expect(entry.summary).toMatch(/one correction has no matching reading in this pass/);
    expect(entry.summary.length).toBeLessThanOrEqual(400);
    // The numbers are the whole report. A value a person typed is theirs and the log is the
    // one collection read in bulk.
    expect(entry.summary).not.toContain('91234');
    expect(JSON.stringify(entry.metadata)).not.toContain('91234');
    expect(entry.caseId).toBe(CASE_ID);
  });

  it('writes the entry it always wrote when nothing moved', () => {
    const item = recordWith(ONE_PHONE, { 'phones.0': '+91 98765 43211' });
    const { workspace: next } = reprocess(item, ONE_PHONE);
    const entry = next.auditLogs.find((log) => log.action === 'EVIDENCE_PROCESSED')!;

    expect(entry.summary).toBe('Processed "Evidence evd_1".');
    expect(Object.keys(entry.metadata).sort()).toEqual(['extractor', 'state']);
  });

  it('leaves the map alone when the re-read could not be done', () => {
    // Including a correction whose key sits past the end. Re-keying against a null extraction
    // would present empty lists and compact everything to 0, 1, 2… destroying the only thing
    // that can re-anchor these later — which reading each one was about.
    const item = recordWith(ONE_PHONE, {
      'phones.0': '+91 98765 43211',
      'phones.2': '+91 90000 22222',
    });
    const { workspace: next } = persistEvidenceExtraction(
      workspace({ evidence: [item] }),
      context(),
      'evd_1',
      { extraction: null, state: 'FAILED', failureReason: 'The stored original could not be read.' },
    );
    const stored = next.evidence.find((record) => record.id === 'evd_1')!;

    expect(stored.confirmedFields).toEqual({
      'phones.0': '+91 98765 43211',
      'phones.2': '+91 90000 22222',
    });
    expect(stored.confirmedAt).toBe(CONFIRMED_AT);
  });
});
