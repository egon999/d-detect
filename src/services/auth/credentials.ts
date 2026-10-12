export type AccountMode = 'signIn' | 'signUp';

export const MIN_PASSWORD_LENGTH = 6;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function problemWithEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return 'Enter the email address for your account.';
  if (!EMAIL_PATTERN.test(trimmed)) return 'That doesn’t look like an email address.';
  return null;
}

export function problemWithPassword(password: string, mode: AccountMode): string | null {
  if (!password) return 'Enter your password.';
  if (mode === 'signUp' && password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function problemWithName(name: string, mode: AccountMode): string | null {
  if (mode !== 'signUp') return null;
  return name.trim() ? null : 'Enter the name to show on your account.';
}

export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export interface SubmitCheck {
  mode: AccountMode;

  name: string;
  email: string;
  password: string;
}

export function whySubmitBlocked({ mode, name, email, password }: SubmitCheck): string | null {
  const missing: string[] = [];
  if (mode === 'signUp' && !name.trim()) missing.push('your name');
  if (!email.trim()) missing.push('your email');
  if (!password) missing.push(mode === 'signUp' ? 'a password' : 'your password');

  if (missing.length > 0) return `Add ${joinWords(missing)} to continue.`;

  return (
    problemWithName(name, mode) ??
    problemWithEmail(email) ??
    problemWithPassword(password, mode)
  );
}
