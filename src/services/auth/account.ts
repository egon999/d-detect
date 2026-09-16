/** Provider identity comes from the authenticated account, never from an avatar URL. */
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

export function sessionAccount(account: AccountSource) {
  const provider = account.providerData.find((item) => item.providerId === 'google.com');
  const createdAt = account.metadata.creationTime ? Date.parse(account.metadata.creationTime) : NaN;
  return {
    id: account.uid,
    email: account.email ?? '',
    displayName: account.displayName || provider?.displayName || account.email?.split('@')[0] || 'Account',
    photoURL: account.photoURL || provider?.photoURL || undefined,
    providerIds: [...new Set(account.providerData.map((item) => item.providerId))],
    emailVerified: account.emailVerified,
    createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
  };
}

export function accountInitials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
}

export function providerLabel(provider: string): string {
  const labels: Record<string, string> = { 'google.com': 'Google', password: 'Email and password', 'apple.com': 'Apple', phone: 'Phone' };
  return labels[provider] ?? provider;
}
