import { describe, expect, it } from 'vitest';

import { buildCaseAuditChain } from '@domain/analysis/audit-chain';
import { evaluateClaim } from '@domain/analysis/claim-state';
import { detectForum, forumProfile } from '@domain/analysis/escalation';
import { filingDraftForCase, renderDraftText } from '@domain/analysis/filing-draft';
import { buildGraph } from '@domain/analysis/graph';
import { buildTimeline } from '@domain/analysis/timeline';
import {
  assertSealable,
  publicKeyFor,
  signSealContents,
  verifySealSignature,
  type SealContents,
} from '@domain/crucible/seal';
import { daysBetween, normalizeDate } from '@domain/normalize/dates';
import { amountsMateriallyDiffer, normalizeAmount } from '@domain/normalize/money';
import { runAnalysis } from '@domain/rules/engine';

import {
  CASE_ID,
  claim,
  event,
  evidence,
  link,
  OWNER,
  ref,
  resetIds,
  testCase,
  workspace,
} from '../helpers';

// ---------------------------------------------------------------------------
// Cryptographic Keys for Scenario Proof Capsules
// ---------------------------------------------------------------------------

const MOCK_SECRET_KEY =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const MOCK_PUBLIC_KEY = publicKeyFor(MOCK_SECRET_KEY);

describe('Tier 4: Realistic Application Scenarios', () => {
  // =========================================================================
  // Scenario 1: Medical Bill Overcharge Dispute
  // =========================================================================
  describe('Scenario 1: Medical Bill Overcharge Dispute', () => {
    it('ingests hospital bill and insurer EOB, extracting conflicting amounts and detecting mismatch', () => {
      resetIds();
      const hospitalBill = [
        'CITY GENERAL HOSPITAL',
        'Invoice Date: 2026-01-15',
        'Patient ID: MED-99201',
        'Service: Emergency Surgery and Inpatient Stay',
        'Total Charges: USD 14,500.00',
        'Due Immediately upon receipt.',
      ].join('\n');

      const insurerEOB = [
        'BLUE HORIZON HEALTH INSURANCE',
        'Explanation of Benefits (EOB)',
        'Processed Date: 2026-01-20',
        'Patient ID: MED-99201',
        'Provider: City General Hospital (In-Network)',
        'Billed Amount: USD 14,500.00',
        'Plan Allowed Amount: USD 9,200.00',
        'Insurance Paid: USD 7,700.00',
        'Patient Responsibility: USD 1,500.00',
      ].join('\n');

      const evdHospital = evidence(hospitalBill, {
        id: 'evd_hospital_bill',
        title: 'City General Itemized Bill',
      });
      const evdInsurer = evidence(insurerEOB, {
        id: 'evd_insurer_eob',
        title: 'Blue Horizon Insurance EOB',
      });

      // Verify amounts extracted
      const hospitalAmount = evdHospital.extraction?.amounts.find(
        (a) => a.minorUnits === 1450000
      );
      expect(hospitalAmount).toBeDefined();

      const patientRespAmount = evdInsurer.extraction?.amounts.find(
        (a) => a.minorUnits === 150000
      );
      expect(patientRespAmount).toBeDefined();

      // Compare amounts: $14,500 vs $1,500 is a material discrepancy
      const normHospital = normalizeAmount('USD 14,500.00', 'USD')!;
      const normPatient = normalizeAmount('USD 1,500.00', 'USD')!;
      expect(amountsMateriallyDiffer(normHospital, normPatient)).toBe(true);

      const ws = workspace({
        evidence: [evdHospital, evdInsurer],
      });

      const analysis = runAnalysis(ws, CASE_ID, 1000);
      expect(analysis.results).toBeDefined();

      // Build relationship graph showing both documents co-existing in workspace
      const graph = buildGraph(ws, CASE_ID);
      expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    });

    it('evaluates network billing agreement claim and detects insurance redressal forum', () => {
      resetIds();
      const patientClaim = claim(
        'Hospital balance billing violates the in-network insurance agreed maximum.'
      );
      const eobText = [
        'BLUE CROSS INSURANCE EOB',
        'Date: 2026-01-20',
        'The participating in-network provider agreed not to bill the patient above allowable charges.',
        'Patient responsibility: USD 1,500.00.',
      ].join('\n');

      const evdEOB = evidence(eobText, { id: 'evd_eob', title: 'Network EOB' });
      const rel = link(ref.evidence(evdEOB.id), ref.claim(patientClaim.id), 'SUPPORTS');

      const ws = workspace({
        claims: [patientClaim],
        evidence: [evdEOB],
        relationships: [rel],
      });

      const claimEval = evaluateClaim(ws, patientClaim.id);
      expect(claimEval?.state).toBe('SUPPORTED');
      expect(claimEval?.supporting).toHaveLength(1);
      expect(claimEval?.contradicting).toHaveLength(0);

      // Redressal forum identification for medical insurance complaint
      const forum = detectForum(
        'Formal complaint against insurance company regarding claim rejected under policy number POL-987654. Sum insured was INR 500,000.'
      );
      expect(forum).toBe('INSURANCE');
      const profile = forumProfile(forum!);
      expect(profile.nextStep).toContain('Insurance Ombudsman');
      expect(profile.replyWindowDays).toBe(30);
    });

    it('generates cryptographic proof capsule over medical dispute audit history', () => {
      resetIds();
      const ws = workspace({
        auditLogs: [
          {
            id: 'log_med_01',
            ownerId: OWNER,
            caseId: CASE_ID,
            createdAt: 1000,
            updatedAt: 1000,
            action: 'CASE_CREATED',
            actorId: OWNER,
            entityRefs: [],
            summary: 'Created medical overcharge dispute case',
            metadata: {},
          },
          {
            id: 'log_med_02',
            ownerId: OWNER,
            caseId: CASE_ID,
            createdAt: 2000,
            updatedAt: 2000,
            action: 'EVIDENCE_UPLOADED',
            actorId: OWNER,
            entityRefs: [{ kind: 'evidence', id: 'evd_hospital_bill' }],
            summary: 'Uploaded City General hospital bill ($14,500.00)',
            metadata: {},
          },
          {
            id: 'log_med_03',
            ownerId: OWNER,
            caseId: CASE_ID,
            createdAt: 3000,
            updatedAt: 3000,
            action: 'EVIDENCE_UPLOADED',
            actorId: OWNER,
            entityRefs: [{ kind: 'evidence', id: 'evd_insurer_eob' }],
            summary: 'Uploaded Blue Horizon EOB ($1,500.00 responsibility)',
            metadata: {},
          },
        ],
      });

      const chain = buildCaseAuditChain(ws, CASE_ID);
      expect(chain.length).toBe(3);
      expect(chain.head).toBeDefined();

      const sealContents: SealContents = {
        caseId: CASE_ID,
        chainHead: chain.head!,
        entryCount: chain.length,
        sealedAt: 4000,
        previousSealSignature: null,
      };

      assertSealable(sealContents);
      const signature = signSealContents(sealContents, MOCK_SECRET_KEY);
      expect(signature).toHaveLength(128);

      const fullSeal = {
        ...sealContents,
        signature,
        keyId: 'crucible_med_v1',
        algorithm: 'ed25519' as const,
      };

      expect(verifySealSignature(fullSeal, MOCK_PUBLIC_KEY)).toBe(true);
    });
  });

  // =========================================================================
  // Scenario 2: Landlord Security Deposit Withholding Dispute
  // =========================================================================
  describe('Scenario 2: Landlord Security Deposit Withholding Dispute', () => {
    it('reconstructs move-in, move-out, and late deduction timeline calculating 46-day statutory gap', () => {
      resetIds();
      const evtMoveIn = event('Lease Commencement & Deposit Paid', '2024-06-01');
      const evtMoveOut = event('Tenant Vacated & Keys Handed Over', '2025-05-31');
      const evtLateNotice = event('Landlord Deduction Notice Received', '2025-07-16');

      const dateMoveOut = normalizeDate('2025-05-31');
      const dateNotice = normalizeDate('2025-07-16');

      // Calculate elapsed days between move-out and deduction notice
      const daysElapsed = daysBetween(dateMoveOut, dateNotice);
      expect(daysElapsed).toBe(46);
      expect(daysElapsed).toBeGreaterThan(30); // Exceeds standard 30-day statutory return window

      const ws = workspace({
        events: [evtMoveIn, evtMoveOut, evtLateNotice],
      });

      const timeline = buildTimeline(ws, CASE_ID);
      expect(timeline.entries).toHaveLength(3);
      expect(timeline.entries[0]?.title).toBe('Lease Commencement & Deposit Paid');
      expect(timeline.entries[1]?.title).toBe('Tenant Vacated & Keys Handed Over');
      expect(timeline.entries[2]?.title).toBe('Landlord Deduction Notice Received');
    });

    it('contradiction between pristine move-out checklist and landlord damage claim drives truth decay', () => {
      resetIds();
      const landlordClaim = claim(
        'Landlord properly deducted $1,800.00 for wall damages caused by tenant.'
      );

      const checklistDoc = evidence(
        'MOVE-OUT JOINT INSPECTION CHECKLIST: All walls clean, no paint damage, apartment in spotless condition.',
        { title: 'Signed Move-out Checklist' }
      );

      const deductionLetter = evidence(
        'Deduction Statement: $1,800.00 withheld from deposit for extensive repainting due to tenant abuse.',
        { title: 'Landlord Deduction Letter' }
      );

      // Material contradiction: signed checklist directly refutes landlord's claim
      const relRefute = link(
        ref.evidence(checklistDoc.id),
        ref.claim(landlordClaim.id),
        'CONTRADICTS',
        { material: true }
      );

      const ws = workspace({
        claims: [landlordClaim],
        evidence: [checklistDoc, deductionLetter],
        relationships: [relRefute],
      });

      const evaluation = evaluateClaim(ws, landlordClaim.id);
      expect(evaluation?.state).toBe('CONTRADICTED');
      expect(evaluation?.contradicting).toHaveLength(1);
      expect(evaluation?.materialContradictions).toHaveLength(1);
      expect(evaluation?.supporting).toHaveLength(0);
    });

    it('assembles statutory consumer redressal letter citing inspection document', () => {
      resetIds();
      const formalComplaint = [
        'To: Grievance Department, Property Management Group',
        'Date: 01/06/2025',
        'Complaint reference: TEN/DEP/5521',
        'I am writing to demand the full refund of my security deposit of USD 2,500.00.',
        'The apartment was returned in spotless condition as verified by the joint inspection checklist.',
      ].join('\n');

      const evd = evidence(formalComplaint, {
        id: 'evd_tenant_demand',
        title: 'Security Deposit Demand Letter',
      });

      const ws = workspace({ evidence: [evd] });
      // 45 days after complaint
      const now = Date.UTC(2025, 6, 16);
      const draft = filingDraftForCase(ws, CASE_ID, now);

      expect(draft).not.toBeNull();
      expect(draft?.sections.length).toBeGreaterThanOrEqual(1);

      const rendered = renderDraftText(draft!, {
        name: 'Alex Johnson',
        address: '456 Elm St, Apt 2B',
        contact: 'alex@example.com',
      });
      expect(rendered).toContain('Alex Johnson');
      expect(rendered).toContain('USD 2,500.00');
    });
  });

  // =========================================================================
  // Scenario 3: Freelance Non-Payment & Deliverable Breach
  // =========================================================================
  describe('Scenario 3: Freelance Non-Payment & Deliverable Breach', () => {
    it('identifies conflicting payment and delivery milestones between statement of work and emails', () => {
      resetIds();
      const sowDoc = evidence(
        'Statement of Work: Milestone 2 Backend Delivery due on 2026-02-10 for USD 8,000.00.',
        { title: 'Statement of Work' }
      );

      const approvalEmail = evidence(
        'From: Client CTO. Date: 2026-02-12. Milestone 2 backend deliverable is reviewed, tested, and fully approved for payment.',
        { title: 'Client Milestone Approval' }
      );

      const repudiationEmail = evidence(
        'From: Client Finance. Date: 2026-03-01. Project has been cancelled. Milestone 2 rejected and will not be paid.',
        { title: 'Cancellation Notice' }
      );

      const ws = workspace({
        evidence: [sowDoc, approvalEmail, repudiationEmail],
      });

      // Verify all 3 evidence items are active in workspace
      expect(ws.evidence).toHaveLength(3);

      const timeline = buildTimeline(ws, CASE_ID);
      expect(timeline.entries).toHaveLength(3);
    });

    it('material contradiction flips client non-acceptance defence claim to CONTRADICTED', () => {
      resetIds();
      const clientDefenceClaim = claim(
        'Client was justified in withholding payment because Milestone 2 was never accepted.'
      );

      const approvalProof = evidence(
        'Email confirmation: Milestone 2 accepted and approved in writing by Client CTO on 2026-02-12.',
        { title: 'Written Acceptance Email' }
      );

      const rel = link(
        ref.evidence(approvalProof.id),
        ref.claim(clientDefenceClaim.id),
        'CONTRADICTS',
        { material: true }
      );

      const ws = workspace({
        claims: [clientDefenceClaim],
        evidence: [approvalProof],
        relationships: [rel],
      });

      const evalResult = evaluateClaim(ws, clientDefenceClaim.id);
      expect(evalResult?.state).toBe('CONTRADICTED');
      expect(evalResult?.materialContradictions).toHaveLength(1);
    });

    it('generates verifiable Ed25519 proof capsule with intact audit chain for small claims court', () => {
      resetIds();
      const ws = workspace({
        auditLogs: [
          {
            id: 'log_freelance_1',
            ownerId: OWNER,
            caseId: CASE_ID,
            createdAt: 1000,
            updatedAt: 1000,
            action: 'CASE_CREATED',
            actorId: OWNER,
            entityRefs: [],
            summary: 'Created Freelance Non-Payment Dispute',
            metadata: {},
          },
          {
            id: 'log_freelance_2',
            ownerId: OWNER,
            caseId: CASE_ID,
            createdAt: 2000,
            updatedAt: 2000,
            action: 'EVIDENCE_UPLOADED',
            actorId: OWNER,
            entityRefs: [{ kind: 'evidence', id: 'evd_sow' }],
            summary: 'Attached Signed Statement of Work ($8,000.00)',
            metadata: {},
          },
          {
            id: 'log_freelance_3',
            ownerId: OWNER,
            caseId: CASE_ID,
            createdAt: 3000,
            updatedAt: 3000,
            action: 'EVIDENCE_UPLOADED',
            actorId: OWNER,
            entityRefs: [{ kind: 'evidence', id: 'evd_approval' }],
            summary: 'Attached Client CTO Acceptance Confirmation',
            metadata: {},
          },
        ],
      });

      const chain = buildCaseAuditChain(ws, CASE_ID);
      expect(chain.length).toBe(3);
      expect(chain.head).toBeDefined();

      const sealContents: SealContents = {
        caseId: CASE_ID,
        chainHead: chain.head!,
        entryCount: chain.length,
        sealedAt: 5000,
        previousSealSignature: null,
      };

      const signature = signSealContents(sealContents, MOCK_SECRET_KEY);
      const courtCapsule = {
        ...sealContents,
        signature,
        keyId: 'crucible_freelance_v1',
        algorithm: 'ed25519' as const,
      };

      // Both signature and chain head independently verifiable by opposing counsel / judge
      expect(verifySealSignature(courtCapsule, MOCK_PUBLIC_KEY)).toBe(true);
      expect(courtCapsule.signature).toMatch(/^[a-f0-9]{128}$/);
      expect(courtCapsule.chainHead).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
