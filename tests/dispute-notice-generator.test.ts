import { describe, expect, it } from 'vitest';
import { generateDisputeNotice } from '../src/domain/analysis/dispute-notice-generator';
import { emptyWorkspace } from '../src/domain/models';
import type { Workspace } from '../src/domain/models';
import { claim, event, evidence, testCase } from './helpers';

describe('Formal Dispute & Grievance Notice Generator', () => {
  function createTestWorkspace(): Workspace {
    const ws = emptyWorkspace();
    const caseId = 'case_notice_test';

    const testCaseRecord = testCase({
      id: caseId,
      ownerId: 'user_1',
      title: 'Wrongful Security Deposit Withholding',
      description: 'Landlord refused to refund $2,500 security deposit after complete tenancy vacating.',
      category: 'TENANCY_DISPUTE',
      incidentDate: '2026-02-01',
      participants: [
        { id: 'p1', name: 'Alice Walker', role: 'Tenant / Claimant' },
        { id: 'p2', name: 'Grand Oak Properties LLC', role: 'Landlord / Respondent' },
      ],
    });
    ws.cases.push(testCaseRecord);

    const ev1 = evidence('Lease agreement states security deposit of $2,500 held in escrow on 2025-01-15.', {
      id: 'ev_1',
      caseId,
      ownerId: 'user_1',
      title: 'Residential Tenancy Agreement',
      fileName: 'lease.pdf',
      sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      capturedAt: '2025-01-15',
    });
    ws.evidence.push(ev1);

    const clm1 = claim('Landlord failed to return $2,500 security deposit within 21 days required by law', {
      id: 'clm_1',
      caseId,
      ownerId: 'user_1',
    });
    ws.claims.push(clm1);

    const evt1 = event('Move out inspection completed with zero damages noted', '2026-02-01', {
      id: 'evt_1',
      caseId,
      ownerId: 'user_1',
    });
    ws.events.push(evt1);

    return ws;
  }

  it('generates a complete dispute notice with sender, recipient, and subject', () => {
    const ws = createTestWorkspace();
    const notice = generateDisputeNotice(ws, 'case_notice_test', {
      cureWindowDays: 14,
      noticeDateMs: 1770000000000,
    });

    expect(notice.caseId).toBe('case_notice_test');
    expect(notice.sender.name).toBe('Alice Walker');
    expect(notice.recipient.name).toBe('Grand Oak Properties LLC');
    expect(notice.subject).toContain('FORMAL NOTICE OF DISPUTE');
    expect(notice.cureWindowDays).toBe(14);
    expect(notice.referenceNumber).toContain('EV-DISP-');
  });

  it('compiles evidence exhibits with Exhibit letters and SHA-256 digests', () => {
    const ws = createTestWorkspace();
    const notice = generateDisputeNotice(ws, 'case_notice_test');

    expect(notice.exhibits.length).toBe(1);
    expect(notice.exhibits[0]!.index).toBe('Exhibit A');
    expect(notice.exhibits[0]!.title).toBe('Residential Tenancy Agreement');
    expect(notice.exhibits[0]!.sha256).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  });

  it('formats claims and factual summary into plainText and executive HTML', () => {
    const ws = createTestWorkspace();
    const notice = generateDisputeNotice(ws, 'case_notice_test', {
      remedySought: 'Immediate electronic refund of $2,500 deposit in full.',
    });

    expect(notice.plainText).toContain('1. STATEMENT OF DISPUTE & FACTUAL BACKGROUND');
    expect(notice.plainText).toContain('Move out inspection completed');
    expect(notice.plainText).toContain('2. SUBSTANTIATED CLAIMS & BASIS');
    expect(notice.plainText).toContain('Landlord failed to return $2,500 security deposit');
    expect(notice.plainText).toContain('4. EVIDENCE EXHIBIT SCHEDULE (CRYPTOGRAPHICALLY VERIFIED)');
    expect(notice.plainText).toContain('Immediate electronic refund of $2,500 deposit in full.');

    // Executive HTML checks
    expect(notice.html).toContain('<!DOCTYPE html>');
    expect(notice.html).toContain('Notice of Dispute & Formal Demand');
    expect(notice.html).toContain('Exhibit A');
    expect(notice.html).toContain('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    expect(notice.html).toContain('Alice Walker');
  });

  it('handles fallbacks when participants and events are empty', () => {
    const ws = emptyWorkspace();
    const caseId = 'bare_case';
    ws.cases.push(
      testCase({
        id: caseId,
        title: 'Minimal Dispute',
        participants: [],
      }),
    );

    const notice = generateDisputeNotice(ws, caseId);
    expect(notice.sender.name).toBe('Claimant / Aggrieved Party');
    expect(notice.recipient.name).toBe('Respondent / Opposing Party');
    expect(notice.exhibits.length).toBe(0);
    expect(notice.plainText).toContain('Minimal Dispute');
    expect(notice.html).toContain('Minimal Dispute');
  });

  it('throws an informative error if the case is not found', () => {
    const ws = emptyWorkspace();
    expect(() => generateDisputeNotice(ws, 'non_existent_case')).toThrow(
      'Case non_existent_case was not found',
    );
  });
});
