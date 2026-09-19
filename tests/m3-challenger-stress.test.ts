import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import type { GeminiProxyConfig } from '../src/services/ai/credentials';
import { CASE_ID, claim, evidence, resetIds } from './helpers';

describe('M3 Challenger: Gemini Session Proxy & Fallback Engine Empirical Stress Suite', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetIds();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  const baseContext: EvidenceContext = {
    caseId: CASE_ID,
    evidence: [
      evidence('Invoice total INR 15,000 issued by Acme Corp on 2026-02-01', {
        title: 'Acme Invoice #101',
      }),
      evidence('Payment transaction confirmation of INR 15,000 settled on 2026-02-05', {
        title: 'Bank Settlement Receipt',
      }),
    ],
    claims: [
      claim('Payment of INR 15,000 was settled in full to Acme Corp'),
    ],
  };

  // ===========================================================================
  // SUITE 1: HTTP Error Status Codes (401, 403, 429, 500, 502, 503, 504, etc.)
  // ===========================================================================
  describe('Suite 1: HTTP Error Status Codes & Gateway Failures', () => {
    const errorStatusCodes = [
      { code: 400, text: 'Bad Request' },
      { code: 401, text: 'Unauthorized (Expired Session Cookie)' },
      { code: 403, text: 'Forbidden (Restricted Access)' },
      { code: 404, text: 'Not Found (Endpoint Missing)' },
      { code: 408, text: 'Request Timeout' },
      { code: 413, text: 'Payload Too Large' },
      { code: 422, text: 'Unprocessable Entity' },
      { code: 429, text: 'Too Many Requests (Rate Limited / Quota Exceeded)' },
      { code: 500, text: 'Internal Server Error (Proxy Crash)' },
      { code: 502, text: 'Bad Gateway (Upstream Connection Failed)' },
      { code: 503, text: 'Service Unavailable (Overloaded Proxy)' },
      { code: 504, text: 'Gateway Timeout (Upstream Timeout)' },
      { code: 520, text: 'Web Server Returned an Unknown Error' },
      { code: 521, text: 'Web Server Is Down' },
      { code: 522, text: 'Connection Timed Out' },
      { code: 524, text: 'A Timeout Occurred' },
      { code: 599, text: 'Network Connect Timeout Error' },
    ];

    for (const { code, text } of errorStatusCodes) {
      it(`silently falls back to deterministic offline rules on HTTP ${code} (${text})`, async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: false,
          status: code,
          statusText: text,
          json: async () => ({ error: text, status: code }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const config: GeminiProxyConfig = {
          enabled: true,
          proxyUrl: 'https://proxy.example.com/v1/chat',
          sessionCookie: `test_session_cookie_for_${code}`,
        };

        let result: ProverResponse | undefined;
        let threwError = false;

        try {
          result = await queryGeminiProxy('Cross-examine the evidence claims', baseContext, config);
        } catch {
          threwError = true;
        }

        // Must NEVER throw an unhandled exception
        expect(threwError).toBe(false);
        expect(result).toBeDefined();

        // Must seamlessly fallback to deterministic rule reasoning
        expect(result!.source).toBe('deterministic');
        expect(typeof result!.answer).toBe('string');
        expect(result!.answer.length).toBeGreaterThan(0);
        expect(result!.answer).toContain('Evidence Prover Assessment');
        expect(result!.confidence).toBeGreaterThanOrEqual(0);
        expect(result!.confidence).toBeLessThanOrEqual(1);
        expect(Array.isArray(result!.supportingEvidenceIds)).toBe(true);
        expect(Array.isArray(result!.contradictionsFound)).toBe(true);

        // Verify entry point wrapper also falls back silently
        const wrapperResult = await queryEvidenceProver('Verify claims', baseContext, config);
        expect(wrapperResult.source).toBe('deterministic');
      });
    }
  });

  // ===========================================================================
  // SUITE 2: Network Drops, Sockets, Aborts & Transport Errors
  // ===========================================================================
  describe('Suite 2: Network Drops, Sockets, Aborts & Transport Errors', () => {
    const transportErrors = [
      { name: 'Generic Node fetch error', error: new TypeError('fetch failed') },
      { name: 'Browser fetch error', error: new TypeError('Failed to fetch') },
      { name: 'Socket ECONNREFUSED', error: new Error('connect ECONNREFUSED 127.0.0.1:8080') },
      { name: 'Socket ECONNRESET', error: new Error('read ECONNRESET') },
      { name: 'Socket ETIMEDOUT', error: new Error('connect ETIMEDOUT 192.168.1.1:443') },
      { name: 'DNS ENOTFOUND', error: new Error('getaddrinfo ENOTFOUND proxy.gemini.internal') },
      { name: 'SSL Certificate Expired', error: new Error('certificate has expired') },
      { name: 'SSL Self-Signed Cert', error: new Error('self signed certificate in certificate chain') },
      { name: 'AbortController Signal Aborted', error: new DOMException('The user aborted a request.', 'AbortError') },
      { name: 'Custom Unexpected Error', error: new Error('Kernel socket buffer overflow') },
    ];

    for (const { name, error } of transportErrors) {
      it(`absorbs network fault "${name}" with 100% silent non-throwing fallback`, async () => {
        const mockFetch = vi.fn().mockRejectedValue(error);
        vi.stubGlobal('fetch', mockFetch);

        const config: GeminiProxyConfig = {
          enabled: true,
          proxyUrl: 'https://proxy.example.com/api',
          sessionCookie: 'session_cookie_active_9876',
        };

        let result: ProverResponse | undefined;
        let caughtError: unknown;

        try {
          result = await queryGeminiProxy('Analyze contradiction', baseContext, config);
        } catch (e) {
          caughtError = e;
        }

        expect(caughtError).toBeUndefined();
        expect(result).toBeDefined();
        expect(result!.source).toBe('deterministic');
        expect(result!.answer).toContain('Evidence Prover');
      });
    }

    it('handles stream reading failure when response.json() rejects midway', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Connection closed prematurely while reading response body stream');
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/api',
        sessionCookie: 'cookie_token_stream_drop',
      };

      const result = await queryGeminiProxy('Test stream drop', baseContext, config);
      expect(result.source).toBe('deterministic');
      expect(result.answer).toBeDefined();
    });

    it('safely handles AbortController timeout without lingering timers', async () => {
      vi.useFakeTimers();
      try {
        const mockFetch = vi.fn().mockImplementation((_url, options) => {
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new DOMException('This operation was aborted', 'AbortError'));
            });
          });
        });
        vi.stubGlobal('fetch', mockFetch);

        const config: GeminiProxyConfig = {
          enabled: true,
          proxyUrl: 'https://proxy.example.com/api',
          sessionCookie: 'timeout_cookie_token',
        };

        const promise = queryGeminiProxy('Hanging request', baseContext, config);

        // Advance past 12s timeout
        vi.advanceTimersByTime(12_500);

        const result = await promise;
        expect(result.source).toBe('deterministic');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // SUITE 3: Malformed, Empty, Corrupted, and Inverted Response Bodies
  // ===========================================================================
  describe('Suite 3: Malformed, Empty, Corrupted & Inverted Response Bodies', () => {
    it('handles HTML error pages masquerading as 200 OK without SyntaxError crash', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0: <!DOCTYPE html><html>...');
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/chat',
        sessionCookie: 'token_html_response',
      };

      const res = await queryGeminiProxy('Verify agreement', baseContext, config);
      expect(res.source).toBe('deterministic');
      expect(res.answer).toBeDefined();
    });

    it('handles empty response body without crash', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/chat',
        sessionCookie: 'token_empty_body',
      };

      const res = await queryGeminiProxy('Verify agreement', baseContext, config);
      expect(res.source).toBe('deterministic');
    });

    it('falls back cleanly when response.json() resolves to primitive values (null, number, string, boolean)', async () => {
      const primitives = [null, 12345, 'unexpected string', true, false];

      for (const val of primitives) {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => val,
        });
        vi.stubGlobal('fetch', mockFetch);

        const config: GeminiProxyConfig = {
          enabled: true,
          proxyUrl: 'https://proxy.example.com/chat',
          sessionCookie: 'token_primitives',
        };

        const res = await queryGeminiProxy('Verify agreement', baseContext, config);
        expect(res.source).toBe('deterministic');
        expect(res.answer).toContain('Evidence Prover Assessment');
      }
    });

    it('handles response.json() returning an empty object with safe defensive defaults', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/chat',
        sessionCookie: 'token_empty_obj',
      };

      const res = await queryGeminiProxy('Verify agreement', baseContext, config);
      expect(res.source).toBe('proxy');
      expect(res.answer).toBe('Analysis completed via session proxy.');
      expect(res.supportingEvidenceIds).toEqual([]);
      expect(res.contradictionsFound).toEqual([]);
      expect(res.confidence).toBe(0.9);
      expect(res.model).toBe('gemini-session-proxy');
    });

    it('handles response.json() returning corrupted/inverted property types defensively', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          answer: 404, // not a string
          supportingEvidenceIds: 'not-an-array', // not an array
          contradictionsFound: { invalid: true }, // not an array
          confidence: 'invalid-confidence', // not a number
          model: 1234, // not a string
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/chat',
        sessionCookie: 'token_corrupted_fields',
      };

      const res = await queryGeminiProxy('Verify agreement', baseContext, config);
      expect(res.source).toBe('proxy');
      expect(res.answer).toBe('Analysis completed via session proxy.');
      expect(Array.isArray(res.supportingEvidenceIds)).toBe(true);
      expect(Array.isArray(res.contradictionsFound)).toBe(true);
      expect(res.confidence).toBe(0.9);
      expect(res.model).toBe('gemini-session-proxy');
    });

    it('prevents prototype pollution from malicious server response payload', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => JSON.parse('{"__proto__": {"polluted": true}, "answer": "Safe answer"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/chat',
        sessionCookie: 'token_proto_test',
      };

      const res = await queryGeminiProxy('Verify agreement', baseContext, config);
      expect(res.source).toBe('proxy');
      expect(res.answer).toBe('Safe answer');
      expect((({} as any)).polluted).toBeUndefined();
    });
  });

  // ===========================================================================
  // SUITE 4: Malformed URLs & Endpoints
  // ===========================================================================
  describe('Suite 4: Malformed URLs & Endpoints', () => {
    it('falls back immediately when proxyUrl and sessionCookie are both missing/empty', async () => {
      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: '',
        sessionCookie: '',
      };

      const res = await queryGeminiProxy('Verify claims', baseContext, config);
      expect(res.source).toBe('deterministic');
    });

    it('falls back immediately when proxy is disabled even if URL is specified', async () => {
      const config: GeminiProxyConfig = {
        enabled: false,
        proxyUrl: 'https://proxy.example.com/v1',
        sessionCookie: 'valid_cookie',
      };

      const res = await queryGeminiProxy('Verify claims', baseContext, config);
      expect(res.source).toBe('deterministic');
    });

    it('uses default fallback endpoint if proxyUrl is whitespace only but sessionCookie is provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: '   \t  \n  ',
        sessionCookie: 'valid_session_cookie',
      };

      const res = await queryGeminiProxy('Verify claims', baseContext, config);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl] = mockFetch.mock.calls[0]!;
      expect(calledUrl).toBe('https://proxy.example.com/v1/chat');
      expect(res.source).toBe('deterministic');
    });

    // Test with real native fetch to ensure URL parse errors do not escape the try/catch
    const malformedUrls = [
      'not-a-valid-url',
      '://missing-scheme',
      'http://',
      'ftp://unsupported-scheme.example.com',
      'http://invalid host with spaces.com',
      'http://[::1]:999999',
      'http://' + 'x'.repeat(4000) + '.internal',
    ];

    for (const badUrl of malformedUrls) {
      it(`safely handles malformed URL "${badUrl.slice(0, 30)}..." with real fetch without crashing`, async () => {
        // Use real native fetch
        globalThis.fetch = originalFetch;

        const config: GeminiProxyConfig = {
          enabled: true,
          proxyUrl: badUrl,
          sessionCookie: 'cookie_for_bad_url_test',
        };

        let result: ProverResponse | undefined;
        let didThrow = false;

        try {
          result = await queryGeminiProxy('Test bad url', baseContext, config);
        } catch {
          didThrow = true;
        }

        expect(didThrow).toBe(false);
        expect(result).toBeDefined();
        expect(result!.source).toBe('deterministic');
      });
    }
  });

  // ===========================================================================
  // SUITE 5: Empty, Corrupt, and Adversarial Cookies
  // ===========================================================================
  describe('Suite 5: Empty, Corrupt & Adversarial Cookies', () => {
    it('operates safely when sessionCookie is empty string', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ answer: 'Success without cookie' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com',
        sessionCookie: '',
      };

      const res = await queryGeminiProxy('Prompt', baseContext, config);
      expect(res.source).toBe('proxy');
      expect(res.answer).toBe('Success without cookie');

      const [, options] = mockFetch.mock.calls[0]!;
      expect(options.headers['Cookie']).toBeUndefined();
      expect(options.headers['Authorization']).toBeUndefined();
    });

    it('safely handles corrupt string tokens ("undefined", "null", "[object Object]")', async () => {
      const corruptTokens = ['undefined', 'null', '[object Object]', 'NaN'];

      for (const token of corruptTokens) {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        });
        vi.stubGlobal('fetch', mockFetch);

        const config: GeminiProxyConfig = {
          enabled: true,
          proxyUrl: 'https://proxy.example.com',
          sessionCookie: token,
        };

        const res = await queryGeminiProxy('Prompt', baseContext, config);
        expect(res.source).toBe('deterministic');
      }
    });

    it('safely handles CRLF injection attempt in sessionCookie with real fetch without crashing', async () => {
      globalThis.fetch = originalFetch;

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com/v1',
        sessionCookie: 'token\r\nX-Injected-Header: evil\r\n\r\n',
      };

      let result: ProverResponse | undefined;
      let didThrow = false;

      try {
        result = await queryGeminiProxy('Prompt', baseContext, config);
      } catch {
        didThrow = true;
      }

      // Native fetch may reject invalid header characters; ensure it never escapes queryGeminiProxy
      expect(didThrow).toBe(false);
      expect(result).toBeDefined();
      expect(result!.source).toBe('deterministic');
    });

    it('safely handles extremely large cookie (64 KB) without crashing', async () => {
      const hugeCookie = 'sess_' + 'A'.repeat(65_536);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 431, // Request Header Fields Too Large
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com',
        sessionCookie: hugeCookie,
      };

      const res = await queryGeminiProxy('Prompt', baseContext, config);
      expect(res.source).toBe('deterministic');
    });

    it('safely handles unicode / emoji / non-ascii characters in cookie', async () => {
      const unicodeCookie = 'session_🍪_🚀_token_999';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com',
        sessionCookie: unicodeCookie,
      };

      const res = await queryGeminiProxy('Prompt', baseContext, config);
      expect(res.source).toBe('deterministic');
    });
  });

  // ===========================================================================
  // SUITE 6: Credential Privacy & Zero Leakage Verification
  // ===========================================================================
  describe('Suite 6: Credential Privacy & Zero Leakage Verification', () => {
    it('verifies scrubKey scrubs session cookies and tokens from error strings', () => {
      const sensitiveCookie = 'session_cookie_secret_super_private_token_99999';
      const errorMessage = `Fatal error: unable to authenticate with cookie ${sensitiveCookie} at remote proxy`;

      const scrubbed = scrubKey(errorMessage, sensitiveCookie);
      expect(scrubbed).not.toContain(sensitiveCookie);
      expect(scrubbed).toContain('[redacted]');
    });

    it('verifies scrubKey redacts standard AI provider prefixes (gsk_, xai-, sk-, AIza)', () => {
      const mixedTokens = 'Errors: gsk_1234567890abcdef and xai-9876543210fedcba and sk-abc123xyz789 and AIzaSyD1234567890abcdefghij';
      const scrubbed = scrubKey(mixedTokens);
      expect(scrubbed).not.toContain('gsk_1234567890abcdef');
      expect(scrubbed).not.toContain('xai-9876543210fedcba');
      expect(scrubbed).not.toContain('sk-abc123xyz789');
      expect(scrubbed).not.toContain('AIzaSyD1234567890abcdefghij');
    });

    it('verifies that fallback response never includes sessionCookie in answer or model', async () => {
      const privateCookie = 'super_secret_cookie_token_never_leak_this';
      const mockFetch = vi.fn().mockRejectedValue(new Error(`Failed with ${privateCookie}`));
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com',
        sessionCookie: privateCookie,
      };

      const res = await queryGeminiProxy('Verify claims', baseContext, config);
      expect(res.source).toBe('deterministic');
      expect(res.answer).not.toContain(privateCookie);
      expect(res.model).toBeUndefined();
    });
  });

  // ===========================================================================
  // SUITE 7: Deterministic Offline Reasoning Quality & Contradiction Hunting
  // ===========================================================================
  describe('Suite 7: Deterministic Offline Reasoning Quality & Contradiction Hunting', () => {
    it('detects monetary contradictions between disparate evidence items during fallback', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal('fetch', mockFetch);

      const ev1 = evidence('Contract agreement fee of INR 50,000 for development services', {
        title: 'Master Service Agreement',
      });
      const ev2 = evidence('Settlement receipt confirming total paid amount INR 12,000 in full', {
        title: 'Payment Voucher',
      });
      const clm = claim('Contract payment is INR 50,000');

      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [ev1, ev2],
        claims: [clm],
      };

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com',
        sessionCookie: 'token_money_test',
      };

      const res = await queryGeminiProxy('Check monetary contradictions and amounts', context, config);
      expect(res.source).toBe('deterministic');
      expect(res.contradictionsFound.length).toBeGreaterThan(0);

      const moneyConflict = res.contradictionsFound.find((c) => c.severity === 'HIGH' && c.title.includes('Monetary'));
      expect(moneyConflict).toBeDefined();
      expect(moneyConflict?.evidenceIds).toContain(ev1.id);
      expect(moneyConflict?.evidenceIds).toContain(ev2.id);
    });

    it('detects FAILED transaction status contradiction during fallback', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 504 });
      vi.stubGlobal('fetch', mockFetch);

      const ev = evidence('Bank transaction notification', { title: 'Wire Transfer Receipt' });
      ev.extraction!.transactionStatus = 'FAILED';

      const clm = claim('The wire transfer was completed successfully');

      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [ev],
        claims: [clm],
      };

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com',
        sessionCookie: 'token_status_test',
      };

      const res = await queryGeminiProxy('Verify payment status', context, config);
      expect(res.source).toBe('deterministic');

      const statusConflict = res.contradictionsFound.find((c) => c.severity === 'CRITICAL');
      expect(statusConflict).toBeDefined();
      expect(statusConflict?.explanation).toContain('FAILED');
    });

    it('distinguishes supported claims from unsupported claims during fallback', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new TypeError('Network dropped'));
      vi.stubGlobal('fetch', mockFetch);

      const ev = evidence('Official employment letter agreeing to monthly salary INR 80,000', {
        title: 'Employment Agreement',
      });
      const supportedClaim = claim('Employment salary is INR 80,000 monthly');
      const unsupportedClaim = claim('Employee was provided a company car on day one');

      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [ev],
        claims: [supportedClaim, unsupportedClaim],
      };

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com',
        sessionCookie: 'token_claims_test',
      };

      const res = await queryGeminiProxy('Verify claims support', context, config);
      expect(res.source).toBe('deterministic');
      expect(res.supportingEvidenceIds).toContain(ev.id);
      expect(res.answer).toContain('Corroborated Claims');
      expect(res.answer).toContain(supportedClaim.statement);
      expect(res.answer).toContain('Evidentiary Vulnerabilities (Unsupported Claims)');
      expect(res.answer).toContain(unsupportedClaim.statement);
    });

    it('handles completely empty evidence and claims without fabricating citations', async () => {
      const emptyContext: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [],
        claims: [],
      };

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com',
        sessionCookie: 'token_empty_ctx',
      };

      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
      vi.stubGlobal('fetch', mockFetch);

      const res = await queryGeminiProxy('Assess case', emptyContext, config);
      expect(res.source).toBe('deterministic');
      expect(res.supportingEvidenceIds).toEqual([]);
      expect(res.contradictionsFound).toEqual([]);
      expect(res.confidence).toBeLessThan(0.3);
      expect(res.answer).toContain('0 active evidence record(s)');
    });

    it('handles evidence items with missing or partial extraction objects', async () => {
      const evPartial = evidence('Bare text note without extraction', {
        title: 'Raw Note',
      });
      // Deliberately delete extraction
      delete (evPartial as any).extraction;

      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [evPartial],
        claims: [claim('Note was recorded')],
      };

      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal('fetch', mockFetch);

      const config: GeminiProxyConfig = {
        enabled: true,
        proxyUrl: 'https://proxy.example.com',
        sessionCookie: 'token_partial_ev',
      };

      const res = await queryGeminiProxy('Cross-examine', context, config);
      expect(res.source).toBe('deterministic');
      expect(res.answer).toBeDefined();
    });

    it('synthesizes timeline chronology when prompt asks for dates/timeline', () => {
      const ev1 = evidence('Letter dated 2026-01-15 regarding initial notice', { title: 'First Notice' });
      const ev2 = evidence('Final termination letter dated 2026-03-01', { title: 'Termination Letter' });

      const context: EvidenceContext = {
        caseId: CASE_ID,
        evidence: [ev1, ev2],
        claims: [],
      };

      const res = evaluateDeterministicProver('Analyze the timeline and dates of events', context);
      expect(res.source).toBe('deterministic');
      expect(res.answer).toContain('Timeline & Chronology Analysis');
      expect(res.answer).toContain('2026-01-15');
      expect(res.answer).toContain('2026-03-01');
    });
  });
});
