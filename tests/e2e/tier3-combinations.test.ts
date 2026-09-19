import { describe, expect, it } from 'vitest';

import { buildCaseAuditChain } from '@domain/analysis/audit-chain';
import { evaluateClaim } from '@domain/analysis/claim-state';
import { detectForum, forumProfile } from '@domain/analysis/escalation';
import { filingDraftForCase, renderDraftText } from '@domain/analysis/filing-draft';
import { buildTimeline } from '@domain/analysis/timeline';
import {
  assertSealable,
  publicKeyFor,
  signSealContents,
  verifySealSignature,
  type SealContents,
} from '@domain/crucible/seal';
import { extractFromText } from '@domain/extraction/deterministic';
import { hashText } from '@domain/hashing';
import { type Evidence, type Workspace } from '@domain/models';
import { dateSortKey, normalizeDate } from '@domain/normalize/dates';
import { amountsMateriallyDiffer, normalizeAmount } from '@domain/normalize/money';
import { runAnalysis } from '@domain/rules/engine';
import { ruleById } from '@domain/rules/registry';
import { scrubKey } from '@services/ai/groq-client';
import { getCloudinaryConfig, MAX_UPLOAD_BYTES } from '@services/storage/cloudinary';
import {
  evidenceStoragePath,
  validatePrivateEvidencePath,
} from '@services/storage/evidence-storage';

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
// Helpers and Test Keys
// ---------------------------------------------------------------------------

const MOCK_SECRET_KEY =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const MOCK_PUBLIC_KEY = publicKeyFor(MOCK_SECRET_KEY);

describe('Tier 3: Pairwise Cross-Feature Combinations', () => {
  // =========================================================================
  // Interaction 1: F04 (Multimodal Ingestion) + F05 (Immediate Deduplication)
  // =========================================================================
  describe('F04 Ingestion + F05 Deduplication', () => {
    it('detects duplicate evidence from identical text payloads ingested under distinct filenames', () => {
      resetIds();
      const sharedContent = 'PAYMENT RECEIPT: $4,500.00 transferred to Acme Corp on 2026-01-10.';

      const evd1 = evidence(sharedContent, {
        fileName: 'bank_statement_january.pdf',
        title: 'January Bank Statement',
      });
      const evd2 = evidence(sharedContent, {
        fileName: 'wire_receipt_copy.pdf',
        title: 'Wire Receipt Copy',
      });

      expect(evd1.sha256).toBe(evd2.sha256);
      expect(evd1.id).not.toBe(evd2.id);

      const ws = workspace({ evidence: [evd1, evd2] });
      const runResult = runAnalysis(ws, CASE_ID, 1000, [ruleById('duplicate-evidence@1')!]);

      const dupFinding = runResult.results.find(
        (r) => r.resultType === 'DUPLICATE_EVIDENCE'
      );
      expect(dupFinding).toBeDefined();
      expect(dupFinding?.supportingEvidenceIds).toContain(evd1.id);
      expect(dupFinding?.supportingEvidenceIds).toContain(evd2.id);
      expect(Object.values(dupFinding?.inputs ?? {})).toContain(evd1.sha256!);
    });

    it('distinguishes near-identical documents differing by a single character and preserves both', () => {
      resetIds();
      const contentA = 'INVOICE INV-2026-001: Amount USD 1,000.00 due on 2026-02-01.';
      const contentB = 'INVOICE INV-2026-002: Amount USD 1,000.00 due on 2026-02-01.';

      const evdA = evidence(contentA, { fileName: 'inv_1.pdf' });
      const evdB = evidence(contentB, { fileName: 'inv_2.pdf' });

      expect(evdA.sha256).not.toBe(evdB.sha256);

      const ws = workspace({ evidence: [evdA, evdB] });
      const runResult = runAnalysis(ws, CASE_ID, 1000, [ruleById('duplicate-evidence@1')!]);

      const dupFinding = runResult.results.find(
        (r) => r.resultType === 'DUPLICATE_EVIDENCE'
      );
      expect(dupFinding).toBeUndefined();
    });
  });

  // =========================================================================
  // Interaction 2: F12 (Opposing Narrative Rules) + F14 (Truth Decay & Cascade)
  // =========================================================================
  describe('F12 Opposing Narrative + F14 Truth Decay Cascade', () => {
    it('transitions claim from SUPPORTED to MIXED_REVIEW when a contradicting bank statement is linked', () => {
      resetIds();
      const clm = claim('The contractor was fully paid $5,000.00 for the project.');
      const evdPaid = evidence('Proof of wire transfer: $5,000.00 completed to Contractor.', {
        title: 'Wire Confirmation',
      });
      const evdReversed = evidence('Notice of transfer reversal: $5,000.00 reversed due to invalid account.', {
        title: 'Reversal Notice',
      });

      // Initially supported by wire confirmation
      const rel1 = link(ref.evidence(evdPaid.id), ref.claim(clm.id), 'SUPPORTS');
      let ws = workspace({
        claims: [clm],
        evidence: [evdPaid, evdReversed],
        relationships: [rel1],
      });

      let evaluation = evaluateClaim(ws, clm.id);
      expect(evaluation?.state).toBe('SUPPORTED');
      expect(evaluation?.supporting).toHaveLength(1);
      expect(evaluation?.contradicting).toHaveLength(0);

      // Add contradicting evidence marked as material
      const rel2 = link(
        ref.evidence(evdReversed.id),
        ref.claim(clm.id),
        'CONTRADICTS',
        { material: true }
      );
      ws = workspace({
        claims: [clm],
        evidence: [evdPaid, evdReversed],
        relationships: [rel1, rel2],
      });

      evaluation = evaluateClaim(ws, clm.id);
      expect(evaluation?.state).toBe('MIXED_REVIEW');
      expect(evaluation?.supporting).toHaveLength(1);
      expect(evaluation?.contradicting).toHaveLength(1);
      expect(evaluation?.materialContradictions).toHaveLength(1);
    });

    it('discounts identical duplicate evidence sources from incrementing independentSupport count', () => {
      resetIds();
      const clm = claim('Tenant paid security deposit of $2,000.00.');
      const duplicateContent = 'Receipt of security deposit: $2,000.00 received in full.';

      const evdOriginal = evidence(duplicateContent, { title: 'Original Receipt' });
      const evdCopy = evidence(duplicateContent, { title: 'Duplicate Scan' });

      expect(evdOriginal.sha256).toBe(evdCopy.sha256);

      const rel1 = link(ref.evidence(evdOriginal.id), ref.claim(clm.id), 'SUPPORTS');
      const rel2 = link(ref.evidence(evdCopy.id), ref.claim(clm.id), 'SUPPORTS');

      const ws = workspace({
        claims: [clm],
        evidence: [evdOriginal, evdCopy],
        relationships: [rel1, rel2],
      });

      const evaluation = evaluateClaim(ws, clm.id);
      expect(evaluation?.state).toBe('SUPPORTED');
      expect(evaluation?.supporting).toHaveLength(2);
      // Independent support must count only unique sources (1 independent source, not 2)
      expect(evaluation?.independentSupport).toHaveLength(1);
    });
  });

  // =========================================================================
  // Interaction 3: F06 (OCR / Date Normalization) + F13 (Event Nexus Chronology)
  // =========================================================================
  describe('F06 Normalization + F13 Event Nexus Timeline', () => {
    it('normalizes heterogeneous date strings and orders timeline entries chronologically', () => {
      resetIds();
      // Three events with different date formats: ISO, written UK, written US
      const evt1 = event('Contract Signed', '10 Jan 2026');
      const evt2 = event('Work Delivered', '2026-02-15');
      const evt3 = event('Invoice Sent', 'March 1, 2026');

      const ws = workspace({ events: [evt3, evt1, evt2] }); // Intentionally unsorted
      const timeline = buildTimeline(ws, CASE_ID);

      expect(timeline.entries).toHaveLength(3);
      // Sorted chronologically: Jan 10 -> Feb 15 -> Mar 1
      expect(timeline.entries[0]?.title).toBe('Contract Signed');
      expect(timeline.entries[0]?.date?.iso).toBe('2026-01-10');

      expect(timeline.entries[1]?.title).toBe('Work Delivered');
      expect(timeline.entries[1]?.date?.iso).toBe('2026-02-15');

      expect(timeline.entries[2]?.title).toBe('Invoice Sent');
      expect(timeline.entries[2]?.date?.iso).toBe('2026-03-01');
    });

    it('positions coarse month-only dates without falsely inventing day 1', () => {
      resetIds();
      const evtExact = event('Payment Made', '2026-04-15');
      const evtCoarse = event('General Agreement', 'April 2026');

      const ws = workspace({ events: [evtExact, evtCoarse] });
      const timeline = buildTimeline(ws, CASE_ID);

      expect(timeline.entries).toHaveLength(2);
      const coarseEntry = timeline.entries.find((e) => e.title === 'General Agreement');
      expect(coarseEntry?.precision).toBe('MONTH');
      expect(coarseEntry?.date?.iso).toBe('2026-04');
      expect(coarseEntry?.displayDate).toContain('April 2026');
      expect(coarseEntry?.displayDate).not.toBe('1 April 2026');
    });
  });

  // =========================================================================
  // Interaction 4: F08 (Session Proxy) + F03 (Offline Deterministic Fallback)
  // =========================================================================
  describe('F08 Session Proxy + F03 Offline Fallback', () => {
    it('executes full rule engine with deterministic precision when offline with zero network calls', () => {
      resetIds();
      const clm = claim('The landlord received the statutory deposit notice.');
      const ws = workspace({ claims: [clm] });

      // Run analysis purely in memory with offline clock
      const runResult = runAnalysis(ws, CASE_ID, 1000);
      expect(runResult.results).toBeDefined();

      const unsupportedFinding = runResult.results.find(
        (r) => r.resultType === 'UNSUPPORTED_CLAIM'
      );
      expect(unsupportedFinding).toBeDefined();
      expect(unsupportedFinding?.relatedClaimIds).toContain(clm.id);
    });

    it('masks sensitive API tokens and keys across error reporting in proxy client', () => {
      const privateApiKey = 'gsk_live_9876543210fedcba9876543210';
      const diagnosticError = `Authentication failed for key: ${privateApiKey} at endpoint`;

      const scrubbed = scrubKey(diagnosticError);
      expect(scrubbed).not.toContain(privateApiKey);
      expect(scrubbed).toContain('[redacted]');
    });
  });

  // =========================================================================
  // Interaction 5: F15 (Proof Capsule) + F12 (Narrative & Tamper Detection)
  // =========================================================================
  describe('F15 Proof Capsule + F12 Blind Spot & Tamper Detection', () => {
    it('detects tampering in audit trail history and refuses to attest corrupted records', () => {
      resetIds();
      const ws = workspace({
        auditLogs: [
          {
            id: 'log_001',
            ownerId: OWNER,
            caseId: CASE_ID,
            createdAt: 1000,
            updatedAt: 1000,
            action: 'CASE_CREATED',
            actorId: OWNER,
            entityRefs: [],
            summary: 'Case created by user',
            metadata: {},
          },
          {
            id: 'log_002',
            ownerId: OWNER,
            caseId: CASE_ID,
            createdAt: 2000,
            updatedAt: 2000,
            action: 'EVIDENCE_UPLOADED',
            actorId: OWNER,
            entityRefs: [{ kind: 'evidence', id: 'evd_001' }],
            summary: 'Initial bank statement attached',
            metadata: {},
          },
        ],
      });

      const intactChain = buildCaseAuditChain(ws, CASE_ID);
      expect(intactChain.length).toBe(2);
      const head = intactChain.head;
      expect(head).toBeDefined();

      // Sign the intact audit chain head
      const sealContents: SealContents = {
        caseId: CASE_ID,
        chainHead: head!,
        entryCount: 2,
        sealedAt: 3000,
        previousSealSignature: null,
      };
      assertSealable(sealContents);
      const signature = signSealContents(sealContents, MOCK_SECRET_KEY);
      expect(signature).toHaveLength(128);

      // Verify that tampering with log entry #1 summary changes chain head
      const tamperedLogs = [
        { ...ws.auditLogs[0]!, summary: 'Tampered summary string' },
        ws.auditLogs[1]!,
      ];
      const tamperedChain = buildCaseAuditChain(
        { ...ws, auditLogs: tamperedLogs },
        CASE_ID
      );
      const tamperedHead = tamperedChain.head;
      expect(tamperedHead).not.toBe(head);

      // Signature over original head fails when verified against tampered head
      const tamperedSeal = {
        ...sealContents,
        chainHead: tamperedHead!,
        signature,
        keyId: 'test_key',
        algorithm: 'ed25519' as const,
      };
      expect(verifySealSignature(tamperedSeal, MOCK_PUBLIC_KEY)).toBe(false);
    });

    it('attests sealed proof capsule containing active case blind spots honestly', () => {
      resetIds();
      // Case with an unresolved blind spot: unsupported claim
      const orphanClaim = claim('Promised refund of $1,200 never delivered.');
      const ws = workspace({
        claims: [orphanClaim],
        auditLogs: [
          {
            id: 'log_blindspot',
            ownerId: OWNER,
            caseId: CASE_ID,
            createdAt: 1500,
            updatedAt: 1500,
            action: 'CLAIM_CREATED',
            actorId: OWNER,
            entityRefs: [{ kind: 'claim', id: orphanClaim.id }],
            summary: 'Created claim for refund',
            metadata: {},
          },
        ],
      });

      const chain = buildCaseAuditChain(ws, CASE_ID);
      expect(chain.length).toBe(1);

      const sealContents: SealContents = {
        caseId: CASE_ID,
        chainHead: chain.head!,
        entryCount: 1,
        sealedAt: 2500,
        previousSealSignature: null,
      };

      const signature = signSealContents(sealContents, MOCK_SECRET_KEY);
      const fullSeal = {
        ...sealContents,
        signature,
        keyId: 'crucible_v1',
        algorithm: 'ed25519' as const,
      };

      expect(verifySealSignature(fullSeal, MOCK_PUBLIC_KEY)).toBe(true);
    });
  });

  // =========================================================================
  // Interaction 6: F16 (Strategic Playbook) + F12 (Timeline Gap & Silence)
  // =========================================================================
  describe('F16 Strategic Playbook + F12 Timeline Gap Detection', () => {
    it('identifies overdue complaint silence (>30 days) and generates structured escalation draft', () => {
      resetIds();
      const bankComplaint = [
        'To: Grievance Officer, State Bank',
        'Date: 01/01/2024',
        'Complaint reference: SBI/GRV/88421',
        'I am writing to complain about an unauthorized UPI transfer from my savings account.',
        'The amount of INR 4,200.00 was debited without authorization.',
      ].join('\n');
      const complaintDoc = evidence(bankComplaint, { id: 'evd_complaint', title: 'Customer Complaint Letter' });

      const ws = workspace({
        evidence: [complaintDoc],
      });

      // June 1, 2024 is 152 days after Jan 1
      const now = Date.UTC(2024, 5, 1);
      const draft = filingDraftForCase(ws, CASE_ID, now);

      expect(draft).not.toBeNull();
      expect(draft?.sections.length).toBeGreaterThanOrEqual(1);

      // The draft lines directly reference the source complaint evidence
      const allLines = draft!.sections.flatMap((s) => s.lines);
      const factualLine = allLines.find((l) => l.evidenceId === complaintDoc.id);
      expect(factualLine).toBeDefined();

      const rendered = renderDraftText(draft!, {
        name: 'Jane Doe',
        address: '123 Main St',
        contact: 'jane@example.com',
      });
      expect(rendered).toContain('Jane Doe');
    });

    it('recommends redressal forum profile with correct statutory cooling-off period', () => {
      const detectedForum = detectForum('unauthorized UPI transaction from savings account');
      expect(detectedForum).toBe('BANKING');

      const profile = forumProfile(detectedForum!);
      expect(profile.replyWindowDays).toBe(30);
      expect(profile.nextStep).toContain('Ombudsman');
      expect(profile.scheme).toBeDefined();
    });
  });

  // =========================================================================
  // Interaction 7: F07 (Secure Clean Settings) + F02 (Cloud Storage Mirroring)
  // =========================================================================
  describe('F07 Secure Clean Settings + F02 Cloud Storage Mirroring', () => {
    it('enforces normalized private storage paths hiding sensitive user filenames', () => {
      const storagePath = evidenceStoragePath(
        OWNER,
        CASE_ID,
        'evd_sensitive001',
        'Confidential Tax Return 2025.pdf'
      );

      // Verifies original sensitive filename is obscured to 'original.pdf'
      expect(storagePath).toBe(
        `users/${OWNER}/cases/${CASE_ID}/evd_sensitive001/original.pdf`
      );
      expect(storagePath).not.toContain('Confidential');
      expect(storagePath).not.toContain('Tax Return');

      // Validates account ownership check passes on valid path
      expect(validatePrivateEvidencePath(storagePath, OWNER)).toBe(storagePath);

      // Cloudinary configuration exposes only safe public metadata
      const config = getCloudinaryConfig();
      expect(config).toHaveProperty('isConfigured');
      expect(config).toHaveProperty('cloudName');
    });
  });

  // =========================================================================
  // Interaction 8: F11 (Rich Media Previews) + F15 (Integrity Verification)
  // =========================================================================
  describe('F11 Media Previews + F15 Cryptographic Integrity', () => {
    it('verifies preview generation metadata and cryptographic digest consistency', () => {
      resetIds();
      const invoiceText = 'Invoice for architectural services: $12,000.00 on 2026-02-10.';
      const evd = evidence(invoiceText, {
        fileName: 'invoice_march.pdf',
        mimeType: 'application/pdf',
      });

      // Byte digest from extraction matches content hash
      const expectedDigest = hashText(invoiceText);
      expect(evd.sha256).toBe(expectedDigest);

      // Extraction stores page/unit count for preview pagination
      expect(evd.sizeBytes).toBe(invoiceText.length);
      expect(evd.extraction?.sourceText).toBe(invoiceText);
    });
  });
});
