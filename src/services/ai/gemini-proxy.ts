/**
 * Personal Gemini Session/Cookie Proxy Engine.
 *
 * Provides personal Gemini proxy support eliminating API credit consumption.
 * Supports personal session cookies and custom proxy URLs with seamless, silent
 * fallback to deterministic rule reasoning if the session expires or connection drops.
 */

import { scrubKey } from './groq-client';
import type { GeminiProxyConfig } from './credentials';
import {
  evaluateDeterministicProver,
  type ContradictionSummary,
  type EvidenceContext,
  type ProverResponse,
} from './evidence-prover';

export type { GeminiProxyConfig };
export type { ContradictionSummary, EvidenceContext, ProverResponse };

/**
 * Executes a query against the personal Gemini session proxy.
 * If the session cookie is expired, the network drops, or the proxy endpoint fails,
 * this function silently and seamlessly falls back to deterministic rule reasoning.
 * Never throws unhandled exceptions or leaks raw credential tokens.
 */
export async function queryGeminiProxy(
  prompt: string,
  context: EvidenceContext,
  config: GeminiProxyConfig,
): Promise<ProverResponse> {
  // If proxy is not enabled or lacks both URL and session cookie, fall back immediately
  if (!config.enabled || (!config.proxyUrl && !config.sessionCookie)) {
    return evaluateDeterministicProver(prompt, context);
  }

  const endpoint = config.proxyUrl?.trim() || 'https://proxy.example.com/v1/chat';

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (config.sessionCookie) {
      headers['Cookie'] = `__Secure-1PSID=${config.sessionCookie}`;
      headers['Authorization'] = `Bearer ${config.sessionCookie}`;
    }

    const payload = {
      prompt,
      context: {
        caseId: context.caseId,
        evidence: (context.evidence || []).map((e) => ({
          id: e.id,
          title: e.title,
          sourceText: e.extraction?.sourceText || e.note,
          dates: e.extraction?.dates,
          amounts: e.extraction?.amounts,
          parties: e.extraction?.parties,
        })),
        claims: (context.claims || []).map((c) => ({
          id: c.id,
          statement: c.statement,
        })),
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12_000);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    // If session expired (401/403), rate limited (429), or server error (500+), fall back silently
    if (!response.ok) {
      return evaluateDeterministicProver(prompt, context);
    }

    const json = await response.json();
    if (!json || typeof json !== 'object') {
      return evaluateDeterministicProver(prompt, context);
    }

    return {
      answer: typeof json.answer === 'string' ? json.answer : 'Analysis completed via session proxy.',
      supportingEvidenceIds: Array.isArray(json.supportingEvidenceIds) ? json.supportingEvidenceIds : [],
      contradictionsFound: Array.isArray(json.contradictionsFound) ? json.contradictionsFound : [],
      confidence: typeof json.confidence === 'number' ? json.confidence : 0.9,
      source: 'proxy',
      model: typeof json.model === 'string' ? json.model : 'gemini-session-proxy',
    };
  } catch (err) {
    // Non-throwing silent fallback on network errors, aborts, timeouts, or parse failures.
    // Ensure any internal log/message is scrubbed of credentials.
    if (config.sessionCookie) {
      scrubKey(String(err), config.sessionCookie);
    }
    return evaluateDeterministicProver(prompt, context);
  }
}

/**
 * Universal query entry point for the Evidence Prover Assistant.
 * Routes through personal proxy if configured and active, falling back to deterministic rules.
 */
export async function queryEvidenceProver(
  prompt: string,
  context: EvidenceContext,
  proxyConfig?: GeminiProxyConfig,
): Promise<ProverResponse> {
  if (proxyConfig?.enabled && (proxyConfig.proxyUrl || proxyConfig.sessionCookie)) {
    return queryGeminiProxy(prompt, context, proxyConfig);
  }
  return evaluateDeterministicProver(prompt, context);
}
