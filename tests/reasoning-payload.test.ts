/**
 * Reading a stored AI payload into something renderable, tested.
 *
 * This module exists because of a specific failure: the panel looked for a flat
 * `payload.citations` array, none of the four cross-document passes writes one, and so every
 * verified quote the product computed was persisted and rendered as nothing. The tests that
 * matter most here are therefore the ones that would fail if that regression came back — a
 * payload in each of the four real shapes must yield its passages.
 *
 * The second group is the opposite risk. A citation is a promise that the reader can open the
 * document and find those characters, and `resolveCitation` keeps that promise by re-slicing
 * the source text at the stored offsets. A citation that cannot satisfy that check must be
 * dropped here rather than rendered as a quote whose source will not open, so the offset
 * validation is pinned as tightly as the happy path.
 */

import { describe, expect, it } from 'vitest';

import { MAX_FINDINGS, flatCitations, readReasoning } from '../src/features/analysis/reasoning';

/** A citation in the shape `verifyCitations` stores, which is `CaseCitation` minus the stance. */
function citation(overrides: Record<string, unknown> = {}) {
  return {
    evidenceId: 'ev_bank',
    segmentId: 'seg_4',
    quote: 'Amount debited: 12,400.00',
    startOffset: 120,
    endOffset: 145,
    exact: true,
    ...overrides,
  };
}

const emptyAudit = { rejected: [], droppedAssertions: 0, weakenedAssertions: 0 };

/** The reconciliation payload for the product's central case: two documents, two amounts. */
function reconciliationPayload(overrides: Record<string, unknown> = {}) {
  return {
    facts: [
      {
        label: 'Amount paid',
        kind: 'AMOUNT',
        agreement: 'DISAGREE',
        divergenceKind: 'DIFFERENT_AMOUNT_SAME_DATE',
        divergence: 'The statement records 12,400 where the receipt records 14,200.',
        note: '',
        readings: [
          { evidenceId: 'ev_bank', value: '₹12,400.00', citations: [citation()] },
          {
            evidenceId: 'ev_receipt',
            value: '₹14,200.00',
            citations: [citation({ evidenceId: 'ev_receipt', segmentId: 'seg_1', quote: 'Total 14,200.00', startOffset: 40, endOffset: 55 })],
          },
        ],
      },
    ],
    unreconciled: [],
    reasoningTrace: '',
    audit: emptyAudit,
    ...overrides,
  };
}

describe('readReasoning — the regression that made the reasoning invisible', () => {
  it('yields the passages behind a disagreement, which a flat citations read returned none of', () => {
    const result = readReasoning('CROSS_DOCUMENT_RECONCILIATION', reconciliationPayload());
    expect(result).not.toBeNull();
    const finding = result?.findings[0];
    const quotes = [
      ...(finding?.citations ?? []),
      ...(finding?.readings.flatMap((reading) => reading.citations) ?? []),
    ].map((entry) => entry.quote);
    expect(quotes).toEqual(['Amount debited: 12,400.00', 'Total 14,200.00']);
  });

  it('carries both readings so the difference is visible without opening a document', () => {
    const result = readReasoning('CROSS_DOCUMENT_RECONCILIATION', reconciliationPayload());
    expect(result?.findings[0]?.readings.map((reading) => reading.value)).toEqual(['₹12,400.00', '₹14,200.00']);
  });

  it('names the disagreement rather than scoring it', () => {
    const result = readReasoning('CROSS_DOCUMENT_RECONCILIATION', reconciliationPayload());
    expect(result?.findings[0]?.status).toEqual({ label: 'Disagree', tone: 'danger' });
  });

  it('describes the shape of the difference when the pass did not describe it itself', () => {
    const payload = reconciliationPayload({
      facts: [{ ...reconciliationPayload().facts[0], divergence: null }],
    });
    const result = readReasoning('CROSS_DOCUMENT_RECONCILIATION', payload);
    expect(result?.findings[0]?.detail).toBe('Two different amounts on the same date.');
  });

  it('counts values that agree instead of listing them, so a disagreement is not buried', () => {
    const payload = reconciliationPayload({
      facts: [
        ...reconciliationPayload().facts,
        { label: 'Reference', agreement: 'ALL_AGREE', readings: [], divergenceKind: 'NONE' },
        { label: 'Payee', agreement: 'ALL_AGREE', readings: [], divergenceKind: 'NONE' },
      ],
    });
    const result = readReasoning('CROSS_DOCUMENT_RECONCILIATION', payload);
    expect(result?.findings).toHaveLength(1);
    expect(result?.footnote).toContain('2 other values agree');
  });

  it('reports a one-sided observation as standing alone rather than as agreement', () => {
    const payload = reconciliationPayload({
      facts: [],
      unreconciled: [{ evidenceId: 'ev_receipt', observation: 'The receipt records a service charge no other document mentions.', citations: [citation()] }],
    });
    const result = readReasoning('CROSS_DOCUMENT_RECONCILIATION', payload);
    expect(result?.findings[0]?.status).toEqual({ label: 'Stands alone', tone: 'warn' });
    expect(result?.findings[0]?.citations).toHaveLength(1);
  });
});

describe('readReasoning — citations that cannot be checked are not shown', () => {
  it('drops a citation with no offsets, because its source could never be opened', () => {
    const payload = reconciliationPayload({
      facts: [{
        ...reconciliationPayload().facts[0],
        readings: [{ evidenceId: 'ev_bank', value: '₹12,400.00', citations: [{ evidenceId: 'ev_bank', segmentId: 'seg_4', quote: 'Amount debited' }] }],
      }],
    });
    const result = readReasoning('CROSS_DOCUMENT_RECONCILIATION', payload);
    expect(result?.findings[0]?.readings[0]?.citations).toEqual([]);
  });

  it('drops an empty range, which would slice no text out of the document', () => {
    const payload = reconciliationPayload({
      unreconciled: [{ evidenceId: 'ev_bank', observation: 'Observed once.', citations: [citation({ startOffset: 120, endOffset: 120 })] }],
      facts: [],
    });
    const result = readReasoning('CROSS_DOCUMENT_RECONCILIATION', payload);
    expect(result?.findings[0]?.citations).toEqual([]);
  });

  it('drops a reversed range', () => {
    const payload = reconciliationPayload({
      unreconciled: [{ evidenceId: 'ev_bank', observation: 'Observed once.', citations: [citation({ startOffset: 200, endOffset: 100 })] }],
      facts: [],
    });
    const result = readReasoning('CROSS_DOCUMENT_RECONCILIATION', payload);
    expect(result?.findings[0]?.citations).toEqual([]);
  });

  it('drops a citation naming no segment, which cannot be resolved to a passage', () => {
    const payload = reconciliationPayload({
      unreconciled: [{ evidenceId: 'ev_bank', observation: 'Observed once.', citations: [citation({ segmentId: '' })] }],
      facts: [],
    });
    const result = readReasoning('CROSS_DOCUMENT_RECONCILIATION', payload);
    expect(result?.findings[0]?.citations).toEqual([]);
  });
});

describe('readReasoning — support strength', () => {
  function supportPayload(overrides: Record<string, unknown> = {}) {
    return {
      assessments: [
        {
          claimId: 'cl_1',
          state: 'CONFLICTING',
          modelState: 'SUPPORTED',
          reasoning: 'One document records the payment and another records it as outstanding.',
          restsOn: 'RECORDED_VALUE',
          independentSourceCount: 2,
          supportingCitations: [citation()],
          conflictingCitations: [citation({ evidenceId: 'ev_ledger', segmentId: 'seg_2', quote: 'Status: UNPAID', startOffset: 10, endOffset: 24 })],
          whatWouldChangeIt: 'A statement covering the week after the transfer.',
          adjustments: ['Downgraded: the model reported support while quoting a conflicting passage.'],
        },
      ],
      overall: 'REQUIRES_REVIEW',
      overallReason: 'The records disagree on whether the amount was settled.',
      audit: emptyAudit,
      ...overrides,
    };
  }

  it('keeps supporting and conflicting passages distinguishable by stance', () => {
    const result = readReasoning('SUPPORT_STRENGTH', supportPayload());
    expect(result?.findings[0]?.citations.map((entry) => entry.stance)).toEqual(['SUPPORTS', 'CONTRADICTS']);
  });

  it('names the claim by id so the view can resolve its current wording', () => {
    const result = readReasoning('SUPPORT_STRENGTH', supportPayload());
    expect(result?.findings[0]?.subjectId).toBe('cl_1');
    expect(result?.findings[0]?.title).toBe('');
  });

  it('surfaces the overall answer as the verdict', () => {
    const result = readReasoning('SUPPORT_STRENGTH', supportPayload());
    expect(result?.verdict).toEqual({
      label: 'Needs your review',
      tone: 'warn',
      reason: 'The records disagree on whether the amount was settled.',
    });
  });

  it('prefers what verification overruled over what might improve the answer', () => {
    const result = readReasoning('SUPPORT_STRENGTH', supportPayload());
    expect(result?.findings[0]?.note).toBe('Downgraded: the model reported support while quoting a conflicting passage.');
  });

  it('falls back to what would change the answer when nothing was overruled', () => {
    const payload = supportPayload({
      assessments: [{ ...supportPayload().assessments[0], adjustments: [] }],
    });
    const result = readReasoning('SUPPORT_STRENGTH', payload);
    expect(result?.findings[0]?.note).toBe('What would change this: A statement covering the week after the transfer.');
  });
});

describe('readReasoning — missing information', () => {
  function gap(overrides: Record<string, unknown> = {}) {
    return {
      missingItem: 'A bank statement for the week after 12 March',
      answersQuestion: 'Whether the transfer was reversed.',
      absenceMeans: '',
      impact: 'CORROBORATES',
      obtainableFrom: 'your bank',
      citations: [citation()],
      ...overrides,
    };
  }

  it('puts the record that would settle the question first', () => {
    const result = readReasoning('MISSING_INFORMATION', {
      gaps: [gap(), gap({ missingItem: 'The signed delivery note', impact: 'DECIDES' })],
      alreadyCovered: [],
      hardLimit: '',
      audit: emptyAudit,
    });
    expect(result?.findings.map((finding) => finding.status?.label)).toEqual(['Would settle it', 'Would corroborate']);
  });

  it('says where the record is usually held rather than telling the user to find more evidence', () => {
    const result = readReasoning('MISSING_INFORMATION', { gaps: [gap()], alreadyCovered: [], hardLimit: '', audit: emptyAudit });
    expect(result?.findings[0]?.note).toBe('Usually held by your bank.');
  });

  it('reports a limit no document can settle as a verdict, not as a gap to fill', () => {
    const result = readReasoning('MISSING_INFORMATION', {
      gaps: [],
      alreadyCovered: [{ point: 'The amount is recorded twice.', citations: [] }],
      hardLimit: 'No document in this case can show what was said on the call.',
      audit: emptyAudit,
    });
    expect(result?.verdict?.reason).toBe('No document in this case can show what was said on the call.');
    expect(result?.footnote).toContain('1 point is already covered');
  });

  it('drops a gap with no item, which would render as a status chip over nothing', () => {
    const result = readReasoning('MISSING_INFORMATION', { gaps: [gap({ missingItem: '' })], alreadyCovered: [], hardLimit: '', audit: emptyAudit });
    expect(result).toBeNull();
  });
});

describe('readReasoning — timeline coherence', () => {
  function timelinePayload(overrides: Record<string, unknown> = {}) {
    return {
      coherence: 'INCOHERENT',
      coherenceReason: 'The refund is dated two days before the payment it refunds.',
      sequence: [
        { label: 'Payment', dateOriginal: '12/03/2024', dateIso: '2024-03-12', evidenceId: 'ev_bank', citations: [citation()], dateAmbiguous: false },
        { label: 'Refund', dateOriginal: '10/03/2024', dateIso: '2024-03-10', evidenceId: 'ev_receipt', citations: [], dateAmbiguous: true },
      ],
      problems: [
        { kind: 'IMPOSSIBLE_ORDER', description: 'The refund precedes the payment.', citations: [citation()] },
      ],
      audit: emptyAudit,
      ...overrides,
    };
  }

  it('leads with whether the dates hold together', () => {
    const result = readReasoning('TIMELINE_COHERENCE', timelinePayload());
    expect(result?.verdict).toEqual({
      label: 'The order does not work',
      tone: 'danger',
      reason: 'The refund is dated two days before the payment it refunds.',
    });
  });

  it('reports the break as a finding with its passage', () => {
    const result = readReasoning('TIMELINE_COHERENCE', timelinePayload());
    expect(result?.findings[0]?.title).toBe('The refund precedes the payment.');
    expect(result?.findings[0]?.status).toEqual({ label: 'Impossible order', tone: 'danger' });
    expect(result?.findings[0]?.citations).toHaveLength(1);
  });

  it('tells the reader when a date could be read two ways, because only the original settles it', () => {
    const result = readReasoning('TIMELINE_COHERENCE', timelinePayload());
    expect(result?.footnote).toContain('1 date could be read two ways');
    expect(result?.footnote).toContain('2 dated facts were placed');
  });
});

describe('readReasoning — payloads no current build would write', () => {
  it('returns nothing for a kind that carries no nested structure', () => {
    expect(readReasoning('RELATIONSHIP', { targetId: 'cl_1' })).toBeNull();
    expect(readReasoning('FIELD_EXTRACTION', { citations: [citation()] })).toBeNull();
  });

  it('returns nothing when a pass ran and found nothing worth showing', () => {
    expect(readReasoning('CROSS_DOCUMENT_RECONCILIATION', { facts: [], unreconciled: [], audit: emptyAudit })).toBeNull();
  });

  it('survives an empty payload rather than throwing inside a render', () => {
    expect(readReasoning('SUPPORT_STRENGTH', {})).toBeNull();
    expect(readReasoning('MISSING_INFORMATION', {})).toBeNull();
    expect(readReasoning('TIMELINE_COHERENCE', {})).toBeNull();
  });

  it('survives fields holding the wrong type entirely', () => {
    expect(
      readReasoning('CROSS_DOCUMENT_RECONCILIATION', {
        facts: 'not an array',
        unreconciled: [null, 42, 'text'],
        audit: null,
      }),
    ).toBeNull();
  });

  it('ignores an array entry that is not an object', () => {
    const result = readReasoning('TIMELINE_COHERENCE', {
      coherence: 'COHERENT',
      coherenceReason: 'The dates run in order.',
      sequence: [],
      problems: [null, 'broken', { kind: 'UNEXPLAINED_GAP', description: 'Nine months pass with no record.', citations: [] }],
    });
    expect(result?.findings).toHaveLength(1);
  });

  it('keeps an unrecognised status readable by leaving the chip off rather than printing a token', () => {
    const result = readReasoning('TIMELINE_COHERENCE', {
      coherence: 'SOMETHING_A_LATER_BUILD_ADDED',
      problems: [{ kind: 'A_NEW_KIND', description: 'A problem this build does not name.', citations: [] }],
    });
    expect(result?.verdict).toBeNull();
    expect(result?.findings[0]?.status).toBeNull();
    expect(result?.findings[0]?.title).toBe('A problem this build does not name.');
  });
});

describe('readReasoning — a long result stays readable', () => {
  it('lists the first few findings and counts the rest', () => {
    const problems = Array.from({ length: MAX_FINDINGS + 4 }, (_unused, index) => ({
      kind: 'UNEXPLAINED_GAP',
      description: `Gap number ${index}.`,
      citations: [],
    }));
    const result = readReasoning('TIMELINE_COHERENCE', { coherence: 'COHERENT_WITH_GAPS', problems, sequence: [] });
    expect(result?.findings).toHaveLength(MAX_FINDINGS);
    expect(result?.footnote).toContain('4 further problems are not shown');
  });
});

describe('flatCitations', () => {
  it('reads the shape the deterministic intelligence pass writes', () => {
    const stored = { ...citation(), stance: 'CONTRADICTS' };
    expect(flatCitations({ citations: [stored] })).toEqual([
      { evidenceId: 'ev_bank', segmentId: 'seg_4', quote: 'Amount debited: 12,400.00', startOffset: 120, endOffset: 145, stance: 'CONTRADICTS' },
    ]);
  });

  it('defaults a citation that recorded no stance to context rather than claiming support', () => {
    expect(flatCitations({ citations: [citation()] })[0]?.stance).toBe('CONTEXT');
  });

  it('returns nothing when the field is absent or the wrong type', () => {
    expect(flatCitations({})).toEqual([]);
    expect(flatCitations({ citations: 'none' })).toEqual([]);
  });
});
