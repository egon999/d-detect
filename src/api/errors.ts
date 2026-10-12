import { ApiError, UPLOAD_CANCELLED } from './client';

const GENERIC = 'That did not work. Please try again.';

const SIGN_IN_AGAIN = 'Please sign in again to continue.';

export function readableError(cause: unknown, fallback?: string): string {
  if (cause instanceof ApiError) {

    if (cause.isAuth) return SIGN_IN_AGAIN;
    if (cause.message) return cause.message;
    return fallback ?? GENERIC;
  }
  return fallback ?? GENERIC;
}

export function isCancelled(cause: unknown): boolean {
  if (cause instanceof ApiError) return cause.code === UPLOAD_CANCELLED;
  return cause instanceof Error && cause.name === 'AbortError';
}

export function worthRetrying(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return false;
  if (isCancelled(cause)) return false;
  return cause.isNetwork || cause.timedOut || cause.status >= 500;
}
