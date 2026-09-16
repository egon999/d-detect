import { describe, expect, it } from 'vitest';
import { looksInternal, readableAuthError } from '@features/settings/auth-errors';

/**
 * The last line of defence on the sign-in screen.
 *
 * The session provider maps the codes it knows and returns the caught error untouched for
 * everything else, so without this module a failed sign-in can print
 * `Firebase: Error (auth/missing-password).` into a banner. These tests pin the two
 * properties that matter: a person always gets a sentence they can act on, and the name of
 * the backend never reaches the screen.
 */
describe('readableAuthError', () => {
  it('turns a code carried on the error object into an instruction', () => {
    expect(readableAuthError({ code: 'auth/missing-password' })).toBe(
      'Enter your password to continue.',
    );
    expect(readableAuthError({ code: 'auth/requires-recent-login' })).toBe(
      'Please sign in again to confirm this change.',
    );
  });

  it('reads a code out of the message when the SDK re-threw a plain Error', () => {
    // Several paths in the auth layer catch a Firebase error and rebuild it as `new Error(...)`,
    // which drops the `code` property and leaves the code only in the text.
    expect(readableAuthError(new Error('Firebase: Error (auth/invalid-action-code).'))).toBe(
      'That link is no longer valid. Request a new one and try again.',
    );
  });

  it('never prints the provider name, even for a code it does not know', () => {
    // The table is knowingly incomplete. An unmapped code must still not fall through to
    // the raw string, because that string is where `Firebase:` lives.
    const result = readableAuthError({
      code: 'auth/some-code-added-after-this-was-written',
      message: 'Firebase: Error (auth/some-code-added-after-this-was-written).',
    });

    expect(result).not.toMatch(/firebase/i);
    expect(result).not.toContain('auth/');
    expect(result).toBe('Sign-in could not be completed. Try again in a moment.');
  });

  it('distinguishes a dropped connection from a rejected credential in the fallback', () => {
    // One is worth retrying straight away and the other is not, so the generic branch is
    // not allowed to collapse into a single "something went wrong".
    expect(readableAuthError(new Error('auth/unknown: network request failed'))).toBe(
      'No connection right now. Check your network and try again.',
    );
    expect(readableAuthError(new Error('auth/unknown: password is invalid'))).toBe(
      'That password was not accepted. Check it and try again.',
    );
  });

  it('passes through wording the session provider already wrote for a person', () => {
    // The provider's own sentences are good and must survive untouched — this module
    // supplements that table, it does not replace it.
    const written = 'That email address is already registered. Sign in instead.';
    expect(readableAuthError(new Error(written))).toBe(written);
  });

  it('says something rather than nothing when the failure carried no message at all', () => {
    expect(readableAuthError(new Error(''))).toBe('That did not work. Try again in a moment.');
    expect(readableAuthError(null)).toBe('That did not work. Try again in a moment.');
    expect(readableAuthError(undefined)).toBe('That did not work. Try again in a moment.');
  });

  it('keeps the same answer for a wrong password and an address with no account', () => {
    // Firebase collapses these deliberately: telling the two apart reveals which addresses
    // are registered. The wording must not helpfully undo that.
    const wrongPassword = readableAuthError({ code: 'auth/wrong-password' });
    const noAccount = readableAuthError({ code: 'auth/user-not-found' });
    expect(wrongPassword).toBe(noAccount);
    expect(wrongPassword).not.toMatch(/no account|not registered|does not exist/i);
  });
});

describe('looksInternal', () => {
  it('recognises provider vocabulary and developer errors', () => {
    expect(looksInternal('Firebase: Error (auth/internal-error).')).toBe(true);
    expect(looksInternal('Missing or insufficient permissions. (firestore/permission-denied)')).toBe(true);
    expect(looksInternal('undefined is not an object')).toBe(true);
    expect(looksInternal('   ')).toBe(true);
  });

  it('accepts a sentence written for a person', () => {
    expect(looksInternal('Enter your password to continue.')).toBe(false);
    expect(looksInternal('No connection right now. Check your network and try again.')).toBe(false);
  });
});
