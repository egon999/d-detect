import { beforeEach, describe, expect, it } from 'vitest';

import {
  confirmEvidenceFields,
  createFileEvidence,
  createNote,
  type MutationContext,
  type RecoveredText,
} from '@/data/mutations';
import { effectiveExtraction } from '@domain/extraction/merge';
import { hashText } from '@domain/hashing';
import type { AnalysisResult, UnconfirmedRead } from '@domain/models';
import { eventDateConflictRule } from '@domain/rules/definitions/event-date-conflict';
import { buildRuleContext, runAnalysis } from '@domain/rules/engine';
import { quarantineFinding, unconfirmedReadsOf } from '@domain/rules/provenance';
import type { Rule, RuleFinding } from '@domain/rules/types';
import { CASE_ID, evidence, event, link, OWNER, ref, resetIds, workspace } from './helpers';

/**
 * Provenance, end to end.
 *
 * Two properties are under test, and they are the two halves of the same promise:
 *
 * 1. **How a value was obtained travels with it.** Text recognised from pixels is recorded
 *    as OCR from the moment of ingestion, and never quietly becomes "read from the document".
 * 2. **An unconfirmed reading may not accuse anyone.** It may group, order and corroborate —
 *    a misread there fails towards silence — but a contradiction resting on it is marked
 *    provisional, demoted and forced to NEEDS_REVIEW until a person vouches for the reading.
 *
 * The failure being defended against is concrete: one misread digit turning ₹1,500 into
 * ₹7,500, and the app then reporting a dispute between two documents that agree.
 */

const NOW = 1_700_000_000_000;

let sequence = 0;
const context = (): MutationContext => ({
  ownerId: OWNER,
  now: NOW,
  nextId: (prefix) => `${prefix}_m${(sequence += 1)}`,
});

beforeEach(() => {
  resetIds();
  sequence = 0;
});

const RECEIPT = `PAYMENT RECEIPT
Invoice Number: INV-2024-018
Payment Date: 12/03/2024
Total: INR 1,500.00
`;

const FILE_INPUT = {
  title: 'Receipt photo',
  kind: 'IMAGE' as const,
  fileName: 'receipt.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 24_000,
  storagePath: 'users/u/cases/c/receipt.jpg',
  sha256: hashText('receipt-bytes'),
};

// ---------------------------------------------------------------------------
// 1. Method plumbing
// ---------------------------------------------------------------------------

describe('extraction method plumbing', () => {
  it('stamps every extracted field with the method the text was obtained by', () => {
    const fromImage = evidence(RECEIPT, { method: 'OCR' });
    const extraction = fromImage.extraction!;

    // Guards against the assertion below passing vacuously over empty arrays.
    expect(extraction.dates.length).toBeGreaterThan(0);
    expect(extraction.amounts.length).toBeGreaterThan(0);
    expect(extraction.invoiceNumbers.length).toBeGreaterThan(0);

    for (const field of [...extraction.dates, ...extraction.amounts, ...extraction.invoiceNumbers]) {
      expect(field.method).toBe('OCR');
    }
  });

  it('records a typed note as DETERMINISTIC, not MANUAL', () => {
    const { workspace: next } = createNote(workspace(), context(), CASE_ID, {
      title: 'Call notes',
      text: RECEIPT,
    });
    const note = next.evidence[0]!;

    // The characters are exactly what the person typed, so nothing guessed at them — but
    // the *fields* are still regex matches over that text. Calling them MANUAL would let a
    // parsing mistake wear a human's authority and become unchallengeable.
    expect(note.extraction?.amounts[0]?.method).toBe('DETERMINISTIC');
    expect(note.extraction?.dates[0]?.method).toBe('DETERMINISTIC');
  });

  it('carries OCR provenance from the upload through to the stored fields', () => {
    const { workspace: next } = createFileEvidence(workspace(), context(), CASE_ID, {
      ...FILE_INPUT,
      text: { value: RECEIPT, method: 'OCR' },
    });
    const item = next.evidence[0]!;

    expect(item.state).toBe('EXTRACTED');
    expect(item.extraction?.amounts[0]?.method).toBe('OCR');
    expect(item.extraction?.dates[0]?.method).toBe('OCR');
  });

  it('keeps DETERMINISTIC for text lifted straight out of a file', () => {
    const { workspace: next } = createFileEvidence(workspace(), context(), CASE_ID, {
      ...FILE_INPUT,
      kind: 'PDF',
      fileName: 'receipt.pdf',
      text: { value: RECEIPT, method: 'DETERMINISTIC' },
    });

    expect(next.evidence[0]!.extraction?.amounts[0]?.method).toBe('DETERMINISTIC');
  });

  it('falls back to OCR, never DETERMINISTIC, when text arrives with no stated method', () => {
    // The type makes this unreachable from current callers; the cast is the point. If a
    // future ingestion path ever routes around it, the safe failure is to *under*-claim
    // provenance — an over-claim is what tells a user a guess was read from the document.
    const { workspace: next } = createFileEvidence(workspace(), context(), CASE_ID, {
      ...FILE_INPUT,
      text: { value: RECEIPT } as RecoveredText,
    });

    expect(next.evidence[0]!.extraction?.amounts[0]?.method).toBe('OCR');
  });

  it('leaves a file with no recoverable text for a person rather than inventing an extraction', () => {
    const { workspace: next } = createFileEvidence(workspace(), context(), CASE_ID, FILE_INPUT);
    const item = next.evidence[0]!;

    expect(item.state).toBe('REVIEW_REQUIRED');
    expect(item.extraction).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Which values count as unconfirmed
// ---------------------------------------------------------------------------

describe('unconfirmedReadsOf', () => {
  it('names every value read off an image, with a label a person can act on', () => {
    const item = evidence(RECEIPT, { id: 'evd_shot', method: 'OCR' });

    const reads = unconfirmedReadsOf(item.id, effectiveExtraction(item));

    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((read) => read.evidenceId === 'evd_shot')).toBe(true);
    expect(reads.map((read) => read.label)).toContain('Amount');
    expect(reads.some((read) => read.reading.includes('1,500'))).toBe(true);
    // Paths are what `confirmEvidenceFields` is keyed by, so they must be field paths.
    expect(reads.every((read) => /^[a-zA-Z]+\.\d+$/.test(read.path))).toBe(true);
    // A fixed order — dates, then amounts, then the identifier fields — mirroring the
    // extraction itself. Stable, but deliberately *not* the order a stored finding uses:
    // `unconfirmedReadsBehind` re-sorts, because that list is persisted and rendered.
    expect(reads.map((read) => read.path)).toEqual(['dates.0', 'amounts.0', 'invoiceNumbers.0']);
  });

  it('treats an AI proposal as unconfirmed too — it sits below OCR, not above it', () => {
    const item = evidence(RECEIPT, { id: 'evd_ai', method: 'AI' });
    expect(unconfirmedReadsOf(item.id, effectiveExtraction(item)).length).toBeGreaterThan(0);
  });

  it('returns nothing for text that was already characters in the file', () => {
    const item = evidence(RECEIPT, { id: 'evd_pdf', method: 'DETERMINISTIC' });
    expect(unconfirmedReadsOf(item.id, effectiveExtraction(item))).toEqual([]);
  });

  it('drops a field a person has confirmed, because it is MANUAL by the time it gets here', () => {
    const item = evidence(RECEIPT, { id: 'evd_shot', method: 'OCR' });
    const confirmed = { ...item, confirmedFields: { 'amounts.0': 'INR 1,500.00' } };

    const reads = unconfirmedReadsOf(item.id, effectiveExtraction(confirmed));

    expect(reads.some((read) => read.path === 'amounts.0')).toBe(false);
    expect(unconfirmedReadsOf(item.id, effectiveExtraction(item)).some((r) => r.path === 'amounts.0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The quarantine itself
// ---------------------------------------------------------------------------

/** A stand-in rule, so the policy is tested rather than any one rule's wording. */
function testRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'test-rule@1',
    title: 'Test rule',
    description: 'Exists only to exercise the quarantine.',
    rationale: 'Exists only to exercise the quarantine.',
    resultType: 'AMOUNT_MISMATCH',
    defaultSeverity: 'HIGH',
    priority: 1,
    enabled: false,
    evaluate: () => [],
    ...overrides,
  };
}

function testFinding(overrides: Partial<RuleFinding> = {}): RuleFinding {
  return {
    key: ['evd_shot'],
    title: 'Two documents disagree',
    explanation: 'The amounts differ.',
    confidence: 'EXACT_MATCH',
    supportingEvidenceIds: ['evd_shot'],
    inputs: { Receipt: 'INR 1,500.00', Invoice: 'INR 7,500.00' },
    ...overrides,
  };
}

describe('the quarantine', () => {
  const imageWorkspace = () =>
    workspace({ evidence: [evidence(RECEIPT, { id: 'evd_shot', method: 'OCR' })] });
  const fileWorkspace = () =>
    workspace({ evidence: [evidence(RECEIPT, { id: 'evd_shot', method: 'DETERMINISTIC' })] });

  /** The engine's own ordering: evidence, then field path. */
  const byKey = (a: UnconfirmedRead, b: UnconfirmedRead) =>
    a.evidenceId.localeCompare(b.evidenceId) || a.path.localeCompare(b.path);

  it('will not let an unconfirmed reading raise a confident accusation', () => {
    const ruleContext = buildRuleContext(imageWorkspace(), CASE_ID);

    const quarantine = quarantineFinding(testRule(), testFinding(), ruleContext);

    expect(quarantine.provisional).toBe(true);
    // Whatever the rule believed, it was comparing a guess.
    expect(quarantine.confidence).toBe('NEEDS_REVIEW');
    // One step down, so a conflict that might not exist cannot outrank one that does.
    expect(quarantine.severity).toBe('MEDIUM');
    expect(quarantine.unconfirmedReads.length).toBeGreaterThan(0);
    expect(quarantine.explanation).toContain('The amounts differ.');
    expect(quarantine.caveat).toMatch(/read from an image/i);
  });

  it('leaves the same finding alone when the values came out of the file as characters', () => {
    const ruleContext = buildRuleContext(fileWorkspace(), CASE_ID);

    const quarantine = quarantineFinding(testRule(), testFinding(), ruleContext);

    expect(quarantine.provisional).toBe(false);
    expect(quarantine.confidence).toBe('EXACT_MATCH');
    expect(quarantine.severity).toBe('HIGH');
    expect(quarantine.unconfirmedReads).toEqual([]);
    expect(quarantine.explanation).toBe('The amounts differ.');
  });

  it('lets an unconfirmed reading corroborate, group and connect untouched', () => {
    const ruleContext = buildRuleContext(imageWorkspace(), CASE_ID);

    // A misread here fails towards silence — two documents that should have been linked
    // simply are not — which leaves the user no worse off than before they uploaded.
    for (const resultType of ['CORROBORATED_EVENT', 'RELATED_EVIDENCE', 'DUPLICATE_EVIDENCE'] as const) {
      const quarantine = quarantineFinding(testRule({ resultType }), testFinding(), ruleContext);
      expect(quarantine.provisional).toBe(false);
      expect(quarantine.confidence).toBe('EXACT_MATCH');
      expect(quarantine.severity).toBe('HIGH');
    }
  });

  it('demotes one step and no further', () => {
    const ruleContext = buildRuleContext(imageWorkspace(), CASE_ID);
    const severityAfter = (severity: RuleFinding['severity']) =>
      quarantineFinding(testRule(), testFinding({ severity }), ruleContext).severity;

    expect(severityAfter('HIGH')).toBe('MEDIUM');
    expect(severityAfter('MEDIUM')).toBe('LOW');
    // LOW and INFO have nowhere to go; demoting to nothing would be deletion.
    expect(severityAfter('LOW')).toBe('LOW');
    expect(severityAfter('INFO')).toBe('INFO');
  });

  it('falls back to every unconfirmed reading in the cited evidence when a rule declares no basis', () => {
    const ruleContext = buildRuleContext(imageWorkspace(), CASE_ID);
    const everything = unconfirmedReadsOf('evd_shot', ruleContext.extractionOf('evd_shot'));

    const quarantine = quarantineFinding(testRule(), testFinding(), ruleContext);

    // The point of the fallback: a rule written tomorrow is covered without touching it,
    // and forgetting to declare a basis costs an over-broad prompt, not a false accusation.
    expect(everything.length).toBeGreaterThan(1);
    expect([...quarantine.unconfirmedReads].sort(byKey)).toEqual([...everything].sort(byKey));
  });

  it('orders the readings by evidence then field path, so a re-run reshuffles nothing', () => {
    const ruleContext = buildRuleContext(imageWorkspace(), CASE_ID);

    const quarantine = quarantineFinding(testRule(), testFinding(), ruleContext);

    // Not the order the extractor produced them in (dates, then amounts, then identifiers).
    // `unconfirmedReadsBehind` sorts, because this list is written into a stored finding and
    // rendered as a list of prompts: a set that means the same thing but arrives in a
    // different order would rewrite the record and move the buttons under the user's thumb.
    expect(quarantine.unconfirmedReads.map((read) => read.path)).toEqual([
      'amounts.0',
      'dates.0',
      'invoiceNumbers.0',
    ]);
  });

  it('narrows the prompt to the values a rule says it compared', () => {
    const ruleContext = buildRuleContext(imageWorkspace(), CASE_ID);
    const amount = ruleContext.extractionOf('evd_shot')!.amounts[0]!;

    const quarantine = quarantineFinding(
      testRule(),
      testFinding({ basis: [{ evidenceId: 'evd_shot', label: 'Amount', field: amount }] }),
      ruleContext,
    );

    expect(quarantine.unconfirmedReads).toEqual([
      { evidenceId: 'evd_shot', path: 'amounts.0', label: 'Amount', reading: amount.original },
    ]);
    // Named in the caveat, so the finding itself carries the prompt.
    expect(quarantine.caveat).toContain(amount.original);
  });
});

// ---------------------------------------------------------------------------
// 4. End to end, through a real rule
// ---------------------------------------------------------------------------

/** Two sources attached to one event that disagree about when it happened. */
function conflictingDates(method: 'DETERMINISTIC' | 'OCR') {
  const handover = event('Handover', '2024-03-12', { id: 'evt_handover' });
  const mine = evidence('Sent: 12 March 2024\nDelivered the final package.', {
    id: 'evd_mine',
    method,
  });
  const theirs = evidence('Sent: 15 March 2024\nDelivered on 15 March 2024 in our records.', {
    id: 'evd_theirs',
    method,
  });

  return workspace({
    events: [handover],
    evidence: [mine, theirs],
    relationships: [
      link(ref.evidence(mine.id), ref.event(handover.id), 'SUPPORTS'),
      link(ref.evidence(theirs.id), ref.event(handover.id), 'SUPPORTS'),
    ],
  });
}

// Only the rule under test, so this stays a test of the quarantine rather than of whatever
// else the registry happens to contain.
const ONLY_DATE_CONFLICT = [eventDateConflictRule];

const conflictIn = (results: readonly AnalysisResult[]): AnalysisResult | undefined =>
  results.find((result) => result.resultType === 'POSSIBLE_CONFLICT');

describe('a date conflict read off two photographs', () => {
  it('is reported as a question, not a conclusion', () => {
    const run = runAnalysis(conflictingDates('OCR'), CASE_ID, NOW, ONLY_DATE_CONFLICT);
    const finding = conflictIn(run.results);

    expect(finding).toBeDefined();
    // Still shown. Suppressing it would be its own kind of lie.
    expect(finding!.provisional).toBe(true);
    expect(finding!.confidence).toBe('NEEDS_REVIEW');
    expect(finding!.severity).toBe('MEDIUM');
    expect(finding!.caveat).toMatch(/read from an image/i);

    // Exactly the two dates compared — not every field of both documents.
    expect(finding!.unconfirmedReads).toHaveLength(2);
    expect(finding!.unconfirmedReads.map((read) => read.evidenceId).sort()).toEqual([
      'evd_mine',
      'evd_theirs',
    ]);
    expect(finding!.unconfirmedReads.every((read) => read.label === 'Date')).toBe(true);
    expect(finding!.unconfirmedReads.every((read) => read.path.startsWith('dates.'))).toBe(true);
  });

  it('is reported plainly when the same two documents were text, not photographs', () => {
    const run = runAnalysis(conflictingDates('DETERMINISTIC'), CASE_ID, NOW, ONLY_DATE_CONFLICT);
    const finding = conflictIn(run.results);

    expect(finding).toBeDefined();
    expect(finding!.provisional).toBe(false);
    expect(finding!.severity).toBe('HIGH');
    expect(finding!.unconfirmedReads).toEqual([]);
    expect(finding!.explanation).not.toMatch(/read from an image/i);
  });

  it('firms up once a person confirms the readings it named', () => {
    const base = conflictingDates('OCR');
    const before = conflictIn(runAnalysis(base, CASE_ID, NOW, ONLY_DATE_CONFLICT).results)!;
    expect(before.provisional).toBe(true);

    // Exactly what the card's "Confirm this reading" button does: record the reading as it
    // stands — "I checked, the image really does say this" — then re-run.
    let confirmed = base;
    for (const read of before.unconfirmedReads) {
      confirmed = confirmEvidenceFields(confirmed, context(), read.evidenceId, {
        [read.path]: read.reading,
      }).workspace;
    }

    const after = conflictIn(runAnalysis(confirmed, CASE_ID, NOW, ONLY_DATE_CONFLICT).results);

    expect(after).toBeDefined();
    expect(after!.provisional).toBe(false);
    expect(after!.unconfirmedReads).toEqual([]);
    expect(after!.severity).toBe('HIGH');
    expect(after!.confidence).toBe('NEEDS_REVIEW'); // the rule's own grade, no longer forced
    expect(after!.explanation).not.toMatch(/read from an image/i);
    // The same finding firming up in place, not a second card appearing beside the first.
    expect(after!.id).toBe(before.id);
  });

  it('disappears entirely when the confirmed reading turns out to have been a misread', () => {
    const base = conflictingDates('OCR');
    const before = conflictIn(runAnalysis(base, CASE_ID, NOW, ONLY_DATE_CONFLICT).results)!;
    const theirs = before.unconfirmedReads.find((read) => read.evidenceId === 'evd_theirs')!;

    // The user opens the document and finds it actually says the same date as the other
    // source. This is the path that makes a fabricated dispute vanish.
    const corrected = confirmEvidenceFields(base, context(), theirs.evidenceId, {
      [theirs.path]: '12 March 2024',
    }).workspace;

    const after = conflictIn(runAnalysis(corrected, CASE_ID, NOW, ONLY_DATE_CONFLICT).results);
    expect(after).toBeUndefined();
  });
});

/**
 * What a human correction does to the value the rest of the app compares on.
 *
 * A confirmation is layered over the raw extraction rather than written into it, so
 * `effectiveExtraction` is the only place where a person's correction becomes the value
 * everything else sees. Two things must hold there, and both were broken:
 *
 * 1. The corrected value is folded the same way the extractor folds its own values.
 *    Otherwise the correction makes the record *less* comparable — the exact opposite of
 *    what confirming a value is for.
 * 2. A confirmed value the extractor never found is still shown. The form accepted it,
 *    the mutation stored it, and the read path then dropped it.
 */
describe('confirmed fields become the values the app compares on', () => {
  it('folds a corrected name the way the extractor folds names', () => {
    // "Ravi Shrma" was misread by OCR; the user corrects it to "Ravi Sharma".
    const source = evidence('From: Ravi Shrma\nAmount: INR 500');
    const original = source.extraction!.people[0]!;

    const corrected = effectiveExtraction({
      ...source,
      confirmedFields: { 'people.0': 'Ravi Sharma' },
    })!;
    const person = corrected.people[0]!;

    expect(person.original).toBe('Ravi Sharma');
    expect(person.method).toBe('MANUAL');
    // Lowercased with word order and spacing preserved — a name normalizer, not an
    // identifier normalizer, which would have produced "RAVISHARMA".
    expect(person.normalized).toBe('ravi sharma');
    // And the same folding the extractor applies, so the corrected record now agrees
    // with the same name read out of another document.
    expect(person.normalized).toBe(
      evidence('From: Ravi Sharma\nAmount: INR 500').extraction!.people[0]!.normalized,
    );
    expect(person.normalized).not.toBe(original.normalized);
  });

  it('folds a corrected email, phone and invoice number each the way their extractor does', () => {
    const corrected = effectiveExtraction({
      ...evidence('Invoice Number: INV-2024-018\nEmail: ops@example.com\nPhone: +91 98765 43210'),
      confirmedFields: {
        'invoiceNumbers.0': 'INV 2024 019',
        'emails.0': 'Ops@Example.COM',
        'phones.0': '+91 90000 11111',
      },
    })!;

    expect(corrected.invoiceNumbers[0]!.normalized).toBe('INV2024019');
    expect(corrected.emails[0]!.normalized).toBe('ops@example.com');
    expect(corrected.phones[0]!.normalized).toBe('+919000011111');
  });

  it('keeps a confirmed value the extractor never found', () => {
    // The document printed one phone number and the user adds a second. There is no
    // extracted field at index 1 to attach it to, so it must be appended rather than
    // discarded — the value was accepted by the form and is in `confirmedFields`.
    const source = evidence('Phone: +91 98765 43210');
    expect(source.extraction!.phones).toHaveLength(1);

    const corrected = effectiveExtraction({
      ...source,
      confirmedFields: { 'phones.0': '+91 90000 11111', 'phones.1': '+91 90000 22222' },
    })!;

    expect(corrected.phones.map((field) => field.normalized)).toEqual([
      '+919000011111',
      '+919000022222',
    ]);
    // A value that has no passage behind it must not claim one.
    expect(corrected.phones[1]!.sourceQuote).toBeUndefined();
    expect(corrected.phones[1]!.method).toBe('MANUAL');
  });
});
