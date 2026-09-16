import { beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeEvidenceIndependence,
  filterIndependentSources,
} from '@domain/analysis/independence';
import { buildRuleContext } from '@domain/rules/engine';
import { CASE_ID, evidence, link, ref, resetIds, workspace } from './helpers';

beforeEach(() => {
  resetIds();
});

describe('analyzeEvidenceIndependence', () => {
  it('treats single source as 100% independent', () => {
    const e1 = evidence('Invoice details for purchase', { id: 'evd_1' });
    const ws = workspace({ evidence: [e1] });
    const ctx = buildRuleContext(ws, CASE_ID);

    const result = analyzeEvidenceIndependence(ctx, [e1]);
    expect(result.totalSources).toBe(1);
    expect(result.independentSourcesCount).toBe(1);
    expect(result.independenceRatio).toBe(1.0);
    expect(result.derivativeGroups).toHaveLength(0);
    expect(result.independentEvidenceIds).toEqual(['evd_1']);
  });

  it('identifies byte-for-byte identical files with same sha256', () => {
    const text = 'Transaction receipt INV-999 for Rs. 5000 paid on 15 March 2024';
    const e1 = evidence(text, { id: 'evd_orig', createdAt: 1000 });
    const e2 = evidence(text, { id: 'evd_copy', createdAt: 2000, sha256: e1.sha256 });
    const ws = workspace({ evidence: [e1, e2] });
    const ctx = buildRuleContext(ws, CASE_ID);

    const result = analyzeEvidenceIndependence(ctx, [e1, e2]);
    expect(result.totalSources).toBe(2);
    expect(result.independentSourcesCount).toBe(1);
    expect(result.independenceRatio).toBe(0.5);
    expect(result.derivativeGroups).toHaveLength(1);
    expect(result.derivativeGroups[0]?.reason).toBe('BYTE_IDENTICAL');
    expect(result.derivativeGroups[0]?.anchorEvidenceId).toBe('evd_orig');
    expect(result.derivativeGroups[0]?.derivativeEvidenceIds).toEqual(['evd_copy']);
    expect(result.independentEvidenceIds).toEqual(['evd_orig']);
  });

  it('identifies explicit DUPLICATE_OF relationship links', () => {
    const e1 = evidence('Original document invoice 101', { id: 'evd_1' });
    const e2 = evidence('Scanned copy of invoice 101', { id: 'evd_2' });
    const ws = workspace({
      evidence: [e1, e2],
      relationships: [link(ref.evidence(e2.id), ref.evidence(e1.id), 'DUPLICATE_OF')],
    });
    const ctx = buildRuleContext(ws, CASE_ID);

    const result = analyzeEvidenceIndependence(ctx, [e1, e2]);
    expect(result.independentSourcesCount).toBe(1);
    expect(result.derivativeGroups[0]?.reason).toBe('EXPLICIT_LINK');
    expect(result.independentEvidenceIds).toEqual(['evd_1']);
  });

  it('identifies substring cropped excerpts (>65% overlap)', () => {
    const fullText =
      'OFFICIAL RECEIPT: Received payment of INR 25,000 from customer John Doe for annual maintenance on 15 March 2024 with ref TXN99881122.';
    const excerptText =
      'Received payment of INR 25,000 from customer John Doe for annual maintenance on 15 March 2024';
    const e1 = evidence(fullText, { id: 'evd_full', title: 'Full Receipt' });
    const e2 = evidence(excerptText, { id: 'evd_crop', title: 'Cropped Receipt Screenshot', sha256: 'crop-hash' });
    const ws = workspace({ evidence: [e1, e2] });
    const ctx = buildRuleContext(ws, CASE_ID);

    const result = analyzeEvidenceIndependence(ctx, [e1, e2]);
    expect(result.independentSourcesCount).toBe(1);
    expect(result.derivativeGroups[0]?.reason).toBe('SUBSTRING_EXCERPT');
    expect(result.derivativeGroups[0]?.anchorEvidenceId).toBe('evd_full');
    expect(result.derivativeGroups[0]?.derivativeEvidenceIds).toEqual(['evd_crop']);
  });

  it('identifies shared transaction record co-occurrence', () => {
    const textA = 'Merchant Gateway Payment: Transaction ID TXN-445566, Date 15 March 2024, Total INR 1,200.00 Paid';
    const textB = 'Bank SMS Alert: Transaction ID TXN-445566 debited INR 1,200.00 on 15 March 2024';
    const e1 = evidence(textA, { id: 'evd_gateway', createdAt: 1000 });
    const e2 = evidence(textB, { id: 'evd_sms', createdAt: 2000 });
    const ws = workspace({ evidence: [e1, e2] });
    const ctx = buildRuleContext(ws, CASE_ID);

    const result = analyzeEvidenceIndependence(ctx, [e1, e2]);
    expect(result.independentSourcesCount).toBe(1);
    expect(result.derivativeGroups[0]?.reason).toBe('SHARED_TRANSACTION_RECORD');
    expect(result.independentEvidenceIds).toEqual(['evd_gateway']);
  });

  it('filters out derivative items using filterIndependentSources', () => {
    const e1 = evidence('Invoice 101 with unique details A', { id: 'evd_1', createdAt: 1000 });
    const e2 = evidence('Invoice 101 with unique details A', { id: 'evd_2', createdAt: 2000 });
    const e3 = evidence('Completely different shipping note 202 for unrelated goods', { id: 'evd_3' });
    const ws = workspace({ evidence: [e1, e2, e3] });
    const ctx = buildRuleContext(ws, CASE_ID);

    const independent = filterIndependentSources(ctx, [e1, e2, e3]);
    expect(independent.map((e) => e.id)).toEqual(['evd_1', 'evd_3']);
  });
});
