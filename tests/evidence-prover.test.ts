import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('expo-secure-store', async () => (await import('./secure-store-double')).secureStoreDouble);

import {
  GEMINI_IS_SERVER_ONLY,
  clearGeminiProxyConfig,
  loadGeminiProxyConfig,
  looksLikeKey,
  saveGeminiProxyConfig,
  saveKey,
  loadKey,
  resetCredentialsCacheForTests,
  type GeminiProxyConfig,
} from '../src/services/ai/credentials';
import {
  queryGeminiProxy,
  queryEvidenceProver,
} from '../src/services/ai/gemini-proxy';
import {
  evaluateDeterministicProver,
  deterministicReasoning,
  type EvidenceContext,
  type ProverResponse,
} from '../src/services/ai/evidence-prover';
import { scrubKey } from '../src/services/ai/groq-client';
import {
  resetSecureStoreDouble,
} from './secure-store-double';
import {
  CASE_ID,
  claim,
  evidence,
  resetIds,
  workspace,
} from './helpers';

describe('Feature 7, 8, 9: Evidence Prover AI Assistant & Session Proxy', () => {
  beforeEach(() => {
    resetSecureStoreDouble();
    resetCredentialsCacheForTests();
    resetIds();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Clean Settings & UI Hygiene (Feature 7 & R3)
  // ---------------------------------------------------------------------------
  describe('Feature 7: Secure Clean Settings (No exposed keys or developer jargon)', () => {
    const aiKeySectionPath = path.resolve(__dirname, '../src/features/settings/ai-key-section.tsx');
    const profileScreenPath = path.resolve(__dirname, '../app/(tabs)/profile.tsx');
    const aiKeySectionContent = fs.readFileSync(aiKeySectionPath, 'utf8');
    const profileScreenContent = fs.readFileSync(profileScreenPath, 'utf8');

    it('presents clean Evidence Reasoning Engine without raw developer URLs or latency probes', () => {
      expect(aiKeySectionContent).toContain('Evidence Reasoning Engine');
      expect(aiKeySectionContent).not.toContain('console.groq.com');
      expect(aiKeySectionContent).not.toContain('console.x.ai');
      expect(aiKeySectionContent).not.toContain('/models');
      expect(aiKeySectionContent).not.toContain('probeProvider');
      expect(profileScreenContent).not.toContain('console.groq.com');
      expect(profileScreenContent).not.toContain('console.x.ai');
    });

    it('scrubs session cookies and auth tokens from all error or diagnostic strings', () => {
      const secretToken = 'sk-sessionsecret9876543210';
      const rawError = `Connection to proxy failed with token ${secretToken} at endpoint`;
      const scrubbed = scrubKey(rawError, secretToken);
      expect(scrubbed).not.toContain(secretToken);
      expect(scrubbed).toContain('[redacted]');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Personal Gemini Session/Cookie Proxy Engine (Feature 8)
  // ---------------------------------------------------------------------------
  describe('Feature 8: Personal Gemini Session Proxy & Credential Management', () => {
    it('lifts GEMINI_IS_SERVER_ONLY restriction for personal session proxies', () => {
      expect(GEMINI_IS_SERVER_ONLY).toBe(false);
    });

    it('maintains device refusal for raw Gemini developer API keys (AIza...)', async () => {
      const rawApiKey = `AIza${'x'.repeat(35)}`;
      expect(looksLikeKey('gemini', rawApiKey)).toBe(false);
      await expect(saveKey('gemini', rawApiKey)).rejects.toThrow(/Gemini keys are not stored on this device/);
      expect(await loadKey('gemini')).toBeNull();
    });

    it('accepts and persists personal Gemini session cookies and tokens', async () => {
      const sessionCookie = 'session_cookie_valid_token_12345';
      expect(looksLikeKey('gemini', sessionCookie)).toBe(true);
      await saveKey('gemini', sessionCookie);
      expect(await loadKey('gemini')).toBe(sessionCookie);
    });

    it('round-trips complete GeminiProxyConfig through hardware keystore', async () => {
      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://my-proxy.company.internal/v1',
        sessionCookie: 'session_cookie_secret_payload_888',
      };

      await saveGeminiProxyConfig(config);
      const loaded = await loadGeminiProxyConfig();
      expect(loaded).toEqual(config);

      await clearGeminiProxyConfig();
      expect(await loadGeminiProxyConfig()).toBeNull();
    });

    it('formats proxy requests with authorization and session cookie headers when active', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          answer: 'Proxy confirmed agreement validity.',
          supportingEvidenceIds: ['ev_1'],
          contradictionsFound: [],
          confidence: 0.94,
          model: 'gemini-1.5-pro-proxy',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const ev1 = evidence('Contract agreement amount INR 10,000 dated 2026-01-10');
      const clm1 = claim('Contract value is INR 10,000');
      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [ev1],
        claims: [clm1],
      };

      const proxyConfig: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/api',
        sessionCookie: 'session_secret_cookie_777',
      };

      const res = await queryGeminiProxy('Analyze contract', context, proxyConfig);
      expect(res.source).toBe('proxy');
      expect(res.answer).toBe('Proxy confirmed agreement validity.');
      expect(res.confidence).toBe(0.94);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://proxy.example.com/api');
      expect(options.headers['Cookie']).toContain('session_secret_cookie_777');
      expect(options.headers['Authorization']).toContain('session_secret_cookie_777');

      const body = JSON.parse(options.body);
      expect(body.prompt).toBe('Analyze contract');
      expect(body.context.evidence.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Seamless Silent Fallback to Deterministic Reasoning
  // ---------------------------------------------------------------------------
  describe('Silent Deterministic Fallback on Expired Sessions & Network Drops', () => {
    const ev1 = evidence('Contract agreement amount INR 10,000');
    const clm1 = claim('Contract value is INR 10,000');
    const context: EvidenceContext = {
      caseId: CASE_ID,
      evidence: [ev1],
      claims: [clm1],
    };

    it('falls back cleanly to deterministic reasoning when proxy is disabled', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = { enabled: false, proxyUrl: 'https://proxy.example.com' };
      const res = await queryEvidenceProver('Verify claims', context, config);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(res.source).toBe('deterministic');
      expect(res.answer).toBeDefined();
      expect(res.confidence).toBeGreaterThan(0.5);
    });

    it('handles empty or undefined proxy URL safely without unhandled rejection', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = { enabled: true, proxyUrl: '' };
      const res = await queryEvidenceProver('Verify claims', context, config);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(res.source).toBe('deterministic');
    });

    it('silently falls back when session cookie has expired (HTTP 401 Unauthorized)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/chat',
        sessionCookie: 'expired_cookie_token_999',
      };

      const res = await queryEvidenceProver('Verify claims', context, config);
      expect(res.source).toBe('deterministic');
      expect(res.answer).toBeDefined();
      expect(typeof res.answer).toBe('string');
    });

    it('silently falls back when proxy returns HTTP 403 Forbidden or 429 Rate Limited', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/chat',
        sessionCookie: 'rate_limited_cookie',
      };

      const res = await queryEvidenceProver('Verify claims', context, config);
      expect(res.source).toBe('deterministic');
    });

    it('silently falls back when network connection drops (TypeError / timeout)', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/chat',
        sessionCookie: 'active_cookie',
      };

      // Must NOT throw unhandled error
      const res = await queryEvidenceProver('Verify claims', context, config);
      expect(res.source).toBe('deterministic');
      expect(res.answer).toContain('Evidence Prover');
    });

    it('silently falls back when proxy returns malformed or non-JSON content', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/chat',
        sessionCookie: 'active_cookie',
      };

      const res = await queryEvidenceProver('Verify claims', context, config);
      expect(res.source).toBe('deterministic');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Conversational Evidence Prover Assistant & Contradiction Hunting (Feature 9)
  // ---------------------------------------------------------------------------
  describe('Feature 9: Conversational Evidence Prover & Contradiction Hunting', () => {
    it('detects monetary contradictions between disparate evidence items', () => {
      const ev1 = evidence('Agreement invoice total amount INR 10,000 payable by client');
      ev1.title = 'Original Agreement';

      const ev2 = evidence('Final payment receipt of INR 450 confirmed for order');
      ev2.title = 'Disputed Payment Receipt';

      const clm = claim('Contract value is INR 10,000');

      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [ev1, ev2],
        claims: [clm],
      };

      const res = evaluateDeterministicProver('Check monetary contradictions and payment amounts', context);
      expect(res.source).toBe('deterministic');
      expect(res.contradictionsFound.length).toBeGreaterThan(0);

      const moneyContradiction = res.contradictionsFound.find((c) =>
        c.title.includes('Monetary') || c.title.includes('amount') || c.explanation.includes('INR'),
      );
      expect(moneyContradiction).toBeDefined();
      expect(moneyContradiction?.severity).toBe('HIGH');
      expect(moneyContradiction?.evidenceIds).toContain(ev1.id);
      expect(moneyContradiction?.evidenceIds).toContain(ev2.id);
    });

    it('identifies transaction status conflicts against settlement assertions', () => {
      const ev = evidence('Bank debit authorization notice');
      ev.title = 'Bank Statement';
      ev.extraction!.transactionStatus = 'FAILED';

      const clm = claim('Payment of INR 5,000 was settled and received in full');

      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [ev],
        claims: [clm],
      };

      const res = evaluateDeterministicProver('Analyze transaction status and cross-examine settlement', context);
      const statusContradiction = res.contradictionsFound.find((c) => c.severity === 'CRITICAL');
      expect(statusContradiction).toBeDefined();
      expect(statusContradiction?.title).toContain('FAILED');
    });

    it('verifies supported claims and lists supporting evidence IDs accurately', () => {
      const ev = evidence('Signed promissory note agreeing to INR 25,000 repayment terms');
      ev.title = 'Signed Note';
      const clm = claim('Promissory note repayment obligation exists');

      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [ev],
        claims: [clm],
      };

      const res = evaluateDeterministicProver('Verify claim support and provide citations', context);
      expect(res.supportingEvidenceIds).toContain(ev.id);
      expect(res.answer).toContain('Corroborated Claims');
      expect(res.answer).toContain(clm.statement);
    });

    it('highlights evidentiary vulnerabilities when claims lack supporting evidence', () => {
      const ev = evidence('Office utility electricity bill for March 2026');
      const unsupportedClaim = claim('Counterparty delivered defective machinery on site');

      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [ev],
        claims: [unsupportedClaim],
      };

      const res = evaluateDeterministicProver('Cross-examine the claims for evidentiary gaps', context);
      expect(res.answer).toContain('Unsupported Claims');
      expect(res.answer).toContain(unsupportedClaim.statement);
    });

    it('operates reliably with zero evidence without crashing or producing fabricated citations', () => {
      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [],
        claims: [claim('Unfounded assertion without documents')],
      };

      const res = deterministicReasoning(context);
      expect(res.source).toBe('deterministic');
      expect(res.supportingEvidenceIds).toEqual([]);
      expect(res.confidence).toBeLessThan(0.3);
      expect(res.answer).toContain('0 active evidence record(s)');
    });
  });
});
