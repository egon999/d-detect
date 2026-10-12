/**
 * One place for the shape of a model reply, and one way to stand in for the provider.
 *
 * ## What this replaces
 *
 * Fourteen of the server's test files stub `globalThis.fetch` by hand. Eight of them write out the
 * same OpenAI-compatible envelope — `{ choices: [{ message: { content: JSON.stringify(answer) } }] }`
 * — from memory. That envelope is not this product's invention and nothing in `src/` guards it, so
 * the eight copies are eight chances to get it subtly wrong in the direction that still passes:
 * a reply nested one level too shallow makes the parser's error branch run, the test asserts the
 * person-facing "could not be read" sentence, and it looks like a test of a fallback rather than a
 * test of a typo. The same goes for the Whisper envelope, which is `{ text }` and not `{ choices }`.
 *
 * ## What it deliberately does not do
 *
 * It does not hide the difference between those tests. Every file that stubs `fetch` today does so
 * for a reason of its own — one routes between two hosts to prove failover, one dispatches on a
 * marker in the prompt, one counts calls to prove a budget is shared, one asserts the multipart
 * body of an audio upload. Those differences are the substance of those tests, so the answering
 * function stays in the test file and only the envelope and the bookkeeping move here.
 *
 * ## It cannot reach the provider
 *
 * The replacement `fetch` has no reference to the real one and no branch that would call it. There
 * is no "pass through" option, because `server/.env` holds a live `GROQ_API_KEY` and a passthrough
 * would be a billed call made from a test that reads as offline. `restore()` puts back whichever
 * `fetch` was installed when the double went in — under `npm test` that is the refusal from
 * `seal-network.mjs`, so forgetting to restore cannot open the network either.
 */

/** An OpenAI-compatible chat message, as the server sends it. */
type ChatMessage = { role?: string; content?: unknown };

/**
 * The argument types are read off `globalThis.fetch` rather than written as `RequestInfo` and
 * `BodyInit`. Those names are DOM globals, and this server compiles with `lib: ["ES2023"]` and
 * Node's own types, where `fetch` comes from undici and the names do not exist at all — spelling
 * them out fails the typecheck on the server while looking perfectly correct in an editor that has
 * the DOM lib loaded.
 */
type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;
type FetchBody = FetchInit['body'];
type FetchHeaders = NonNullable<FetchInit['headers']>;

/** What the double saw. `prompt` is the flattened message text, which is what most tests assert on. */
export type ModelCall = {
  url: string;
  host: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  /** The parsed JSON body, or `undefined` when the body was not JSON (an audio upload, say). */
  body: Record<string, unknown> | undefined;
  /** The raw body, for the tests that assert on a multipart upload rather than on JSON. */
  raw: FetchBody;
  /** Every message's content joined by newlines, so a test can look for a marker in one string. */
  prompt: string;
  /** The model the server asked for, when the body named one. */
  model: string | undefined;
};

/**
 * What an answering function may return. A string or a plain object is wrapped in the chat
 * envelope, which is the case eight files were writing out by hand; a `Response` is used as given,
 * for the tests that are about a status code or a malformed body.
 */
export type ModelAnswer = Response | string | Record<string, unknown> | Array<unknown>;

export type ModelDouble = {
  /** Every call, in order. */
  readonly calls: readonly ModelCall[];
  /** The flattened prompt of every call, in order. */
  readonly prompts: readonly string[];
  /** The host of every call, in order — the shape a failover test asserts on. */
  readonly hosts: readonly string[];
  /** How many calls were made. */
  readonly count: number;
  /** Puts back the `fetch` that was installed before this double. Safe to call more than once. */
  restore(): void;
};

/**
 * The chat envelope. `content` is stringified when it is not already a string, because the server
 * asks for JSON in the reply and parses the content as JSON.
 */
export function chatCompletion(content: unknown, extra: Record<string, unknown> = {}): Response {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Response.json({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    ...extra,
  });
}

/** The transcription envelope, which is `{ text }` and nothing like the chat one. */
export function transcription(text: string): Response {
  return Response.json({ text });
}

/**
 * A provider refusal with the body shape the real one sends, so the server's own error reading is
 * exercised rather than bypassed. A test that only needs "the provider said no" should use this
 * rather than inventing a status body, because the server reads `error.message` out of it.
 */
export function providerError(status: number, message: string, code?: string): Response {
  return Response.json({ error: { message, ...(code === undefined ? {} : { code }) } }, { status });
}

function headersOf(init: FetchInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (raw === undefined) return {};
  const headers = new Headers(raw as FetchHeaders);
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function parseBody(raw: FetchBody): Record<string, unknown> | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function promptOf(body: Record<string, unknown> | undefined): string {
  const messages = body?.['messages'];
  if (!Array.isArray(messages)) return '';
  // Empty pieces are dropped rather than joined. A vision call's image part contributes no text,
  // and leaving it in appends a trailing newline that makes an equality assertion on the prompt
  // fail for a reason that has nothing to do with what the test is checking.
  return messages
    .map((message: ChatMessage) => {
      const content = message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : ''))
          .filter((text) => text !== '')
          .join('\n');
      }
      return '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

function describe(input: FetchInput): { url: string; host: string; path: string } {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : ((input as Request).url ?? '');
  try {
    const parsed = new URL(url);
    return { url, host: parsed.host, path: parsed.pathname };
  } catch {
    return { url, host: '', path: url };
  }
}

/**
 * Puts `answer` in front of every `fetch` for the rest of the test and records what was asked.
 *
 * The answering function receives the call rather than the raw arguments, so a test that routes on
 * the host or looks for a marker in the prompt does not have to parse either itself. Returning a
 * string or an object means "the model replied with this", which is the common case; returning a
 * `Response` is the escape hatch for a status code or a deliberately broken body.
 */
export function installModelDouble(
  answer: (call: ModelCall) => ModelAnswer | Promise<ModelAnswer>,
): ModelDouble {
  const previous = globalThis.fetch;
  const calls: ModelCall[] = [];
  let restored = false;

  globalThis.fetch = (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const { url, host, path } = describe(input);
    const raw = init?.body;
    const body = parseBody(raw);
    const call: ModelCall = {
      url,
      host,
      path,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: headersOf(init),
      body,
      raw,
      prompt: promptOf(body),
      model: typeof body?.['model'] === 'string' ? (body['model'] as string) : undefined,
    };
    calls.push(call);
    const reply = await answer(call);
    return reply instanceof Response ? reply : chatCompletion(reply);
  }) as typeof globalThis.fetch;

  return {
    calls,
    get prompts() {
      return calls.map((call) => call.prompt);
    },
    get hosts() {
      return calls.map((call) => call.host);
    },
    get count() {
      return calls.length;
    },
    restore() {
      if (restored) return;
      restored = true;
      globalThis.fetch = previous;
    },
  };
}
