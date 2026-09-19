import { describe, expect, it } from 'vitest';
import { calculateRecoveryLedger } from '../src/domain/analysis/recovery-ledger';
import { deriveDeadlineSentinel } from '../src/domain/analysis/deadline-sentinel';
import { buildStakeholderDossier } from '../src/domain/analysis/stakeholder-dossier';
import { evaluateSettlementMatrix } from '../src/domain/analysis/settlement-matrix';
import { emptyWorkspace } from '../src/domain/models';
import type { Workspace } from '../src/domain/models';
import { claim, event, evidence, testCase } from './helpers';

describe('Beyond-Evidence Core Capabilities Suite', () => {
  function makeMockWorkspace(): Workspace {
    const ws = emptyWorkspace();
    const caseId = 'case_test_1';

    const testCaseRecord = testCase({
      id: caseId,
      ownerId: 'user_1',
      title: 'Disputed Security Deposit and Repair Withholding',
      description: 'Landlord wrongfully withheld security deposit of $2800.',
      status: 'OPEN',
      category: 'HOUSING_DISPUTE',
      priority: 'HIGH',
      tags: ['rent', 'deposit'],
      participants: [
        { id: 'part_1', name: 'Marcus Claimant', role: 'Tenant / Claimant' },
        { id: 'part_2', name: 'Apex Property Management LLC', role: 'Landlord / Respondent' },
      ],
      createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      updatedAt: Date.now(),
      deletedAt: null,
    });
    ws.cases.push(testCaseRecord);

    const ev1 = evidence('Standard 12-month lease with $2,800 deposit clause and $150 cleaning fee.', {
      id: 'ev_1',
      caseId,
      ownerId: 'user_1',
      title: 'Original Lease Agreement PDF',
    });
    ev1.extraction = {
      ...ev1.extraction!,
      amounts: [
        { original: '$2,800.00', minorUnits: 280000, currency: 'USD', role: 'Deposit', evidenceId: 'ev_1', method: 'DETERMINISTIC' },
        { original: '$150.00', minorUnits: 15000, currency: 'USD', role: 'Cleaning Fee', evidenceId: 'ev_1', method: 'DETERMINISTIC' },
      ],
      people: [{ original: 'Marcus Claimant', normalized: 'Marcus Claimant', evidenceId: 'ev_1', method: 'DETERMINISTIC' }],
      organizations: [{ original: 'Apex Property Management LLC', normalized: 'Apex Property Management LLC', evidenceId: 'ev_1', method: 'DETERMINISTIC' }],
      emails: [{ original: 'disputes@apexprops.com', normalized: 'disputes@apexprops.com', evidenceId: 'ev_1', method: 'DETERMINISTIC' }],
      phones: [{ original: '555-0199', normalized: '555-0199', evidenceId: 'ev_1', method: 'DETERMINISTIC' }],
    };
    ws.evidence.push(ev1);

    const claim1 = claim('Landlord must refund full $2,800 security deposit due to lack of itemization within 21 days.', {
      id: 'clm_1',
      caseId,
      ownerId: 'user_1',
      state: 'SUPPORTED',
    });
    ws.claims.push(claim1);

    const event1 = event('Key Handover & Move Out Inspection', '2025-01-15', {
      id: 'event_1',
      caseId,
      ownerId: 'user_1',
      claimIds: [claim1.id],
    });
    ws.events.push(event1);

    return ws;
  }

  it('calculates Financial Recovery Ledger damages, interest, and statutory multipliers accurately', () => {
    const ws = makeMockWorkspace();
    const ledger = calculateRecoveryLedger(ws, 'case_test_1', 0.10);

    expect(ledger.caseId).toBe('case_test_1');
    expect(ledger.currency).toBe('USD');
    expect(ledger.totalPrincipalMinor).toBe(280000); // $2,800.00
    expect(ledger.totalConsequentialMinor).toBe(15000); // $150.00 cleaning fee
    expect(ledger.totalPenaltiesMinor).toBe(280000); // 1x statutory bad-faith multiplier for deposit
    expect(ledger.totalInterestMinor).toBeGreaterThan(0);
    expect(ledger.totalClaimableMinor).toBeGreaterThan(575000);
    expect(ledger.itemizedScheduleText).toContain('ITEMIZED STATEMENT OF DAMAGES');
    expect(ledger.itemizedScheduleText).toContain('Marcus Claimant');
  });

  it('derives Statutory & Regulatory Deadline Sentinel clocks and urgency tiers', () => {
    const ws = makeMockWorkspace();
    const sentinel = deriveDeadlineSentinel(ws, 'case_test_1');

    expect(sentinel.caseId).toBe('case_test_1');
    expect(sentinel.activeClocks.length).toBeGreaterThanOrEqual(3);

    const depositClock = sentinel.activeClocks.find((c) => c.clockType === 'TENANT_DEPOSIT_RETURN');
    expect(depositClock).toBeDefined();
    expect(depositClock?.statutoryReference).toContain('1950.5');
    expect(depositClock?.triggerDateIso).toBe('2025-01-15');

    const solClock = sentinel.activeClocks.find((c) => c.clockType === 'STATUTE_OF_LIMITATIONS');
    expect(solClock).toBeDefined();
    expect(solClock?.daysRemaining).toBeGreaterThan(100);
  });

  it('builds Stakeholder Directory & Communication Dossier with party credibility', () => {
    const ws = makeMockWorkspace();
    const dossier = buildStakeholderDossier(ws, 'case_test_1');

    expect(dossier.caseId).toBe('case_test_1');
    expect(dossier.stakeholders.length).toBeGreaterThanOrEqual(2);

    const apex = dossier.stakeholders.find((s) => s.name.includes('Apex Property Management'));
    expect(apex).toBeDefined();
    expect(apex?.entityType).toBe('ORGANIZATION');
    expect(apex?.email).toBe('disputes@apexprops.com');
    expect(apex?.phone).toBe('555-0199');
  });

  it('evaluates Settlement Negotiation Matrix with Floor, Target, and Ceiling brackets', () => {
    const ws = makeMockWorkspace();
    const matrix = evaluateSettlementMatrix(ws, 'case_test_1');

    expect(matrix.caseId).toBe('case_test_1');
    expect(matrix.currency).toBe('USD');
    expect(matrix.winProbabilityPercent).toBeGreaterThanOrEqual(60);
    expect(matrix.walkAwayFloorMinor).toBeLessThan(matrix.targetSettlementMinor);
    expect(matrix.targetSettlementMinor).toBeLessThanOrEqual(matrix.trialCeilingMinor);
    expect(matrix.tacticalRecommendation).toBeTruthy();
    expect(matrix.negotiationScript).toContain('Dear [Counterparty]');
  });

  it('handles empty workspace gracefully without throwing errors', () => {
    const ws = emptyWorkspace();
    const ledger = calculateRecoveryLedger(ws, 'empty_case');
    expect(ledger.totalClaimableMinor).toBe(0);

    const sentinel = deriveDeadlineSentinel(ws, 'empty_case');
    expect(sentinel.activeClocks.length).toBeGreaterThanOrEqual(1);

    const dossier = buildStakeholderDossier(ws, 'empty_case');
    expect(dossier.stakeholders.length).toBe(0);

    const matrix = evaluateSettlementMatrix(ws, 'empty_case');
    expect(matrix.winProbabilityPercent).toBeGreaterThan(0);
  });
});
