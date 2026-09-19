import { describe, expect, it } from 'vitest';
import { simulateOpposingNarrative } from '@domain/analysis/opposing-narrative';
import { buildEventNexus } from '@domain/analysis/event-nexus';
import { propagateContradictionCascade } from '@domain/analysis/truth-decay';
import { generateProofCapsule } from '@domain/analysis/proof-capsule';
import { generateStrategicPlaybook } from '@domain/analysis/strategic-playbook';
import { emptyWorkspace } from '@domain/models';
import { CASE_ID, claim, event, evidence, link, OWNER, ref, resetIds, testCase } from './helpers';

describe('Groundbreaking Capabilities (Milestone 5)', () => {
  // -------------------------------------------------------------------------
  // 1. Opposing Narrative Simulator & Blind-Spot Hunter
  // -------------------------------------------------------------------------
  describe('simulateOpposingNarrative', () => {
    it('detects unsupported claims and flags them with counterparty defense arguments', () => {
      resetIds();
      const clm = claim('The seller promised an unconditional 100% refund');
      const ws = {
        ...emptyWorkspace(),
        cases: [testCase()],
        claims: [clm],
      };

      const report = simulateOpposingNarrative(ws, CASE_ID);
      expect(report.blindSpots.length).toBeGreaterThanOrEqual(1);
      const unsupported = report.blindSpots.find((b) => b.category === 'UNSUPPORTED_CLAIM');
      expect(unsupported).toBeDefined();
      expect(unsupported?.counterpartyArgument).toContain('unsubstantiated subjective assertion');
      expect(report.overallVulnerability).not.toBe('LOW');
    });

    it('identifies unaddressed timeline gaps (>35 days) as defense vulnerabilities', () => {
      resetIds();
      const ev1 = event('Contract Initiated', '2026-01-01');
      const ev2 = event('Legal Notice Sent', '2026-04-01');
      const ws = {
        ...emptyWorkspace(),
        cases: [testCase()],
        events: [ev1, ev2],
      };

      const report = simulateOpposingNarrative(ws, CASE_ID);
      const gap = report.unaddressedTimeGaps.find((g) => g.days > 35);
      expect(gap).toBeDefined();
      expect(gap?.days).toBe(90);
      const gapSpot = report.blindSpots.find((b) => b.category === 'TIMELINE_GAP');
      expect(gapSpot).toBeDefined();
      expect(gapSpot?.counterpartyArgument).toContain('tacit acceptance');
    });
  });

  // -------------------------------------------------------------------------
  // 2. The Event Nexus: Multi-Modal Chronological Replay
  // -------------------------------------------------------------------------
  describe('buildEventNexus', () => {
    it('synchronizes case events and evidence dates into a continuous temporal axis', () => {
      resetIds();
      const ev1 = event('Order Placed', '2026-02-10');
      const evd = evidence('Payment receipt processed on 2026-02-11');

      const ws = {
        ...emptyWorkspace(),
        cases: [testCase()],
        events: [ev1],
        evidence: [evd],
      };

      const nexus = buildEventNexus(ws, CASE_ID);
      expect(nexus.totalArtifacts).toBe(2);
      expect(nexus.clusters.length).toBe(2);
      expect(nexus.earliestDate).toBe('2026-02-10');
      expect(nexus.latestDate).toBe('2026-02-11');
      expect(nexus.spanDays).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Truth Decay & Credibility Cascade
  // -------------------------------------------------------------------------
  describe('propagateContradictionCascade', () => {
    it('traces contradiction ripple to compromise dependent claims and score participants', () => {
      resetIds();
      const clm = claim('Security deposit of INR 30,000 was deducted without notice');
      const evd1 = evidence('Bank statement showing INR 30,000 deduction');
      const evd2 = evidence('Email from landlord saying deduction was INR 15,000 only');
      if (evd2.extraction) {
        evd2.extraction.parties = [
          {
            evidenceId: evd2.id,
            original: 'John Landlord',
            normalized: 'John Landlord',
            method: 'DETERMINISTIC',
          },
        ];
      }

      const lkSupport = link(ref.evidence(evd1.id), ref.claim(clm.id), 'SUPPORTS');
      const lkConflict = link(ref.evidence(evd1.id), ref.evidence(evd2.id), 'CONTRADICTS', { material: true });

      const ws = {
        ...emptyWorkspace(),
        cases: [testCase()],
        claims: [clm],
        evidence: [evd1, evd2],
        relationships: [lkSupport, lkConflict],
      };

      const cascade = propagateContradictionCascade(ws, CASE_ID);
      expect(cascade.contradictionCount).toBe(2);
      expect(cascade.compromisedClaims.length).toBe(1);
      expect(cascade.compromisedClaims[0]?.claimId).toBe(clm.id);
      expect(cascade.participantCredibilities.length).toBeGreaterThanOrEqual(1);
      const landlord = cascade.participantCredibilities.find((p) => p.name === 'John Landlord');
      expect(landlord).toBeDefined();
      expect(landlord?.reliabilityScore).toBeLessThan(100);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cryptographic Proof Capsule
  // -------------------------------------------------------------------------
  describe('generateProofCapsule', () => {
    it('assembles a verifiable cryptographic manifest package', () => {
      resetIds();
      const evd = evidence('Primary Agreement PDF', { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
      const clm = claim('Contract executed successfully');
      const ws = {
        ...emptyWorkspace(),
        cases: [testCase()],
        evidence: [evd],
        claims: [clm],
      };

      const capsule = generateProofCapsule(ws, CASE_ID);
      expect(capsule.capsuleId).toContain(CASE_ID);
      expect(capsule.version).toBe('1.0.0');
      expect(capsule.evidenceManifest.length).toBe(1);
      expect(capsule.evidenceManifest[0]?.sha256).toBe(evd.sha256);
      expect(capsule.claimsMatrix.length).toBe(1);
      expect(capsule.verificationInstructions).toContain('Recompute SHA-256');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Strategic Next-Move Playbook
  // -------------------------------------------------------------------------
  describe('generateStrategicPlaybook', () => {
    it('detects sector and builds a 3-step escalation ladder with notice template', () => {
      resetIds();
      const clm = claim('Formal complaint regarding failed bank transfer from savings account.');
      const ws = {
        ...emptyWorkspace(),
        cases: [testCase({ title: 'Unauthorized Bank Debit Dispute' })],
        claims: [clm],
        evidence: [evidence('Bank account statement')],
      };

      const playbook = generateStrategicPlaybook(ws, CASE_ID);
      expect(playbook.sector).toBe('BANKING');
      expect(playbook.escalationLadder.length).toBe(3);
      expect(playbook.escalationLadder[0]?.stepNumber).toBe(1);
      expect(playbook.escalationLadder[1]?.stageName).toContain('Banking Ombudsman');
      expect(playbook.formalNoticeSnippet).toContain('FORMAL NOTICE OF DISPUTE');
      expect(playbook.recommendedNextMove).toBeDefined();
    });
  });
});
