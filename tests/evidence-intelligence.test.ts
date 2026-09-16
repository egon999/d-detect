import { beforeEach, describe, expect, it } from 'vitest';
import {
  discoverCandidateAssertions,
  evaluateEvidenceCompleteness,
  reconstructTimelineFromEvidence,
  resolveEntitiesFromEvidence,
  runEvidenceIntelligence,
} from '@domain/analysis/evidence-intelligence';
import { quoteNamesEntity } from '@domain/analysis/report-entities';
import { CASE_ID, evidence, resetIds, workspace } from './helpers';

beforeEach(() => {
  resetIds();
});

describe('discoverCandidateAssertions', () => {
  it('discovers transaction assertions from transaction IDs', () => {
    const e1 = evidence(
      'Payment receipt for Transaction ID TXN-998811 from Vendor Corp on 15 March 2024 for INR 5,000.00.',
      { id: 'evd_tx' },
    );
    const assertions = discoverCandidateAssertions([e1]);
    expect(assertions.length).toBeGreaterThan(0);

    const txAssertion = assertions.find((a) => a.kind === 'TRANSACTION');
    expect(txAssertion).toBeDefined();
    expect(txAssertion?.statement).toContain('TXN-998811');
    expect(txAssertion?.statement).toContain('5,000.00');
    expect(txAssertion?.corroboration).toBe('SINGLE_SOURCE');
    expect(txAssertion?.sourceEvidenceIds).toEqual(['evd_tx']);
    expect(txAssertion?.citations.length).toBeGreaterThan(0);
  });

  it('discovers invoice assertions from invoice numbers', () => {
    const e1 = evidence(
      'Tax Invoice Number: INV-2024-8877 issued on 10 March 2024. Total: INR 12,500.00.',
      { id: 'evd_inv' },
    );
    const assertions = discoverCandidateAssertions([e1]);
    const invAssertion = assertions.find((a) => a.kind === 'BILLING');
    expect(invAssertion).toBeDefined();
    expect(invAssertion?.statement).toContain('INV-2024-8877');
    expect(invAssertion?.statement).toContain('12,500.00');
  });

  it('marks transaction status FAILED as CONTRADICTED assertion', () => {
    const e1 = evidence('Transaction failure for order 992. Payment failed. Status: FAILED.', {
      id: 'evd_fail',
    });
    const assertions = discoverCandidateAssertions([e1]);
    const statusAssertion = assertions.find((a) => a.kind === 'STATUS');
    expect(statusAssertion).toBeDefined();
    expect(statusAssertion?.corroboration).toBe('CONTRADICTED');
  });

  it('upgrades assertion to CORROBORATED when multiple sources share transaction ID', () => {
    const e1 = evidence('Merchant statement: Transaction ID TXN-554433 completed for INR 2,000.00.', {
      id: 'evd_1',
    });
    const e2 = evidence('Bank confirmation: Transaction ID TXN-554433 debited INR 2,000.00.', {
      id: 'evd_2',
    });
    const assertions = discoverCandidateAssertions([e1, e2]);
    const txAssertion = assertions.find((a) => a.kind === 'TRANSACTION');
    expect(txAssertion).toBeDefined();
    expect(txAssertion?.corroboration).toBe('CORROBORATED');
    expect(txAssertion?.sourceEvidenceIds).toContain('evd_1');
    expect(txAssertion?.sourceEvidenceIds).toContain('evd_2');
    expect(txAssertion?.citations.length).toBe(2);
  });
});

describe('reconstructTimelineFromEvidence', () => {
  it('reconstructs events ordered by normalized date', () => {
    const e1 = evidence('Document B recorded on 20 March 2024.', { id: 'evd_b', title: 'Doc B' });
    const e2 = evidence('Document A recorded on 10 March 2024.', { id: 'evd_a', title: 'Doc A' });
    const timeline = reconstructTimelineFromEvidence([e1, e2]);

    expect(timeline.length).toBe(2);
    expect(timeline[0]?.occurredAt).toBe('2024-03-10');
    expect(timeline[0]?.evidenceId).toBe('evd_a');
    expect(timeline[1]?.occurredAt).toBe('2024-03-20');
    expect(timeline[1]?.evidenceId).toBe('evd_b');
    expect(timeline[0]?.citations[0]?.quote).toContain('10 March 2024');
  });

  it('integrates chat timestamps into the timeline', () => {
    const chatText = `Chat Export:
[2024-03-12 10:30] Alice: I sent the advance payment.
[2024-03-14 14:15] Bob: Confirmed received.`;
    const e1 = evidence(chatText, { id: 'evd_chat', title: 'WhatsApp Chat' });
    const timeline = reconstructTimelineFromEvidence([e1]);

    expect(timeline.length).toBeGreaterThan(0);
    const aliceMsg = timeline.find((t) => t.title.includes('Alice'));
    expect(aliceMsg).toBeDefined();
    expect(aliceMsg?.description).toContain('I sent the advance payment');
  });
});

describe('resolveEntitiesFromEvidence', () => {
  it('resolves named entities with citations satisfying quoteNamesEntity', () => {
    const text = 'Payment was remitted by Acme Logistics Corp to Rahul Sharma regarding Invoice INV-1002.';
    const e1 = evidence(text, { id: 'evd_acme' });
    const entities = resolveEntitiesFromEvidence([e1], [{ name: 'Rahul Sharma', role: 'Claimant' }]);

    expect(entities.length).toBeGreaterThan(0);
    const rahul = entities.find((ent) => ent.name.toLowerCase() === 'rahul sharma');
    expect(rahul).toBeDefined();
    expect(rahul?.type).toBe('PERSON');
    expect(rahul?.citations.length).toBeGreaterThan(0);
    expect(quoteNamesEntity(rahul!.citations[0]!.quote, rahul!.name)).toBe(true);
  });
});

describe('evaluateEvidenceCompleteness', () => {
  it('identifies missing payment when invoice exists without payment receipt', () => {
    const e1 = evidence('Invoice Number: INV-9901 issued for INR 50,000.', { id: 'evd_inv' });
    const gaps = evaluateEvidenceCompleteness([e1], 1);

    expect(gaps.some((g) => g.id === 'gap_missing_payment')).toBe(true);
  });

  it('identifies missing invoice when payment exists without invoice', () => {
    const e1 = evidence('Transaction ID: TXN-776655 paid INR 50,000.', { id: 'evd_pay' });
    const gaps = evaluateEvidenceCompleteness([e1], 1);

    expect(gaps.some((g) => g.id === 'gap_missing_invoice')).toBe(true);
  });

  it('identifies unresolved failed transaction', () => {
    const e1 = evidence('Transaction failed. Payment status: FAILED.', { id: 'evd_fail' });
    const gaps = evaluateEvidenceCompleteness([e1], 1);

    expect(gaps.some((g) => g.id === 'gap_failed_resolution')).toBe(true);
  });
});

describe('runEvidenceIntelligence', () => {
  it('assembles a full case report from workspace', () => {
    const e1 = evidence(
      'Invoice Number: INV-2024-001 issued on 10 March 2024 for INR 15,000.00 by Stark Industries.',
      { id: 'evd_1', title: 'Invoice 1' },
    );
    const e2 = evidence(
      'Payment Receipt: Transaction ID TXN-998811 paid INR 15,000.00 on 11 March 2024 to Stark Industries.',
      { id: 'evd_2', title: 'Payment Receipt' },
    );
    const ws = workspace({ evidence: [e1, e2] });

    const report = runEvidenceIntelligence(ws, CASE_ID);
    expect(report.discoveredAssertions.length).toBeGreaterThan(0);
    expect(report.reconstructedTimeline.length).toBeGreaterThanOrEqual(2);
    expect(report.resolvedEntities.length).toBeGreaterThan(0);
    expect(report.independence.totalSources).toBe(2);
    expect(report.independence.independentSources).toBe(2);
    expect(report.independence.ratio).toBe(1.0);
  });
});
