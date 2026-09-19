import { beforeEach, describe, expect, it } from 'vitest';
import { applyAnalysisRun, buildRuleContext, runAnalysis } from '@domain/rules/engine';
import { enabledRules, RULES, ruleById } from '@domain/rules/registry';
import { CASE_ID, claim, evidence, event, link, ref, resetIds, workspace } from './helpers';

const NOW = 1_700_000_000_000;
const LATER = NOW + 86_400_000;

const INVOICE = `TAX INVOICE
Invoice Number: INV-2024-018
Invoice Date: 12/03/2024
Total: INR 85,000.00
`;

const RECEIPT = `PAYMENT CONFIRMATION
Against Invoice No: INV-2024-018
Payment Date: 28/03/2024
Total amount paid: INR 40,000.00
`;

beforeEach(resetIds);

describe('rule registry', () => {
  it('gives every rule a unique, versioned id', () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z-]+@\d+$/);
  });

  it('states for every rule what it does not prove', () => {
    for (const rule of RULES) {
      expect(rule.rationale.length).toBeGreaterThan(40);
      expect(rule.description.length).toBeGreaterThan(10);
    }
  });

  it('orders rules by priority so the most serious checks run first', () => {
    const priorities = enabledRules().map((rule) => rule.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
  });

  it('looks rules up by id', () => {
    expect(ruleById('amount-mismatch@2')?.resultType).toBe('AMOUNT_MISMATCH');
    expect(ruleById('does-not-exist@1')).toBeUndefined();
  });
});

describe('buildRuleContext', () => {
  it('excludes soft-deleted records', () => {
    const alive = evidence(INVOICE);
    const dead = evidence(RECEIPT, { deletedAt: NOW });
    const context = buildRuleContext(workspace({ evidence: [alive, dead] }), CASE_ID);
    expect(context.evidence.map((item) => item.id)).toEqual([alive.id]);
  });

  it('excludes records belonging to another case', () => {
    const mine = evidence(INVOICE);
    const theirs = evidence(RECEIPT, { caseId: 'case_other' });
    const context = buildRuleContext(workspace({ evidence: [mine, theirs] }), CASE_ID);
    expect(context.evidence.map((item) => item.id)).toEqual([mine.id]);
  });

  it('drops relationships whose endpoint was deleted, so removed evidence stops counting', () => {
    const kept = claim('A claim');
    const removed = evidence(INVOICE, { deletedAt: NOW });
    const context = buildRuleContext(
      workspace({
        claims: [kept],
        evidence: [removed],
        relationships: [link(ref.evidence(removed.id), ref.claim(kept.id), 'SUPPORTS')],
      }),
      CASE_ID,
    );
    expect(context.relationships).toEqual([]);
    expect(context.linksTo('claim', kept.id)).toEqual([]);
  });

  it('throws rather than silently analysing nothing when the case is absent', () => {
    expect(() => buildRuleContext(workspace(), 'case_missing')).toThrow(/not present/);
  });
});

describe('runAnalysis', () => {
  it('produces no findings for an empty case', () => {
    const run = runAnalysis(workspace(), CASE_ID, NOW);
    expect(run.results).toEqual([]);
    expect(run.evaluatedRuleIds.length).toBe(enabledRules().length);
  });

  it('flags byte-identical files as duplicates regardless of file name', () => {
    const original = evidence(INVOICE, { fileName: 'invoice.pdf' });
    const copy = evidence(INVOICE, { fileName: 'invoice-final.pdf' });
    const run = runAnalysis(workspace({ evidence: [original, copy] }), CASE_ID, NOW);
    const duplicate = run.results.find((result) => result.resultType === 'DUPLICATE_EVIDENCE');
    expect(duplicate).toBeDefined();
    expect(duplicate?.supportingEvidenceIds.sort()).toEqual([original.id, copy.id].sort());
  });

  it('does not call two different documents duplicates', () => {
    const run = runAnalysis(workspace({ evidence: [evidence(INVOICE), evidence(RECEIPT)] }), CASE_ID, NOW);
    expect(run.results.some((result) => result.resultType === 'DUPLICATE_EVIDENCE')).toBe(false);
  });

  it('reports an amount discrepancy only between documents sharing a reference', () => {
    const withShared = runAnalysis(
      workspace({ evidence: [evidence(INVOICE), evidence(RECEIPT)] }),
      CASE_ID,
      NOW,
    );
    expect(withShared.results.some((result) => result.resultType === 'AMOUNT_MISMATCH')).toBe(true);

    // Same two amounts, but no shared identifier: the comparison is ungrounded and
    // must not fire.
    const unrelated = runAnalysis(
      workspace({
        evidence: [
          evidence('Total: INR 85,000.00'),
          evidence('Total amount paid: INR 40,000.00'),
        ],
      }),
      CASE_ID,
      NOW,
    );
    expect(unrelated.results.some((result) => result.resultType === 'AMOUNT_MISMATCH')).toBe(false);
  });

  it('detects amount discrepancy between mall bill and UPI screenshot sharing party and date', () => {
    const mallBill = evidence(
      'Bill No: 4471\nBilled by: Mall Retail Outlet Pvt Ltd\nDate: 12/09/2026\nTotal: INR 100.00',
      { fileName: 'mall-bill.pdf' },
    );
    const upiScreenshot = evidence(
      'UPI Transaction ID: 409182736155\nPaid to: Mall Retail Outlet Pvt Ltd\nDate: 12/09/2026\nTotal amount paid: INR 1,000.00',
      { fileName: 'gpay-screenshot.jpg' },
    );
    const run = runAnalysis(
      workspace({ evidence: [mallBill, upiScreenshot] }),
      CASE_ID,
      NOW,
    );
    const mismatch = run.results.find((result) => result.resultType === 'AMOUNT_MISMATCH');
    expect(mismatch).toBeDefined();
    expect(mismatch?.explanation).toContain('INR 900.00');
    // Why the two figures were put side by side is a reason to doubt the comparison, not part
    // of what the records say, so it lives in the caveat. Asserted on that field alone: an
    // `a ?? b` or a concatenation would pass wherever the text ended up and stop testing the
    // split at all.
    expect(mismatch?.caveat).toContain('mall retail outlet');
  });

  it('raises one finding per shared reference, not one per pair of documents', () => {
    // Four documents quoting one invoice number make six pairs. Six near-identical
    // findings would bury the case; one finding names all four.
    const items = [
      evidence(INVOICE, { id: 'evd_a' }),
      evidence(`Invoice No: INV-2024-018\nFollow-up one`, { id: 'evd_b' }),
      evidence(`Invoice No: INV-2024-018\nFollow-up two`, { id: 'evd_c' }),
      evidence(`Invoice No: INV-2024-018\nFollow-up three`, { id: 'evd_d' }),
    ];
    const run = runAnalysis(workspace({ evidence: items }), CASE_ID, NOW);
    const related = run.results.filter((result) => result.resultType === 'RELATED_EVIDENCE');
    expect(related).toHaveLength(1);
    expect(related[0]?.supportingEvidenceIds).toHaveLength(4);
  });

  it('ignores amounts in different currencies rather than inventing a conversion', () => {
    const run = runAnalysis(
      workspace({
        evidence: [
          evidence('Invoice No: INV-2024-018\nTotal: INR 85,000.00'),
          evidence('Invoice No: INV-2024-018\nTotal: USD 85,000.00'),
        ],
      }),
      CASE_ID,
      NOW,
    );
    expect(run.results.some((result) => result.resultType === 'AMOUNT_MISMATCH')).toBe(false);
  });

  it('tolerates small differences that are rounding or fees', () => {
    const run = runAnalysis(
      workspace({
        evidence: [
          evidence('Invoice No: INV-2024-018\nTotal: INR 85,000.00'),
          evidence('Invoice No: INV-2024-018\nTotal: INR 84,950.00'),
        ],
      }),
      CASE_ID,
      NOW,
    );
    expect(run.results.some((result) => result.resultType === 'AMOUNT_MISMATCH')).toBe(false);
  });

  it('flags a claim with nothing linked to it', () => {
    const orphan = claim('Nothing backs this up');
    const run = runAnalysis(workspace({ claims: [orphan] }), CASE_ID, NOW);
    const finding = run.results.find((result) => result.resultType === 'UNSUPPORTED_CLAIM');
    expect(finding?.relatedClaimIds).toEqual([orphan.id]);
  });

  it('does not flag a claim supported indirectly through a required event', () => {
    const supported = claim('Supported via its event');
    const occurred = event('The event', '2024-03-12');
    const backing = evidence(INVOICE);
    const run = runAnalysis(
      workspace({
        claims: [{ ...supported, requiredEventIds: [occurred.id] }],
        events: [occurred],
        evidence: [backing],
        relationships: [link(ref.evidence(backing.id), ref.event(occurred.id), 'ATTACHED_TO_EVENT')],
      }),
      CASE_ID,
      NOW,
    );
    expect(run.results.some((result) => result.resultType === 'UNSUPPORTED_CLAIM')).toBe(false);
  });

  it('counts two copies of one file as a single source, not corroboration', () => {
    const asserted = claim('Backed by the same file twice');
    const original = evidence(INVOICE, { id: 'evd_original' });
    const copy = evidence(INVOICE, { id: 'evd_copy' });
    const run = runAnalysis(
      workspace({
        claims: [asserted],
        evidence: [original, copy],
        relationships: [
          link(ref.evidence(original.id), ref.claim(asserted.id), 'SUPPORTS'),
          link(ref.evidence(copy.id), ref.claim(asserted.id), 'SUPPORTS'),
        ],
      }),
      CASE_ID,
      NOW,
    );
    expect(run.results.some((result) => result.resultType === 'CORROBORATED_CLAIM')).toBe(false);
  });

  it('reports corroboration when two genuinely different sources agree', () => {
    const asserted = claim('Backed by two different documents');
    const first = evidence(INVOICE);
    const second = evidence(RECEIPT);
    const run = runAnalysis(
      workspace({
        claims: [asserted],
        evidence: [first, second],
        relationships: [
          link(ref.evidence(first.id), ref.claim(asserted.id), 'SUPPORTS'),
          link(ref.evidence(second.id), ref.claim(asserted.id), 'SUPPORTS'),
        ],
      }),
      CASE_ID,
      NOW,
    );
    expect(run.results.some((result) => result.resultType === 'CORROBORATED_CLAIM')).toBe(true);
  });

  it('corroborates matching amounts across independent sources (e.g. Mall Bill and GPay screenshot)', () => {
    const mallBill = evidence('TAX INVOICE\nMall Store Receipt\nTotal: INR 100.00\nDate: 12/03/2024', {
      id: 'evd_mall_bill',
      title: 'Mall Bill',
    });
    const gpayScreenshot = evidence('Google Pay Transaction Successful\nPaid to Merchant\nAmount: INR 100.00\nDate: 12/03/2024', {
      id: 'evd_gpay_screenshot',
      title: 'Google Pay Screenshot',
    });

    const run = runAnalysis(
      workspace({ evidence: [mallBill, gpayScreenshot] }),
      CASE_ID,
      NOW,
    );

    const corroborated = run.results.find((result) => result.resultType === 'CORROBORATED_EVENT');
    expect(corroborated).toBeDefined();
    expect(corroborated?.supportingEvidenceIds).toEqual([mallBill.id, gpayScreenshot.id].sort());
    expect(corroborated?.inputs['Agreed amount']).toBe('INR 100.00');
    expect(corroborated?.title).toContain('INR 100.00');
    // The grounds for the comparison are part of the finding, not an implementation detail:
    // the reader has to be able to see why these two documents were put side by side.
    expect(corroborated?.inputs['Compared because']).toContain('12 March 2024');
    // `12/03/2024` reads as both 12 March and 3 December, which costs one step of confidence
    // and is stated rather than hidden.
    expect(corroborated?.confidence).toBe('NEEDS_REVIEW');
    expect(corroborated?.inputs['Compared because']).toContain('two ways');
  });

  it('does not corroborate equal amounts that nothing links together', () => {
    // The bug this guards: grouping the whole case by amount alone reported a March rent
    // payment and an August phone bill as "corroborated across 2 sources". Round numbers
    // repeat constantly in real money, so ungrounded matching misfires by default — and
    // inventing agreement misleads a user far more than missing a disagreement.
    const rent = evidence('Rent receipt\nPaid: INR 5000.00\nDate: 03/03/2024', {
      id: 'evd_rent',
      title: 'Rent receipt',
    });
    const phoneBill = evidence('Airtel postpaid bill\nTotal: INR 5000.00\nDate: 19/08/2024', {
      id: 'evd_phone',
      title: 'Phone bill',
    });

    const run = runAnalysis(workspace({ evidence: [rent, phoneBill] }), CASE_ID, NOW);

    expect(run.results.some((result) => result.resultType === 'CORROBORATED_EVENT')).toBe(false);
  });

  it('reports an amount mismatch between documents linked only by a shared date', () => {
    // A shop's bill number and a payment app's UPI reference come from unrelated numbering
    // schemes and never match, so requiring a shared identifier missed the most common real
    // case entirely. A shared date is weaker grounding, and the finding says so.
    const bill = evidence('Mall Store\nTAX INVOICE\nTotal: INR 100.00\nDate: 12/03/2024', {
      id: 'evd_bill_low',
      title: 'Mall Bill',
    });
    const screenshot = evidence('Google Pay\nAmount: INR 1000.00\nDate: 12/03/2024', {
      id: 'evd_gpay_high',
      title: 'Google Pay Screenshot',
    });

    const run = runAnalysis(workspace({ evidence: [bill, screenshot] }), CASE_ID, NOW);

    const mismatch = run.results.find((result) => result.resultType === 'AMOUNT_MISMATCH');
    expect(mismatch).toBeDefined();
    expect(mismatch?.inputs['Difference']).toBe('INR 900.00');
    expect(mismatch?.inputs['Compared because']).toContain('12 March 2024');
    // A difference always needs a human: partial payment, tax and platform fees all explain
    // one legitimately, and the rule does not decide which applies.
    expect(mismatch?.confidence).toBe('NEEDS_REVIEW');
  });

  it('does not corroborate amounts between duplicate copies of the same file', () => {
    const original = evidence('Payment: INR 100.00', { id: 'evd_orig' });
    const duplicate = evidence('Payment: INR 100.00', { id: 'evd_dup' });

    const run = runAnalysis(
      workspace({ evidence: [original, duplicate] }),
      CASE_ID,
      NOW,
    );

    expect(
      run.results.some(
        (result) => result.resultType === 'CORROBORATED_EVENT' && result.confidence === 'EXACT_MATCH',
      ),
    ).toBe(false);
  });

  it('flags amount mismatch between documents linked to the same claim without shared invoice numbers', () => {
    const claimDispute = claim('User paid ₹100 at retail store');
    const mallBill = evidence('TAX INVOICE\nRetail Store Bill\nTotal: INR 100.00', {
      id: 'evd_bill',
      title: 'Store Bill',
    });
    const debitReceipt = evidence('Bank Statement Debit\nMerchant Transfer: INR 75.00', {
      id: 'evd_debit',
      title: 'Bank Debit',
    });

    const run = runAnalysis(
      workspace({
        claims: [claimDispute],
        evidence: [mallBill, debitReceipt],
        relationships: [
          link(ref.evidence(mallBill.id), ref.claim(claimDispute.id), 'SUPPORTS'),
          link(ref.evidence(debitReceipt.id), ref.claim(claimDispute.id), 'SUPPORTS'),
        ],
      }),
      CASE_ID,
      NOW,
    );

    const mismatch = run.results.find(
      (r) => r.resultType === 'AMOUNT_MISMATCH' && r.supportingEvidenceIds.includes('evd_bill'),
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.explanation).toContain('INR 100.00');
    expect(mismatch?.explanation).toContain('INR 75.00');
  });

  it('flags conflicting dates for one event', () => {
    const handover = event('Handover', '2024-03-12');
    const mine = evidence('Sent: 12 March 2024\nDelivered the final package.');
    const theirs = evidence('Sent: 15 March 2024\nDelivered on 15 March 2024 in our records.');
    const run = runAnalysis(
      workspace({
        events: [handover],
        evidence: [mine, theirs],
        relationships: [
          link(ref.evidence(mine.id), ref.event(handover.id), 'SUPPORTS'),
          link(ref.evidence(theirs.id), ref.event(handover.id), 'SUPPORTS'),
        ],
      }),
      CASE_ID,
      NOW,
    );
    expect(run.results.some((result) => result.resultType === 'POSSIBLE_CONFLICT')).toBe(true);
  });

  it('does not treat a month-precision date as conflicting with a day inside it', () => {
    const handover = event('Handover', '2024-03-12');
    const precise = evidence('Delivered on 12 March 2024.');
    const vague = evidence('Delivered in March 2024 sometime.');
    const run = runAnalysis(
      workspace({
        events: [handover],
        evidence: [precise, vague],
        relationships: [
          link(ref.evidence(precise.id), ref.event(handover.id), 'SUPPORTS'),
          link(ref.evidence(vague.id), ref.event(handover.id), 'SUPPORTS'),
        ],
      }),
      CASE_ID,
      NOW,
    );
    expect(run.results.some((result) => result.resultType === 'POSSIBLE_CONFLICT')).toBe(false);
  });
});

describe('re-running analysis', () => {
  const buildWorkspace = () => {
    const first = evidence(INVOICE, { id: 'evd_invoice' });
    const second = evidence(RECEIPT, { id: 'evd_receipt' });
    const orphan = claim('Nothing backs this up', { id: 'clm_orphan' });
    return workspace({ evidence: [first, second], claims: [orphan] });
  };

  it('produces identical ids and content on an unchanged case', () => {
    const base = buildWorkspace();
    const first = runAnalysis(base, CASE_ID, NOW);
    const second = runAnalysis(applyAnalysisRun(base, first, CASE_ID), CASE_ID, NOW);
    expect(second.results.map((result) => result.id)).toEqual(first.results.map((result) => result.id));
    expect(second.results).toEqual(first.results);
  });

  it('never accumulates duplicate findings across repeated runs', () => {
    let current = buildWorkspace();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      current = applyAnalysisRun(current, runAnalysis(current, CASE_ID, NOW + attempt), CASE_ID);
    }
    const ids = current.analysisResults.map((result) => result.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('preserves createdAt so a finding keeps its original age', () => {
    const base = buildWorkspace();
    const first = runAnalysis(base, CASE_ID, NOW);
    const second = runAnalysis(applyAnalysisRun(base, first, CASE_ID), CASE_ID, LATER);
    expect(second.results[0]?.createdAt).toBe(NOW);
    expect(second.results[0]?.updatedAt).toBe(LATER);
  });

  it('keeps a dismissed finding dismissed', () => {
    const base = buildWorkspace();
    const first = runAnalysis(base, CASE_ID, NOW);
    const target = first.results[0]!;
    const reviewed = applyAnalysisRun(base, first, CASE_ID);
    reviewed.analysisResults = reviewed.analysisResults.map((result) =>
      result.id === target.id
        ? { ...result, status: 'DISMISSED' as const, reviewNote: 'Checked, not an issue' }
        : result,
    );

    const second = runAnalysis(reviewed, CASE_ID, LATER);
    const after = second.results.find((result) => result.id === target.id);
    expect(after?.status).toBe('DISMISSED');
    expect(after?.reviewNote).toBe('Checked, not an issue');
  });

  it('resolves a finding once the condition behind it is gone, keeping the record', () => {
    const base = buildWorkspace();
    const first = runAnalysis(base, CASE_ID, NOW);
    const unsupported = first.results.find((result) => result.resultType === 'UNSUPPORTED_CLAIM')!;

    // Link evidence to the claim: the finding should no longer hold.
    const applied = applyAnalysisRun(base, first, CASE_ID);
    const fixed = {
      ...applied,
      relationships: [...applied.relationships, link(ref.evidence('evd_invoice'), ref.claim('clm_orphan'), 'SUPPORTS')],
    };

    const second = runAnalysis(fixed, CASE_ID, LATER);
    expect(second.results.some((result) => result.id === unsupported.id)).toBe(false);
    const resolved = second.resolved.find((result) => result.id === unsupported.id);
    expect(resolved?.status).toBe('RESOLVED');
  });

  it('leaves a dismissed finding alone rather than resolving it', () => {
    const base = buildWorkspace();
    const first = runAnalysis(base, CASE_ID, NOW);
    const unsupported = first.results.find((result) => result.resultType === 'UNSUPPORTED_CLAIM')!;

    const applied = applyAnalysisRun(base, first, CASE_ID);
    const dismissed = {
      ...applied,
      analysisResults: applied.analysisResults.map((result) =>
        result.id === unsupported.id ? { ...result, status: 'DISMISSED' as const } : result,
      ),
      relationships: [...applied.relationships, link(ref.evidence('evd_invoice'), ref.claim('clm_orphan'), 'SUPPORTS')],
    };

    const second = runAnalysis(dismissed, CASE_ID, LATER);
    expect(second.resolved.some((result) => result.id === unsupported.id)).toBe(false);
  });

  it('reopens a finding that was resolved and has started firing again', () => {
    const base = buildWorkspace();
    const first = runAnalysis(base, CASE_ID, NOW);
    const target = first.results[0]!;
    const applied = applyAnalysisRun(base, first, CASE_ID);
    applied.analysisResults = applied.analysisResults.map((result) =>
      result.id === target.id ? { ...result, status: 'RESOLVED' as const } : result,
    );

    const second = runAnalysis(applied, CASE_ID, LATER);
    expect(second.results.find((result) => result.id === target.id)?.status).toBe('OPEN');
  });
});

describe('applyAnalysisRun', () => {
  it('records when the case was last analysed', () => {
    const base = workspace({ evidence: [evidence(INVOICE)] });
    const applied = applyAnalysisRun(base, runAnalysis(base, CASE_ID, NOW), CASE_ID);
    expect(applied.cases[0]?.lastAnalyzedAt).toBe(NOW);
  });

  it('sorts findings by severity so the most serious appears first', () => {
    const run = runAnalysis(
      workspace({ evidence: [evidence(INVOICE), evidence(RECEIPT)], claims: [claim('Unsupported')] }),
      CASE_ID,
      NOW,
    );
    expect(run.results[0]?.severity).toBe('HIGH');
  });

  it('always attributes a finding to the rule that produced it', () => {
    const run = runAnalysis(workspace({ evidence: [evidence(INVOICE), evidence(RECEIPT)] }), CASE_ID, NOW);
    for (const result of run.results) {
      expect(result.triggeredRuleIds).toHaveLength(1);
      expect(ruleById(result.triggeredRuleIds[0]!)).toBeDefined();
      // Every finding shows the values it compared, so a reader can check it themselves.
      expect(Object.keys(result.inputs).length).toBeGreaterThan(0);
    }
  });

  /**
   * Severity tracks the weaker of the two things being compared.
   *
   * This pair of tests exists because the first one used to expect `HIGH`. A document
   * recording `FAILED` against *this app's reading of a sentence the user typed* was
   * presented at the same severity as two bank records that flatly disagree — and it
   * sorted above them, since it also carries a higher rule priority. The user's own
   * account of their dispute was being used as the evidence that they were lying.
   *
   * Nothing about the word list fixes that. "Transferred" in a claim is an inference about
   * prose; `transactionStatus` on a second document is a value a person can go and look at.
   * So the claim-only finding is graded as the question it is, and only document-against-
   * document keeps `HIGH`.
   */
  it('asks rather than accuses when the only thing disagreeing is wording the user typed', () => {
    const failedReceipt = evidence('UPI Transaction ID: UPI-8492048102\nStatus: FAILED\nAmount: INR 50,000');
    const paymentClaim = claim('Rahul transferred ₹50,000 to Priya via UPI');
    const run = runAnalysis(workspace({ evidence: [failedReceipt], claims: [paymentClaim] }), CASE_ID, NOW);
    const finding = run.results.find((r) => r.resultType === 'PAYMENT_STATUS_CONFLICT');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('LOW');
    expect(finding?.confidence).toBe('NEEDS_REVIEW');
    expect(finding?.supportingEvidenceIds).toContain(failedReceipt.id);
    // The grounds are named, so the reading can be rejected by the person who typed it.
    expect(finding?.inputs['Matched on the word']).toBe('transferred');
  });

  it('keeps a document-against-document payment conflict at full severity', () => {
    const failedReceipt = evidence('UPI Transaction ID: UPI-8492048102\nStatus: FAILED\nAmount: INR 50,000', {
      title: 'Gateway log',
    });
    const successReceipt = evidence('UPI Transaction ID: UPI-8492048103\nStatus: SUCCESS\nAmount: INR 50,000', {
      title: 'Bank statement',
    });
    const run = runAnalysis(workspace({ evidence: [failedReceipt, successReceipt] }), CASE_ID, NOW);
    const finding = run.results.find((r) => r.resultType === 'PAYMENT_STATUS_CONFLICT');
    expect(finding?.severity).toBe('HIGH');
    expect(finding?.confidence).toBe('STRONG_MATCH');
    expect(finding?.supportingEvidenceIds).toEqual(
      expect.arrayContaining([failedReceipt.id, successReceipt.id]),
    );
    // No claim was involved, so the finding must not imply one was.
    expect(finding?.relatedClaimIds).toEqual([]);
  });

  it('says nothing when a claim carries both senses at once', () => {
    // "I paid nothing / the transfer failed" is the user agreeing with the document. A
    // classifier that stopped at the first success-shaped word would report a conflict.
    const failedReceipt = evidence('UPI Transaction ID: UPI-8492048102\nStatus: FAILED\nAmount: INR 50,000');
    const run = runAnalysis(
      workspace({
        evidence: [failedReceipt],
        claims: [claim('I transferred the money but the payment failed and was never received')],
      }),
      CASE_ID,
      NOW,
    );
    expect(run.results.find((r) => r.resultType === 'PAYMENT_STATUS_CONFLICT')).toBeUndefined();
  });

  it('detects harassment and threatening statements in chat records', () => {
    const chatDoc = evidence('[12/03/2024, 14:22] Rahul: Pay me right now or I will destroy your reputation and ruin you!');
    const run = runAnalysis(workspace({ evidence: [chatDoc] }), CASE_ID, NOW);
    const finding = run.results.find((r) => r.resultType === 'HARASSMENT_INDICATOR');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('HIGH');
    expect(finding?.explanation).toContain('Rahul');
  });
});


/**
 * Two sources sharing a title is ordinary — "Screenshot" twice, or two exports from the
 * same banking app. Because `inputs` is a `Record<string, string>` keyed by the label a
 * rule chooses, a rule that keys it by document title loses one of the two values it was
 * comparing when the titles match: no error, nothing to notice, and a finding that shows
 * one figure while claiming to have compared two.
 *
 * These tests pin the guarantee at the level a reader experiences it — the finding names
 * its sources distinguishably, and shows as many compared values as it compared.
 */
describe('findings stay readable when two sources share a title', () => {
  const SAME_TITLE = 'Screenshot';

  it('keeps both compared values when two documents have identical titles', () => {
    const paid = evidence('UPI Payment\nRef No: TXN-55510\nStatus: SUCCESS\nAmount: INR 12,000', {
      title: SAME_TITLE,
      fileName: 'gpay-1.png',
    });
    const failed = evidence('UPI Payment\nRef No: TXN-55510\nStatus: FAILED\nAmount: INR 12,000', {
      title: SAME_TITLE,
      fileName: 'gpay-2.png',
    });

    const run = runAnalysis(workspace({ evidence: [paid, failed] }), CASE_ID, NOW);
    const finding = run.results.find((r) => r.resultType === 'STATEMENT_DISCREPANCY');
    expect(finding).toBeDefined();

    // Two documents were compared, so two rows must survive into `inputs`.
    expect(Object.keys(finding!.inputs)).toHaveLength(2);
    // And the two rows must be tellable apart, which the shared title alone is not.
    expect(new Set(Object.keys(finding!.inputs)).size).toBe(2);
  });

  it('names duplicate files distinguishably, since duplicates share a title by nature', () => {
    const text = 'RECEIPT\nOrder: ORD-9001\nTotal: INR 2,400';
    const first = evidence(text, { title: SAME_TITLE, fileName: 'receipt-a.pdf' });
    const second = evidence(text, { title: SAME_TITLE, fileName: 'receipt-b.pdf' });

    const run = runAnalysis(workspace({ evidence: [first, second] }), CASE_ID, NOW);
    const finding = run.results.find((r) => r.resultType === 'DUPLICATE_EVIDENCE');
    expect(finding).toBeDefined();
    expect(finding!.inputs['First item']).not.toBe(finding!.inputs['Second item']);
    // The full digest is the entire basis for the claim, so it is not abbreviated away.
    expect(finding!.inputs['SHA-256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never shows a reader a raw enum value or a code identifier', () => {
    const failed = evidence('UPI Payment\nRef No: TXN-7781\nStatus: FAILED\nAmount: INR 5,000');
    const ok = evidence('UPI Payment\nRef No: TXN-7781\nStatus: SUCCESS\nAmount: INR 5,000');
    const chat = evidence('[12/03/2024, 14:22] Rahul: Pay me right now or I will destroy you!');
    const asserted = claim('Rahul paid ₹5,000 and it was received');

    const run = runAnalysis(
      workspace({ evidence: [failed, ok, chat], claims: [asserted] }),
      CASE_ID,
      NOW,
    );
    expect(run.results.length).toBeGreaterThan(0);

    for (const result of run.results) {
      for (const [label, value] of Object.entries(result.inputs)) {
        // SCREAMING_SNAKE is how enums are stored; it is not how they are shown. The
        // SHA-256 label is the one legitimate all-caps term a reader recognises.
        if (label !== 'SHA-256') {
          expect(label, `label "${label}"`).not.toMatch(/^[A-Z][A-Z_]+$/);
        }
        expect(value, `value of "${label}"`).not.toMatch(/^[A-Z][A-Z_]{3,}$/);
        // camelCase keys are code identifiers that leaked into the interface.
        expect(label, `label "${label}"`).not.toMatch(/^[a-z]+[A-Z]/);
      }
    }
  });
});
