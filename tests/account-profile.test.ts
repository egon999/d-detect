import { describe, expect, it } from 'vitest';
import { accountInitials, providerLabel, sessionAccount, type AccountSource } from '../src/services/auth/account';

const account: AccountSource = {
  uid: 'user_one', email: 'user@example.test', displayName: null, photoURL: null,
  emailVerified: true, metadata: { creationTime: '2026-09-01T00:00:00Z' },
  providerData: [{ providerId: 'google.com', displayName: 'Priya Sharma', photoURL: 'https://lh3.googleusercontent.com/photo' }],
};
describe('authenticated account identity', () => {
  it('restores Google provider name/photo when Firebase top-level fields are empty', () => {
    expect(sessionAccount(account)).toMatchObject({ displayName: 'Priya Sharma', photoURL: account.providerData[0]!.photoURL, providerIds: ['google.com'], emailVerified: true });
  });
  it('preserves edited profile information and password provider without inferring from avatar', () => {
    const mapped = sessionAccount({ ...account, displayName: 'Edited name', photoURL: 'https://example.test/avatar', providerData: [...account.providerData, { providerId: 'password', displayName: null, photoURL: null }] });
    expect(mapped.displayName).toBe('Edited name');
    expect(mapped.photoURL).toBe('https://example.test/avatar');
    expect(mapped.providerIds).toEqual(['google.com', 'password']);
  });
  it('does not invent an account creation date', () => {
    expect(sessionAccount({ ...account, metadata: { creationTime: 'invalid' } }).createdAt).toBeUndefined();
  });
  it('uses person initials and actual provider names', () => {
    expect(accountInitials('  Priya   Sharma ')).toBe('PS');
    expect(accountInitials('')).toBe('?');
    expect(providerLabel('password')).toBe('Email and password');
  });
});
