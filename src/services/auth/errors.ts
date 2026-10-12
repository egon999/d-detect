const GENERIC = 'Something went wrong. Please try again.';

const NO_CONNECTION = 'Check your connection and try again.';

const SENTENCES: Readonly<Record<string, string>> = {

  'auth/invalid-credential':
    'That email and password don’t match. Check both and try again, or reset your password.',
  'auth/invalid-login-credentials':
    'That email and password don’t match. Check both and try again, or reset your password.',

  'auth/wrong-password': 'That password isn’t right. Try again, or reset your password.',
  'auth/user-not-found': 'There’s no account with that email yet — create one to get started.',

  'auth/invalid-email': 'That doesn’t look like an email address. Check it and try again.',
  'auth/missing-email': 'Enter the email address for your account.',
  'auth/missing-password': 'Enter your password.',
  'auth/weak-password': 'Choose a longer password — at least six characters.',
  'auth/email-already-in-use':
    'There’s already an account with that email. Sign in instead, or reset the password.',

  'auth/user-disabled': 'This account has been turned off. Use a different email to continue.',
  'auth/requires-recent-login': 'Sign in again to confirm this change.',
  'auth/account-exists-with-different-credential':
    'That email is already in use with a different way of signing in. Sign in the way you did the first time.',
  'auth/credential-already-in-use':
    'That account is already linked to someone else here. Sign in with your email and password instead.',
  'auth/too-many-requests': 'Too many tries. Wait a minute, then try again.',

  'auth/expired-action-code': 'That link has expired. Ask for a new one and try again.',
  'auth/invalid-action-code': 'That link has already been used. Ask for a new one and try again.',

  'auth/invalid-credential-or-provider-id':
    'That Google account couldn’t be verified. Use your email and password instead.',
  'auth/popup-blocked':
    'The Google sign-in window was blocked. Allow it and try again, or use your email and password.',
  'auth/popup-closed-by-user':
    'The Google sign-in window closed before it finished. Try again, or use your email and password.',
  'auth/cancelled-popup-request':
    'The Google sign-in window closed before it finished. Try again, or use your email and password.',

  'auth/operation-not-allowed':
    'That way of signing in isn’t switched on. Use your email and password instead.',
  'auth/app-not-authorized':
    'Signing in that way isn’t working in this version of the app. Use your email and password instead.',
  'auth/unauthorized-domain':
    'Signing in that way isn’t working here. Use your email and password instead.',
  'auth/invalid-api-key':
    'Accounts aren’t working in this version of the app. Please try again later.',
  'auth/api-key-not-valid':
    'Accounts aren’t working in this version of the app. Please try again later.',

  'auth/network-request-failed': NO_CONNECTION,
  'auth/timeout': 'That took too long. Check your connection and try again.',
  'auth/internal-error': GENERIC,
  'auth/web-storage-unsupported': GENERIC,
};

export const KNOWN_AUTH_ERROR_CODES: readonly string[] = Object.keys(SENTENCES);

const TECHNICAL = [
  /[a-z-]+\/[a-z-]{3,}/i, 
  /firebase|firestore|googleapis|grpc|xhr|axios|fetch failed|networkerror/i,
  /\b(?:undefined|null|NaN)\b/,
  /\b(?:TypeError|RangeError|SyntaxError|ReferenceError|Exception|stack)\b/i,
  /[{}[\]<>]|=>|\(\)/, 
  /\bat\s+\w+\s*\(/, 
];

const SENTENCE_LIMIT = 180;

function looksTechnical(message: string): boolean {
  if (message.length > SENTENCE_LIMIT) return true;
  return TECHNICAL.some((pattern) => pattern.test(message));
}

function authCodeOf(caught: unknown): string | null {
  if (!caught || typeof caught !== 'object') return null;

  const code = (caught as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('auth/')) return code;

  const message = (caught as { message?: unknown }).message;
  if (typeof message === 'string') {
    const found = /\b(auth\/[a-z-]+)/i.exec(message);
    if (found?.[1]) return found[1].toLowerCase();
  }

  return null;
}

function isUnreachable(caught: unknown): boolean {
  if (!caught || typeof caught !== 'object') return false;
  return (caught as { status?: unknown }).status === 0;
}

export function readableAuthError(caught: unknown): string {
  const code = authCodeOf(caught);
  if (code) return SENTENCES[code] ?? GENERIC;

  if (isUnreachable(caught)) return NO_CONNECTION;

  const message =
    typeof caught === 'string'
      ? caught
      : typeof (caught as { message?: unknown } | null)?.message === 'string'
        ? ((caught as { message: string }).message)
        : '';

  const trimmed = message.trim();
  if (!trimmed || looksTechnical(trimmed)) return GENERIC;
  return trimmed;
}

export function asAuthError(caught: unknown): Error {
  return new Error(readableAuthError(caught));
}
