/**
 * Chat transport, Groq and xAI.
 *
 * Every AI feature in this app goes through one function — `requestGroqJson` — and this file
 * is the only place that speaks HTTP to a chat model provider. Everything above it
 * (`semantic-assistant.ts`) builds a system prompt, a user payload and a Zod schema, and
 * gets back either typed data or a typed failure. Nothing above it handles a status code,
 * a retry, or a half-parsed JSON string.
 *
 * Two providers, both OpenAI-compatible: Groq and xAI (Grok). The wire shape is the same,
 * so one transport serves both; what differs per provider — endpoint, model chain, the name
 * in the failure sentences — lives in the maps below rather than in a second client.
 * Transcription is deliberately not routed through here: Whisper exists on Groq only, and
 * `../ingestion/transcribe` keeps its own transport for that.
 *
 * ## Where the key lives, and why that is defensible
 *
 * The key is the user's own, entered in Settings, held in the device keystore by
 * `./credentials` (Android Keystore / iOS Keychain via `expo-secure-store`). It is never
 * compiled into the bundle, never written to `.env`, never sent anywhere but the chosen
 * provider's endpoint, and never included in an error message — `scrubKey` runs over
 * anything that could carry it before it is returned.
 *
 * This is not the same as embedding a key in the app. An `EXPO_PUBLIC_` key is one key,
 * the developer's, published to every installation and extractable with `unzip` and
 * `grep`. A keystore-held key is the user's own credential on the user's own device,
 * protected by the same mechanism as their saved passwords, and revocable by them. The
 * distinction matters here because the project has no server: there is no Cloud Functions
 * environment to hold a shared key in, and inventing one would mean the app cannot be
 * demonstrated without hosting.
 *
 * ## Why the app still works when there is no key
 *
 * It always does. The deterministic extractor and the rule engine are the source of truth
 * and run entirely on-device with no network at all. What this file adds is a *second*
 * reading — suggestions, marked as suggestions, in violet, which a person accepts or
 * rejects. `reason: 'unavailable'` is the expected state for a fresh install, not an error,
 * and the UI treats it as such.
 *
 * ## Failure vocabulary
 *
 * `error` is always one of the sentences defined in this file, naming the provider the
 * request was sent to. A provider's own words are never passed through: they leak request
 * contents, they occasionally contain the key, and they are written for the developer who
 * made the call rather than the person holding the phone.
 */

import type { z } from 'zod';

import { configuredProviders, loadKey, type AIProviderId } from './credentials';

/**
 * The providers this transport speaks to.
 *
 * `gemini` is excluded for the same reason `./credentials` refuses to store its key: it has
 * no client-side story. `AIProviderId` still names it, so old keys can be cleaned up.
 */
export type ChatProvider = Exclude<AIProviderId, 'gemini'>;

/**
 * The short name each provider gets in the fixed failure sentences, and in the Settings
 * copy. `AI_PROVIDER_LABELS` in `./credentials` carries the long form for menus; this is
 * the one that fits inside a sentence.
 */
export const CHAT_PROVIDER_NAMES: Record<ChatProvider, string> = {
  groq: 'Groq',
  grok: 'xAI',
};

/**
 * API base URLs. Both providers are OpenAI-compatible, so the chat endpoint is always
 * `{base}/chat/completions` and Settings can validate a key with `GET {base}/models`.
 */
export const CHAT_PROVIDER_BASE_URLS: Record<ChatProvider, string> = {
  groq: 'https://api.groq.com/openai/v1',
  grok: 'https://api.x.ai/v1',
};

/**
 * Models tried in order, best-first, for Groq.
 *
 * The chain is not load balancing. Groq retires models on its own schedule and answers a
 * request for a retired one with a 404 that mentions `model_not_found`; without a fallback,
 * the app's entire AI layer goes dark on a day nobody touched the code. Descending
 * capability also means a rate limit on the large model degrades to a smaller one that
 * answers rather than to nothing.
 *
 * Verified against https://console.groq.com/docs/models (production tier).
 */
export const GROQ_MODEL_CHAIN = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'llama-3.1-8b-instant',
] as const;

/** The model tried first. Reported in the UI when nothing has run yet. */
export const GROQ_MODEL = GROQ_MODEL_CHAIN[0];

/**
 * Models tried in order, best-first, for xAI.
 *
 * The xAI lineup changes on its own schedule — models are renamed and retired between app
 * releases — so when one 404s, the next in this chain answers instead of the AI layer going
 * dark. This constant is the single place to update when xAI's offering changes.
 */
export const GROK_MODEL_CHAIN = ['grok-4-1-fast', 'grok-4-fast-reasoning'] as const;

const MODEL_CHAINS: Record<ChatProvider, readonly string[]> = {
  groq: GROQ_MODEL_CHAIN,
  grok: GROK_MODEL_CHAIN,
};

/**
 * 45 seconds.
 *
 * Long enough for a 70B model reading a few thousand characters of a document under load;
 * short enough that a user who has been staring at a spinner gets told something. The
 * providers are usually an order of magnitude faster than this, so hitting the timeout
 * means something is actually wrong.
 */
export const REQUEST_TIMEOUT_MS = 45_000;

/** Attempts per model before moving down the chain. */
const MAX_ATTEMPTS_PER_MODEL = 2;

/** Base for exponential backoff, overridden by a `retry-after` header when one is sent. */
const BACKOFF_BASE_MS = 700;

export type AIFailureReason =
  /** No key in the keystore. The expected state on a fresh install, not an error. */
  | 'unavailable'
  /** Provider returned 429 or an explicit quota message. */
  | 'rate_limited'
  /** A reply arrived but did not satisfy the schema, after repair attempts. */
  | 'invalid_response'
  /** The request never completed — offline, DNS, captive portal, timeout. */
  | 'network'
  /** The caller asked for something this transport does not do. */
  | 'not-applicable';

/**
 * A failure.
 *
 * `error` is a human-readable sentence drawn from a fixed vocabulary defined in this
 * file — never a provider string, never an exception message, never anything derived
 * from the request. `reason` is what code should branch on.
 */
export interface AIFailure {
  ok: false;
  reason: AIFailureReason;
  error: string;
}

/** A success, carrying the provenance a stored suggestion is required to record. */
export interface AISuccess<T> {
  ok: true;
  data: T;
  /** The model that actually answered, which may be a fallback rather than the chain head. */
  model: string;
  promptVersion: string;
  durationMs: number;
}

export type AIResult<T> = AISuccess<T> | AIFailure;

/**
 * One OpenAI content part, for a multimodal user message.
 *
 * Transport capability only: the array is passed to the provider exactly as given and the
 * reply comes back through the same schema validation as any other. `image_url.url` is
 * expected to be a data URI the caller already holds; this file neither fetches nor
 * stores images.
 */
export interface ChatImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

/** The text part of a multimodal user message. */
export interface ChatTextPart {
  type: 'text';
  text: string;
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

/**
 * What a user message can be: a plain string, or OpenAI content parts when the caller
 * wants to attach an image alongside text.
 */
export type ChatUserContent = string | ReadonlyArray<ChatContentPart>;

export interface GroqJsonRequest<T> {
  /** Task framing and output contract. Comes from `./prompts`. */
  system: string;
  /**
   * The payload. Contains evidence-derived text, so it is never logged. Either a plain
   * string or OpenAI content parts (`ChatContentPart[]`) for image+text requests; the
   * value is serialised into the request untouched.
   */
  user: ChatUserContent;
  /** The contract the response must satisfy in full to be returned at all. */
  schema: z.ZodType<T>;
  /** Recorded on the result so a stored suggestion can name the instructions that produced it. */
  promptVersion: string;
  /**
   * Which provider to send to. Defaults to `'groq'`.
   *
   * Named per request rather than configured globally so a future caller can choose a
   * provider for a reason — a vision-capable model, a longer context — without a settings
   * dance, while every existing caller keeps its behaviour unchanged.
   */
  provider?: ChatProvider;
  /** Caller cancellation, e.g. the user leaving the screen. */
  signal?: AbortSignal;
  /**
   * An already-resolved key, used instead of reading the keystore.
   *
   * Only for callers that hold a key for a reason — the Settings screen validating a key
   * the user has typed but not yet saved. Everything else should omit this and let
   * `loadKey` do the lookup, so that a key entered in Settings is picked up without every
   * call site having to remember to look for it.
   */
  key?: string;
  /**
   * Test seam. Defaults to the global `fetch`. No test in this repository reaches the
   * network; they pass a stub here or spy on `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test seam for the backoff delay. Defaults to a real timer. A retry test that waited
   * out three real backoffs would add seconds to the suite for no extra coverage.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Upper bound on the reply. Defaults to 4096, which fits every schema in `./prompts`.
   * A truncated reply is invalid JSON, so this is a correctness setting, not a cost one.
   */
  maxTokens?: number;
}

/**
 * The fixed sentences for one provider. Built per request so every message names the
 * provider that was actually called — "xAI did not accept that key" is actionable, "the
 * provider did not accept that key" is a puzzle.
 */
function messagesFor(provider: ChatProvider) {
  const name = CHAT_PROVIDER_NAMES[provider];
  return {
    unavailable:
      `No ${name} key is set up yet. Add one in Settings to turn on AI suggestions — everything else works without it.`,
    rejectedKey: `${name} did not accept that key. Check it in Settings, or paste a new one from the ${name} console.`,
    rateLimited: `${name} is rate limiting this key right now. Wait a minute and try again.`,
    quota: `This ${name} key has no quota left. Check the usage limits on your ${name} account.`,
    network: `Could not reach ${name}. Check your connection and try again.`,
    timeout: `${name} took too long to answer. Try again, or try with fewer documents selected.`,
    cancelled: 'Cancelled.',
    invalid: `${name} replied with something this app could not read. Try again.`,
    refused: `${name} refused this request. Try again, or try with a shorter document.`,
  } as const;
}

type Messages = ReturnType<typeof messagesFor>;

/**
 * Removes anything key-shaped from a string before it can be shown or stored.
 *
 * Both halves matter. Splitting on the known key catches it verbatim; the pattern catches a
 * *different* key echoed back by a provider error, which the first half cannot know about.
 */
export function scrubKey(text: string, key?: string | null): string {
  const cleaned = key ? text.split(key).join('[redacted]') : text;
  return cleaned.replace(/(?:gsk_|xai-|sk-|AIza)[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

function failure(reason: AIFailureReason, error: string): AIFailure {
  return { ok: false, reason, error };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Pulls the JSON object out of a model's reply.
 *
 * JSON mode is requested, and both providers honour it, but a fallback model in the chain
 * may not, and a model under `json_object` still occasionally wraps its answer in a ```json
 * fence or prefixes a sentence. Slicing to the outermost braces recovers those cases. It is
 * not a parser and does not try to be — anything it cannot recover is reported as
 * `invalid_response` rather than guessed at.
 */
function parseJsonReply(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to recovery
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced.trim());
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

/** Outcome of one HTTP attempt, before schema validation. */
type Attempt =
  | { status: 'ok'; content: string }
  /**
   * Worth trying again with the same model.
   *
   * Carries the whole `failure` rather than a bare reason, because the attempt is the only
   * place that can tell a timeout from an unreachable host, or a rate limit from a spent
   * quota, and the sentence shown to the user differs in each case.
   */
  | { status: 'retry'; afterMs: number; failure: AIFailure }
  /** This model will not work; move down the chain. */
  | { status: 'next-model' }
  /** Nothing will work; stop. */
  | { status: 'fatal'; failure: AIFailure };

/**
 * Whether a 429 body names quota or billing exhaustion rather than a transient rate limit.
 *
 * Both arrive as the same status code, but they mean different things to the person holding
 * the phone: one says "wait a minute", the other says "this key has no credit left and
 * waiting will not help". Only the sentence shown to the user changes — the request is still
 * backed off and bounded exactly as before, because a client that ignores a 429 and retries
 * blind is how a soft limit becomes a ban. The body is read to choose the sentence and then
 * discarded; it is never returned, logged, or stored.
 *
 * A body that cannot be read at all returns `false`: an unreadable 429 is treated as an
 * ordinary rate limit, which is the safe default.
 */
async function bodyMentionsQuota(response: Response): Promise<boolean> {
  try {
    const body = await response.text();
    return /quota|billing|insufficient|credit|out of tokens|exceeded your current/i.test(body);
  } catch {
    return false;
  }
}

async function attempt(
  model: string,
  request: GroqJsonRequest<unknown>,
  key: string,
  endpoint: string,
  messages: Messages,
  fetchImpl: typeof fetch,
): Promise<Attempt> {
  // The caller's signal and the timeout are separate reasons to stop, and they need to be
  // told apart afterwards: a timeout is worth retrying and a user walking away is not.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  const onCallerAbort = () => timeoutController.abort();
  request.signal?.addEventListener('abort', onCallerAbort);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        // Temperature 0 does not make a language model deterministic, but it removes the
        // sampling variance that would otherwise let the same document produce a different
        // suggestion on each run — which, in a product about comparing records, would be
        // the app contradicting itself.
        temperature: 0,
        max_tokens: request.maxTokens ?? 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
      signal: timeoutController.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { status: 'fatal', failure: failure('unavailable', messages.rejectedKey) };
    }

    if (response.status === 429) {
      // Both providers send `retry-after` in seconds. Honouring it beats guessing, and
      // ignoring it is how a client turns a rate limit into a ban.
      const header = Number.parseFloat(response.headers.get('retry-after') ?? '');
      const afterMs = Number.isFinite(header) ? Math.min(header * 1000, 20_000) : BACKOFF_BASE_MS * 4;
      // Same status, two different situations: a transient rate limit heals on its own, a
      // spent quota does not. The backoff is identical either way; only the sentence differs.
      const spent = await bodyMentionsQuota(response);
      return {
        status: 'retry',
        afterMs,
        failure: failure('rate_limited', spent ? messages.quota : messages.rateLimited),
      };
    }

    if (response.status === 404 || response.status === 400) {
      // A decommissioned or renamed model. Nothing about this request will fix it, but the
      // next model in the chain might answer it.
      return { status: 'next-model' };
    }

    if (response.status >= 500) {
      return { status: 'retry', afterMs: BACKOFF_BASE_MS, failure: failure('network', messages.network) };
    }

    if (!response.ok) {
      return { status: 'fatal', failure: failure('invalid_response', messages.refused) };
    }

    // Read the raw text first and parse it separately. `response.json()` throws the same
    // `SyntaxError` for a body that is not JSON at all — an HTML error page from a proxy, a
    // truncated stream — as for one that is merely unexpected, and the outer catch reads any
    // throw as a transport failure. Parsing here keeps a malformed body classified as what it
    // is: a reply this app cannot read, worth one retry, not a network problem.
    const raw = await response.text();
    let body: { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return { status: 'retry', afterMs: BACKOFF_BASE_MS, failure: failure('invalid_response', messages.invalid) };
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { status: 'retry', afterMs: BACKOFF_BASE_MS, failure: failure('invalid_response', messages.invalid) };
    }
    return { status: 'ok', content };
  } catch (caught) {
    if (request.signal?.aborted) {
      return { status: 'fatal', failure: failure('network', messages.cancelled) };
    }
    // The timeout controller fires our own abort; a caller abort is handled above. Telling
    // them apart here is what lets a user who waited 45 seconds hear "took too long" rather
    // than "check your connection", which would send them to debug the wrong thing.
    if (timeoutController.signal.aborted) {
      return { status: 'retry', afterMs: BACKOFF_BASE_MS, failure: failure('network', messages.timeout) };
    }
    return { status: 'retry', afterMs: BACKOFF_BASE_MS, failure: failure('network', messages.network) };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Sends one JSON request and returns typed data or a typed failure.
 *
 * Walks the chosen provider's model chain, retrying each model up to
 * `MAX_ATTEMPTS_PER_MODEL` times on transient conditions, and validates every reply
 * against the caller's schema before returning it. A reply that does not satisfy the
 * schema is discarded, not coerced: these values end up next to a user's evidence, and a
 * half-populated object with a plausible shape is worse than an honest failure.
 *
 * The name keeps `Groq` for continuity with every existing import; the request's
 * `provider` field decides where it actually goes.
 */
export async function requestGroqJson<T>(request: GroqJsonRequest<T>): Promise<AIResult<T>> {
  if (request.promptVersion === 'legacy') {
    return failure('not-applicable', 'Legacy client prompts are deprecated and not applicable.');
  }
  const provider = request.provider ?? 'groq';
  const messages = messagesFor(provider);
  const key = request.key ?? (await loadKey(provider)) ?? null;
  if (!key) return failure('unavailable', messages.unavailable);

  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const sleep = request.sleepImpl ?? wait;
  const started = Date.now();

  const chain = MODEL_CHAINS[provider];
  let lastFailure: AIFailure = failure('network', messages.network);

  for (let modelIndex = 0; modelIndex < chain.length; modelIndex += 1) {
    const model = chain[modelIndex]!;
    // Whether the reason for leaving this model was a rate limit, which decides whether the
    // next model needs a delay before it is tried. Reset per model.
    let leftOnRateLimit = false;

    for (let tries = 0; tries < MAX_ATTEMPTS_PER_MODEL; tries += 1) {
      if (request.signal?.aborted) return failure('network', messages.cancelled);

      const outcome = await attempt(
        model,
        request as GroqJsonRequest<unknown>,
        key,
        `${CHAT_PROVIDER_BASE_URLS[provider]}/chat/completions`,
        messages,
        fetchImpl,
      );

      if (outcome.status === 'fatal') return outcome.failure;
      if (outcome.status === 'next-model') break;

      if (outcome.status === 'retry') {
        lastFailure = outcome.failure;
        leftOnRateLimit = outcome.failure.reason === 'rate_limited';
        if (tries + 1 < MAX_ATTEMPTS_PER_MODEL) await sleep(outcome.afterMs * (tries + 1));
        continue;
      }

      leftOnRateLimit = false;
      const parsed = parseJsonReply(outcome.content);
      if (parsed === null) {
        lastFailure = failure('invalid_response', messages.invalid);
        continue;
      }

      const validated = request.schema.safeParse(parsed);
      if (!validated.success) {
        lastFailure = failure('invalid_response', messages.invalid);
        continue;
      }

      return {
        ok: true,
        data: validated.data,
        model,
        promptVersion: request.promptVersion,
        durationMs: Date.now() - started,
      };
    }

    // A rate limit applies to the account, not to one model, so the next model in the chain
    // is subject to the same limit. Advancing the instant this model runs out would hammer a
    // limit that was just asked to be respected — which is how a soft limit becomes a ban.
    // Sleep once before moving on. A different-model failure still advances immediately,
    // because a schema mismatch on one model says nothing about the next.
    if (leftOnRateLimit && modelIndex + 1 < chain.length) await sleep(BACKOFF_BASE_MS * 4);
  }

  return lastFailure;
}

/**
 * Whether an AI action can be offered at all.
 *
 * True when any provider has a key stored. Only checks the keystore — it deliberately does
 * not make a network call. Screens call this on mount to decide whether to render an AI
 * affordance, and a request per screen mount would spend the user's quota on rendering
 * decisions.
 */
export async function aiAvailable(): Promise<boolean> {
  return (await configuredProviders()).length > 0;
}