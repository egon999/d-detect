import { config } from '../env.ts';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export const MAX_VISION_BYTES = 4 * 1024 * 1024;

export const MAX_VISION_EDGE = 1600;

export type UntrustedSource = { label: string; text: string };

export type ChatRequest = {
  messages: ChatMessage[];

  json?: boolean;
  maxTokens?: number;
  temperature?: number;

  untrusted?: UntrustedSource[];

  signal?: AbortSignal;

  timeoutMs?: number;
};

export type ChatResult = {
  text: string;
  provider: ProviderName;
  model: string;
  latencyMs: number;

  truncated?: string[];
};

export type ImageRequest = {
  prompt: string;

  imageBase64: string;
  mime: string;
  json?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type TranscribeRequest = {
  signal?: AbortSignal;

  timeoutMs?: number;
};

export type ProviderName = 'groq';

export type AiFailureKind =

  | 'not-configured'

  | 'rejected-key'

  | 'rate-limited'

  | 'unavailable'

  | 'timeout'

  | 'too-large'

  | 'unreadable-answer'

  | 'refused'

  | 'aborted';

export const RETRYABLE_KINDS: ReadonlySet<AiFailureKind> = new Set<AiFailureKind>([
  'rate-limited',
  'unavailable',
  'timeout',
]);

export const FAILURE_SENTENCE: Readonly<Record<AiFailureKind, string>> = {
  'not-configured': 'Reading files is not switched on for this server yet, so this cannot be read.',
  'rejected-key': 'This server cannot reach its reading service, so this cannot be read right now.',
  'rate-limited': 'Too much is being read at the moment. This will be read again in a moment.',
  unavailable: 'The reading service could not be reached just now. Try again in a moment.',
  timeout: 'This was taking too long to read. Try again, or type in the details yourself.',
  'too-large': 'This is too large to read in one go. Try a shorter file, or the most important pages.',
  'unreadable-answer': 'This could not be read in a way we can use. Try again with a clearer copy.',
  refused: 'This could not be read as it is. Try a clearer photo or a different file.',
  aborted: 'Reading stopped before it finished. Try again when you are ready.',
};

export function sentenceFor(kind: AiFailureKind): string {
  return FAILURE_SENTENCE[kind] ?? 'This could not be read just now. Try again in a moment.';
}

export const RATE_LIMIT_WAIT_BUDGET_MS = 30_000;

export const RATE_LIMIT_BLIND_WAIT_MS = 1_500;

const KEY_SHAPES: readonly RegExp[] = [
  /\bgsk_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bxai-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,

  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /([?&](?:key|api_key|apikey|access_token)=)[^\s&"']+/gi,
];

/** Replaces anything key-shaped with `[redacted]`. Exported so a test can assert on it. */
export function redactSecrets(text: string): string {
  let safe = text;
  for (const pattern of KEY_SHAPES) safe = safe.replace(pattern, '[redacted]');
  for (const secret of [config.ai.groqKey]) {
    // Two characters would match everywhere; a real key is far longer than this.
    if (secret.length < 16) continue;
    safe = safe.split(secret).join('[redacted]');
  }
  return safe;
}

/** A message safe to log, store on a row, or put through `redactSecrets` a second time. */
function safeMessage(provider: ProviderName, text: string): string {
  return redactSecrets(`${provider}: ${text}`);
}

/**
 * A model call that failed in a way the caller can reason about.
 *
 * `kind` is the classification; `retryable` and `personMessage` are derived from it so a
 * route can branch on one of three views of the same fact without them ever disagreeing.
 * The constructor still takes an explicit `retryable` for backward compatibility, but the
 * kind wins when it is given: an error constructed as "retryable" and classified
 * `rejected-key` is a disagreement, and the classification is the one with evidence.
 */
export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly status: number | undefined;
  /** What the vendor itself said to wait, in milliseconds, when it said anything. */
  readonly retryAfterMs: number | undefined;
  readonly kind: AiFailureKind;
  readonly retryable: boolean;
  readonly personMessage: string;

  constructor(
    provider: ProviderName,
    message: string,
    retryable: boolean,
    status?: number,
    retryAfterMs?: number,
    kind: AiFailureKind = inferKind(status, message, retryable),
  ) {
    super(safeMessage(provider, message));
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.kind = kind;
    this.retryable = RETRYABLE_KINDS.has(kind);
    this.personMessage = sentenceFor(kind);
  }
}

/** The classification for an error built without one, so no throw site can omit it. */
function inferKind(status: number | undefined, message: string, retryable: boolean): AiFailureKind {
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'rejected-key';
  if (status === 408) return 'timeout';
  if (status === 413) return 'too-large';
  if (status !== undefined && status >= 500) return 'unavailable';
  if (/timed out|timeout|deadline/i.test(message)) return 'timeout';
  if (/abort/i.test(message)) return 'aborted';
  if (/no .*key configured|not configured/i.test(message)) return 'not-configured';
  return retryable ? 'unavailable' : 'refused';
}

// --------------------------------------------------------------------------------
// The wire.
// --------------------------------------------------------------------------------

/**
 * How long the vendor asked us to wait, as it asked for it.
 *
 * A rate-limited response usually carries `retry-after`, and honouring it is both faster
 * than a guess when the window is short and kinder than one when it is long.
 *
 * Reported verbatim, and that is the whole contract of this function: it says what the
 * provider said, and `retryPlanFor` in `index.ts` decides whether it is affordable. The two
 * jobs were run together once and the seam is where the bug lived. Returning `undefined` for
 * an absurd value looks like caution and is the opposite — the engine then falls back to its
 * blind 1.5-second default, so a vendor saying "wait ten minutes" was asked again a second and
 * a half later, which is how a soft rate limit becomes a hard one. Clamping instead was the
 * fix for that and bought a second bug: a demand of ten minutes came back as 30 seconds, a
 * figure the provider never named, and anything the clamp produced above the wait budget was
 * then refused anyway. A refusal must be a refusal of what the provider actually asked for,
 * so the only judgement left here is whether the header means anything at all.
 *
 * An unparseable header, a past date and a non-finite figure are all `undefined` — meaning
 * "the provider said nothing useful", which is the one case the blind default is for. A huge
 * but real figure is returned in full and refused in full.
 *
 * Exported so the drift test can assert that relationship directly instead of waiting out
 * half a minute of real time to infer it.
 */
export function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;

  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.round(ms);
}

/**
 * One deadline for one attempt.
 *
 * The caller's signal and our ceiling are merged into one controller rather than passed
 * to `fetch` as two, because `fetch` can only be given one and the two failures mean
 * different things downstream: an abort is the person's decision and is never reported as
 * a failure, while a timeout is a failure the engine may retry. `release` also removes
 * the listener, so a long-lived caller prompt does not accumulate one per attempt.
 */
function deadline(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): { signal: AbortSignal; timedOut: () => boolean; release: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const cutoff = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const forward = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    release: () => {
      clearTimeout(cutoff);
      signal?.removeEventListener('abort', forward);
    },
  };
}

/** A reply that arrived. The body is already read, so the deadline below still covers it. */
type Arrived = { ok: true; status: number; json: unknown };
type Failed = {
  ok: false;
  status: number;
  body: string;
  retryAfterMs: number | undefined;
  kind: AiFailureKind;
  note: string;
};

type Outcome = Arrived | Failed;

/**
 * Sends one request and reads its body, all inside the deadline.
 *
 * Reading the body is the part that is easy to leave outside: a large error body streamed
 * slowly will hang a call whose only ceiling was on the connection. The deadline is
 * released in a `finally` that covers both the connection and the body, because a timer
 * left armed on the failure path holds the event loop open for its full duration — which
 * is how a test run that should take seven seconds came to take a minute and a half per
 * file, and how a short-lived process came to sit idle after its work was done.
 */
async function send(
  provider: ProviderName,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  const span = deadline(timeoutMs, signal);
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: span.signal });
    } catch (cause) {
      const aborted = signal?.aborted === true || (cause as { name?: string } | null)?.name === 'AbortError';
      if (aborted) {
        const reason = signal?.reason instanceof Error ? signal.reason : null;
        if (span.timedOut() || reason === null) {
          throw new ProviderError(
            provider,
            `The request took longer than ${Math.round(timeoutMs / 1000)}s.`,
            true,
            undefined,
            undefined,
            'timeout',
          );
        }
        throw new ProviderError(provider, reason.message, false, undefined, undefined, 'aborted');
      }
      throw new ProviderError(
        provider,
        `Could not reach the service: ${cause instanceof Error ? cause.message : String(cause)}`,
        true,
        undefined,
        undefined,
        'unavailable',
      );
    }

    let body: string;
    try {
      body = await response.text();
    } catch (cause) {
      throw new ProviderError(
        provider,
        `The reply could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        true,
        response.status,
        undefined,
        'unavailable',
      );
    }

    if (!response.ok) {
      const kind = kindForStatus(response.status, body);
      return {
        ok: false,
        status: response.status,
        body,
        retryAfterMs: retryAfterMs(response),
        kind,
        note: `returned ${response.status}. ${body.slice(0, 300)}`,
      };
    }

    try {
      return { ok: true, status: response.status, json: JSON.parse(body) as unknown };
    } catch {
      // A 200 with a truncated or non-JSON body is a transport fault, not a malformed request.
      throw new ProviderError(provider, 'The reply was not readable.', true, response.status, undefined, 'unavailable');
    }
  } finally {
    span.release();
  }
}

/** A body that says the input itself is the problem, not this model. */
const TOO_LARGE_BODY = /request_too_large|context_length_exceeded|maximum context|too large|too long|exceeds the maximum/i;

function kindForStatus(status: number, body: string): AiFailureKind {
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'rejected-key';
  if (status === 408) return 'timeout';
  if (status === 413) return 'too-large';
  if (status >= 500) return 'unavailable';
  if (TOO_LARGE_BODY.test(body)) return 'too-large';
  return 'refused';
}

/**
 * Whether the next candidate model is worth asking instead.
 *
 * Only for service-side refusals and for the two ways a model id goes stale. A wrong key,
 * a rate limit and an oversized request are properties of the request, not of the model,
 * and trying the next id for those is how one 429 turned into nine requests.
 */
function tryNextModel(kind: AiFailureKind, body: string): boolean {
  if (kind === 'unavailable') return true;
  if (kind !== 'refused') return false;
  return /model_not_found|decommissioned|json_validate_failed|does not exist|has been retired/i.test(body);
}

/** The same question for an image, where "this model cannot see" is reported as a 400. */
function tryNextModelForImage(kind: AiFailureKind, body: string): boolean {
  if (tryNextModel(kind, body)) return true;
  return kind === 'refused' && /does not support|must be a string|image/i.test(body);
}

// --------------------------------------------------------------------------------
// Groq — OpenAI-compatible chat completions, plus Whisper.
// --------------------------------------------------------------------------------

const GROQ_BASE = 'https://api.groq.com/openai/v1';

/** Extensions explicitly supported by Groq's Whisper audio transcriptions endpoint. */
const GROQ_WHISPER_EXTS: Record<string, string> = {
  flac: 'flac',
  mp3: 'mp3',
  mp4: 'mp4',
  mpeg: 'mpeg',
  mpga: 'mpga',
  m4a: 'm4a',
  ogg: 'ogg',
  opus: 'opus',
  wav: 'wav',
  webm: 'webm',
  aac: 'm4a',
  '3gp': 'mp4',
  '3gpp': 'mp4',
  caf: 'wav',
};

export function groqWhisperFilename(filename: string): string {
  const parts = filename.split('.');
  const ext = (parts.length > 1 ? parts.pop() : '')?.toLowerCase() ?? '';
  const base = parts.join('.') || 'recording';
  const targetExt = GROQ_WHISPER_EXTS[ext] ?? 'm4a';
  return `${base}.${targetExt}`;
}

/** The text default first, then the smaller siblings this account has served. */
function textCandidates(): string[] {
  return [config.ai.groqTextModel, 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'].filter(
    (model, index, self) => Boolean(model) && self.indexOf(model) === index,
  );
}

/** The vision model is a separate id: the text default refuses image parts outright. */
function visionCandidates(): string[] {
  return [config.ai.groqVisionModel, 'qwen/qwen3.8-27b'].filter(
    (model, index, self) => Boolean(model) && self.indexOf(model) === index,
  );
}

/** An answer the model produced but that carries no text is a failure, not an answer. */
function answerText(payload: unknown): string {
  const choices = (payload as { choices?: Array<{ message?: { content?: string } }> } | null)?.choices;
  return choices?.[0]?.message?.content ?? '';
}

export const groq = {
  name: 'groq' as const,

  get configured(): boolean {
    return config.ai.groqKey.length > 0;
  },

  async chat(request: ChatRequest): Promise<ChatResult> {
    if (!this.configured) {
      throw new ProviderError('groq', 'No key configured for this server.', false, undefined, undefined, 'not-configured');
    }
    const startedAt = Date.now();
    let last: ProviderError | null = null;

    for (const model of textCandidates()) {
      const outcome = await send(
        'groq',
        `${GROQ_BASE}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.ai.groqKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: request.messages,
            temperature: request.temperature ?? 0.2,
            max_completion_tokens: request.maxTokens ?? 4096,
            ...(request.json ? { response_format: { type: 'json_object' } } : {}),
          }),
        },
        config.ai.timeoutMs,
        request.signal,
      );

      if (outcome.ok) {
        const text = answerText(outcome.json);
        if (text.trim()) return { text, provider: 'groq', model, latencyMs: Date.now() - startedAt };
        last = new ProviderError('groq', 'The service returned an empty answer.', true, undefined, undefined, 'unavailable');
        continue;
      }

      const error = new ProviderError('groq', outcome.note, true, outcome.status, outcome.retryAfterMs, outcome.kind);
      if (tryNextModel(outcome.kind, outcome.body)) {
        last = error;
        continue;
      }
      throw error;
    }
    throw last ?? new ProviderError('groq', 'Every model declined the request.', true, undefined, undefined, 'unavailable');
  },

  /**
   * Whisper. The only transcription path, and it is genuinely free on this tier.
   *
   * No language is passed: Whisper detects it, which is the requirement — a meeting
   * held in Hindi must come back in Hindi, not translated into English. The
   * `/translations` endpoint would do exactly the wrong thing here.
   */
  async transcribe(
    audio: Uint8Array,
    filename: string,
    options: TranscribeRequest = {},
  ): Promise<{ text: string; language: string | null }> {
    if (!this.configured) {
      throw new ProviderError('groq', 'No key configured for this server.', false, undefined, undefined, 'not-configured');
    }

    const safeName = groqWhisperFilename(filename);
    const form = new FormData();
    form.append('file', new Blob([audio]), safeName);
    form.append('model', config.ai.groqAudioModel);
    form.append('response_format', 'verbose_json');

    // An hour of audio and a four-word question do not share a ceiling. The transcription
    // default is generous on purpose: the length of a recording is not something a person
    // can change, and failing a meeting because it was long is worse than waiting.
    const outcome = await send(
      'groq',
      `${GROQ_BASE}/audio/transcriptions`,
      { method: 'POST', headers: { authorization: `Bearer ${config.ai.groqKey}` }, body: form },
      options.timeoutMs ?? config.ai.transcribeTimeoutMs,
      options.signal,
    );

    if (!outcome.ok) {
      throw new ProviderError('groq', `Transcription ${outcome.note}`, true, outcome.status, outcome.retryAfterMs, outcome.kind);
    }

    const payload = outcome.json as { text?: string; language?: string };
    return { text: payload.text ?? '', language: payload.language ?? null };
  },

  /**
   * Reads an image. The production vision path, and the only one that needs no second
   * vendor and no browser cookie.
   *
   * Groq's chat endpoint takes OpenAI-shaped multipart content, so a vision call is an
   * ordinary completion whose user message carries a `data:` URL. Only some models on
   * the key accept it — the text default refuses image parts outright — so the vision
   * model is configured separately and the candidates are tried in order.
   */
  async readImage(request: ImageRequest): Promise<ChatResult> {
    if (!this.configured) {
      throw new ProviderError('groq', 'No key configured for this server.', false, undefined, undefined, 'not-configured');
    }
    const startedAt = Date.now();
    let last: ProviderError | null = null;

    for (const model of visionCandidates()) {
      const outcome = await send(
        'groq',
        `${GROQ_BASE}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.ai.groqKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: request.prompt },
                  {
                    type: 'image_url',
                    image_url: { url: `data:${request.mime};base64,${request.imageBase64}` },
                  },
                ],
              },
            ],
            temperature: 0,
            max_completion_tokens: 4096,
            ...(request.json ? { response_format: { type: 'json_object' } } : {}),
          }),
        },
        request.timeoutMs ?? config.ai.timeoutMs,
        request.signal,
      );

      if (outcome.ok) {
        const text = answerText(outcome.json).trim();
        if (text) return { text, provider: 'groq', model, latencyMs: Date.now() - startedAt };
        last = new ProviderError('groq', 'The service returned an empty answer.', true, undefined, undefined, 'unavailable');
        continue;
      }

      const error = new ProviderError('groq', outcome.note, true, outcome.status, outcome.retryAfterMs, outcome.kind);
      if (tryNextModelForImage(outcome.kind, outcome.body)) {
        last = error;
        continue;
      }
      throw error;
    }
    throw last ?? new ProviderError('groq', 'Every vision model declined the request.', true, undefined, undefined, 'unavailable');
  },
};
