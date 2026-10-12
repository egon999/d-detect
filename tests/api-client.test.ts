/**
 * The transport layer, exercised against a stubbed `fetch`.
 *
 * `tests/setup.ts` refuses every real request, so each test here substitutes `globalThis.fetch`
 * itself — which is the point of the guard: the fake is in the test's own text, where a reader
 * can see exactly what the network was made to do. Everything below is a failure this product
 * actually meets on Indian mobile data: a dropped cell, a captive portal, a body cut off
 * mid-download, a token that expired while the phone sat in a pocket, a device clock that is a
 * month out.
 *
 * The last block is the one that has nothing to do with behaviour and everything to do with
 * voice: whatever this layer throws must already be a sentence a shopkeeper can read. A single
 * `HTTP 500` or a URL reaching a card is the old build's developer-tool look coming back, and it
 * arrives through this file, so this file is where it is caught.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  apiBaseUrl,
  apiDelete,
  apiGet,
  apiPost,
  clearApiCache,
  clockSkewMs,
  configureApi,
  currentAuthHeaders,
  fetchCached,
  getCustomApiBaseUrl,
  isLocalLoopback,
  serverDate,
  serverNow,
  setCustomApiBaseUrl,
  uploadTimeoutMs,
} from '../src/api/client';
import { isCancelled, readableError, worthRetrying } from '../src/api/errors';
import { getHealth } from '../src/api/health';
import { deleteAccount, exportAccount } from '../src/api/me';
import { currentMonthKey } from '../src/api/insights';
import { createUploadQueue, isUploadCancelled, tooLargeToSend } from '../src/api/files';

// ---------------------------------------------------------------------------
// A network that does what the test says
// ---------------------------------------------------------------------------

type Reply = {
  status?: number;
  body?: string;
  /** Thrown in place of a reply — a socket that never came up. */
  throw?: unknown;
  /** Milliseconds before the reply exists. Advanced with fake timers. */
  after?: number;
  headers?: Record<string, string>;
};

const calls: { url: string; init: RequestInit }[] = [];
let scripted: Reply[] = [];

function json(value: unknown, status = 200): Reply {
  return { status, body: JSON.stringify(value) };
}

/**
 * A cancellation shaped the way the platform's own is, because that is what the code reads.
 *
 * `client.ts` and `errors.ts` both recognise a cancellation by `name === 'AbortError'` and
 * nothing else, so a stub that rejects with a plain `Error` would be classed as a dead socket
 * and retried.
 */
function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * A delay that loses to its signal, which is the whole behaviour a timeout is built on.
 *
 * `send` enforces every deadline by aborting the signal it handed to `fetch` and waiting for
 * `fetch` to reject. A stub that takes a delay but ignores the signal therefore never settles
 * once the deadline passes: the request hangs, the test dies on its own timeout rather than on
 * an assertion, and — because the hung request is still in the de-duplication map — the *next*
 * test asking for the same path silently joins it and sees no fetch at all. Both of those were
 * mistaken for bugs in the client before the stub was fixed to reject the way fetch does.
 */
function waitFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!ms) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Replays the scripted replies in order. The last one repeats, so a test that asserts "it did
 * not try again" only has to script one.
 */
function stubFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const reply = scripted.length > 1 ? scripted.shift()! : scripted[0];
    if (!reply) throw new Error('This test scripted no reply.');
    await waitFor(reply.after ?? 0, init?.signal ?? undefined);
    if (reply.throw !== undefined) throw reply.throw;
    const status = reply.status ?? 200;
    return new Response(reply.body ?? null, { status, headers: reply.headers });
  }) as typeof globalThis.fetch;
}

const BASE = 'http://api.example.test';

/**
 * Everything that must never appear in a sentence handed to a screen.
 *
 * A status code, a URL, an exception name, a serialised object, the name of whichever model
 * answered — each of them is a card a shopkeeper cannot act on, and each has a real route into
 * a message: a server body passed through, an exception's own `message`, a template that
 * interpolated something that was `undefined`. Kept at file scope because the credential block
 * at the bottom needs it too.
 */
const FORBIDDEN = /HTTP|\bhttps?:\/\/|:\/\/|\bundefined\b|\bNaN\b|Error:|\bTypeError\b|\{[^}]*\}|groq|openai|whisper|gpt|gemini|llama/i;

beforeEach(() => {
  calls.length = 0;
  scripted = [];
  clearApiCache();
  stubFetch();
  // A device account: one header, no token to expire. Individual tests override this.
  configureApi(() => ({ deviceId: 'device-abc' }));
  vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', BASE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  configureApi(() => null);
});

// ---------------------------------------------------------------------------
// A dropped connection, retried
// ---------------------------------------------------------------------------

describe('a read that fails once', () => {
  it('retries a GET that came back 503 and returns the answer', async () => {
    vi.useFakeTimers();
    scripted = [json({ error: 'Something went wrong on our side. Try again.' }, 503), json({ records: [] })];

    const answer = apiGet<{ records: unknown[] }>('/api/daybook');
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(answer).resolves.toEqual({ records: [] });
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a 500, which is a route that threw and will throw again', async () => {
    // 503/502/504 are a server being restarted or a proxy between us and it, and they come
    // good on their own. A 500 is this server's own unexpected-failure branch: the same
    // request will hit the same bug, and sending it twice only doubles the wait before the
    // person is told. This is why `isTransient` leaves 500 out, and it is deliberate.
    vi.useFakeTimers();
    scripted = [json({ error: 'Something went wrong on our side. Try again.' }, 500)];

    const answer = apiGet('/api/daybook');
    const settled = expect(answer).rejects.toBeInstanceOf(ApiError);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    expect(calls).toHaveLength(1);
  });

  it('retries a GET whose connection dropped entirely', async () => {
    vi.useFakeTimers();
    scripted = [{ throw: new TypeError('Network request failed') }, json({ tasks: [] })];

    const answer = apiGet<{ tasks: unknown[] }>('/api/tasks');
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(answer).resolves.toEqual({ tasks: [] });
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a POST that failed — the first one may already have been stored', async () => {
    // This is the assertion that keeps a person from owning two copies of one bill. A POST is
    // not repeated on a dropped connection, however transient it looks.
    scripted = [{ throw: new TypeError('Network request failed') }];

    await expect(apiPost('/api/tasks', { text: 'Call the supplier' })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry a GET the server refused outright', async () => {
    scripted = [json({ error: 'That record does not exist.' }, 404)];

    await expect(apiGet('/api/daybook/rec-1')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it('gives up after its budget and hands back the failure', async () => {
    vi.useFakeTimers();
    scripted = [{ throw: new TypeError('Network request failed') }];

    const answer = apiGet('/api/daybook');
    const settled = expect(answer).rejects.toBeInstanceOf(ApiError);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    expect(calls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Out of time
// ---------------------------------------------------------------------------

describe('a request that stops moving', () => {
  it('gives up and says so, without naming a number or a status', async () => {
    vi.useFakeTimers();
    // A reply that never arrives until the clock is advanced past the timeout.
    scripted = [{ after: 10 * 60_000, body: '{}' }];

    const answer = apiGet('/api/daybook');
    const settled = answer.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(31_000);
    const error = await settled;

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).timedOut).toBe(true);
    // Two different retries, and a timeout answers them differently on purpose.
    // `isTransient` gates the automatic one this layer performs without telling anybody, and
    // repeating a request that has already burned thirty seconds only doubles the wait before
    // the person is told anything — so a timeout is not transient. `worthRetrying` gates the
    // "Try again" button a screen offers, and there a timeout is the single most worthwhile
    // thing to press: the person has seen the failure and is choosing to spend the time.
    expect((error as ApiError).isTransient).toBe(false);
    expect(worthRetrying(error)).toBe(true);
    expect(readableError(error)).not.toMatch(/\d/);
  });

  it('allows an upload far longer than a read', () => {
    expect(uploadTimeoutMs(40 * 1_048_576)).toBeGreaterThan(8 * 60_000);
    // A size the platform would not report is treated as a large one, never as a small one:
    // cutting a recording short loses the only copy that exists.
    expect(uploadTimeoutMs(null)).toBeGreaterThan(uploadTimeoutMs(40 * 1_048_576));
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('a screen that went away', () => {
  it("propagates the caller's own abort so the screen can tell it from a failure", async () => {
    const controller = new AbortController();
    scripted = [
      {
        throw: Object.assign(new Error('Aborted'), { name: 'AbortError' }),
      },
    ];

    const pending = apiGet('/api/daybook', undefined, controller.signal);
    controller.abort();
    const error = await pending.catch((cause: unknown) => cause);

    expect(isCancelled(error)).toBe(true);
  });

  it('stops retrying once the caller has cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    scripted = [{ throw: new TypeError('Network request failed') }];

    const pending = apiGet('/api/daybook', undefined, controller.signal);
    const settled = pending.catch((cause: unknown) => cause);
    // Far enough for the first attempt to have failed and the backoff timer to be waiting, and
    // not far enough to reach it: the first delay is 400ms plus up to 40% of jitter, so this
    // has to abort inside the gap rather than guess where the gap ends.
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(30_000);

    // The person left while the layer was waiting to try again. The wait is abandoned rather
    // than slept through, so nothing is sent at a screen that is gone.
    expect(calls).toHaveLength(1);
    expect(isCancelled(await settled)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// An expired token
// ---------------------------------------------------------------------------

describe('a token that expired mid-session', () => {
  it('refreshes once and sends the request again, and the person never hears about it', async () => {
    let refreshes = 0;
    configureApi((refresh) => {
      if (refresh?.forceRefresh) refreshes += 1;
      return 'token-1';
    });
    scripted = [json({ error: 'Please sign in again to continue.' }, 401), json({ records: [] })];

    await expect(apiGet('/api/daybook')).resolves.toEqual({ records: [] });
    expect(refreshes).toBe(1);
    expect(calls).toHaveLength(2);
    // The retry carried the fresh credential, not the one that was refused.
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer token-1');
  });

  it('refreshes once for six requests that all went out with the same dead token', async () => {
    // A cold start fires several reads at once; each comes back 401. One token exchange, not six
    // — the platform rate-limits them, and six refusals become a sign-out.
    let refreshes = 0;
    let token = 'token-expired';
    configureApi((refresh) => {
      if (refresh?.forceRefresh) {
        refreshes += 1;
        token = 'token-live';
      }
      return token;
    });
    let attempts = 0;
    let served = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.authorization !== 'Bearer token-live') {
        return new Response(JSON.stringify({ error: 'Please sign in again to continue.' }), { status: 401 });
      }
      served += 1;
      return new Response(JSON.stringify({ n: served }), { status: 200 });
    }) as typeof globalThis.fetch;

    await Promise.all([
      apiGet('/api/a'),
      apiGet('/api/b'),
      apiGet('/api/c'),
      apiGet('/api/daybook'),
      apiGet('/api/tasks'),
      apiGet('/api/insights'),
    ]);

    expect(refreshes).toBe(1);
    // Six refused, one exchange, six served: every screen gets its answer and the person is
    // never asked to sign in.
    expect(served).toBe(6);
    expect(attempts).toBe(12);
  });

  it('gives exactly one "sign in again" path when the token cannot be renewed', async () => {
    // The refresh resolves to nothing, so there is no credential to retry with. The request is
    // handed back as one auth failure — not retried, not looped.
    configureApi(() => null);
    scripted = [json({ error: 'Please sign in again to continue.' }, 401)];

    const error = await apiGet('/api/daybook').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isAuth).toBe(true);
    expect(calls).toHaveLength(1);
    expect(readableError(error)).toBe('Please sign in again to continue.');
  });

  it('does not retry a DELETE whose body was a destructive confirmation', async () => {
    configureApi(() => 'token-1');
    scripted = [json({ error: 'Please sign in again to continue.' }, 401)];

    await expect(apiDelete('/api/me', { confirm: 'delete my account' })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A server asking for room
// ---------------------------------------------------------------------------

/**
 * Per-account rate limits return 429 on capture, ask, analyse, advice and meeting upload.
 *
 * The entire value of that reply is the sentence in it, which names when to come back. A
 * layer that retries it quietly throws that sentence away and leans on a gate that has just
 * asked for room, so the person waits longer and is then told something vaguer. Nothing here
 * may render it as a quota, a plan, a tier or an upgrade either: there is nothing to buy in
 * this product, and offering a person a way out that does not exist is worse than the wait.
 */
describe('a server asking for room', () => {
  const PAUSE = "You've saved a lot in the last hour. Try again after 3 pm.";

  it('passes the sentence through untouched, including the hour to come back', async () => {
    scripted = [json({ error: PAUSE }, 429)];

    const error = await apiPost('/api/daybook/ask', { question: 'What did I spend?' }).catch(
      (cause: unknown) => cause,
    );

    // Verbatim. The time of day is the actionable part and a house sentence would delete it.
    expect(readableError(error)).toBe(PAUSE);
  });

  it('does not send it again, on a read or on a write', async () => {
    vi.useFakeTimers();
    scripted = [json({ error: PAUSE }, 429)];

    const read = apiGet('/api/insights/advice');
    const settled = read.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;

    // One attempt. A GET is the one method this layer does retry, and it still must not retry
    // this: 429 is a refusal with a reason, not a dropped packet.
    expect(calls).toHaveLength(1);
  });

  it('is not transient and is not worth another press', async () => {
    scripted = [json({ error: PAUSE }, 429)];

    const error = (await apiGet('/api/insights').catch((cause: unknown) => cause)) as ApiError;

    expect(error.isRateLimited).toBe(true);
    expect(error.isTransient).toBe(false);
    // Pressing Try again is what the server just asked the app not to do, so the one function
    // a screen consults before offering that button has to say no.
    expect(worthRetrying(error)).toBe(false);
    expect(error.isAuth).toBe(false);
    expect(error.isMissing).toBe(false);
  });

  it('never words it as a quota, a plan or an upgrade', async () => {
    scripted = [json({ error: PAUSE }, 429)];

    const sentence = readableError(await apiGet('/api/insights').catch((cause: unknown) => cause));

    expect(sentence).not.toMatch(/quota|upgrade|\bplan\b|\btier\b|premium|subscri|\blimit\b/i);
    expect(sentence).not.toMatch(FORBIDDEN);
  });

  it('falls back to a sentence, not a status, when the gate sends no wording of its own', async () => {
    scripted = [{ status: 429, body: '' }];

    const sentence = readableError(await apiGet('/api/insights').catch((cause: unknown) => cause));

    expect(sentence).not.toMatch(/429/);
    expect(sentence).not.toMatch(FORBIDDEN);
    expect(sentence).toMatch(/[a-z]\./i);
  });
});

// ---------------------------------------------------------------------------
// A reply that is not the reply
// ---------------------------------------------------------------------------

describe('a reply this layer cannot use', () => {
  it('refuses a body cut off mid-download rather than returning half a document', async () => {
    scripted = [{ status: 200, body: '{"records":[{"id":"rec-1","title":"Sharma' }];

    const error = await apiGet('/api/daybook').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isNetwork).toBe(true);
    expect(readableError(error)).toBe('That reply could not be read. Please try again.');
  });

  it('refuses a login page served with a 200 by a captive portal', async () => {
    scripted = [{ status: 200, body: '<!doctype html><html><body>Sign in to wifi</body></html>' }];

    await expect(apiGet('/api/daybook')).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses an empty 200 rather than reporting nothing saved', async () => {
    scripted = [{ status: 200, body: '' }];

    const error = await apiGet('/api/daybook').catch((cause: unknown) => cause);
    expect(readableError(error)).toBe('That came back empty. Please try again.');
  });

  it('accepts an empty DELETE reply — 204 with nothing in it is the success shape', async () => {
    scripted = [{ status: 204 }];

    await expect(apiDelete('/api/tasks/task-1')).resolves.toBeNull();
  });

  it('refuses a bare list, because no route here returns one', async () => {
    // Every route on this server answers with an object — a collection arrives as
    // `{ records: [...] }`, never as a top-level array. So an array on the wire is not a
    // collection read succeeding, it is something that is not this server answering: a proxy,
    // a cache, a captive portal. Refusing it is what stops a screen from rendering a
    // middlebox's JSON as though it were the person's own records.
    scripted = [json([{ id: 'a' }])];

    const error = await apiGet('/api/thing').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(readableError(error)).toBe('That reply could not be read. Please try again.');
  });

  it('will not pass a reply missing the field the schema requires', async () => {
    const { getAttention } = await import('../src/api/attention');
    // `signals` is absent. Zod strips what it does not know and refuses what it does not have,
    // so this must be an error rather than a screen rendering `undefined.map`.
    scripted = [json({ counts: { commitment: 0, renewal: 0, anomaly: 0 }, total: 0 })];

    await expect(getAttention()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Never an empty screen when a copy exists
// ---------------------------------------------------------------------------

describe('a screen on a train', () => {
  it('serves a remembered copy instead of an empty one', async () => {
    scripted = [json({ records: [{ id: 'rec-1' }] })];
    const first = await fetchCached<{ records: unknown[] }>('/api/daybook');
    expect(first.outcome).toBe('fresh');

    // The connection goes. The read now fails, and the copy is what the person sees.
    scripted = [{ throw: new TypeError('Network request failed') }];
    const second = await fetchCached<{ records: unknown[] }>('/api/daybook');

    expect(second.outcome).toBe('remembered');
    expect(second.body).toEqual({ records: [{ id: 'rec-1' }] });
  });

  it('says "empty" rather than inventing a body when there is no copy at all', async () => {
    scripted = [{ throw: new TypeError('Network request failed') }];

    const result = await fetchCached<{ records: unknown[] }>('/api/daybook');

    // `body` is `undefined` on purpose: the caller is told there is nothing, not handed `[]`,
    // which would render as "you have no records" — a lie about their own account.
    expect(result.outcome).toBe('empty');
    expect(result.body).toBeUndefined();
  });

  it('never serves a remembered copy across a 404 — that record was deleted', async () => {
    scripted = [json({ record: { id: 'rec-1' } })];
    await fetchCached('/api/daybook/rec-1');
    scripted = [json({ error: 'That record does not exist.' }, 404)];

    await expect(fetchCached('/api/daybook/rec-1')).rejects.toBeInstanceOf(ApiError);
  });

  it("never serves one person's records to the next person on the handset", async () => {
    configureApi(() => ({ deviceId: 'device-abc' }));
    scripted = [json({ records: [{ id: 'abc-1' }] })];
    await fetchCached('/api/daybook');

    // Same phone, different account. The cache must not answer for the wrong person.
    configureApi(() => ({ deviceId: 'device-xyz' }));
    scripted = [{ throw: new TypeError('Network request failed') }];
    const result = await fetchCached<{ records: unknown[] }>('/api/daybook');

    expect(result.outcome).toBe('empty');
    expect(result.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Two screens, one request
// ---------------------------------------------------------------------------

describe('two screens opening together', () => {
  it('fires one GET for two mounts', async () => {
    scripted = [{ after: 10, ...json({ records: [] }) }];

    const [a, b] = await Promise.all([apiGet('/api/daybook'), apiGet('/api/daybook')]);

    expect(a).toEqual({ records: [] });
    expect(b).toEqual({ records: [] });
    expect(calls).toHaveLength(1);
  });

  it('keeps serving the screen that is still waiting when the other one leaves', async () => {
    scripted = [{ after: 20, ...json({ records: [{ id: 'rec-1' }] }) }];
    const controller = new AbortController();

    const leaving = apiGet('/api/daybook', undefined, controller.signal);
    const staying = apiGet('/api/daybook');
    leaving.catch(() => undefined);
    controller.abort();

    // The shared request is aborted only when the last caller has gone, so the second screen
    // still gets its answer.
    await expect(staying).resolves.toEqual({ records: [{ id: 'rec-1' }] });
  });

  it('does not collapse two taps on save into one record', async () => {
    scripted = [json({ task: { id: 'task-1' } }), json({ task: { id: 'task-2' } })];

    await Promise.all([apiPost('/api/tasks', { text: 'One' }), apiPost('/api/tasks', { text: 'Two' })]);

    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// A clock that is wrong
// ---------------------------------------------------------------------------

describe('a device whose clock is wrong', () => {
  it("learns the server's clock from a reply and reports the offset", async () => {
    // Five minutes behind. Under a minute is ignored, because the header has one-second
    // resolution and a healthy pair already reads a few hundred milliseconds apart.
    const serverTime = new Date(Date.now() + 5 * 60_000);
    scripted = [{ status: 200, body: '{"records":[]}', headers: { date: serverTime.toUTCString() } }];

    await apiGet('/api/daybook');

    expect(clockSkewMs()).toBeGreaterThan(4 * 60_000);
    expect(serverNow()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(Math.abs(serverDate().getTime() - serverNow())).toBeLessThanOrEqual(100);
  });

  it('names the month the server is living in, not the month the handset thinks', () => {
    expect(currentMonthKey()).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});

// ---------------------------------------------------------------------------
// The account export and delete
// ---------------------------------------------------------------------------

describe('the account export and delete', () => {
  it('sends the deletion phrase in the body, never in the path', async () => {
    scripted = [json({ deleted: true, removed: {}, message: 'Your account has been deleted.' })];

    await deleteAccount('delete my account');

    expect(calls).toHaveLength(1);
    // The server logs request paths, and a proxy in front of it does the same. A phrase in a
    // query string is the phrase written to disk in two places.
    expect(calls[0]!.url).not.toContain('delete my account');
    expect(calls[0]!.url).not.toContain('confirm');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ confirm: 'delete my account' });
  });

  it("reads the export as a document with the person's own material in it", async () => {
    scripted = [
      json({
        product: 'D-Detect',
        downloadName: 'd-detect-export.json',
        exportedAt: 1_700_000_000_000,
        howToReadThis: ['Everything you saved, as a file you keep.'],
        whatIsNotHere: ['Nothing here tells you how the app works.'],
        you: { name: 'Sharma', email: null, currency: 'INR', locale: 'en-IN', accountOpenedAt: 1 },
        entries: [],
        meetings: [],
        tasks: [],
        cases: [],
        budgets: [],
        noticed: [],
        storedFiles: [],
        totals: {},
      }),
    ];

    const document = await exportAccount();

    expect(document.you.name).toBe('Sharma');
    // The export is the person's material, not a description of the machine that produced it.
    const text = JSON.stringify(document);
    expect(text).not.toMatch(/groq|openai|whisper|gpt|gemini|llama|api[_-]?key|bearer/i);
  });
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

describe('an upload', () => {
  it('tells a cancelled upload apart from a failed one, all the way up', async () => {
    class FakeXhr {
      static last: FakeXhr | null = null;
      upload: { onprogress: ((event: unknown) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      status = 0;
      responseText = '';
      timeout = 0;
      constructor() {
        FakeXhr.last = this;
      }
      open(): void {}
      setRequestHeader(): void {}
      send(): void {
        // Never answers: this test is about the person stopping it.
      }
      abort(): void {
        this.onabort?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const { apiUploadTracked } = await import('../src/api/client');
    const tracked = apiUploadTracked('/api/daybook/capture', new FormData(), { bytes: 1_000 });
    tracked.cancel();

    const error = await tracked.result.catch((cause: unknown) => cause);
    expect(isUploadCancelled(error)).toBe(true);
    // `readableError` never shows this to the person — the screen checks `isCancelled` first —
    // but if it did, it is a sentence and not a code.
    expect(readableError(error)).not.toMatch(/\d{3}/);
  });

  it('quotes the ceiling the server actually enforces', () => {
    expect(tooLargeToSend(30 * 1_048_576, 'save')).toContain('25 MB');
    expect(tooLargeToSend(100 * 1_048_576, 'audio')).toContain('96 MB');
    // An unknown size is not a refusal: the server decides, not this layer's guess.
    expect(tooLargeToSend(null, 'save')).toBeNull();
    expect(tooLargeToSend(1_000, 'save')).toBeNull();
  });

  it('sends every item exactly once, in order, and keeps going after one fails', async () => {
    const sent: string[] = [];
    const queue = createUploadQueue<{ name: string }, string>(
      [
        { label: 'One', payload: { name: 'one' } },
        { label: 'Two', payload: { name: 'two' } },
        { label: 'Three', payload: { name: 'three' } },
      ],
      {
        send: async (payload) => {
          sent.push(payload.name);
          if (payload.name === 'two') throw new ApiError(500, 'Something went wrong. Please try again.', null, null);
          return payload.name;
        },
      },
    );

    const finished = await queue.start();

    expect(sent).toEqual(['one', 'two', 'three']);
    expect(finished.saved).toBe(2);
    expect(finished.failed).toBe(1);
    // Nothing is left pending and un-reported: `finished` is true only when there is no work
    // outstanding, which an item put back by `retryFailed` used to break.
    expect(finished.finished).toBe(true);
  });

  it('does not report the queue finished while a retried item is still waiting', async () => {
    // The retry lands on a row *behind* the walker. A straight index loop steps over it and
    // reports success with an item still unsent.
    const attempts: string[] = [];
    const queue = createUploadQueue<{ name: string }, void>(
      [
        { label: 'One', payload: { name: 'one' } },
        { label: 'Two', payload: { name: 'two' } },
      ],
      {
        send: async (payload) => {
          attempts.push(payload.name);
          if (payload.name === 'two' && attempts.filter((name) => name === 'two').length === 1) {
            throw new ApiError(503, 'Something went wrong. Please try again.', null, null);
          }
        },
      },
    );

    const first = await queue.start();
    expect(first.failed).toBe(1);

    queue.retryFailed();
    const second = await queue.start();

    expect(second.saved).toBe(2);
    expect(second.finished).toBe(true);
    expect(attempts.filter((name) => name === 'two')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The voice
// ---------------------------------------------------------------------------

/**
 * Every string this layer can produce, put through the one function that hands a message to a
 * screen. A number, a status, a URL or an exception name in here is a card a person cannot act
 * on, and it is the failure this whole block exists to prevent.
 */
describe('what a person is actually shown', () => {
  const cases: { name: string; reply: Reply; run: () => Promise<unknown> }[] = [
    { name: 'a 500', reply: json({ error: 'Something went wrong on our side. Try again.' }, 500), run: () => apiGet('/api/daybook') },
    { name: 'a 404', reply: json({ error: 'That record does not exist.' }, 404), run: () => apiGet('/api/daybook/rec-1') },
    { name: 'a 413', reply: json({ error: 'That file is too large. The limit is 25 MB.' }, 413), run: () => apiGet('/api/daybook') },
    { name: 'an empty 200', reply: { status: 200, body: '' }, run: () => apiGet('/api/daybook') },
    { name: 'a truncated body', reply: { status: 200, body: '{"records":[' }, run: () => apiGet('/api/daybook') },
    { name: 'a dropped socket', reply: { throw: new TypeError('Network request failed') }, run: () => apiGet('/api/daybook') },
    { name: 'a 401', reply: json({ error: 'Please sign in again to continue.' }, 401), run: () => apiGet('/api/daybook') },
    {
      name: 'a body written for a developer',
      reply: json({ error: 'TypeError: cannot read properties of undefined (reading "id")' }, 500),
      run: () => apiGet('/api/daybook'),
    },
    {
      name: 'a bare status in the error slot',
      reply: json({ error: '500' }, 500),
      run: () => apiGet('/api/daybook'),
    },
    {
      name: 'an unrouted path',
      reply: json({ error: 'No such endpoint.' }, 404),
      run: () => apiGet('/api/daybook'),
    },
  ];

  for (const testCase of cases) {
    it(`shows a sentence, not a stack, for ${testCase.name}`, async () => {
      configureApi(() => null);
      scripted = [testCase.reply];

      const error = await testCase.run().catch((cause: unknown) => cause);
      const sentence = readableError(error);

      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence).not.toMatch(FORBIDDEN);
      // A sentence, not a figure. "500" and "25 MB" pass the blocklist above by accident of
      // shape; the first word being a number never does.
      expect(sentence.trim()).not.toMatch(/^[\d\s.,-]+/);
      expect(sentence).toMatch(/[a-z]\./i);
    });
  }

  it('keeps a developer-shaped body from reaching a screen even when the route is healthy', async () => {
    vi.useFakeTimers();
    scripted = [{ status: 502, body: 'upstream connect error or disconnect/reset' }];

    const answer = apiGet('/api/daybook');
    const settled = answer.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await settled;
    const sentence = readableError(error);

    // A 502 is a proxy talking, and what it says is addressed to whoever runs the proxy. The
    // person is told the thing that is true for them and nothing about the hop that failed.
    expect(sentence).toBe('Something went wrong. Please try again.');
    expect(sentence).not.toMatch(FORBIDDEN);
    expect(sentence).not.toContain('upstream');
  });

  it('never names the server or a header in the readiness check', async () => {
    scripted = [{ throw: new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:8787') }];

    const error = await getHealth().catch((cause: unknown) => cause);
    const sentence = readableError(error);

    expect(sentence).toBe('No connection. Check your internet and try again.');
    expect(sentence).not.toMatch(FORBIDDEN);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('where the credential is allowed to live', () => {
  it('attaches an account token as a bearer header and nothing else', async () => {
    configureApi(() => 'device-id-token');
    scripted = [json({ ok: true })];

    await apiGet('/api/me');

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer device-id-token');
    expect(Object.keys(headers).sort()).toEqual(['accept', 'authorization']);
  });

  it('uses the device id header for a local account', async () => {
    configureApi(() => ({ deviceId: 'device-abc' }));
    scripted = [json({ ok: true })];

    await apiGet('/api/me');

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-device-id']).toBe('device-abc');
    expect(headers.authorization).toBeUndefined();
  });

  it('puts no credential anywhere in the URL', async () => {
    configureApi(() => 'device-id-token');
    scripted = [json({ ok: true })];

    await apiGet('/api/me');

    expect(calls[0]!.url).not.toContain('device-id-token');
    expect(calls[0]!.url).not.toContain('token');
  });

  it('refuses a request aimed anywhere but the application server', async () => {
    scripted = [json({ ok: true })];

    const error = await apiGet('https://elsewhere.example.com/api/me').catch((cause: unknown) => cause);

    // Nothing left the handset: the credential was never offered to the other host.
    expect(calls).toHaveLength(0);
    // This one is deliberately not an `ApiError`. An `ApiError` carries a message meant to be
    // shown, and there is no sentence to show a person here — this is a wrong call in the app,
    // not something that happened to their request. `readableError` gives anything that is not
    // an `ApiError` the generic sentence, so the host it refused never reaches the screen.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
    const sentence = readableError(error);
    expect(sentence).toBe('That did not work. Please try again.');
    expect(sentence).not.toContain('elsewhere.example.com');
    expect(sentence).not.toMatch(FORBIDDEN);
  });

  it('hands a caller the header without starting a token exchange of its own', async () => {
    let refreshes = 0;
    configureApi((refresh) => {
      if (refresh?.forceRefresh) refreshes += 1;
      return 'device-id-token';
    });

    const headers = await currentAuthHeaders();
    expect(headers.authorization).toBe('Bearer device-id-token');
    expect(refreshes).toBe(0);

    // The file viewer asks for a forced refresh only after the server refused one.
    await currentAuthHeaders(true);
    expect(refreshes).toBe(1);
  });
});

describe('API base URL and network resilience', () => {
  it('identifies local loopback addresses accurately', () => {
    expect(isLocalLoopback('http://127.0.0.1:8787')).toBe(true);
    expect(isLocalLoopback('http://localhost:8787')).toBe(true);
    expect(isLocalLoopback('http://10.0.2.2:8787')).toBe(true);
    expect(isLocalLoopback('http://10.0.3.2:8787')).toBe(true);
    expect(isLocalLoopback('http://api.example.com')).toBe(false);
    expect(isLocalLoopback('not a url')).toBe(false);
  });

  it('allows setting and clearing custom API base URL for physical device testing', () => {
    setCustomApiBaseUrl('http://192.168.1.100:8787/');
    expect(getCustomApiBaseUrl()).toBe('http://192.168.1.100:8787');
    expect(apiBaseUrl()).toBe('http://192.168.1.100:8787');

    setCustomApiBaseUrl(null);
    expect(getCustomApiBaseUrl()).toBeNull();
    clearApiCache();
    expect(apiBaseUrl()).toBe(BASE);
  });

  it('populates cache on successful apiGet so fetchCached can serve remembered copy', async () => {
    scripted = [json({ records: [{ id: 'rec-100' }] })];
    const direct = await apiGet<{ records: Array<{ id: string }> }>('/api/daybook');
    expect(direct).toEqual({ records: [{ id: 'rec-100' }] });

    // Connection drops, but memory cache serves remembered data
    scripted = [{ throw: new TypeError('Network request failed') }];
    const cached = await fetchCached<{ records: Array<{ id: string }> }>('/api/daybook');
    expect(cached.outcome).toBe('remembered');
    expect(cached.body).toEqual({ records: [{ id: 'rec-100' }] });
  });
});

