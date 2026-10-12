export interface AccountSource {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
  metadata: { creationTime?: string };
  providerData: ReadonlyArray<{
    providerId: string;
    displayName: string | null;
    photoURL: string | null;
  }>;
}

const INVENTED_NAMES: readonly string[] = ['local user', 'account', 'user', 'local'];

const INVENTED_EMAILS: readonly string[] = ['local@device'];

export function personalName(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  return INVENTED_NAMES.includes(trimmed.toLowerCase()) ? '' : trimmed;
}

export function personalEmail(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || !trimmed.includes('@')) return '';
  return INVENTED_EMAILS.includes(trimmed.toLowerCase()) ? '' : trimmed;
}

export const UNNAMED_LABEL = 'You';

export function accountLabel(name: string | null | undefined): string {
  return personalName(name) || UNNAMED_LABEL;
}

export function greetingName(name: string | null | undefined): string | null {
  const first = personalName(name).split(/\s+/)[0];
  return first ? first : null;
}

export function hasPersonalName(name: string | null | undefined): boolean {
  return personalName(name).length > 0;
}

export function sessionAccount(account: AccountSource) {
  const provider = account.providerData.find((item) => item.providerId === 'google.com');
  const createdAt = account.metadata.creationTime ? Date.parse(account.metadata.creationTime) : NaN;
  const email = personalEmail(account.email);
  return {
    id: account.uid,
    email,
    displayName:
      personalName(account.displayName) ||
      personalName(provider?.displayName) ||
      personalName(email.split('@')[0]),
    photoURL: account.photoURL || provider?.photoURL || undefined,
    providerIds: [...new Set(account.providerData.map((item) => item.providerId))],
    emailVerified: account.emailVerified,
    createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
  };
}

export interface StoredDeviceIdentity {
  id: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
  phone?: string | null;
  address?: string | null;
  createdAt?: number;
}

export function deviceSessionUser(stored: StoredDeviceIdentity) {
  return {
    id: stored.id,
    email: personalEmail(stored.email),
    displayName: personalName(stored.displayName),
    ...(stored.photoURL ? { photoURL: stored.photoURL } : {}),
    ...(stored.phone ? { phone: stored.phone } : {}),
    ...(stored.address ? { address: stored.address } : {}),
    providerIds: [] as string[],
    ...(stored.createdAt ? { createdAt: stored.createdAt } : {}),
  };
}

export function accountInitials(name: string | null | undefined): string {
  return personalName(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

export function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    'google.com': 'Google',
    password: 'Email and password',
    'apple.com': 'Apple',
    phone: 'Phone',
  };
  return labels[provider] ?? 'Linked account';
}
