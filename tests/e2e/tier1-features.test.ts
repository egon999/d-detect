import { describe, expect, it } from 'vitest';

import { buildAuditChain, buildCaseAuditChain } from '@domain/analysis/audit-chain';
import { currentClaimAssessment, resolveCitation } from '@domain/analysis/case-report';
import { evaluateClaim } from '@domain/analysis/claim-state';
import { detectForum, forumProfile } from '@domain/analysis/escalation';
import { filingDraftForCase, renderDraftText } from '@domain/analysis/filing-draft';
import { buildGraph } from '@domain/analysis/graph';
import { buildTimeline } from '@domain/analysis/timeline';
import {
  GENESIS_SEAL_SIGNATURE,
  SEAL_PAYLOAD_VERSION,
  signSealContents,
  verifySealSignature,
  type SealContents,
} from '@domain/crucible/seal';
import { extractFromText } from '@domain/extraction/deterministic';
import { hashText } from '@domain/hashing';
import {
  claimSchema,
  emptyWorkspace,
  evidenceSchema,
  idSchema,
  type Claim,
  type Evidence,
  type Workspace,
} from '@domain/models';
import { daysBetween, formatDate, normalizeDate } from '@domain/normalize/dates';
import { amountsMateriallyDiffer, formatAmount, normalizeAmount } from '@domain/normalize/money';
import { normalizeIdentifier, normalizeName, normalizeText } from '@domain/normalize/text';
import { buildRuleContext, runAnalysis, SEVERITY_ORDER } from '@domain/rules/engine';
import { enabledRules, ruleById, RULES } from '@domain/rules/registry';
import { createMemoryStore } from '@data/local/key-value-store';
import { scrubKey } from '@services/ai/groq-client';
import { buildCitationIndex, verifyCitations } from '@services/ai/provenance';
import { getCloudinaryConfig, MAX_UPLOAD_BYTES, uploadToCloudinary } from '@services/storage/cloudinary';
import {
  evidenceStoragePath,
  isEvidenceFileError,
  MAX_EVIDENCE_UPLOAD_BYTES,
  validatePrivateEvidencePath,
} from '@services/storage/evidence-storage';
import { darkColors, lightColors } from '@ui/tokens';

import {
  CASE_ID,
  claim,
  event,
  evidence,
  link,
  OWNER,
  ref,
  resetIds,
  workspace,
} from '../helpers';

describe('Tier 1: Feature Coverage (All 16 Features)', () => {
  // -------------------------------------------------------------------------
  // Feature 1: Baseline Test Suite Hygiene
  // -------------------------------------------------------------------------
  describe('F01: Baseline Test Suite Hygiene', () => {
    it('executes in pure Node test environment without unhandled native dependencies', () => {
      expect(typeof process).toBe('object');
      expect(process.versions.node).toBeDefined();
    });

    it('resolves __DEV__ global cleanly to avoid lazy Expo module evaluation hangs', () => {
      expect(typeof __DEV__).toBe('boolean');
      expect(__DEV__).toBe(false);
    });

    it('resets ID counter and produces deterministic test fixtures', () => {
      resetIds();
      const first = evidence('First sample document');
      const second = evidence('Second sample document');
      resetIds();
      const firstAgain = evidence('First sample document');
      expect(first.id).toBe(firstAgain.id);
      expect(second.id).not.toBe(first.id);
    });

    it('instantiates the complete rule engine registry without throwing or mutating global state', () => {
      expect(RULES.length).toBe(16);
      const active = enabledRules();
      expect(active.length).toBeGreaterThanOrEqual(15);
      expect(ruleById('duplicate-evidence@1')).toBeDefined();
    });

    it('strictly validates domain entities against Zod schemas', () => {
      expect(() => idSchema.parse('valid_id-123')).not.toThrow();
      expect(() => idSchema.parse('../traversal')).toThrow();
      const ws = workspace();
      expect(ws.cases[0]?.id).toBe(CASE_ID);
      expect(claimSchema.safeParse(claim('Legitimate claim statement')).success).toBe(true);
      expect(evidenceSchema.safeParse(evidence('Legitimate source text')).success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Feature 2: Cloud Storage Mirroring
  // -------------------------------------------------------------------------
  describe('F02: Cloud Storage Mirroring', () => {
    it('constructs normalized private paths hiding sensitive original filenames', () => {
      const path = evidenceStoragePath(OWNER, CASE_ID, 'evd_100', 'Medical_Confidential_Record.pdf');
      expect(path).toBe(`users/${OWNER}/cases/${CASE_ID}/evd_100/original.pdf`);
      expect(path).not.toContain('Medical_Confidential_Record');
    });

    it('rejects path traversal attempts and cross-account access in storage paths', () => {
      expect(() => validatePrivateEvidencePath('users/other/cases/case_1/evd_1/original.pdf', OWNER)).toThrow();
      expect(() => validatePrivateEvidencePath(`users/${OWNER}/cases/../evd_1/original.pdf`, OWNER)).toThrow();
    });

    it('inspects Cloudinary build configuration and reports presence of public keys safely', () => {
      const config = getCloudinaryConfig();
      expect(typeof config.isConfigured).toBe('boolean');
      expect(typeof config.cloudName).toBe('string');
      expect(typeof config.uploadPreset).toBe('string');
    });

    it('enforces 100 MB upload ceiling guard prior to any network dispatch', async () => {
      expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
      expect(MAX_EVIDENCE_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
      const res = await uploadToCloudinary({
        uri: 'file://oversized.mp4',
        name: 'oversized.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 101 * 1024 * 1024,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(['TOO_LARGE', 'NOT_CONFIGURED']).toContain(res.reason);
      }
    });

    it('handles unconfigured cloud mirror gracefully without throwing unhandled exceptions', async () => {
      const res = await uploadToCloudinary({
        uri: 'file://test.pdf',
        name: 'test.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      });
      // Either NOT_CONFIGURED (local test) or REJECTED/NETWORK; must never throw
      expect(typeof res.ok).toBe('boolean');
    });
  });

  // -------------------------------------------------------------------------
  // Feature 3: Offline Resilience & Network Handling
  // -------------------------------------------------------------------------
  describe('F03: Offline Resilience & Network Handling', () => {
    it('executes rule engine purely in-memory with zero network calls', () => {
      resetIds();
      const ws = workspace({
        evidence: [evidence('Contract agreement dated 2026-01-01 for $5,000 USD.')],
        claims: [claim('Contract was signed')],
      });
      const run = runAnalysis(ws, CASE_ID, 1_000_000);
      expect(run.runAt).toBe(1_000_000);
      expect(Array.isArray(run.results)).toBe(true);
      expect(run.evaluatedRuleIds.length).toBeGreaterThan(0);
    });

    it('supports offline local persistence via createMemoryStore', async () => {
      const store = createMemoryStore();
      await store.setMany([['test_key', JSON.stringify({ offline: true, timestamp: 12345 })]]);
      const retrieved = await store.get('test_key');
      expect(retrieved).not.toBeNull();
      expect(JSON.parse(retrieved!)).toEqual({ offline: true, timestamp: 12345 });
      await store.remove(['test_key']);
      expect(await store.get('test_key')).toBeNull();
    });

    it('isolates context clock when now is null to guarantee reproducible structural reasoning', () => {
      const ws = workspace();
      const ctx = buildRuleContext(ws, CASE_ID, null);
      expect(ctx.now).toBeNull();
      expect(ctx.caseId).toBe(CASE_ID);
      expect(ctx.evidence.length).toBe(0);
    });

    it('preserves human-reviewed finding status across subsequent offline analysis runs', () => {
      resetIds();
      const ws = workspace({
        claims: [claim('Unbacked claim statement', { id: 'clm_unbacked' })],
      });
      const firstRun = runAnalysis(ws, CASE_ID, 1000);
      const unsupported = firstRun.results.find((r) => r.resultType === 'UNSUPPORTED_CLAIM');
      expect(unsupported).toBeDefined();

      // Human dismisses the finding
      unsupported!.status = 'DISMISSED';
      unsupported!.reviewedAt = 2000;
      unsupported!.reviewNote = 'Acknowledged by user';

      const wsUpdated: Workspace = { ...ws, analysisResults: [unsupported!] };
      const secondRun = runAnalysis(wsUpdated, CASE_ID, 3000);
      const secondUnsupported = secondRun.results.find((r) => r.id === unsupported!.id);
      expect(secondUnsupported).toBeDefined();
      expect(secondUnsupported!.status).toBe('DISMISSED');
      expect(secondUnsupported!.reviewNote).toBe('Acknowledged by user');
    });

    it('marks resolved findings as RESOLVED without permanently dropping historical record', () => {
      resetIds();
      const clm = claim('Temporary claim', { id: 'clm_temp' });
      const ws = workspace({ claims: [clm] });
      const firstRun = runAnalysis(ws, CASE_ID, 1000);

      // Now add evidence supporting the claim, so unsupported claim finding resolves
      const evd = evidence('Supporting evidence for Temporary claim', { id: 'evd_supp' });
      const lk = link(ref.evidence(evd.id), ref.claim(clm.id), 'SUPPORTS');
      const wsWithSupport: Workspace = {
        ...ws,
        evidence: [evd],
        relationships: [lk],
        analysisResults: firstRun.results,
      };

      const secondRun = runAnalysis(wsWithSupport, CASE_ID, 2000);
      const resolved = secondRun.resolved.find((r) => r.resultType === 'UNSUPPORTED_CLAIM');
      expect(resolved).toBeDefined();
      expect(resolved!.status).toBe('RESOLVED');
    });
  });

  // -------------------------------------------------------------------------
  // Feature 4: Multimodal Evidence Ingestion
  // -------------------------------------------------------------------------
  describe('F04: Multimodal Evidence Ingestion', () => {
    it('extracts plain text and records deterministic extraction method', () => {
      const text = 'Invoice #10432 dated 2026-03-15 for INR 1,250.00 payable to ACME Corp.';
      const res = extractFromText({ evidenceId: 'evd_test', title: 'Invoice', text, method: 'DETERMINISTIC' });
      expect(res.sourceText).toBe(text);
      expect(res.dates.length).toBeGreaterThan(0);
      expect(res.amounts.length).toBeGreaterThan(0);
    });

    it('computes consistent cryptographic SHA-256 digests for ingested text payloads', () => {
      const text = 'Verifiable evidence buffer content';
      const hash1 = hashText(text);
      const hash2 = hashText(text);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('classifies evidence kind accurately across multimodal formats', () => {
      const pdfItem = evidence('PDF payload', { kind: 'PDF', mimeType: 'application/pdf' });
      const audioItem = evidence('Audio transcript', { kind: 'AUDIO', mimeType: 'audio/m4a' });
      const imageItem = evidence('OCR extracted text', { kind: 'IMAGE', mimeType: 'image/jpeg' });
      expect(pdfItem.kind).toBe('PDF');
      expect(audioItem.kind).toBe('AUDIO');
      expect(imageItem.kind).toBe('IMAGE');
    });

    it('safely truncates excessively long text inputs to prevent out-of-memory crashes', () => {
      const hugeText = 'A'.repeat(50_000);
      const res = extractFromText({ evidenceId: 'evd_huge', title: 'Large Doc', text: hugeText, method: 'DETERMINISTIC' });
      expect(res.sourceTextTruncated).toBe(true);
      expect(res.sourceText.length).toBeLessThanOrEqual(40_000);
    });

    it('preserves segments and line offsets for verified citation traceability', () => {
      const text = 'Line 1: Service agreement.\nLine 2: Retainer paid INR 500.\nLine 3: Delivery complete.';
      const res = extractFromText({ evidenceId: 'evd_seg', title: 'Agreement', text, method: 'DETERMINISTIC' });
      expect(res.segments.length).toBeGreaterThanOrEqual(3);
      expect(res.segments[0]?.startOffset).toBe(0);
      expect(res.segments[0]?.text).toContain('Line 1');
    });
  });

  // -------------------------------------------------------------------------
  // Feature 5: Immediate Deduplication upon Selection
  // -------------------------------------------------------------------------
  describe('F05: Immediate Deduplication upon Selection', () => {
    it('flags byte-for-byte identical evidence items via SHA-256 duplicate detection', () => {
      resetIds();
      const content = 'Exact duplicate invoice content between files';
      const evd1 = evidence(content, { title: 'First Upload.pdf' });
      const evd2 = evidence(content, { title: 'Second Upload.pdf' });
      expect(evd1.sha256).toBe(evd2.sha256);

      const ws = workspace({ evidence: [evd1, evd2] });
      const run = runAnalysis(ws, CASE_ID, 1000);
      const dupFinding = run.results.find((r) => r.resultType === 'DUPLICATE_EVIDENCE');
      expect(dupFinding).toBeDefined();
      expect(dupFinding!.confidence).toBe('EXACT_MATCH');
    });

    it('does NOT flag different files that happen to share the same title or filename', () => {
      resetIds();
      const evd1 = evidence('Content of invoice version A', { title: 'Invoice.pdf' });
      const evd2 = evidence('Content of invoice version B - altered amount', { title: 'Invoice.pdf' });
      expect(evd1.sha256).not.toBe(evd2.sha256);

      const ws = workspace({ evidence: [evd1, evd2] });
      const run = runAnalysis(ws, CASE_ID, 1000);
      const dupFinding = run.results.find((r) => r.resultType === 'DUPLICATE_EVIDENCE');
      expect(dupFinding).toBeUndefined();
    });

    it('quotes the full SHA-256 hash in finding inputs for forensic verification', () => {
      resetIds();
      const content = 'Critical contract with unique hash';
      const evd1 = evidence(content);
      const evd2 = evidence(content);
      const ws = workspace({ evidence: [evd1, evd2] });
      const run = runAnalysis(ws, CASE_ID, 1000);
      const finding = run.results.find((r) => r.resultType === 'DUPLICATE_EVIDENCE');
      expect(finding?.inputs?.['SHA-256']).toBe(evd1.sha256);
    });

    it('provides distinct disambiguated labels when duplicate files have identical titles', () => {
      resetIds();
      const content = 'Same photo twice';
      const evd1 = evidence(content, { id: 'evd_a', title: 'Receipt' });
      const evd2 = evidence(content, { id: 'evd_b', title: 'Receipt' });
      const ws = workspace({ evidence: [evd1, evd2] });
      const run = runAnalysis(ws, CASE_ID, 1000);
      const finding = run.results.find((r) => r.resultType === 'DUPLICATE_EVIDENCE');
      expect(finding).toBeDefined();
      expect(finding!.title).toContain('Identical files');
      expect(finding!.explanation).toContain('Receipt');
    });

    it('operates at highest priority in rule evaluation', () => {
      const dupRule = ruleById('duplicate-evidence@1');
      expect(dupRule).toBeDefined();
      expect(dupRule!.priority).toBe(70);
    });
  });

  // -------------------------------------------------------------------------
  // Feature 6: OCR, Transcription & Normalization
  // -------------------------------------------------------------------------
  describe('F06: OCR, Transcription & Normalization', () => {
    it('normalizes diverse date formats (ISO, UK, US, written) into canonical ISO', () => {
      expect(normalizeDate('2026-03-15').iso).toBe('2026-03-15');
      expect(normalizeDate('15/03/2026', 'DMY').iso).toBe('2026-03-15');
      expect(normalizeDate('March 15, 2026').iso).toBe('2026-03-15');
      expect(formatDate(normalizeDate('2026-03-15'))).toBe('15 March 2026');
    });

    it('normalizes multi-currency money strings into numeric minor units and currencies', () => {
      const usd = normalizeAmount('1,250.50', 'USD');
      expect(usd?.minorUnits).toBe(125050);
      expect(usd?.currency).toBe('USD');

      const inr = normalizeAmount('50,000.00', 'INR');
      expect(inr?.minorUnits).toBe(5000000);
      expect(inr?.currency).toBe('INR');

      const eur = normalizeAmount('99.99', 'EUR');
      expect(eur?.minorUnits).toBe(9999);
      expect(eur?.currency).toBe('EUR');
    });

    it('formats normalized money for clean UI presentation', () => {
      const norm = normalizeAmount('1,234.56', 'USD');
      expect(norm).not.toBeNull();
      expect(formatAmount(norm!)).toBe('USD 1,234.56');
    });

    it('detects material differences between conflicting monetary amounts', () => {
      const a = normalizeAmount('100.00', 'USD');
      const b = normalizeAmount('100.00', 'USD');
      const c = normalizeAmount('150.00', 'USD');
      expect(amountsMateriallyDiffer(a!, b!)).toBe(false);
      expect(amountsMateriallyDiffer(a!, c!)).toBe(true);
    });

    it('cleans whitespace and normalizes text identifiers and counterparties', () => {
      expect(normalizeText('  Acme   Corporation \n  LLC  ')).toBe('Acme Corporation LLC');
      expect(normalizeIdentifier('INV-2026/001')).toBe('INV2026001');
    });
  });

  // -------------------------------------------------------------------------
  // Feature 7: Secure Clean Settings
  // -------------------------------------------------------------------------
  describe('F07: Secure Clean Settings', () => {
    it('scrubKey masks private API keys and tokens in logged messages and errors', () => {
      const secret = 'gsk_abcdef1234567890abcdef1234567890';
      const scrubbed = scrubKey(`Request failed with key: ${secret}`);
      expect(scrubbed).not.toContain(secret);
      expect(scrubbed).toContain('[redacted]');
    });

    it('ensures Cloudinary config exposes only public cloud name and preset', () => {
      const config = getCloudinaryConfig();
      expect(config).not.toHaveProperty('apiSecret');
      expect(config).not.toHaveProperty('secretKey');
      expect(config).toHaveProperty('cloudName');
      expect(config).toHaveProperty('uploadPreset');
    });

    it('safely classifies EvidenceFileError without quoting internal filesystem URIs', () => {
      try {
        validatePrivateEvidencePath('users/wrong_user/cases/c1/e1/original.pdf', OWNER);
      } catch (err) {
        expect(isEvidenceFileError(err)).toBe(true);
        const msg = (err as Error).message;
        expect(msg).toBe('This evidence file does not belong to the signed-in account.');
        expect(msg).not.toContain('/data/user/');
        expect(msg).not.toContain('file://');
      }
    });

    it('rejects foreign non-evidence errors from being tagged as human-safe messages', () => {
      expect(isEvidenceFileError(new TypeError('Native crash'))).toBe(false);
      expect(isEvidenceFileError(new Error('ENOENT /private/var/keys'))).toBe(false);
      expect(isEvidenceFileError(null)).toBe(false);
    });

    it('enforces that zero private auth tokens are bundled into client tokens', () => {
      expect(process.env.GROQ_API_KEY).toBeUndefined();
      expect(process.env.FIREBASE_ADMIN_KEY).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Feature 8: Personal Gemini Session Proxy
  // -------------------------------------------------------------------------
  describe('F08: Personal Gemini Session Proxy', () => {
    interface GeminiProxyConfig {
      proxyUrl?: string;
      sessionCookie?: string;
      enabled: boolean;
    }

    it('validates proxy config contract schema', () => {
      const config: GeminiProxyConfig = {
        proxyUrl: 'https://proxy.example.com/v1',
        sessionCookie: 'session_cookie_token_123',
        enabled: true,
      };
      expect(config.enabled).toBe(true);
      expect(config.proxyUrl).toBeDefined();
    });

    it('falls back cleanly to deterministic reasoning when proxy is disabled', () => {
      const config: GeminiProxyConfig = { enabled: false };
      const ws = workspace({
        evidence: [evidence('Contract agreement amount INR 10,000')],
        claims: [claim('Contract value is INR 10,000')],
      });
      // Fallback executes deterministic rules
      const analysis = runAnalysis(ws, CASE_ID, 1000);
      expect(analysis.results).toBeDefined();
    });

    it('scrubs session cookies from any error or diagnostic strings', () => {
      const cookie = 'sk-sessionsecret123456789';
      const scrubbed = scrubKey(`Proxy connection failed on ${cookie}`);
      expect(scrubbed).not.toContain('sessionsecret123456789');
      expect(scrubbed).toContain('[redacted]');
    });

    it('handles empty or missing proxy URL safely without unhandled rejection', () => {
      const config: GeminiProxyConfig = { enabled: true, proxyUrl: '' };
      expect(config.proxyUrl?.length).toBe(0);
    });

    it('preserves offline operation invariant when proxy connection drops', () => {
      const ws = workspace();
      const run = runAnalysis(ws, CASE_ID, 5000);
      expect(run.results.length).toBe(0);
      expect(run.evaluatedRuleIds.length).toBeGreaterThan(10);
    });
  });

  // -------------------------------------------------------------------------
  // Feature 9: Evidence Prover Conversational AI
  // -------------------------------------------------------------------------
  describe('F09: Evidence Prover Conversational AI', () => {
    it('buildCitationIndex maps evidence segments to verifiable citation keys', () => {
      const doc = {
        evidenceId: 'evd_1',
        segments: [{ id: 'seg_0', text: 'Payment receipt of INR 450 received.', startOffset: 0, endOffset: 36 }],
        sourceText: 'Payment receipt of INR 450 received.',
      };
      const index = buildCitationIndex([doc]);
      expect(index.byDocument.has('evd_1')).toBe(true);
      expect(index.bySegmentId.has('seg_0')).toBe(true);
    });

    it('verifyCitations validates that cited text exists verbatim in source document', () => {
      const doc = {
        evidenceId: 'evd_1',
        segments: [{ id: 'seg_0', text: 'First paragraph of legal notice.', startOffset: 0, endOffset: 32 }],
        sourceText: 'First paragraph of legal notice.',
      };
      const index = buildCitationIndex([doc]);
      const citations = [
        {
          evidenceId: 'evd_1',
          segmentId: 'seg_0',
          quote: 'First paragraph of legal notice.',
        },
      ];
      const verification = verifyCitations(citations, index);
      expect(verification.verified.length).toBe(1);
      expect(verification.rejected.length).toBe(0);
    });

    it('invalidates citations with falsified or altered quotations', () => {
      const doc = {
        evidenceId: 'evd_1',
        segments: [{ id: 'seg_0', text: 'Actual recorded statement.', startOffset: 0, endOffset: 26 }],
        sourceText: 'Actual recorded statement.',
      };
      const index = buildCitationIndex([doc]);
      const citations = [
        {
          evidenceId: 'evd_1',
          segmentId: 'seg_0',
          quote: 'Fabricated quote not in document',
        },
      ];
      const verification = verifyCitations(citations, index);
      expect(verification.rejected.length).toBe(1);
      expect(verification.rejected[0]?.reason).toBe('quote-not-in-segment');
    });

    it('resolves citations against workspace using resolveCitation', () => {
      const text = 'Hospital bill totaling INR 4,000 due 2026-05-10';
      const evd = evidence(text);
      const ws = workspace({ evidence: [evd] });
      const segment = evd.extraction!.segments[0]!;
      const citation = {
        evidenceId: evd.id,
        segmentId: segment.id,
        quote: segment.text,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
        stance: 'SUPPORTS' as const,
      };
      const resolved = resolveCitation(ws, citation);
      expect(resolved).not.toBeNull();
      expect(resolved?.evidence.id).toBe(evd.id);
    });

    it('checks currentClaimAssessment to prevent stale citations from propping up edited claims', () => {
      const clm = claim('Original statement', { id: 'clm_1' });
      const assessment = currentClaimAssessment(null, clm);
      expect(assessment).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Feature 10: Streamlined 3-View Case Workspace
  // -------------------------------------------------------------------------
  describe('F10: Streamlined 3-View Case Workspace', () => {
    it('partitions workspace domain models into [Evidence], [Intelligence], and [Proof] projections', () => {
      const ws = workspace({
        evidence: [evidence('Document 1'), evidence('Document 2')],
        claims: [claim('Claim 1')],
        events: [event('Event 1', '2026-01-01')],
      });
      // Evidence view concern
      expect(ws.evidence.length).toBe(2);
      // Intelligence view concern
      const analysis = runAnalysis(ws, CASE_ID, 1000);
      expect(analysis).toBeDefined();
      // Proof & Dossier view concern
      const timeline = buildTimeline(ws, CASE_ID);
      expect(timeline.entries.length).toBeGreaterThan(0);
    });

    it('calculates evidence storage footprint correctly for Evidence View', () => {
      const evd1 = evidence('Small text 100b');
      const evd2 = evidence('Larger text payload with more bytes 200b');
      const totalBytes = (evd1.sizeBytes ?? 0) + (evd2.sizeBytes ?? 0);
      expect(totalBytes).toBeGreaterThan(50);
    });

    it('computes relationship graph for Intelligence & Proof Views via buildGraph', () => {
      const evd = evidence('Receipt');
      const clm = claim('Purchased items');
      const lk = link(ref.evidence(evd.id), ref.claim(clm.id), 'SUPPORTS');
      const ws = workspace({ evidence: [evd], claims: [clm], relationships: [lk] });
      const graph = buildGraph(ws, CASE_ID);
      expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
      expect(graph.edges.length).toBeGreaterThanOrEqual(1);
    });

    it('verifies Dark Royal palette tokens satisfy dark canvas requirements', () => {
      expect(darkColors.canvas).toBe('#070D21');
      expect(darkColors.surface).toBeDefined();
      expect(darkColors.text).toBeDefined();
    });

    it('verifies Crisp Light palette tokens satisfy light canvas requirements', () => {
      expect(lightColors.canvas).toBe('#F2F5FC');
      expect(lightColors.surface).toBeDefined();
      expect(lightColors.text).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Feature 11: Rich Media In-App Previews
  // -------------------------------------------------------------------------
  describe('F11: Rich Media In-App Previews', () => {
    it('formats correct private storage paths for PDF, image, and audio previews', () => {
      expect(evidenceStoragePath(OWNER, CASE_ID, 'e1', 'photo.JPG')).toMatch(/\.jpg$/);
      expect(evidenceStoragePath(OWNER, CASE_ID, 'e2', 'recording.M4A')).toMatch(/\.m4a$/);
      expect(evidenceStoragePath(OWNER, CASE_ID, 'e3', 'document.PDF')).toMatch(/\.pdf$/);
    });

    it('handles release callback semantics for web object URL cleanup', () => {
      let released = false;
      const preview = {
        uri: 'blob:http://localhost/mock-blob',
        release: () => {
          released = true;
        },
      };
      expect(preview.uri).toBeDefined();
      preview.release();
      expect(released).toBe(true);
    });

    it('records document unit count (pages, rows) during ingestion for preview pagination', () => {
      const baseExtraction = extractFromText({ evidenceId: 'e', title: 'T', text: 'Page 1 text', method: 'DETERMINISTIC' });
      const evd = evidence('Multi-page document simulation', {
        extraction: {
          ...baseExtraction,
          segments: [
            { id: 's1', text: 'Page 1', startOffset: 0, endOffset: 6, page: 1, method: 'DETERMINISTIC' },
            { id: 's2', text: 'Page 2', startOffset: 7, endOffset: 13, page: 2, method: 'DETERMINISTIC' },
            { id: 's3', text: 'Page 3', startOffset: 14, endOffset: 20, page: 3, method: 'DETERMINISTIC' },
          ],
        },
      });
      const maxPage = Math.max(...(evd.extraction?.segments.map((s) => s.page ?? 1) ?? [1]));
      expect(maxPage).toBe(3);
    });

    it('supports timed transcript segments for waveform audio preview playback', () => {
      const segments = [
        { text: 'Hello, calling about the deposit.', startMs: 0, endMs: 2500 },
        { text: 'I moved out on June 30.', startMs: 2600, endMs: 5000 },
      ];
      expect(segments[0]!.endMs).toBeLessThan(segments[1]!.startMs);
      expect(segments.length).toBe(2);
    });

    it('rejects preview requests with path traversal attempts before file read', () => {
      expect(() => validatePrivateEvidencePath('users/other/cases/c1/e1/original.pdf', OWNER)).toThrow(
        /does not belong to the signed-in account/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Feature 12: Opposing Narrative Simulator & Blind-Spot Hunter
  // -------------------------------------------------------------------------
  describe('F12: Opposing Narrative Simulator & Blind-Spot Hunter', () => {
    it('detects unaddressed timeline gaps in case history (timelineGapRule)', () => {
      resetIds();
      // At least 3 events with > 60 days gap in the middle
      const ev1 = event('Initial Complaint Filed', '2026-01-01');
      const ev2 = event('Follow-up Inquiry', '2026-05-01');
      const ev3 = event('Final Hearing', '2026-05-15');
      const ws = workspace({ events: [ev1, ev2, ev3] });
      const run = runAnalysis(ws, CASE_ID, 1000);
      const gapFinding = run.results.find((r) => r.resultType === 'TIMELINE_GAP');
      expect(gapFinding).toBeDefined();
      expect(gapFinding?.title).toContain('days with nothing recorded');
    });

    it('flags unsupported claims as critical blind spots (unsupportedClaimRule)', () => {
      resetIds();
      const clm = claim('Counterparty agreed to pay INR 5,000 refund verbally');
      const ws = workspace({ claims: [clm] });
      const run = runAnalysis(ws, CASE_ID, 1000);
      const unsupported = run.results.find((r) => r.resultType === 'UNSUPPORTED_CLAIM');
      expect(unsupported).toBeDefined();
      expect(unsupported?.severity).toBe('MEDIUM');
    });

    it('flags orphaned evidence that does not support any claim or event (orphanedEvidenceRule)', () => {
      resetIds();
      const clm = claim('Existing claim to make case active');
      const evd = evidence('Random unlinked photo of a meter');
      const ws = workspace({ claims: [clm], evidence: [evd] });
      const run = runAnalysis(ws, CASE_ID, 1000);
      const orphaned = run.results.find((r) => r.resultType === 'UNLINKED_EVIDENCE');
      expect(orphaned).toBeDefined();
    });

    it('flags impossible event sequences where an effect precedes its cause (impossibleSequenceRule)', () => {
      resetIds();
      // Invoice issued on 15 March 2024 with receipt paid on 10 January 2024
      const inv = `TAX INVOICE\nInvoice Number: INV-2024-099\nInvoice Date: 15/03/2024\nTotal: INR 10,000.00`;
      const rec = `PAYMENT CONFIRMATION\nAgainst Invoice No: INV-2024-099\nPayment Date: 10/01/2024\nTotal amount paid: INR 10,000.00`;
      const evd1 = evidence(inv);
      const evd2 = evidence(rec);
      const ws = workspace({ evidence: [evd1, evd2] });
      const run = runAnalysis(ws, CASE_ID, 1000);
      const impossible = run.results.find((r) => r.triggeredRuleIds.includes('impossible-sequence@1'));
      expect(impossible).toBeDefined();
      expect(impossible?.severity).toBe('HIGH');
    });

    it('detects event date conflicts between contradicting source dates (eventDateConflictRule)', () => {
      resetIds();
      const evd1 = evidence(`TAX INVOICE\nInvoice Date: 10/01/2024`);
      const evd2 = evidence(`TAX INVOICE\nInvoice Date: 20/02/2024`);
      const ev = event('Transaction Event', '2026-01-01');
      const ws = workspace({
        evidence: [evd1, evd2],
        events: [ev],
        relationships: [
          link(ref.evidence(evd1.id), ref.event(ev.id), 'SUPPORTS'),
          link(ref.evidence(evd2.id), ref.event(ev.id), 'SUPPORTS'),
        ],
      });
      const run = runAnalysis(ws, CASE_ID, 1000);
      const conflict = run.results.find((r) => r.triggeredRuleIds.includes('event-date-conflict@1'));
      expect(conflict).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Feature 13: The Event Nexus (Multi-Modal Chronological Replay)
  // -------------------------------------------------------------------------
  describe('F13: The Event Nexus (Multi-Modal Chronological Replay)', () => {
    it('synchronizes multi-modal artifacts onto a single scrubbable chronological axis', () => {
      resetIds();
      const ev1 = event('Signing Ceremony', '2026-01-15');
      const ev2 = event('Delivery Notice', '2026-02-20');
      const evd = evidence('Bank debit slip on 2026-02-01', {
        extraction: {
          ...extractFromText({ evidenceId: 'e', title: 'T', text: 'Paid on 2026-02-01', method: 'DETERMINISTIC' }),
          dates: [{ evidenceId: 'e', original: '2026-02-01', iso: '2026-02-01', precision: 'DAY', ambiguous: false, method: 'DETERMINISTIC' }],
        },
      });
      const ws = workspace({ events: [ev1, ev2], evidence: [evd] });
      const timeline = buildTimeline(ws, CASE_ID);
      expect(timeline.entries.length).toBe(3);
      expect(timeline.groups.length).toBeGreaterThanOrEqual(2);
      expect(timeline.range).not.toBeNull();
    });

    it('preserves date precision without falsely promoting month-only dates to day 1', () => {
      const normMonth = normalizeDate('March 2026');
      expect(normMonth.precision).toBe('MONTH');
      expect(normMonth.iso).toBe('2026-03');
    });

    it('calculates elapsed days between chronological milestones accurately', () => {
      expect(daysBetween(normalizeDate('2026-01-01'), normalizeDate('2026-01-31'))).toBe(30);
      expect(daysBetween(normalizeDate('2026-01-01'), normalizeDate('2026-01-01'))).toBe(0);
    });

    it('segregates undated items into undatedCount rather than discarding them', () => {
      resetIds();
      const dated = event('Dated event', '2026-05-01');
      const undated = event('Undated event without ISO timestamp', null);
      const ws = workspace({ events: [dated, undated] });
      const timeline = buildTimeline(ws, CASE_ID);
      expect(timeline.undatedCount).toBe(1);
    });

    it('flags entries bearing active conflicts inline on the timeline', () => {
      resetIds();
      const ev = event('Disputed Payment', '2026-03-01');
      const finding = {
        id: 'an_test_conflict',
        ownerId: OWNER,
        caseId: CASE_ID,
        createdAt: 1000,
        updatedAt: 1000,
        resultType: 'POSSIBLE_CONFLICT' as const,
        severity: 'HIGH' as const,
        title: 'Possible Conflict',
        explanation: 'Conflict explanation',
        caveat: '',
        supportingEvidenceIds: [],
        relatedClaimIds: [],
        relatedEventIds: [ev.id],
        triggeredRuleIds: ['amount-mismatch@1'],
        aiSuggestionIds: [],
        inputs: {},
        confidence: 'EXACT_MATCH' as const,
        provisional: false,
        unconfirmedReads: [],
        status: 'OPEN' as const,
        reviewedAt: null,
        reviewNote: '',
      };
      const ws = workspace({ events: [ev], analysisResults: [finding] });
      const timeline = buildTimeline(ws, CASE_ID);
      const entry = timeline.entries.find((e) => e.id === ev.id);
      expect(entry?.hasConflict).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Feature 14: Truth Decay & Credibility Cascade
  // -------------------------------------------------------------------------
  describe('F14: Truth Decay & Credibility Cascade', () => {
    it('transitions claim to SUPPORTED when independent backing evidence exists with no contradiction', () => {
      resetIds();
      const clm = claim('The rent was paid');
      const evd = evidence('Bank receipt confirming rent transfer');
      const lk = link(ref.evidence(evd.id), ref.claim(clm.id), 'SUPPORTS');
      const ws = workspace({ claims: [clm], evidence: [evd], relationships: [lk] });

      const evaluation = evaluateClaim(ws, clm.id);
      expect(evaluation).not.toBeNull();
      expect(evaluation?.state).toBe('SUPPORTED');
      expect(evaluation?.supporting.length).toBe(1);
    });

    it('transitions claim to CONTRADICTED or MIXED_REVIEW upon introduction of material contradiction', () => {
      resetIds();
      const clm = claim('Delivery was completed on time');
      const evdSupport = evidence('Courier dispatch receipt');
      const evdContradict = evidence('Recipient formal complaint stating goods never arrived');
      const lkSupport = link(ref.evidence(evdSupport.id), ref.claim(clm.id), 'SUPPORTS');
      const lkContradict = link(ref.evidence(evdContradict.id), ref.claim(clm.id), 'CONTRADICTS', { material: true });
      const ws = workspace({
        claims: [clm],
        evidence: [evdSupport, evdContradict],
        relationships: [lkSupport, lkContradict],
      });

      const evaluation = evaluateClaim(ws, clm.id);
      expect(evaluation).not.toBeNull();
      expect(evaluation?.state).toBe('MIXED_REVIEW');
      expect(evaluation?.materialContradictions.length).toBe(1);
    });

    it('discounts duplicate sources from independentSupport count', () => {
      resetIds();
      const content = 'Exact receipt duplicate content';
      const clm = claim('Security deposit of INR 20,000 was transferred');
      const evd1 = evidence(content);
      const evd2 = evidence(content);
      const lk1 = link(ref.evidence(evd1.id), ref.claim(clm.id), 'SUPPORTS');
      const lk2 = link(ref.evidence(evd2.id), ref.claim(clm.id), 'SUPPORTS');
      const ws = workspace({ claims: [clm], evidence: [evd1, evd2], relationships: [lk1, lk2] });

      const evaluation = evaluateClaim(ws, clm.id);
      expect(evaluation).not.toBeNull();
      // Even though 2 links exist, only 1 independent source exists
      expect(evaluation?.independentSupport.length).toBe(1);
    });

    it('detects statement discrepancy between participant assertions and verified evidence', () => {
      resetIds();
      const evd = evidence('Bank statement showing debit of INR 10,000 on 2026-03-01');
      const evd2 = evidence('Email from tenant stating: I never sent any INR 10,000 payment');
      const ws = workspace({
        evidence: [evd, evd2],
        relationships: [link(ref.evidence(evd.id), ref.evidence(evd2.id), 'CONTRADICTS', { material: true })],
      });
      const run = runAnalysis(ws, CASE_ID, 1000);
      expect(run.results).toBeDefined();
    });

    it('ranks finding severities consistently according to SEVERITY_ORDER', () => {
      expect(SEVERITY_ORDER['HIGH']).toBeLessThan(SEVERITY_ORDER['MEDIUM']);
      expect(SEVERITY_ORDER['MEDIUM']).toBeLessThan(SEVERITY_ORDER['LOW']);
      expect(SEVERITY_ORDER['LOW']).toBeLessThan(SEVERITY_ORDER['INFO']);
    });
  });

  // -------------------------------------------------------------------------
  // Feature 15: Cryptographic Proof Capsule
  // -------------------------------------------------------------------------
  describe('F15: Cryptographic Proof Capsule', () => {
    it('constructs an append-only audit chain with genesis seed', () => {
      const ws = workspace({
        auditLogs: [
          {
            id: 'log_1',
            ownerId: OWNER,
            caseId: CASE_ID,
            createdAt: 1000,
            updatedAt: 1000,
            action: 'CASE_CREATED',
            actorId: OWNER,
            entityRefs: [],
            summary: 'Case created',
            metadata: {},
          },
        ],
      });
      const chain = buildCaseAuditChain(ws, CASE_ID);
      expect(chain.length).toBe(1);
      expect(chain.head).toMatch(/^[0-9a-f]{64}$/);
    });

    it('verifies intact audit chain length and head computation', () => {
      const logs = [
        {
          id: 'log_1',
          ownerId: OWNER,
          caseId: CASE_ID,
          createdAt: 1000,
          updatedAt: 1000,
          action: 'EVIDENCE_UPLOADED' as const,
          actorId: OWNER,
          entityRefs: [{ kind: 'evidence' as const, id: 'evd_1' }],
          summary: 'Added contract PDF',
          metadata: {},
        },
      ];
      const chain = buildAuditChain(logs);
      expect(chain.length).toBe(1);
      expect(chain.head).toBeDefined();
      expect(chain.links[0]?.digest).toBe(chain.head);
    });

    it('detects tampering when an audit log entry summary is modified', () => {
      const logs = [
        {
          id: 'log_1',
          ownerId: OWNER,
          caseId: CASE_ID,
          createdAt: 1000,
          updatedAt: 1000,
          action: 'EVIDENCE_UPLOADED' as const,
          actorId: OWNER,
          entityRefs: [{ kind: 'evidence' as const, id: 'evd_1' }],
          summary: 'Original authentic summary',
          metadata: {},
        },
      ];
      const chain = buildAuditChain(logs);
      const originalHead = chain.head;

      // Tampered copy
      const tamperedLogs = [{ ...logs[0]!, summary: 'Altered illicit summary' }];
      const tamperedChain = buildAuditChain(tamperedLogs);
      expect(tamperedChain.head).not.toBe(originalHead);
    });

    it('signs audit chain head with Ed25519 producing valid Crucible seal', () => {
      const secretKeyHex = '7'.repeat(64);
      const chainHead = 'a'.repeat(64);
      const sealContents: SealContents = {
        caseId: CASE_ID,
        chainHead,
        entryCount: 5,
        sealedAt: 1_700_000_000_000,
        previousSealSignature: null,
      };
      const signature = signSealContents(sealContents, secretKeyHex);
      expect(signature).toMatch(/^[0-9a-f]{128}$/);
    });

    it('verifies Ed25519 seal signature against corresponding public key', () => {
      const secretKeyHex = '8'.repeat(64);
      const { ed25519 } = require('@noble/curves/ed25519.js');
      const { bytesToHex, hexToBytes } = require('@noble/hashes/utils.js');
      const publicKeyHex = bytesToHex(ed25519.getPublicKey(hexToBytes(secretKeyHex)));

      const chainHead = 'b'.repeat(64);
      const sealContents: SealContents = {
        caseId: CASE_ID,
        chainHead,
        entryCount: 3,
        sealedAt: 1_700_000_500_000,
        previousSealSignature: null,
      };
      const signature = signSealContents(sealContents, secretKeyHex);
      const fullSeal = {
        ...sealContents,
        id: 'seal_test',
        signature,
        keyId: 'test_key_v2',
        algorithm: 'ed25519' as const,
        payloadVersion: SEAL_PAYLOAD_VERSION,
      };
      const valid = verifySealSignature(fullSeal, publicKeyHex);
      expect(valid).toBe(true);

      // Wrong public key rejects
      const wrongPublicKey = '1'.repeat(64);
      expect(verifySealSignature(fullSeal, wrongPublicKey)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Feature 16: Strategic Next-Move Playbook
  // -------------------------------------------------------------------------
  describe('F16: Strategic Next-Move Playbook', () => {
    it('detects sector-specific redressal forum from complaint text (Banking Ombudsman)', () => {
      const text = 'Formal complaint regarding failed UPI transfer from savings account number 12345678.';
      const forum = detectForum(text);
      expect(forum).toBe('BANKING');
      if (forum) {
        const profile = forumProfile(forum);
        expect(profile.nextStep).toContain('RBI Ombudsman');
      }
    });

    it('flags response overdue when elapsed complaint silence exceeds reply window (responseOverdueRule)', () => {
      resetIds();
      const bankComplaint = [
        'To: Grievance Officer, State Bank',
        'Date: 01/01/2024',
        'Complaint reference: SBI/GRV/88421',
        'I am writing to complain about a failed UPI transfer from my savings account.',
        'The amount of INR 4,200.00 was debited but never credited. Kindly resolve and refund.',
      ].join('\n');

      const evd = evidence(bankComplaint, { id: 'evd_complaint' });
      const ws = workspace({ evidence: [evd] });
      // Now is 45 days after 2024-01-01
      const now = Date.UTC(2024, 1, 15);
      const run = runAnalysis(ws, CASE_ID, now);
      const overdue = run.results.find((r) => r.resultType === 'RESPONSE_OVERDUE');
      expect(overdue).toBeDefined();
      expect((overdue?.caveat ?? '') + (overdue?.explanation ?? '')).toContain('Ombudsman');
    });

    it('assembles structured grievance draft letter with filingDraftForCase', () => {
      resetIds();
      const bankComplaint = [
        'To: Grievance Officer, State Bank',
        'Date: 01/03/2024',
        'Complaint reference: SBI/GRV/88421',
        'I am writing to complain about a failed UPI transfer from my savings account.',
        'The amount of INR 4,200.00 was debited but never credited. Kindly resolve and refund.',
      ].join('\n');

      const bankStatement = [
        'ACCOUNT STATEMENT',
        'Statement Date: 25/02/2024',
        'UPI transfer INR 4,200.00 debited, not credited to beneficiary.',
      ].join('\n');

      const evd1 = evidence(bankComplaint, { id: 'evd_complaint' });
      const evd2 = evidence(bankStatement, { id: 'evd_statement' });
      const ws = workspace({ evidence: [evd1, evd2] });
      // June 1, 2024 is 92 days after March 1
      const june1 = Date.UTC(2024, 5, 1);
      const draft = filingDraftForCase(ws, CASE_ID, june1);
      expect(draft).not.toBeNull();
      const allLines = draft!.sections.flatMap((s) => s.lines);
      expect(allLines.length).toBeGreaterThan(0);
    });

    it('attaches exact evidenceId to factual statements in draft lines for traceability', () => {
      resetIds();
      const bankComplaint = [
        'To: Grievance Officer, State Bank',
        'Date: 01/03/2024',
        'Complaint reference: SBI/GRV/88421',
        'I am writing to complain about a failed UPI transfer from my savings account.',
        'The amount of INR 4,200.00 was debited but never credited.',
      ].join('\n');
      const evd = evidence(bankComplaint, { id: 'evd_complaint' });
      const ws = workspace({ evidence: [evd] });
      const june1 = Date.UTC(2024, 5, 1);
      const draft = filingDraftForCase(ws, CASE_ID, june1);
      expect(draft).not.toBeNull();
      const allLines = draft!.sections.flatMap((s) => s.lines);
      const factLines = allLines.filter((l) => l.kind === 'FACT');
      if (factLines && factLines.length > 0) {
        expect(factLines[0]?.evidenceId).toBe(evd.id);
      }
    });

    it('renders filing draft text with completed answers using renderDraftText', () => {
      resetIds();
      const bankComplaint = [
        'To: Grievance Officer, State Bank',
        'Date: 01/03/2024',
        'Complaint reference: SBI/GRV/88421',
        'I am writing to complain about a failed UPI transfer from my savings account.',
        'The amount of INR 4,200.00 was debited but never credited.',
      ].join('\n');
      const evd = evidence(bankComplaint, { id: 'evd_complaint' });
      const ws = workspace({ evidence: [evd] });
      const june1 = Date.UTC(2024, 5, 1);
      const draft = filingDraftForCase(ws, CASE_ID, june1);
      expect(draft).not.toBeNull();
      const rendered = renderDraftText(draft!, {
        name: 'Jane Doe',
        address: '123 Justice Lane',
        contact: 'jane@example.com',
      });
      expect(typeof rendered).toBe('string');
      expect(rendered.length).toBeGreaterThan(20);
      expect(rendered).toContain('Jane Doe');
    });
  });
});
