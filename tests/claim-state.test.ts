import { beforeEach, describe, expect, it } from 'vitest';
import { claimStateSummary, evaluateCaseClaims, evaluateClaim, refreshClaimStates } from '@domain/analysis/claim-state';
import { AnalysisTypeEnum, CONFLICT_ANALYSIS_TYPES, isConflictFinding } from '@domain/enums';
import { CASE_ID, claim, evidence, event, link, ref, resetIds, workspace } from './helpers';

const NOW = 1_700_000_000_000;
const DOC_A = 'Invoice No: INV-2024-018\nTotal: INR 85,000.00';
const DOC_B = 'PAYMENT CONFIRMATION\nAgainst Invoice No: INV-2024-018\nTotal amount paid: INR 40,000.00';

beforeEach(resetIds);

describe('claim state', () => {
  it('is UNSUPPORTED when nothing is linked, which says nothing about the truth of the claim', () => {
    const target = claim('Untested assertion');
    const result = evaluateClaim(workspace({ claims: [target] }), target.id);
    expect(result?.state).toBe('UNSUPPORTED');
    expect(result?.trace.join(' ')).toMatch(/says nothing about whether it is true/i);
  });

  it('is SUPPORTED when evidence backs it and nothing contradicts it', () => {
    const target = claim('Backed by a document');
    const doc = evidence(DOC_A);
    const result = evaluateClaim(
      workspace({
        claims: [target],
        evidence: [doc],
        relationships: [link(ref.evidence(doc.id), ref.claim(target.id), 'SUPPORTS')],
      }),
      target.id,
    );
    expect(result?.state).toBe('SUPPORTED');
    expect(result?.supporting.map((item) => item.id)).toEqual([doc.id]);
  });

  it('is CONTRADICTED only when a material contradiction stands alone', () => {
    const target = claim('Disputed assertion');
    const against = evidence(DOC_B);
    const result = evaluateClaim(
      workspace({
        claims: [target],
        evidence: [against],
        relationships: [link(ref.evidence(against.id), ref.claim(target.id), 'CONTRADICTS', { material: true })],
      }),
      target.id,
    );
    expect(result?.state).toBe('CONTRADICTED');
  });

  it('holds a non-material contradiction for review rather than calling the claim false', () => {
    const target = claim('Disputed by an offhand remark');
    const against = evidence(DOC_B);
    const result = evaluateClaim(
      workspace({
        claims: [target],
        evidence: [against],
        relationships: [link(ref.evidence(against.id), ref.claim(target.id), 'CONTRADICTS', { material: false })],
      }),
      target.id,
    );
    expect(result?.state).toBe('MIXED_REVIEW');
    expect(result?.materialContradictions).toEqual([]);
  });

  it('is MIXED_REVIEW when both sides have evidence, leaving the judgement to a person', () => {
    const target = claim('Both supported and disputed');
    const supporting = evidence(DOC_A);
    const against = evidence(DOC_B);
    const result = evaluateClaim(
      workspace({
        claims: [target],
        evidence: [supporting, against],
        relationships: [
          link(ref.evidence(supporting.id), ref.claim(target.id), 'SUPPORTS'),
          link(ref.evidence(against.id), ref.claim(target.id), 'CONTRADICTS', { material: true }),
        ],
      }),
      target.id,
    );
    expect(result?.state).toBe('MIXED_REVIEW');
  });

  it('does not let a "relevant" link alone make a claim supported', () => {
    const target = claim('Only marked relevant');
    const doc = evidence(DOC_A);
    const result = evaluateClaim(
      workspace({
        claims: [target],
        evidence: [doc],
        relationships: [link(ref.evidence(doc.id), ref.claim(target.id), 'RELEVANT_TO_CLAIM')],
      }),
      target.id,
    );
    expect(result?.state).toBe('UNSUPPORTED');
    expect(result?.trace.join(' ')).toMatch(/do not change the state on their own/i);
  });

  it('counts duplicate uploads as one independent source and explains the discount', () => {
    const target = claim('Backed by the same file twice');
    const original = evidence(DOC_A, { id: 'evd_original' });
    const copy = evidence(DOC_A, { id: 'evd_copy' });
    const result = evaluateClaim(
      workspace({
        claims: [target],
        evidence: [original, copy],
        relationships: [
          link(ref.evidence(original.id), ref.claim(target.id), 'SUPPORTS'),
          link(ref.evidence(copy.id), ref.claim(target.id), 'SUPPORTS'),
        ],
      }),
      target.id,
    );
    expect(result?.supporting).toHaveLength(2);
    expect(result?.independentSupport).toHaveLength(1);
    expect(result?.trace.join(' ')).toMatch(/discounted as duplicates/i);
  });

  it('keeps the original rather than the copy when discounting a duplicate', () => {
    const target = claim('Backed by a document and its re-upload');
    const original = evidence(DOC_A, { id: 'evd_original', title: 'Original invoice' });
    const copy = evidence(DOC_B, { id: 'evd_copy', title: 'Re-uploaded invoice' });
    const result = evaluateClaim(
      workspace({
        claims: [target],
        evidence: [original, copy],
        relationships: [
          link(ref.evidence(original.id), ref.claim(target.id), 'SUPPORTS'),
          link(ref.evidence(copy.id), ref.claim(target.id), 'SUPPORTS'),
          // The link points from the copy to what it is a copy of.
          link(ref.evidence(copy.id), ref.evidence(original.id), 'DUPLICATE_OF'),
        ],
      }),
      target.id,
    );
    expect(result?.independentSupport.map((item) => item.title)).toEqual(['Original invoice']);
  });

  it('stops counting evidence that was deleted', () => {
    const target = claim('Was supported until the document was removed');
    const doc = evidence(DOC_A, { deletedAt: NOW });
    const result = evaluateClaim(
      workspace({
        claims: [target],
        evidence: [doc],
        relationships: [link(ref.evidence(doc.id), ref.claim(target.id), 'SUPPORTS')],
      }),
      target.id,
    );
    expect(result?.state).toBe('UNSUPPORTED');
  });

  it('returns null for a claim that is not in the workspace', () => {
    expect(evaluateClaim(workspace(), 'clm_missing')).toBeNull();
  });

  it('always records a readable trace of how the state was reached', () => {
    const target = claim('Any claim');
    const result = evaluateClaim(workspace({ claims: [target] }), target.id);
    expect(result?.trace.length).toBeGreaterThan(1);
    for (const step of result!.trace) expect(step.length).toBeGreaterThan(10);
  });
});

describe('bulk evaluation', () => {
  it('evaluates every claim in a case against one shared context', () => {
    const supported = claim('Supported', { id: 'clm_supported' });
    const orphan = claim('Orphan', { id: 'clm_orphan' });
    const doc = evidence(DOC_A);
    const evaluations = evaluateCaseClaims(
      workspace({
        claims: [supported, orphan],
        evidence: [doc],
        relationships: [link(ref.evidence(doc.id), ref.claim(supported.id), 'SUPPORTS')],
      }),
      CASE_ID,
    );
    expect(evaluations.get('clm_supported')?.state).toBe('SUPPORTED');
    expect(evaluations.get('clm_orphan')?.state).toBe('UNSUPPORTED');
    expect(claimStateSummary(evaluations)).toEqual({
      SUPPORTED: 1,
      UNSUPPORTED: 1,
      CONTRADICTED: 0,
      MIXED_REVIEW: 0,
    });
  });

  it('only touches claims whose cached state actually changed', () => {
    const stale = claim('Supported but cached as unsupported', { id: 'clm_stale', state: 'UNSUPPORTED' });
    const correct = claim('Correctly cached', { id: 'clm_correct', state: 'UNSUPPORTED' });
    const doc = evidence(DOC_A);
    const refreshed = refreshClaimStates(
      workspace({
        claims: [stale, correct],
        evidence: [doc],
        relationships: [link(ref.evidence(doc.id), ref.claim(stale.id), 'SUPPORTS')],
      }),
      CASE_ID,
      NOW,
    );

    const updated = refreshed.find((item) => item.id === 'clm_stale')!;
    const untouched = refreshed.find((item) => item.id === 'clm_correct')!;
    expect(updated.state).toBe('SUPPORTED');
    expect(updated.updatedAt).toBe(NOW);
    // Unchanged claims are returned as-is, so nothing needless is written back.
    expect(untouched).toBe(correct);
  });

  it('gracefully returns an empty Map when the case is not in the workspace', () => {
    const evaluations = evaluateCaseClaims(workspace(), 'case_nonexistent');
    expect(evaluations.size).toBe(0);
  });

  it('gracefully returns null for evaluateClaim when the case is not in the workspace', () => {
    const orphanClaim = claim('Claim with missing case', { caseId: 'case_nonexistent' });
    const evaluation = evaluateClaim(workspace({ claims: [orphanClaim] }), orphanClaim.id);
    expect(evaluation).toBeNull();
  });

  it('gracefully returns empty array for refreshClaimStates when the case is not in the workspace', () => {
    const refreshed = refreshClaimStates(workspace(), 'case_nonexistent', NOW);
    expect(refreshed).toEqual([]);
  });
});

/**
 * Which findings count as a disagreement.
 *
 * Six modules each answered this separately and no two agreed. The one that mattered most is
 * the module these tests cover — it decides whether a user's claim reads as contradicted — so
 * its five-way condition became the shared set. The other five were a screen each, which is how
 * the same case came to report a different number of conflicts on the graph than in the panel.
 */
describe('the conflict finding set', () => {
  it('holds only real analysis types', () => {
    // One of the six lists contained 'EVENT_DATE_CONFLICT', which has never been a member of
    // this enum — the rule of that name reports POSSIBLE_CONFLICT. Nothing caught it because a
    // `string[]` compared with `includes` accepts any string, so the entry matched nothing and
    // every date conflict was silently missing from the contradictions that list fed.
    for (const type of CONFLICT_ANALYSIS_TYPES) {
      expect(() => AnalysisTypeEnum.parse(type), `"${type}" is not an AnalysisType`).not.toThrow();
    }
  });

  it('excludes the findings that are about something being absent', () => {
    // Nothing disagrees with anything in these. Counting a silence as a conflict would be the
    // app inventing a dispute out of a gap in the evidence.
    for (const type of ['TIMELINE_GAP', 'MISSING_EVIDENCE', 'UNLINKED_EVIDENCE', 'RESPONSE_OVERDUE'] as const) {
      expect(isConflictFinding(type), `"${type}" should not be a conflict`).toBe(false);
    }
  });

  it('excludes the findings that say two documents agree', () => {
    for (const type of ['CORROBORATED_CLAIM', 'CORROBORATED_EVENT', 'RELATED_EVIDENCE', 'DUPLICATE_EVIDENCE'] as const) {
      expect(isConflictFinding(type), `"${type}" should not be a conflict`).toBe(false);
    }
  });

  it('counts a possible conflict, which two of the six lists left out', () => {
    expect(isConflictFinding('POSSIBLE_CONFLICT')).toBe(true);
  });
});
