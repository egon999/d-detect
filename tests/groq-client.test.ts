import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiAmountField, aiDateField, aiProvenance, aiSuggestionRecord, aiTextField, confidenceBand, toSuggestedFields } from '../src/services/ai/provenance';
import { aiSuggestionSchema } from '../src/domain/models';
import { PROMPT_VERSION } from '../src/services/ai/prompts';
import {
  CHAT_PROVIDER_BASE_URLS,
  GROK_MODEL_CHAIN,
  GROQ_MODEL,
  GROQ_MODEL_CHAIN,
  REQUEST_TIMEOUT_MS,
  requestGroqJson,
  type ChatContentPart,
} from '../src/services/ai/groq-client';

describe('AI provenance', () => {
  const input = { evidenceId: 'evd_1', model: GROQ_MODEL, promptVersion: PROMPT_VERSION };

  it('marks every AI-derived field with AI method, model and prompt version', () => {
    const provenance = aiProvenance({ ...input, sourceQuote: 'Invoice INV-2024-018' });

    // `method: 'AI'` is what places the value last in MANUAL > DETERMINISTIC > AI, so a
    // human correction can never be overwritten by a later model run.
    expect(provenance.method).toBe('AI');
    expect(provenance.model).toBe(GROQ_MODEL);
    expect(provenance.extractionVersion).toContain(PROMPT_VERSION);
  });

  it('recomputes an amount deterministically instead of trusting the model arithmetic', () => {
    const field = aiAmountField(
      { original: '$1,240.50', currency: 'USD', role: 'billed' },
      { ...input, sourceText: 'Total due: $1,240.50 USD on 14 March 2025' },
    );

    expect(field).not.toBeNull();
    // 124050 comes from `normalizeAmount`, not from the model's own `minorUnits`.
    expect(field?.minorUnits).toBe(124_050);
    expect(field?.currency).toBe('USD');
    expect(field?.method).toBe('AI');
  });

  it('drops a value the model reported but the document does not contain', () => {
    const fabricated = aiAmountField(
      { original: '$9,999.00', currency: 'USD' },
      { ...input, sourceText: 'Total due: $1,240.50 USD' },
    );

    // The one check that catches outright fabrication rather than trusting the prompt.
    expect(fabricated).toBeNull();
  });

  it('drops a date the deterministic normalizer cannot resolve', () => {
    const vague = aiDateField({ original: 'sometime last spring' }, { ...input, sourceText: 'sometime last spring' });
    expect(vague).toBeNull();

    const real = aiDateField({ original: '14 March 2025' }, { ...input, sourceText: 'Dated 14 March 2025.' });
    expect(real?.iso).toBe('2025-03-14');
    expect(real?.method).toBe('AI');
  });

  it('normalizes an identifier so the rule engine can match it', () => {
    const field = aiTextField('INV-2024-018', { ...input, sourceText: 'Invoice Number: INV-2024-018' });

    expect(field?.normalized).toBe('INV2024018');
    expect(field?.method).toBe('AI');
  });

  it('counts what it discarded rather than dropping it silently', () => {
    const fields = toSuggestedFields(
      {
        dates: [{ original: '14 March 2025' }, { original: 'whenever' }],
        amounts: [{ original: '$1,240.50', currency: 'USD' }, { original: '$9,999.00', currency: 'USD' }],
        identifiers: [{ value: 'INV-2024-018' }],
        entities: [
          { type: 'organization', name: 'Acme Corp' },
          { type: 'person', name: 'Nobody Invented' },
        ],
      },
      { ...input, sourceText: 'Acme Corp invoice INV-2024-018 dated 14 March 2025. Total due: $1,240.50 USD.' },
    );

    expect(fields.dates).toHaveLength(1);
    expect(fields.amounts).toHaveLength(1);
    expect(fields.identifiers).toHaveLength(1);
    expect(fields.organizations).toHaveLength(1);
    expect(fields.people).toHaveLength(0);
    // Two hallucinated values plus one unparseable date.
    expect(fields.discarded).toBe(3);
    for (const field of [...fields.dates, ...fields.amounts, ...fields.identifiers, ...fields.organizations]) {
      expect(field.method).toBe('AI');
    }
  });

  it('builds a storable suggestion that is always SUGGESTED and never pre-accepted', () => {
    const record = aiSuggestionRecord({
      ownerId: 'user_test',
      caseId: 'case_test',
      evidenceId: 'evd_1',
      kind: 'FIELD_EXTRACTION',
      model: GROQ_MODEL,
      promptVersion: PROMPT_VERSION,
      summary: 'Found one amount and one date.',
      payload: { amounts: 1 },
      confidence: 0.8,
      now: 1_000,
    });

    // `status` is not a parameter of `aiSuggestionRecord`, so no code path can write a
    // model output into a case as an authoritative value.
    expect(record.status).toBe('SUGGESTED');
    expect(record.reviewedAt).toBeNull();
    expect(record.model).toBe(GROQ_MODEL);
    expect(record.promptVersion).toBe(PROMPT_VERSION);
    // Round-trips through the domain schema, so it is genuinely storable.
    expect(aiSuggestionSchema.safeParse(record).success).toBe(true);
  });

  it('clamps a confidence the model reported out of range', () => {
    const base = {
      ownerId: 'user_test',
      caseId: 'case_test',
      evidenceId: null,
      kind: 'RELATIONSHIP' as const,
      model: GROQ_MODEL,
      promptVersion: PROMPT_VERSION,
      summary: 'x',
      payload: {},
    };

    expect(aiSuggestionRecord({ ...base, confidence: 4.2 }).confidence).toBe(1);
    expect(aiSuggestionRecord({ ...base, confidence: -1 }).confidence).toBe(0);
    // A model that reported no confidence is stored as having reported none. An earlier
    // version substituted 0.5, which put a number on screen no model had produced.
    expect(aiSuggestionRecord(base).confidence).toBeNull();
    expect(aiSuggestionRecord({ ...base, confidence: Number.NaN }).confidence).toBeNull();
  });

  it('maps a self-reported confidence to a band, never to a percentage', () => {
    // Deterministic equality is the only thing that earns EXACT_MATCH. No amount of model
    // confidence does — see the note on `confidenceBand`.
    expect(confidenceBand(1)).toBe('STRONG_MATCH');
    expect(confidenceBand(0.85)).toBe('STRONG_MATCH');
    expect(confidenceBand(0.7)).toBe('SUGGESTED_MATCH');
    expect(confidenceBand(0.6)).toBe('SUGGESTED_MATCH');
    expect(confidenceBand(0.59)).toBe('NEEDS_REVIEW');
    // Nothing reported and low confidence collapse to the same band: a person must look.
    expect(confidenceBand(null)).toBe('NEEDS_REVIEW');
    expect(confidenceBand(Number.NaN)).toBe('NEEDS_REVIEW');
  });
});


// ---------------------------------------------------------------------------
// Chat transport
//
// Every test injects `fetchImpl` (and `sleepImpl` where a retry would otherwise wait), so
// nothing reaches the network and no keystore is involved: the `key` seam supplies the
// credential directly. What matters here is the routing decision — which endpoint, which
// model chain — and the two behaviours every caller depends on: the structured no-key
// outcome, and content parts for image+text requests passing through untouched.
// ---------------------------------------------------------------------------

/** One recorded call to a fetch double: the URL and the request init. */
type FetchCall = [url: unknown, init?: RequestInit];

/** The half of the serialised body these tests make assertions against. */
interface SentChatBody {
  model?: string;
  temperature?: number;
  response_format?: { type?: string };
  messages?: Array<{ role?: string; content?: unknown }>;
}

const sentBody = (call: FetchCall): SentChatBody => JSON.parse(String(call[1]?.body)) as SentChatBody;

/** A fetch double that always answers with one well-formed chat completion. */
function chatFetch(): { mock: ReturnType<typeof vi.fn>; impl: typeof fetch } {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  return { mock, impl: mock as unknown as typeof fetch };
}

describe('chat transport routing', () => {
  const schema = z.object({ ok: z.boolean() });

  it('sends a request with no provider to Groq, first model in the Groq chain', async () => {
    const { mock, impl } = chatFetch();
    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema,
      promptVersion: 'routing-v1',
      key: `gsk_${'k'.repeat(24)}`,
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    const call = mock.mock.calls[0] as FetchCall;
    expect(call[0]).toBe(`${CHAT_PROVIDER_BASE_URLS.groq}/chat/completions`);
    expect(sentBody(call).model).toBe(GROQ_MODEL_CHAIN[0]);
  });

  it('sends an xAI request to the xAI endpoint with the xAI model chain', async () => {
    const { mock, impl } = chatFetch();
    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema,
      promptVersion: 'routing-v1',
      provider: 'grok',
      key: `xai-${'k'.repeat(24)}`,
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    const call = mock.mock.calls[0] as FetchCall;
    expect(call[0]).toBe(`${CHAT_PROVIDER_BASE_URLS.grok}/chat/completions`);
    expect(sentBody(call).model).toBe(GROK_MODEL_CHAIN[0]);
  });

  it('falls down the xAI chain when the first model is retired', async () => {
    const replies = [
      new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }),
      new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    const mock = vi.fn(async () => replies.shift());
    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema,
      promptVersion: 'routing-v1',
      provider: 'grok',
      key: `xai-${'k'.repeat(24)}`,
      fetchImpl: mock as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe(GROK_MODEL_CHAIN[1]);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('keeps the shared request shape on both providers: JSON mode, temperature 0, bearer key', async () => {
    for (const provider of ['groq', 'grok'] as const) {
      const { mock, impl } = chatFetch();
      await requestGroqJson({
        system: 'Reply with JSON.',
        user: 'ping',
        schema,
        promptVersion: 'routing-v1',
        provider,
        key: `${provider === 'groq' ? 'gsk' : 'xai-'}${'k'.repeat(24)}`,
        fetchImpl: impl,
      });

      const call = mock.mock.calls[0] as FetchCall;
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer (gsk|xai-)/);
      expect(sentBody(call).temperature).toBe(0);
      expect(sentBody(call).response_format).toEqual({ type: 'json_object' });
    }
  });
});

describe('chat transport without a key', () => {
  it('returns the structured unconfigured outcome and touches no network', async () => {
    const fetchImpl = vi.fn();
    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema: z.object({ ok: z.boolean() }),
      promptVersion: 'routing-v1',
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names the provider the missing key belongs to', async () => {
    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema: z.object({ ok: z.boolean() }),
      promptVersion: 'routing-v1',
      provider: 'grok',
      fetchImpl: vi.fn(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
    expect(result.error).toContain('xAI');
  });
});

describe('chat transport vision passthrough', () => {
  it('passes OpenAI content parts through to the provider untouched', async () => {
    const { mock, impl } = chatFetch();
    const parts: ChatContentPart[] = [
      { type: 'text', text: 'What does this receipt show?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
    ];

    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: parts,
      schema: z.object({ ok: z.boolean() }),
      promptVersion: 'vision-v1',
      key: `gsk_${'k'.repeat(24)}`,
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    const call = mock.mock.calls[0] as FetchCall;
    expect(sentBody(call).messages?.[1]?.role).toBe('user');
    expect(sentBody(call).messages?.[1]?.content).toEqual(parts);
  });

  it('sends a plain string user message as the string, not wrapped in parts', async () => {
    const { mock, impl } = chatFetch();

    await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'plain text',
      schema: z.object({ ok: z.boolean() }),
      promptVersion: 'vision-v1',
      key: `gsk_${'k'.repeat(24)}`,
      fetchImpl: impl,
    });

    const call = mock.mock.calls[0] as FetchCall;
    expect(sentBody(call).messages?.[1]?.content).toBe('plain text');
  });
});

// ---------------------------------------------------------------------------
// Transport failure handling
//
// These cover the conditions a provider actually produces in the field — a rate limit, a
// spent quota, an HTML error page from a proxy, a stalled connection, a rejected key — and
// the two things that must hold for each: the request is not retried in a way that makes the
// situation worse, and the sentence the user reads describes what actually happened. A wrong
// sentence here sends someone to check their wifi when their billing has lapsed.
// ---------------------------------------------------------------------------

const OK_BODY = JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] });
const okSchema = z.object({ ok: z.boolean() });
const groqKey = `gsk_${'k'.repeat(24)}`;

describe('chat transport backoff', () => {
  it('waits before moving to the next model after a rate limit, instead of hammering the same key', async () => {
    // A rate limit is imposed on the account, not on the model, so the next model down the
    // chain is behind the same limit. Advancing to it instantly is what turns a soft limit
    // into a ban — the order of events below is the actual fix.
    const events: string[] = [];
    const replies = [
      new Response('{}', { status: 429, headers: { 'retry-after': '1' } }),
      new Response('{}', { status: 429, headers: { 'retry-after': '1' } }),
      new Response(OK_BODY, { status: 200 }),
    ];
    const fetchImpl = vi.fn(async () => {
      events.push('fetch');
      return replies.shift();
    });

    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema: okSchema,
      promptVersion: 'backoff-v1',
      key: groqKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => {
        events.push('sleep');
      },
    });

    expect(result.ok).toBe(true);
    // The middle `sleep` is the one that was missing: without it the trace reads
    // fetch,sleep,fetch,fetch and the second model is called the instant the first gives up.
    expect(events).toEqual(['fetch', 'sleep', 'fetch', 'sleep', 'fetch']);
  });

  it('honours a retry-after header rather than guessing a delay', async () => {
    const waits: number[] = [];
    const replies = [
      new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
      new Response(OK_BODY, { status: 200 }),
    ];

    await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema: okSchema,
      promptVersion: 'backoff-v1',
      key: groqKey,
      fetchImpl: (async () => replies.shift()) as unknown as typeof fetch,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits[0]).toBe(2000);
  });
});

describe('chat transport failure messages', () => {
  it('tells a user with no quota left that it is their quota, not their connection', async () => {
    // Both arrive as 429. Only the body distinguishes them, and the difference is the whole
    // message: "wait a minute" is wrong advice for a key whose billing has lapsed.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'You exceeded your current quota. Check your plan.' } }), {
          status: 429,
        }),
    );

    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema: okSchema,
      promptVersion: 'quota-v1',
      key: groqKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('rate_limited');
    expect(result.error).toMatch(/no quota left/i);
    // Still backed off and still bounded: a 429 is never retried blind.
    expect(fetchImpl).toHaveBeenCalledTimes(GROQ_MODEL_CHAIN.length * 2);
  });

  it('reports a non-JSON body as an unreadable reply, not as a network failure', async () => {
    // A proxy or captive portal answers 200 with an HTML page. Calling that "check your
    // connection" sends the user to debug a connection that is working.
    const fetchImpl = vi.fn(
      async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 200 }),
    );

    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema: okSchema,
      promptVersion: 'badbody-v1',
      key: groqKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_response');
    expect(result.error).toMatch(/could not read/i);
  });

  it('says a request timed out rather than blaming the connection', async () => {
    // The transport aborts with its own controller at REQUEST_TIMEOUT_MS. A request that
    // stalls is a different situation from an unreachable host and gets its own sentence.
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        }),
    );

    vi.useFakeTimers();
    try {
      const pending = requestGroqJson({
        system: 'Reply with JSON.',
        user: 'ping',
        schema: okSchema,
        promptVersion: 'timeout-v1',
        key: groqKey,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: async () => undefined,
      });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * GROQ_MODEL_CHAIN.length * 2 + 1000);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/took too long/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a rejected key, and never echoes the key back', async () => {
    // 401 is a decision, not a transient condition. Retrying it spends the user's time and,
    // on some providers, counts against the very limit that locked them out.
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: `Invalid API key: ${groqKey}` }), { status: 401 }),
    );

    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema: okSchema,
      promptVersion: 'auth-v1',
      key: groqKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The provider echoed the key in its body. Nothing carrying it may reach the user.
    expect(result.error).not.toContain(groqKey);
    expect(result.error).not.toMatch(/gsk_/);
  });

  it('discards a well-formed reply that does not satisfy the caller schema', async () => {
    // A half-populated object with a plausible shape next to someone's evidence is worse
    // than an honest failure, so a schema miss is never coerced into a partial result.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":"yes"}' } }] }), { status: 200 }),
    );

    const result = await requestGroqJson({
      system: 'Reply with JSON.',
      user: 'ping',
      schema: okSchema,
      promptVersion: 'schema-v1',
      key: groqKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_response');
  });
});