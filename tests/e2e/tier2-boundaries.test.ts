import { describe, expect, it } from 'vitest';

import { buildCaseAuditChain } from '@domain/analysis/audit-chain';
import { evaluateClaim } from '@domain/analysis/claim-state';
import { buildGraph } from '@domain/analysis/graph';
import { buildTimeline } from '@domain/analysis/timeline';
import {
  assertSealable,
  GENESIS_SEAL_SIGNATURE,
  publicKeyFor,
  SealRefused,
  signSealContents,
  verifySealSignature,
  type SealContents,
} from '@domain/crucible/seal';
import { extractFromText } from '@domain/extraction/deterministic';
import { hashBytes, hashText } from '@domain/hashing';
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
import {
  amountsMateriallyDiffer,
  formatAmount,
  isKnownCurrency,
  normalizeAmount,
} from '@domain/normalize/money';
import {
  clampText,
  foldDigits,
  normalizeEmail,
  normalizeIdentifier,
  normalizeName,
  normalizePhone,
  normalizeText,
} from '@domain/normalize/text';
import { buildRuleContext, runAnalysis } from '@domain/rules/engine';
import { MAX_UPLOAD_BYTES } from '@services/storage/cloudinary';

// ---------------------------------------------------------------------------
// Helpers and Test Constants
// ---------------------------------------------------------------------------

import {
  CASE_ID,
  claim,
  evidence,
  OWNER,
  resetIds,
  testCase,
  workspace,
} from '../helpers';

const OWNER_ID = OWNER;

const MOCK_SECRET_KEY =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const MOCK_PUBLIC_KEY = publicKeyFor(MOCK_SECRET_KEY);

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return workspace(overrides);
}

// ---------------------------------------------------------------------------
// Test Suite: Tier 2 Boundary Value Analysis
// ---------------------------------------------------------------------------

describe('Tier 2: Boundary Value Analysis', () => {
  // =========================================================================
  // Category 1: Empty Workspaces & Zero Values
  // =========================================================================
  describe('Category 1: Empty Workspaces & Zero Inputs', () => {
    it('evaluates completely empty workspace without crashing across all analysis engines', () => {
      const ws = makeWorkspace();

      const timeline = buildTimeline(ws, CASE_ID);
      expect(timeline.entries).toHaveLength(0);
      expect(timeline.undatedCount).toBe(0);

      const graph = buildGraph(ws, CASE_ID);
      expect(graph.nodes).toHaveLength(0);
      expect(graph.edges).toHaveLength(0);

      const auditChain = buildCaseAuditChain(ws, CASE_ID);
      expect(auditChain).toHaveLength(0);

      const runResult = runAnalysis(ws, CASE_ID, 1000);
      expect(runResult.results).toHaveLength(0);
    });

    it('evaluates non-existent claim in empty workspace safely returning null', () => {
      const ws = makeWorkspace();
      const assessment = evaluateClaim(ws, 'clm_nonexistent9999');
      expect(assessment).toBeNull();

      // An unlinked claim evaluates to UNSUPPORTED with zero support
      const unlinked = claim('Unlinked standalone claim');
      const wsWithClaim = makeWorkspace({ claims: [unlinked] });
      const unlinkedAssessment = evaluateClaim(wsWithClaim, unlinked.id);
      expect(unlinkedAssessment).not.toBeNull();
      expect(unlinkedAssessment?.state).toBe('UNSUPPORTED');
      expect(unlinkedAssessment?.independentSupport).toHaveLength(0);
      expect(unlinkedAssessment?.contradicting).toHaveLength(0);
      expect(unlinkedAssessment?.materialContradictions).toHaveLength(0);
    });

    it('handles zero-byte buffer and empty string hashing deterministically', () => {
      const emptyBuffer = new Uint8Array(0);
      const emptyHash = hashBytes(emptyBuffer);
      const emptyTextHash = hashText('');

      const canonicalEmptySha256 =
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

      expect(emptyHash).toBe(canonicalEmptySha256);
      expect(emptyTextHash).toBe(canonicalEmptySha256);
    });

    it('extracts from empty text gracefully without generating false entities', () => {
      const result = extractFromText({
        evidenceId: 'evd_empty0000000001',
        title: 'Empty File',
        text: '',
        method: 'DETERMINISTIC',
      });

      expect(result.segments).toHaveLength(0);
      expect(result.dates).toHaveLength(0);
      expect(result.amounts).toHaveLength(0);
      expect(result.parties).toHaveLength(0);
      expect(result.summary).toBe('Document');
      expect(result.sourceText).toBe('');
      expect(result.sourceTextTruncated).toBe(false);
    });
  });

  // =========================================================================
  // Category 2: Maximum Limits & Capacity Clamping
  // =========================================================================
  describe('Category 2: Maximum Limits & Capacity Clamping', () => {
    it('verifies MAX_UPLOAD_BYTES boundary limit is exactly 100 MB', () => {
      expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
      expect(MAX_UPLOAD_BYTES).toBe(104857600);
    });

    it('clamps text at arbitrary boundaries and reports truncation status honestly', () => {
      const sample = 'a'.repeat(100);
      const notTruncated = clampText(sample, 100);
      expect(notTruncated.text).toHaveLength(100);
      expect(notTruncated.truncated).toBe(false);

      const truncated = clampText(sample, 80);
      expect(truncated.text).toHaveLength(80);
      expect(truncated.truncated).toBe(true);

      const zeroClamp = clampText(sample, 0);
      expect(zeroClamp.text).toBe('');
      expect(zeroClamp.truncated).toBe(true);
    });

    it('enforces maximum source text bounding (40,000 chars) during deterministic extraction', () => {
      const longInput = 'Invoice total USD 500.00 on 2026-03-01. ' + 'X'.repeat(60000);
      const result = extractFromText({
        evidenceId: 'evd_long00000000001',
        title: 'Huge Text Input',
        text: longInput,
        method: 'DETERMINISTIC',
      });

      expect(result.sourceText.length).toBeLessThanOrEqual(40000);
      expect(result.sourceTextTruncated).toBe(true);
      expect(result.amounts.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects identifiers exceeding max length schema bound of 128 characters', () => {
      const validId = 'id_' + 'a'.repeat(120);
      expect(idSchema.safeParse(validId).success).toBe(true);

      const oversizedId = 'id_' + 'a'.repeat(130);
      expect(idSchema.safeParse(oversizedId).success).toBe(false);

      const emptyId = '';
      expect(idSchema.safeParse(emptyId).success).toBe(false);
    });
  });

  // =========================================================================
  // Category 3: Extreme, Zero & Multi-Locale Monetary Values
  // =========================================================================
  describe('Category 3: Extreme, Zero & Multi-Locale Monetary Values', () => {
    it('normalizes zero currency amounts across USD, EUR, and INR accurately', () => {
      const zeroUsd = normalizeAmount('$0.00', 'USD');
      expect(zeroUsd).not.toBeNull();
      expect(zeroUsd?.minorUnits).toBe(0);
      expect(formatAmount(zeroUsd!)).toBe('USD 0.00');

      const zeroInr = normalizeAmount('₹0', 'INR');
      expect(zeroInr).not.toBeNull();
      expect(zeroInr?.minorUnits).toBe(0);
      expect(formatAmount(zeroInr!)).toBe('INR 0.00');

      const zeroEur = normalizeAmount('0,00 €', 'EUR');
      expect(zeroEur).not.toBeNull();
      expect(zeroEur?.minorUnits).toBe(0);
    });

    it('parses negative amounts and accounting parentheses notation', () => {
      const standardNegative = normalizeAmount('-1,250.50', 'USD');
      expect(standardNegative).not.toBeNull();
      expect(standardNegative?.minorUnits).toBe(-125050);
      expect(formatAmount(standardNegative!)).toBe('-USD 1,250.50');

      const accountingNegative = normalizeAmount('(500.00)', 'USD');
      expect(accountingNegative).not.toBeNull();
      expect(accountingNegative?.minorUnits).toBe(-50000);
      expect(formatAmount(accountingNegative!)).toBe('-USD 500.00');
    });

    it('safely handles multi-locale digit groupings (Indian lakh vs European dot vs US comma)', () => {
      // Indian lakh grouping: 1,00,000.00 (1 Lakh = 100,000)
      const indianLakh = normalizeAmount('₹ 1,00,000.00', 'INR');
      expect(indianLakh).not.toBeNull();
      expect(indianLakh?.minorUnits).toBe(10000000); // 100,000.00 in paise

      // European decimal comma and dot thousands: 1.250,50
      const european = normalizeAmount('1.250,50 EUR', 'EUR');
      expect(european).not.toBeNull();
      expect(european?.minorUnits).toBe(125050);

      // US decimal dot and comma thousands: 1,250.50
      const us = normalizeAmount('$1,250.50', 'USD');
      expect(us).not.toBeNull();
      expect(us?.minorUnits).toBe(125050);
    });

    it('rejects malformed numbers, invalid decimal precision, and unsafe integers', () => {
      // More decimals than currency exponent (USD exponent is 2, 4 decimals rejected)
      expect(normalizeAmount('$12.3456', 'USD')).toBeNull();

      // Malformed grouping delimiters (version string)
      expect(normalizeAmount('1.2.3.4', 'USD')).toBeNull();

      // Completely non-numeric text
      expect(normalizeAmount('USD abc', 'USD')).toBeNull();

      // Number exceeding Number.isSafeInteger
      const hugeOverflow = '99999999999999999999999999999.00';
      expect(normalizeAmount(hugeOverflow, 'USD')).toBeNull();
    });
  });

  // =========================================================================
  // Category 4: Malformed Data & Structural Anomalies
  // =========================================================================
  describe('Category 4: Malformed Data & Structural Anomalies', () => {
    it('returns unparsed date object rather than throwing on invalid calendar dates', () => {
      // Non-existent leap year day
      const feb30 = normalizeDate('2026-02-30');
      expect(feb30.iso).toBeNull();
      expect(feb30.precision).toBe('UNKNOWN');
      expect(formatDate(feb30)).toBe('2026-02-30');

      // Invalid month
      const month13 = normalizeDate('2026-13-01');
      expect(month13.iso).toBeNull();

      // Complete non-date gibberish
      const gibberish = normalizeDate('not-a-valid-date-string');
      expect(gibberish.iso).toBeNull();
      expect(gibberish.precision).toBe('UNKNOWN');
      expect(formatDate(gibberish)).toBe('not-a-valid-date-string');
    });

    it('returns null for daysBetween when any date operand is unparsed or coarse', () => {
      const validDay = normalizeDate('2026-03-01');
      const invalidDay = normalizeDate('2026-02-30');
      const monthOnly = normalizeDate('March 2026');

      expect(daysBetween(validDay, invalidDay)).toBeNull();
      expect(daysBetween(validDay, monthOnly)).toBeNull();
      expect(daysBetween(monthOnly, validDay)).toBeNull();
    });

    it('rejects path traversal attempts and invalid path segments via idSchema and entity contracts', () => {
      // Path traversal with parent directory markers and illegal separators
      expect(idSchema.safeParse('../other').success).toBe(false);
      expect(idSchema.safeParse('../../etc/passwd').success).toBe(false);
      expect(idSchema.safeParse('cases/../evd').success).toBe(false);
      expect(idSchema.safeParse('null\0byte').success).toBe(false);

      // Evidence schema rejects malformed SHA-256 digests
      const sample = evidence('Valid sample text');
      expect(evidenceSchema.safeParse({ ...sample, sha256: 'deadbeef' }).success).toBe(false);
      expect(evidenceSchema.safeParse({ ...sample, sha256: 'Z'.repeat(64) }).success).toBe(false);
      expect(evidenceSchema.safeParse({ ...sample, sha256: 'a'.repeat(63) }).success).toBe(false);
    });

    it('refuses to create or verify Crucible seals on empty history, invalid heads, or malformed keys', () => {
      const emptyContents: SealContents = {
        caseId: CASE_ID,
        chainHead: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        entryCount: 0, // Empty history prohibited
        sealedAt: Date.now(),
        previousSealSignature: null,
      };

      expect(() => assertSealable(emptyContents)).toThrowError(SealRefused);
      expect(() => signSealContents(emptyContents, MOCK_SECRET_KEY)).toThrowError(
        'Nothing to seal: this case has no recorded history yet.'
      );

      const invalidHeadContents: SealContents = {
        caseId: CASE_ID,
        chainHead: 'not-a-64-char-hex-digest',
        entryCount: 1,
        sealedAt: Date.now(),
        previousSealSignature: null,
      };
      expect(() => assertSealable(invalidHeadContents)).toThrowError(
        'A seal must cover a chain head: 64 lowercase hex characters.'
      );

      // Verification returns false rather than throwing on malformed inputs
      const badSeal = {
        ...invalidHeadContents,
        signature: 'deadbeef',
        keyId: 'key1',
        algorithm: 'ed25519' as const,
      };
      expect(verifySealSignature(badSeal, MOCK_PUBLIC_KEY)).toBe(false);
    });
  });

  // =========================================================================
  // Category 5: Unicode, Script Diversity & Injection Resistance
  // =========================================================================
  describe('Category 5: Unicode, Script Diversity & Injection Resistance', () => {
    it('folds Indic and Arabic-Indic non-ASCII digits into ASCII digits preserving length', () => {
      // Devanagari numerals: ०१२३४५६७८९ -> 0123456789
      const devanagariText = 'कुल राशि ₹१२५०';
      const foldedDevanagari = foldDigits(devanagariText);
      expect(foldedDevanagari).toBe('कुल राशि ₹1250');
      expect(foldedDevanagari.length).toBe(devanagariText.length);

      // Amount normalization parses Devanagari amounts seamlessly
      const devanagariAmount = normalizeAmount('₹१२५०.००', 'INR');
      expect(devanagariAmount).not.toBeNull();
      expect(devanagariAmount?.minorUnits).toBe(125000);

      // Bengali numerals: ০১২৩৪৫৬৭৮৯
      const bengaliText = 'টাকা ৩৫০';
      expect(foldDigits(bengaliText)).toBe('টাকা 350');
    });

    it('normalizes NFKC ligatures and collapses complex whitespace patterns', () => {
      // Ligatures "ﬁ" (U+FB01) and "ﬂ" (U+FB02)
      const ligatureInput = 'ﬁle   ﬂow   veriﬁcation';
      expect(normalizeText(ligatureInput)).toBe('file flow verification');

      // Fullwidth ASCII characters (U+FF01 to U+FF5E)
      const fullwidth = 'ＩＮＶＯＩＣＥ　２０２６';
      expect(normalizeText(fullwidth)).toBe('INVOICE 2026');
      expect(normalizeIdentifier(fullwidth)).toBe('INVOICE2026');
    });

    it('preserves malicious SQL, XSS, and JSON injection strings as literal text safely', () => {
      const maliciousStatement =
        "<script>alert('pwned')</script>'; DROP TABLE cases; -- {\"injected\": true}";

      const sampleClaim: Claim = {
        id: 'clm_sqli00000000001',
        caseId: CASE_ID,
        ownerId: OWNER_ID,
        statement: maliciousStatement,
        detail: 'Testing injection handling in statement string',
        requiredEventIds: [],
        state: 'UNSUPPORTED',
        createdAt: 1000,
        updatedAt: 1000,
        deletedAt: null,
      };

      // Zod schema passes without escaping failure
      const parsed = claimSchema.safeParse(sampleClaim);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.statement).toBe(maliciousStatement);

      // Rule engine context evaluation handles injection strings without crashing
      const ws = makeWorkspace({ claims: [sampleClaim] });
      const runResult = runAnalysis(ws, CASE_ID, 1000);
      expect(Array.isArray(runResult.results)).toBe(true);
    });

    it('normalizes telephone, email, and name variations consistently', () => {
      expect(normalizePhone('+1 (555) 234-5678')).toBe('+15552345678');
      expect(normalizePhone('0091 98765-43210')).toBe('00919876543210');

      expect(normalizeEmail('  Contact.User@Example.COM  ')).toBe(
        'contact.user@example.com'
      );

      expect(normalizeName('Acme Solutions Pvt. Ltd.')).toBe('acme solutions');
      expect(normalizeName('Global Holdings LLC')).toBe('global holdings');
    });
  });
});
