/**
 * Turning an authentication failure into a sentence.
 *
 * ## Why this exists beside `describeAuthError`
 *
 * `src/services/session-provider.tsx` already maps the common Firebase codes, and it is the
 * right place for that. But its `default:` branch returns the caught error untouched, which
 * means anything outside its table reaches the screen as the SDK printed it —
 * `Firebase: Error (auth/missing-password).` is a real string that can land in an error
 * banner today. Two things follow, and they are different problems:
 *
 *   - **Completeness.** The table is missing codes a user can genuinely trigger on these
 *     forms: submitting an empty password, a malformed email, a disabled project, an
 *     expired action code, a browser that refuses storage.
 *   - **Safety.** Whatever the table does not catch must still never be shown raw. A screen
 *     that renders a provider's internal code is a screen that has stopped speaking to the
 *     person using it.
 *
 * This module closes both from the screen's side, so the fix does not depend on a file
 * another agent owns. Every error on a form in this app goes through `readableAuthError`
 * before it is rendered, and the function's contract is total: it returns a human sentence
 * for *any* input, including a bare string, a code with no message, and `undefined`.
 *
 * ## The one message that is deliberately vague
 *
 * `auth/invalid-credential` covers both "wrong password" and "no such account", and the
 * vagueness is Firebase's own Email Enumeration Protection doing its job: naming which of
 * the two it was tells an attacker which addresses are registered here. That is also why
 * `auth/user-not-found` and `auth/wrong-password` are mapped to the same sentence rather
 * than being reported accurately — they are the legacy codes, and a project old enough to
 * still emit them should get the same treatment as a new one.
 */

import { looksInternal as sharedLooksInternal } from '@ui/readable';

/** The prefixes a raw provider code arrives behind. Matched case-insensitively. */
const CODE = /auth\/([a-z0-9-]+)/i;
/**
 * Codes the session provider's table does not cover.
 *
 * Keys are the bare suffixes — `auth/` is stripped before lookup — because that is the
 * stable part of the string and the prefix has appeared as both `auth/` and `firebase/`.
 */
const SUPPLEMENTARY_CODES: Readonly<Record<string, string>> = {
  'missing-password': 'Enter your password to continue.',
  'missing-email': 'Enter your email address to continue.',
  'null-user': 'Your session expired. Sign in again to continue.',
  'internal-error': 'Something went wrong on our side. Try again in a moment.',
  'unauthorized-domain': 'Sign-in is not set up for this address. Use email and password instead.',
  'operation-not-supported-in-this-environment':
    'That sign-in method is not available here. Use email and password instead.',
  'expired-action-code': 'That link has expired. Request a new one and try again.',
  'invalid-action-code': 'That link is no longer valid. Request a new one and try again.',
  'invalid-verification-code': 'That code is not correct. Check it and try again.',
  'invalid-verification-id': 'That code has expired. Request a new one.',
  'missing-verification-code': 'Enter the code we sent you.',
  'user-mismatch': 'Those details belong to a different account. Sign in again and retry.',
  'credential-already-in-use': 'That sign-in method is already connected to another account.',
  'email-change-needs-verification': 'Confirm your email address before changing it.',
  'multi-factor-auth-required': 'This account needs a second step. Complete it and try again.',
  'second-factor-required': 'This account needs a second step. Complete it and try again.',
  'quota-exceeded': 'Too many attempts from this device. Wait a few minutes and try again.',
  'timeout': 'The request took too long. Check your connection and try again.',
  'web-storage-unsupported':
    'Your browser is blocking local storage, so sign-in cannot continue. Allow storage for this site, or turn off private browsing.',
  'web-context-cancelled': 'Sign-in was interrupted. Try again.',
  'cancelled-popup-request': 'That sign-in attempt was interrupted by another one. Try again.',
  'popup-closed-by-user': 'The sign-in window closed before it finished. Try again.',
  'blocking-function-error': 'Sign-in was stopped by a check on our side. Contact support.',
  'provider-already-linked': 'That sign-in method is already connected to this account.',
  'no-such-provider': 'That sign-in method is not connected to this account.',
  'requires-recent-login': 'Please sign in again to confirm this change.',
  'invalid-tenant-id': 'This account belongs to an organisation that could not be found.',
  'missing-tenant-id': 'This account belongs to an organisation that could not be found.',
  'unsupported-tenant-operation': 'That action is not available for this organisation.',
  'no-auth-event': 'Sign-in did not complete. Try again.',
};

/**
 * Technically-named substrings that mean "the app broke", not "you typed something wrong".
 *
 * Matched after the code table has had its turn, so a mapped code never reaches here.
 *
 * Kept local to the auth path rather than folded into `@ui/readable`: these are the markers that
 * matter on a sign-in form specifically, and the shared predicate is deliberately broader.
 */
const INTERNAL_MARKERS = ['firebase', 'firestore', 'auth/', 'undefined is not', 'null is not'];

/**
 * Whether a string is a provider's internal vocabulary rather than a sentence for a person.
 *
 * The general answer now lives in `@ui/readable`, which is where the four screens outside the
 * auth layer reach for it. This wrapper stays because the auth forms import it from here, and
 * because a bare `auth/...` code with nothing else around it has to fail this test even though
 * the shared predicate is scoped to a handful of Firebase namespaces.
 */
export function looksInternal(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0) return true;
  if (CODE.test(trimmed)) return true;
  if (sharedLooksInternal(trimmed)) return true;
  const lowered = trimmed.toLowerCase();
  return INTERNAL_MARKERS.some((marker) => lowered.includes(marker));
}

/** The sentence for a bare code, or null when this module has nothing to add for it. */
function sentenceForCode(code: string): string | null {
  const suffix = code.toLowerCase().split('/')[1] ?? '';
  return SUPPLEMENTARY_CODES[suffix] ?? null;
}

/**
 * A sentence a person can act on, for anything thrown by an authentication call.
 *
 * Order matters. A `code` property is the most reliable signal and is consulted first; a
 * message that names a known code is next, because several paths in the auth layer re-throw
 * a plain `Error` built from one; then a message that already reads as a sentence is passed
 * through unchanged, which is what keeps the session provider's own good wording intact.
 */
export function readableAuthError(caught: unknown): string {
  const code = (caught as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) {
    const mapped = sentenceForCode(code);
    // A code this module does not know is still evidence that the message is not worth
    // showing — the alternative is leaning on a table that is known to be incomplete.
    if (mapped) return mapped;
    return genericFor(caught);
  }

  const message = caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : '';
  const named = CODE.exec(message);
  if (named?.[0]) {
    const mapped = sentenceForCode(named[0]);
    if (mapped) return mapped;
  }

  if (!message.trim()) return 'That did not work. Try again in a moment.';
  if (looksInternal(message)) return genericFor(caught);
  return message;
}

/**
 * The last resort, chosen by the half-sentence the SDK left behind.
 *
 * Kept separate so the fallback is not one flat "something went wrong" for every case: a
 * failed request and a rejected password are different problems and only one of them is
 * worth retrying immediately.
 */
function genericFor(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : '';
  const lowered = raw.toLowerCase();
  if (lowered.includes('network') || lowered.includes('offline') || lowered.includes('connect')) {
    return 'No connection right now. Check your network and try again.';
  }
  if (lowered.includes('password')) return 'That password was not accepted. Check it and try again.';
  if (lowered.includes('email')) return 'That email address was not accepted. Check it and try again.';
  return 'Sign-in could not be completed. Try again in a moment.';
}
