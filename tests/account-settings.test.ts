/**
 * The account screen's pure logic.
 *
 * Two things are checked here, and both are checked because getting either one wrong puts
 * something in front of a person that should never reach them.
 *
 * `readableAuthError` is the one mapping every account failure in the app goes through. The
 * test below walks *every* code it knows rather than a few someone remembered, because the
 * failure mode is not "the sentence is clumsy" — it is a code, a vendor name or an empty box
 * appearing on screen at the moment somebody is already stuck.
 *
 * The preference resolvers decide which currency and which date format a person sees. The
 * case that matters is the ordinary one: a phone sold in India, left on its en-US default,
 * must not put a dollar sign on a rupee bill.
 */

import { describe, expect, it } from 'vitest';

import { KNOWN_AUTH_ERROR_CODES, readableAuthError } from '../src/services/auth/errors';
import {
  FALLBACK_CURRENCY,
  FALLBACK_LOCALE,
  currencyLabel,
  deviceLocale,
  localeLabel,
  resolveCurrency,
  resolveLocale,
} from '../src/services/preferences';

/** The sentence said when there is nothing more specific to say. */
const GENERIC = 'Something went wrong. Please try again.';

/**
 * Anything that is machinery rather than language.
 *
 * `auth/` and the bracketed form are what the auth library actually produces, and both have
 * shipped to users in this app before. The rest are the names of things a person has no
 * relationship with — mentioning any of them tells them they are reading someone else's
 * diagnostics. "Google" is deliberately absent: it is the name printed on the button they
 * pressed, and a message about that button has to be able to say it.
 */
const LEAKS = [
  /auth\//i,
  /firebase|firestore|googleapis|grpc|xhr|axios/i,
  /\berror\s*\(/i,
  /\b(?:TypeError|RangeError|SyntaxError|ReferenceError|Exception)\b/,
  /\bundefined\b|\bnull\b|\bNaN\b/,
  /[{}[\]<>]|=>/,
  /\bHTTP\b|\b[45]\d\d\b/,
  /\bAPI\b|\bSDK\b|\btoken\b/i,
];

/** Reads as something a person wrote: words, and a full stop at the end. */
function readsAsASentence(text: string): boolean {
  if (text.trim() !== text) return false;
  if (text.length < 10 || text.length > 180) return false;
  if (!/^[A-Z]/.test(text)) return false;
  if (!/[.?]$/.test(text)) return false;
  return text.split(/\s+/).length >= 3;
}

describe('account failures, in words', () => {
  it('has a sentence for every code it claims to know', () => {
    // The list is not empty, so a mapping that was emptied out cannot pass this file by
    // making the loop below run zero times.
    expect(KNOWN_AUTH_ERROR_CODES.length).toBeGreaterThan(20);

    for (const code of KNOWN_AUTH_ERROR_CODES) {
      const sentence = readableAuthError({ code, message: `Firebase: Error (${code}).` });

      expect(sentence, `${code} produced nothing`).toBeTruthy();
      expect(readsAsASentence(sentence), `${code} → ${JSON.stringify(sentence)}`).toBe(true);

      for (const leak of LEAKS) {
        expect(leak.test(sentence), `${code} leaked ${String(leak)}: ${sentence}`).toBe(false);
      }
    }
  });

  it('never passes the raw failure through, however it is shaped', () => {
    // The same code arriving three ways: as a property, buried in a re-thrown message, and
    // in the bracketed form the library prints. All three must land on the same sentence.
    const asProperty = readableAuthError({ code: 'auth/invalid-credential' });
    const asMessage = readableAuthError(new Error('Firebase: Error (auth/invalid-credential).'));
    const asBoth = readableAuthError({
      code: 'auth/invalid-credential',
      message: 'auth/invalid-credential',
    });

    expect(asMessage).toBe(asProperty);
    expect(asBoth).toBe(asProperty);
    expect(asProperty).toContain('password');
  });

  it('explains re-authentication instead of printing it', () => {
    const sentence = readableAuthError({ code: 'auth/requires-recent-login' });

    // The thing a person has to *do*. A code here would be the worst case of all: they are
    // mid-change, the change has not happened, and there is a specific repair available.
    expect(sentence).toContain('Sign in again');
    expect(sentence).not.toBe(GENERIC);
  });

  it('collapses a code nobody has written a sentence for', () => {
    expect(readableAuthError({ code: 'auth/some-code-from-the-future' })).toBe(GENERIC);
    expect(KNOWN_AUTH_ERROR_CODES).not.toContain('auth/some-code-from-the-future');
  });

  it('answers with a sentence for anything at all', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      '',
      '   ',
      0,
      42,
      true,
      [],
      {},
      new Error(''),
      new Error('TypeError: cannot read properties of undefined'),
      { message: { nested: 'not a string' } },
      new Error('x'.repeat(400)),
    ];

    for (const input of inputs) {
      const sentence = readableAuthError(input);
      expect(readsAsASentence(sentence), `${JSON.stringify(input)} → ${sentence}`).toBe(true);
      for (const leak of LEAKS) {
        expect(leak.test(sentence), `${JSON.stringify(input)} leaked: ${sentence}`).toBe(false);
      }
    }
  });

  it('keeps a sentence the server wrote, and drops one it did not', () => {
    // The server writes for people, so its own wording is better than anything this mapping
    // could substitute — the account routes are full of sentences like this one.
    const fromServer =
      'That is not a currency we recognise. Enter a three-letter currency code, like INR for rupees.';
    expect(readableAuthError({ status: 400, message: fromServer })).toBe(fromServer);

    // A reply that is not for reading does not reach the person just because it came over HTTP.
    expect(readableAuthError({ status: 500, message: '{"error":"ECONNREFUSED"}' })).toBe(GENERIC);
  });

  it('says to check the connection when nothing was reached', () => {
    // `status === 0` is how the API client spells "could not connect".
    const sentence = readableAuthError({ status: 0, message: 'Cannot reach the server.' });
    expect(sentence.toLowerCase()).toContain('connection');
    expect(readsAsASentence(sentence)).toBe(true);
  });

  it('is safe to apply twice', () => {
    for (const code of KNOWN_AUTH_ERROR_CODES) {
      const once = readableAuthError({ code });
      expect(readableAuthError(once)).toBe(once);
      expect(readableAuthError(new Error(once))).toBe(once);
    }
  });
});

describe('which currency and date format applies', () => {
  it('uses the account’s choice before anything else', () => {
    expect(resolveLocale('hi-IN', 'fr-FR')).toBe('hi-IN');
    expect(resolveCurrency('usd')).toBe('USD');
  });

  it('tidies a stored value into the form the formatters want', () => {
    expect(resolveLocale('en-in', null)).toBe('en-IN');
    expect(resolveCurrency('  eur  ')).toBe('EUR');
  });

  it('falls back to the phone for dates when nothing is chosen', () => {
    // The device is passed in rather than read, so this asserts the rule and not the machine
    // the test happens to run on.
    expect(resolveLocale(null, 'fr-FR')).toBe('fr-FR');
    expect(resolveLocale(undefined, 'de-DE')).toBe('de-DE');
    expect(resolveLocale('', 'ta-IN')).toBe('ta-IN');
  });

  it('falls back to India in English when neither can be used', () => {
    expect(resolveLocale(null, null)).toBe(FALLBACK_LOCALE);
    expect(resolveLocale('not a language', 'nor is this')).toBe(FALLBACK_LOCALE);
    expect(resolveLocale('en_IN!!', null)).toBe(FALLBACK_LOCALE);
  });

  it('never takes the currency off the phone', () => {
    // The case this exists for: an ordinary phone in India left on its en-US default. A
    // currency read off that setting would put a dollar sign on a rupee bill.
    expect(resolveCurrency(null)).toBe(FALLBACK_CURRENCY);
    expect(resolveCurrency(undefined)).toBe(FALLBACK_CURRENCY);
    expect(resolveCurrency('')).toBe(FALLBACK_CURRENCY);
    expect(resolveCurrency('$')).toBe(FALLBACK_CURRENCY);
    expect(resolveCurrency('rupees')).toBe(FALLBACK_CURRENCY);
    expect(resolveLocale(null, 'en-US')).toBe('en-US');
    expect(FALLBACK_CURRENCY).toBe('INR');
  });

  it('reads the phone’s setting as a usable tag or not at all', () => {
    const device = deviceLocale();
    if (device !== null) {
      expect(Intl.getCanonicalLocales(device)[0]).toBe(device);
    }
  });

  it('names a setting rather than showing its tag', () => {
    for (const tag of ['en-IN', 'hi-IN', 'en-GB', 'en-US']) {
      const label = localeLabel(tag);
      expect(label, `${tag} had no name`).toBeTruthy();
      expect(label).not.toBe(tag);
      expect(label).not.toMatch(/[_-]/);
    }
    expect(localeLabel('en-IN')).toBe('English (India)');
  });

  it('gives nothing rather than a tag it cannot name', () => {
    expect(localeLabel('not a tag!!')).toBeNull();
    expect(localeLabel('')).toBeNull();
  });

  it('keeps the currency code in the label, because that is what is on the bill', () => {
    expect(currencyLabel('INR')).toBe('Indian Rupee (INR)');
    expect(currencyLabel('usd')).toContain('(USD)');
    // Nothing usable still produces something to read, never an empty row: an unset currency
    // is labelled as the one that applies, which is the same one `resolveCurrency` returns.
    expect(currencyLabel('')).toBe(currencyLabel(FALLBACK_CURRENCY));
    // A code with no name behind it shows the code, which is still a word people read on a
    // statement rather than a token.
    expect(currencyLabel('ZZZ')).toBe('ZZZ');
  });
});
