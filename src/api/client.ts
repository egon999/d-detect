import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly payload: unknown;

  readonly timedOut: boolean;

  constructor(status: number, message: string, code: string | null, payload: unknown, timedOut = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.timedOut = timedOut;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isTransient(): boolean {
    if (this.timedOut) return false;
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }

  get isMissing(): boolean {
    return this.status === 404;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export type ApiIdentity = string | { deviceId: string } | null;

export type AuthRefresh = { forceRefresh?: boolean };
type AuthResolver = (refresh?: AuthRefresh) => Promise<ApiIdentity> | ApiIdentity;

type AuthContext = {
  headers: Record<string, string>;

  key: string;
};

let authResolver: AuthResolver | null = null;

export function configureApi(resolver: AuthResolver): void {
  authResolver = resolver;
}

const NO_CONNECTION = 'No connection. Check your internet and try again.';

const TOO_SLOW = 'This is taking longer than it should. Check your connection and try again.';

const UNREADABLE_REPLY = 'That reply could not be read. Please try again.';

const EMPTY_REPLY = 'That came back empty. Please try again.';

function fallbackBaseUrl(): string {
  if (Platform.OS === 'android') return 'http://10.0.2.2:8787';
  return 'http://localhost:8787';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '10.0.2.2', '10.0.3.2']);

export function isLocalLoopback(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

let customBaseUrl: string | null = null;
let cachedBase: string | null = null;
let lastFailoverAttempt = 0;
const FAILOVER_COOLDOWN_MS = 6000;

export const CUSTOM_API_URL_STORAGE_KEY = 'detact.custom_api_base_url';

export function setCustomApiBaseUrl(url: string | null): void {
  customBaseUrl = url ? url.trim().replace(/\/+$/, '') : null;
  cachedBase = customBaseUrl;
}

export function getCustomApiBaseUrl(): string | null {
  return customBaseUrl;
}

export async function loadPersistedCustomApiBaseUrl(): Promise<string | null> {
  try {
    const saved = await AsyncStorage.getItem(CUSTOM_API_URL_STORAGE_KEY);
    if (saved && typeof saved === 'string' && saved.trim()) {
      const clean = saved.trim().replace(/\/+$/, '');
      setCustomApiBaseUrl(clean);
      return clean;
    }
  } catch {

  }
  return null;
}

export async function persistCustomApiBaseUrl(url: string | null): Promise<void> {
  const clean = url && url.trim() ? url.trim().replace(/\/+$/, '') : null;
  setCustomApiBaseUrl(clean);
  try {
    if (clean) {
      await AsyncStorage.setItem(CUSTOM_API_URL_STORAGE_KEY, clean);
    } else {
      await AsyncStorage.removeItem(CUSTOM_API_URL_STORAGE_KEY);
    }
  } catch {

  }
}

export async function testServerConnection(url: string): Promise<{ ok: boolean; message: string }> {
  const clean = url.trim().replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${clean}/health`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.ok || res.status > 0) {
      return { ok: true, message: 'Server is reachable and responding.' };
    }
    return { ok: false, message: 'Server replied with an unexpected error.' };
  } catch {
    return { ok: false, message: 'Could not connect to server at this address.' };
  } finally {
    clearTimeout(timer);
  }
}

export function apiBaseUrl(): string {
  if (customBaseUrl) return customBaseUrl;
  if (cachedBase) return cachedBase;

  const fromEnv = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').trim();
  cachedBase = (fromEnv || fallbackBaseUrl()).replace(/\/+$/, '');
  return cachedBase;
}

let failoverPromise: Promise<boolean> | null = null;

async function attemptLoopbackFailover(): Promise<boolean> {
  const now = Date.now();
  if (now - lastFailoverAttempt < FAILOVER_COOLDOWN_MS) {
    return false;
  }
  lastFailoverAttempt = now;

  const current = apiBaseUrl();
  if (!isLocalLoopback(current)) return false;

  let port = '8787';
  let protocol = 'http:';
  try {
    const parsed = new URL(current);
    port = parsed.port || '8787';
    protocol = parsed.protocol;
  } catch {
    return false;
  }

  const candidateHosts =
    Platform.OS === 'android'
      ? ['10.0.2.2', '127.0.0.1', 'localhost', '10.0.3.2']
      : ['localhost', '127.0.0.1', '10.0.2.2', '10.0.3.2'];

  for (const host of candidateHosts) {
    const candidateBase = `${protocol}//${host}:${port}`;
    if (candidateBase === current) continue;
    try {
      const probeController = new AbortController();
      const timer = setTimeout(() => probeController.abort(), 1200);
      const res = await fetch(`${candidateBase}/health`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: probeController.signal,
      });
      clearTimeout(timer);
      if (res.ok || res.status > 0) {
        cachedBase = candidateBase;
        if (customBaseUrl && isLocalLoopback(customBaseUrl)) {
          customBaseUrl = candidateBase;
        }
        return true;
      }
    } catch {

    }
  }
  return false;
}

function identityKey(identity: ApiIdentity): string {
  if (!identity) return 'anon';
  const seen = typeof identity === 'string' ? identity : identity.deviceId;

  let hash = 0x811c9dc5;
  for (let index = 0; index < seen.length; index += 1) {
    hash ^= seen.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

async function authContext(forceRefresh = false): Promise<AuthContext> {
  if (!authResolver) return { headers: {}, key: 'anon' };
  const identity = await authResolver(forceRefresh ? { forceRefresh: true } : undefined);
  const key = identityKey(identity);
  if (!identity) return { headers: {}, key };
  if (typeof identity === 'object') return { headers: { 'x-device-id': identity.deviceId }, key };
  return { headers: { authorization: `Bearer ${identity}` }, key };
}

function buildUrl(path: string, query?: QueryInput): string {
  const base = apiBaseUrl();
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? path : `/${path}`}`;
  if (new URL(url).origin !== new URL(base).origin) {
    throw new Error('Requests must use the application server.');
  }
  if (!query) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function replyProblem(payload: unknown, status: number): string | null {
  if (status === 204) return null;
  if (payload === null) return EMPTY_REPLY;

  if (typeof payload !== 'object') return UNREADABLE_REPLY;
  if (Array.isArray(payload)) return UNREADABLE_REPLY;
  return null;
}

const DEVELOPER_TEXT =
  /(?:\bhttps?:\/\/|\bwww\.|localhost|\bHTTP\b|:\/\/|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|\bError\s*:|\bundefined\b|\bNaN\b|\{|\}|\bcharAt\b|\bstack\b|\bECONN[A-Z]|\bhost is down\b)/i;

function speaksToThePerson(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (DEVELOPER_TEXT.test(trimmed)) return false;

  if (/^[\d\s.,-]+$/.test(trimmed)) return false;
  return true;
}

function messageFrom(payload: unknown, status: number): { message: string; code: string | null } {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const message =
      (typeof record.error === 'string' && record.error) ||
      (typeof record.message === 'string' && record.message) ||
      '';
    const code = typeof record.code === 'string' ? record.code : null;
    if (message && speaksToThePerson(message)) return { message, code };
  }
  return { message: status >= 500 ? 'Something went wrong. Please try again.' : 'That request could not be completed.', code: null };
}

export type QueryValue = string | number | boolean | undefined | null;
export type QueryInput = Record<string, QueryValue>;

type RequestOptions = {
  query?: QueryInput;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;

  auth?: AuthContext;

  allowRefresh?: boolean;
};

const DEFAULT_TIMEOUT_MS = 120_000;

const READ_TIMEOUT_MS = 30_000;

const UPLOAD_FLOOR_MS = 45_000;
const UPLOAD_MS_PER_MB = 12_000;
const UPLOAD_CEILING_MS = 20 * 60_000;

export function uploadTimeoutMs(bytes: number | null): number {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return UPLOAD_CEILING_MS;
  const megabytes = Math.ceil(bytes / 1_048_576);
  return Math.min(UPLOAD_CEILING_MS, UPLOAD_FLOOR_MS + megabytes * UPLOAD_MS_PER_MB);
}

let clockOffsetMs = 0;

function noteServerClock(response: Response): void {
  const header = response.headers.get('date');
  if (!header) return;
  const serverNow = Date.parse(header);
  if (!Number.isFinite(serverNow)) return;
  const offset = serverNow - Date.now();

  clockOffsetMs = Math.abs(offset) < 60_000 ? 0 : offset;
}

export function serverNow(): number {
  return Date.now() + clockOffsetMs;
}

export function clockSkewMs(): number {
  return clockOffsetMs;
}

export function serverDate(): Date {
  return new Date(serverNow());
}

async function send<T>(method: string, path: string, options: RequestOptions): Promise<T> {
  const auth = options.auth ?? (await authContext(false));
  const headers: Record<string, string> = { accept: 'application/json', ...auth.headers };

  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    const json = JSON.stringify(options.body);

    body = json === undefined ? undefined : json;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? (method === 'GET' ? READ_TIMEOUT_MS : DEFAULT_TIMEOUT_MS));

  const callerSignal = options.signal;
  const forwardAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  const detach = () => {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', forwardAbort);
  };

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), { method, headers, body, signal: controller.signal });
  } catch (cause) {
    detach();
    const aborted = cause instanceof Error && cause.name === 'AbortError';

    if (aborted && !timedOut) throw cause;

    throw new ApiError(0, timedOut ? TOO_SLOW : NO_CONNECTION, null, cause, timedOut);
  }

  noteServerClock(response);

  let payload: unknown;
  try {
    payload = await parse(response);
  } catch (cause) {
    detach();
    throw new ApiError(0, NO_CONNECTION, null, cause);
  }
  detach();

  if (!response.ok) {
    const { message, code } = messageFrom(payload, response.status);
    throw new ApiError(response.status, message, code, payload);
  }

  const problem = replyProblem(payload, response.status);
  if (problem) throw new ApiError(0, problem, null, payload);

  return payload as T;
}

const READ_RETRY_DELAYS_MS = [400, 1_200];
const READ_RETRY_JITTER = 0.4;

function retryDelay(step: number): number {
  const base = READ_RETRY_DELAYS_MS[step];
  if (base === undefined) return Number.NaN;
  return base + Math.random() * base * READ_RETRY_JITTER;
}

const RETRYABLE_METHODS = new Set(['GET']);

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {

    if (signal?.aborted) {
      fail(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      done();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      fail(signal?.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

let refreshing: Promise<boolean> | null = null;

async function refreshIdentity(): Promise<boolean> {
  if (!authResolver) return false;
  if (!refreshing) {
    refreshing = Promise.resolve()
      .then(() => authContext(true))
      .then((fresh) => {
        const had = fresh.headers.authorization !== undefined || fresh.headers['x-device-id'] !== undefined;
        invalidateCacheForOther(fresh.key);
        return had;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

const RETRY_AUTHENTICATED = new Set(['GET', 'POST', 'PATCH', 'PUT']);

async function attempt<T>(method: string, path: string, options: RequestOptions): Promise<T> {
  for (let step = 0; ; step += 1) {
    const allowed = RETRYABLE_METHODS.has(method);
    try {
      return await send<T>(method, path, options);
    } catch (cause) {
      if (!(cause instanceof ApiError)) throw cause;

      if (cause.isAuth && options.allowRefresh !== false && RETRY_AUTHENTICATED.has(method)) {
        const refreshed = await refreshIdentity();
        if (refreshed) {
          options = { ...options, auth: undefined, allowRefresh: false };
          continue;
        }
        throw cause;
      }

      if (cause.isNetwork && isLocalLoopback(apiBaseUrl())) {
        if (!failoverPromise) {
          failoverPromise = attemptLoopbackFailover().finally(() => {
            failoverPromise = null;
          });
        }
        const switched = await failoverPromise;
        if (switched) {
          continue;
        }
      }

      const delay = retryDelay(step);
      const worthRetrying = allowed && cause.isTransient && !Number.isNaN(delay);
      if (!worthRetrying || options.signal?.aborted) throw cause;
      await wait(delay, options.signal);
    }
  }
}

const cache = new Map<string, { at: number; body: unknown; identity: string }>();

export const CACHE_FRESH_MS = 30_000;

const CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

function cacheKey(method: string, path: string, query: QueryInput | undefined, identity: string): string {
  const search = buildUrl(path, query);
  return `${identity}\u0000${method}\u0000${search}`;
}

function invalidateCacheForOther(identity: string): void {
  for (const [key, entry] of cache) {
    if (entry.identity !== identity) cache.delete(key);
  }
  for (const [key, entry] of inFlight) {

    if (entry.identity !== identity) inFlight.delete(key);
  }
}

function cacheAge(key: string, identity: string, now: number): number | null {
  const entry = cache.get(key);
  if (!entry || entry.identity !== identity) return null;
  const age = now - entry.at;
  if (age > CACHE_MAX_AGE_MS) {
    cache.delete(key);
    return null;
  }
  return age;
}

export function clearApiCache(): void {
  cache.clear();
  cachedBase = customBaseUrl;
}

export type CachedOutcome = 'fresh' | 'remembered' | 'empty';
export type Cached<T> = { body: T; outcome: CachedOutcome; at: number };

export async function fetchCached<T>(
  path: string,
  query?: QueryInput,
  signal?: AbortSignal,
): Promise<Cached<T>> {
  const auth = await authContext(false);
  const key = cacheKey('GET', path, query, auth.key);

  const remembered = () => {
    const at = cacheAge(key, auth.key, Date.now());
    if (at === null) return null;
    return { body: cache.get(key)!.body as T, outcome: 'remembered' as const, at: Date.now() - at };
  };

  const inWindow = remembered();
  if (inWindow && inWindow.at <= CACHE_FRESH_MS) return { ...inWindow, outcome: 'fresh' };

  try {
    const body = await singleFlight<T>(key, auth.key, 'GET', path, { query, signal, auth });
    cache.set(key, { at: Date.now(), body, identity: auth.key });
    return { body, outcome: 'fresh', at: Date.now() };
  } catch (cause) {

    if (cause instanceof ApiError && cause.isTransient) {
      const stale = inWindow ?? remembered();
      if (stale) return stale;
      return { body: undefined as T, outcome: 'empty', at: Date.now() };
    }
    throw cause;
  }
}

type InFlight = {
  promise: Promise<unknown>;
  identity: string;
  controller: AbortController;

  key: string;

  waiters: number;
};

const inFlight = new Map<string, InFlight>();

function AbortErrorLite(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function stake<T>(entry: InFlight, request: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let held = true;
    let finished = false;

    function onAbort() {
      release();
      reject(AbortErrorLite(signal?.reason));
    }

    function release() {
      if (!held) return;
      held = false;
      signal?.removeEventListener('abort', onAbort);
      entry.waiters -= 1;
      if (entry.waiters > 0 || finished) return;

      if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key);
      entry.controller.abort();
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    request.then(
      (value) => {
        finished = true;
        release();
        resolve(value);
      },
      (error: unknown) => {
        finished = true;
        release();
        reject(error);
      },
    );
  });
}

function singleFlight<T>(
  key: string,
  identity: string,
  method: string,
  path: string,
  options: RequestOptions,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {

    existing.waiters += 1;
    return stake(existing, existing.promise as Promise<T>, options.signal);
  }

  const controller = new AbortController();
  const entry: InFlight = { identity, controller, key, waiters: 1, promise: Promise.resolve() };
  inFlight.set(key, entry);
  const request = attempt<T>(method, path, { ...options, signal: controller.signal }).finally(() => {

    if (inFlight.get(key) === entry) inFlight.delete(key);
  });
  entry.promise = request;
  return stake(entry, request, options.signal);
}

export function apiGet<T>(
  path: string,
  query?: QueryInput,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  return deduped<T>('GET', path, { query, signal, timeoutMs });
}

export function apiPost<T>(path: string, body?: unknown, query?: QueryInput, signal?: AbortSignal): Promise<T> {
  return attempt<T>('POST', path, { body, query, signal });
}

export function apiPatch<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return attempt<T>('PATCH', path, { body, signal });
}

export function apiPut<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return attempt<T>('PUT', path, { body, signal });
}

export function apiDelete<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return attempt<T>('DELETE', path, { body, signal });
}

function deduped<T>(method: string, path: string, options: RequestOptions): Promise<T> {
  const { query, signal, timeoutMs } = options;
  return authContext(false).then((auth) => {
    const key = cacheKey(method, path, query, auth.key);
    return singleFlight<T>(key, auth.key, method, path, { query, signal, timeoutMs, auth }).then(
      (body) => {
        if (method === 'GET' && body !== undefined && body !== null) {
          cache.set(key, { at: Date.now(), body, identity: auth.key });
        }
        return body;
      },
    );
  });
}

export function apiUpload<T>(path: string, form: FormData, query?: QueryInput, bytes?: number | null): Promise<T> {
  return attempt<T>('POST', path, { body: form, query, timeoutMs: uploadTimeoutMs(bytes ?? null) });
}

export type UploadProgress = {

  sent: number;

  total: number | null;

  fraction: number | null;
};

export type TrackedUpload<T> = {

  result: Promise<T>;

  cancel: () => void;
};

export const UPLOAD_CANCELLED = 'upload_cancelled';

export function apiUploadTracked<T>(
  path: string,
  form: FormData,
  options: {
    query?: QueryInput;
    bytes?: number | null;
    onProgress?: (progress: UploadProgress) => void;
    timeoutMs?: number;
  } = {},
): TrackedUpload<T> {
  let cancelled = false;
  let settled = false;
  let refreshed = false;

  let current: XMLHttpRequest | null = null;

  let sentSoFar = 0;

  const result = new Promise<T>((resolve, reject) => {
    const fail = (error: ApiError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const sendOnce = async (): Promise<void> => {
      let headers: Record<string, string>;
      let url: string;
      try {
        headers = { accept: 'application/json', ...(await authContext(refreshed)).headers };
        url = buildUrl(path, options.query);
      } catch (cause) {
        fail(new ApiError(0, NO_CONNECTION, null, cause));
        return;
      }

      if (cancelled) {
        fail(new ApiError(0, 'Upload cancelled.', UPLOAD_CANCELLED, null));
        return;
      }

      const xhr = new XMLHttpRequest();
      current = xhr;
      xhr.open('POST', url);
      xhr.timeout = options.timeoutMs ?? uploadTimeoutMs(options.bytes ?? null);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

      if (xhr.upload) {
        xhr.upload.onprogress = (event) => {
          const total = event.lengthComputable ? event.total : (options.bytes ?? null);
          sentSoFar = event.loaded;
          options.onProgress?.({
            sent: event.loaded,
            total,

            fraction: total && total > 0 ? Math.min(0.99, event.loaded / total) : null,
          });
        };
      }

      xhr.onload = () => {
        const payload = parseText(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          const total = options.bytes ?? null;
          options.onProgress?.({ sent: total ?? sentSoFar, total, fraction: 1 });
          const problem = replyProblem(payload, xhr.status);
          if (problem) {
            fail(new ApiError(0, problem, null, payload));
            return;
          }
          succeed(payload as T);
          return;
        }

        if ((xhr.status === 401 || xhr.status === 403) && !refreshed && !cancelled) {
          refreshed = true;
          void refreshIdentity().then((ok) => {
            if (!ok) {
              const { message, code } = messageFrom(payload, xhr.status);
              fail(new ApiError(xhr.status, message, code, payload));
              return;
            }

            sentSoFar = 0;
            options.onProgress?.({ sent: 0, total: options.bytes ?? null, fraction: options.bytes ? 0 : null });
            void sendOnce();
          });
          return;
        }
        const { message, code } = messageFrom(payload, xhr.status);
        fail(new ApiError(xhr.status, message, code, payload));
      };
      xhr.onerror = () => fail(new ApiError(0, NO_CONNECTION, null, null));
      xhr.ontimeout = () => fail(new ApiError(0, 'The upload is taking too long. Check your connection and try again.', null, null, true));
      xhr.onabort = () => fail(new ApiError(0, 'Upload cancelled.', UPLOAD_CANCELLED, null));

      xhr.send(form);
    };

    void sendOnce();
  });

  return {
    result,
    cancel: () => {
      if (settled) return;
      cancelled = true;
      current?.abort();
    },
  };
}

function parseText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function fileEndpoint(fileId: string): string {
  return `${apiBaseUrl()}/api/files/${encodeURIComponent(fileId)}`;
}

export async function currentAuthHeaders(forceRefresh = false): Promise<Record<string, string>> {
  return (await authContext(forceRefresh)).headers;
}
