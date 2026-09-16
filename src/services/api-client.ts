import { Platform } from 'react-native';

/** Same-origin or explicitly configured platform API. No provider credential exists here. */
export function apiBaseUrl(): string | null {
  const configured = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (!configured) return null;
  const url = new URL(configured);
  const local = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('The platform API address must use HTTPS, or a local development network.');
  }
  // On physical mobile devices, localhost or 127.0.0.1 resolves to the phone itself where no server runs.
  if (Platform.OS !== 'web' && process.env.NODE_ENV !== 'test' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return null;
  }
  return url.toString().replace(/\/$/, '');
}

export class PlatformApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

export async function platformAuthorization(expectedOwner?: string): Promise<string> {
  const { firebaseAuth } = await import('@data/firebase/auth');
  const auth = await firebaseAuth();
  const user = auth?.currentUser;
  if (!user || (expectedOwner !== undefined && user.uid !== expectedOwner)) {
    throw new PlatformApiError('unauthenticated', 'Sign in to access your case workspace.');
  }
  return `Bearer ${await user.getIdToken()}`;
}

export function apiFailure(status: number): PlatformApiError {
  const failures: Record<number, [string, string]> = {
    400: ['invalid-argument', 'Some case details were invalid. Review the fields and try again.'],
    401: ['unauthenticated', 'Your session has expired. Sign in again.'],
    403: ['permission-denied', 'You do not have access to this case or file.'],
    404: ['not-found', 'This case, file, or service could not be found. Refresh and try again.'],
    409: ['failed-precondition', 'The case changed or the operation is already underway. Refresh before retrying.'],
    413: ['resource-exhausted', 'This file exceeds the processing limit. Split it into smaller files.'],
    429: ['resource-exhausted', 'Too many requests. Wait a moment and try again.'],
  };
  const failure = failures[status] ?? ['unavailable', 'The platform service is unavailable. Your changes have not been confirmed.'];
  return new PlatformApiError(failure[0]!, failure[1]!);
}

export async function apiRequest(path: string, options: RequestInit = {}, expectedOwner?: string): Promise<Response> {
  const base = apiBaseUrl();
  if (!base) throw new PlatformApiError('unavailable', 'The platform service is not configured.');
  if (!path.startsWith('/api/') || path.includes('..')) throw new PlatformApiError('invalid-argument', 'Invalid platform request.');
  const authorization = await platformAuthorization(expectedOwner);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 30_000);
  try {
    const response = await fetch(`${base}${path}`, { ...options, headers: { ...options.headers, Authorization: authorization }, signal: controller.signal });
    if (!response.ok) {
      const failure = apiFailure(response.status);
      // Validation and workflow messages come from our authenticated platform, never a provider.
      // Server failures remain generic because infrastructure responses may contain private data.
      if (response.status === 400 || response.status === 409 || response.status === 413) {
        try {
          const body = await response.json() as { error?: unknown };
          if (typeof body.error === 'string' && body.error.length <= 600 && !/(?:gsk_|xai-|AIza|Bearer\s)/i.test(body.error)) {
            failure.message = body.error;
          }
        } catch { /* Non-JSON responses use the fixed safe message. */ }
      }
      throw failure;
    }
    return response;
  } catch (error) {
    if (error instanceof PlatformApiError) throw error;
    throw new PlatformApiError('unavailable', 'The platform service could not be reached. Check your connection and try again.');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function apiJson(path: string, options: RequestInit = {}, expectedOwner?: string): Promise<unknown> {
  const response = await apiRequest(path, options, expectedOwner);
  try { return await response.json(); } catch {
    throw new PlatformApiError('invalid-response', 'The platform returned unreadable data. Refresh and try again.');
  }
}
