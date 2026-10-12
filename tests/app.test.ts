import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * `@services/preferences` imports AsyncStorage at module scope for the one flag it still keeps,
 * and the real module loads a native side that does not exist under Node. Replaced outright
 * rather than spread from an original, because there is no original to spread. Nothing below
 * reads or writes storage — the functions under test here are the pure half of that file.
 */
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

import {
  formatMoneyCompact,
  formatRelativeTime,
  formatAbsoluteDate,
  formatTimestamp,
  normalizeUserAmount,
} from '../src/ui/format';
import {
  ApiError,
  apiBaseUrl,
  configureApi,
  fileEndpoint,
  currentAuthHeaders,
  uploadTimeoutMs,
} from '../src/api/client';
import { uploadBytes } from '../src/api/files';
import {
  FALLBACK_CURRENCY,
  FALLBACK_LOCALE,
  currencyLabel,
  localeLabel,
  resolveCurrency,
  resolveLocale,
} from '../src/services/preferences';

describe('UI Formatting', () => {
  describe('normalizeUserAmount', () => {
    it('normalizes formatted currency amounts to clean numeric strings', () => {
      expect(normalizeUserAmount('₹30,000')).toBe('30000');
      expect(normalizeUserAmount('₹30,000/-')).toBe('30000');
      expect(normalizeUserAmount('30000/-')).toBe('30000');
      expect(normalizeUserAmount('30 000')).toBe('30000');
      expect(normalizeUserAmount('Rs. 25000')).toBe('25000');
      expect(normalizeUserAmount('INR 50000.50')).toBe('50000.50');
      expect(normalizeUserAmount('$ 1,250.50')).toBe('1250.50');
      expect(normalizeUserAmount('€500')).toBe('500');
      expect(normalizeUserAmount('  30000  ')).toBe('30000');
      expect(normalizeUserAmount('1,00,000.75')).toBe('100000.75');
      expect(normalizeUserAmount('12.345')).toBe('12.345');
    });

    it('rejects non-positive numbers and non-numeric inputs', () => {
      expect(normalizeUserAmount('')).toBeNull();
      expect(normalizeUserAmount('   ')).toBeNull();
      expect(normalizeUserAmount('0')).toBeNull();
      expect(normalizeUserAmount('-500')).toBeNull();
      expect(normalizeUserAmount('-₹500')).toBeNull();
      expect(normalizeUserAmount('abc')).toBeNull();
      expect(normalizeUserAmount('₹')).toBeNull();
      expect(normalizeUserAmount('12.3456')).toBeNull();
      expect(normalizeUserAmount(null)).toBeNull();
      expect(normalizeUserAmount(undefined)).toBeNull();
    });
  });

  describe('formatMoneyCompact', () => {
    it('formats INR whole and fractional amounts with Indian grouping', () => {
      expect(formatMoneyCompact(150000, 'INR')).toBe('₹1,500');
      expect(formatMoneyCompact(3000000, 'INR')).toBe('₹30,000');
      expect(formatMoneyCompact(123456789, 'INR')).toBe('₹12,34,567.89');
      expect(formatMoneyCompact(5050, 'INR')).toBe('₹50.50');
      expect(formatMoneyCompact(5005, 'INR')).toBe('₹50.05');
    });

    it('formats 0-decimal currencies correctly without decimals', () => {
      expect(formatMoneyCompact(1500, 'JPY')).toBe('¥1,500');
      expect(formatMoneyCompact(50000, 'KRW')).toBe('KRW 50,000');
    });

    it('formats 3-decimal currencies correctly', () => {
      expect(formatMoneyCompact(12345, 'KWD')).toBe('KWD 12.345');
      expect(formatMoneyCompact(10000, 'BHD')).toBe('BHD 10');
    });

    it('handles negative amounts correctly', () => {
      expect(formatMoneyCompact(-50000, 'INR')).toBe('-₹500');
      expect(formatMoneyCompact(-1250, 'USD')).toBe('-$12.50');
    });

    it('falls back to currency code when symbol is unknown', () => {
      expect(formatMoneyCompact(100000, 'NZD')).toBe('NZD 1,000');
    });
  });

  describe('formatRelativeTime', () => {
    const NOW = 1774700000000;

    it('returns "Just now" for recent times or future timestamps', () => {
      expect(formatRelativeTime(NOW - 1000, NOW)).toBe('Just now');
      expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('Just now');
      expect(formatRelativeTime(NOW + 5000, NOW)).toBe('Just now');
    });

    it('returns minute increments under an hour', () => {
      expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
      expect(formatRelativeTime(NOW - 45 * 60_000, NOW)).toBe('45 min ago');
    });

    it('returns hour increments under a day', () => {
      expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe('1 hour ago');
      expect(formatRelativeTime(NOW - 5 * 3600_000, NOW)).toBe('5 hours ago');
    });

    it('returns "Yesterday" or day increments under a month', () => {
      expect(formatRelativeTime(NOW - 24 * 3600_000, NOW)).toBe('Yesterday');
      expect(formatRelativeTime(NOW - 4 * 24 * 3600_000, NOW)).toBe('4 days ago');
      expect(formatRelativeTime(NOW - 14 * 24 * 3600_000, NOW)).toBe('2 weeks ago');
    });

    it('switches to absolute date after 30 days', () => {
      const past = NOW - 40 * 24 * 3600_000;
      const expected = formatAbsoluteDate(past);
      expect(formatRelativeTime(past, NOW)).toBe(expected);
    });
  });

  describe('formatAbsoluteDate and formatTimestamp', () => {
    it('formats dates consistently', () => {
      const date = new Date(2026, 8, 26, 14, 30);
      const str = formatTimestamp(date.getTime());
      expect(str).toContain('26');
      expect(str).toContain('Sep');
      expect(str).toContain('2026');
      expect(str).toContain('14:30');
    });
  });
});

describe('API Client', () => {
  beforeEach(() => {
    configureApi(() => null);
  });

  it('ApiError correctly reflects network and auth status', () => {
    const netErr = new ApiError(0, 'Cannot reach server', null, null);
    expect(netErr.isNetwork).toBe(true);
    expect(netErr.isAuth).toBe(false);

    const authErr = new ApiError(401, 'Unauthorized', 'AUTH_REQUIRED', null);
    expect(authErr.isNetwork).toBe(false);
    expect(authErr.isAuth).toBe(true);

    const forbiddenErr = new ApiError(403, 'Forbidden', null, null);
    expect(forbiddenErr.isAuth).toBe(true);

    const validationErr = new ApiError(400, 'Bad request', null, null);
    expect(validationErr.isNetwork).toBe(false);
    expect(validationErr.isAuth).toBe(false);
  });

  it('returns valid apiBaseUrl', () => {
    const base = apiBaseUrl();
    expect(base).toBeTruthy();
    expect(base.startsWith('http')).toBe(true);
  });

  it('builds file endpoints safely', () => {
    const endpoint = fileEndpoint('file_123456');
    expect(endpoint).toBe(`${apiBaseUrl()}/api/files/file_123456`);
  });

  it('handles device identity in currentAuthHeaders', async () => {
    configureApi(() => ({ deviceId: 'test-device-uuid' }));
    const headers = await currentAuthHeaders();
    expect(headers).toEqual({ 'x-device-id': 'test-device-uuid' });
  });

  it('handles bearer token in currentAuthHeaders', async () => {
    configureApi(() => 'mock-jwt-token');
    const headers = await currentAuthHeaders();
    expect(headers).toEqual({ authorization: 'Bearer mock-jwt-token' });
  });
});


/*
 * The upload clock. A meeting recording is the only thing this app sends that is measured in
 * tens of megabytes, and it is also the only thing that exists nowhere else if the request is
 * aborted — the audio is not on a server yet and the recorder has already released it. These
 * pin the two ends of that: a big upload gets enough time, and an unknown one is never given
 * the short allowance.
 */
describe('Upload timeouts', () => {
  const MINUTE = 60_000;
  const MB = 1_048_576;

  it('gives a long recording far more than the two minutes a JSON request gets', () => {
    // ~96 MB is what the server accepts for meeting audio, four Whisper-sized segments. The
    // old fixed 120s killed this upload on any connection slower than about 6 Mbit/s.
    expect(uploadTimeoutMs(96 * MB)).toBeGreaterThan(10 * MINUTE);
    // A twenty-minute meeting at a typical bitrate, on a mobile uplink.
    expect(uploadTimeoutMs(20 * MB)).toBeGreaterThan(4 * MINUTE);
  });

  it('does not punish a screenshot for the sake of a meeting', () => {
    // A 300 KB receipt should not sit for twenty minutes before reporting a stalled network.
    expect(uploadTimeoutMs(300 * 1024)).toBeLessThanOrEqual(MINUTE);
    expect(uploadTimeoutMs(300 * 1024)).toBeGreaterThanOrEqual(30_000);
  });

  it('treats an unknown size as a large one, never a small one', () => {
    // The recorder cannot report a byte count without reading the file back. Guessing small
    // there would abort exactly the upload this whole mechanism exists to protect.
    const ceiling = uploadTimeoutMs(null);
    expect(ceiling).toBe(uploadTimeoutMs(Number.MAX_SAFE_INTEGER));
    expect(ceiling).toBeGreaterThanOrEqual(15 * MINUTE);
    for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(uploadTimeoutMs(nonsense)).toBe(ceiling);
    }
  });

  it('is capped, so a stalled upload still ends in an error a person can act on', () => {
    expect(uploadTimeoutMs(10_000 * MB)).toBe(uploadTimeoutMs(null));
  });

  it('grows with the payload and never shrinks', () => {
    const sizes = [1, MB, 5 * MB, 50 * MB, 200 * MB];
    const timeouts = sizes.map(uploadTimeoutMs);
    expect(timeouts).toEqual([...timeouts].sort((left, right) => left - right));
  });

  it('reads a size from a blob and from a picker descriptor, and admits when there is none', () => {
    expect(uploadBytes(new Blob(['x'.repeat(2048)]))).toBe(2048);
    expect(uploadBytes({ uri: 'file:///a.m4a', name: 'a.m4a', type: 'audio/m4a', size: 4096 })).toBe(4096);
    // The recorder path: a native uri and nothing else to go on.
    expect(uploadBytes({ uri: 'file:///a.m4a', name: 'a.m4a', type: 'audio/m4a' })).toBeNull();
    // A zero from a picker means it did not know, not that the file is empty.
    expect(uploadBytes({ uri: 'file:///a.m4a', name: 'a.m4a', type: 'audio/m4a', size: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// How dates and amounts are written, and what decides it
// ---------------------------------------------------------------------------

/**
 * Anything that is not a word.
 *
 * Every value these functions produce is rendered directly — into a date, an amount, or the
 * label on a settings row. A `undefined` or a `NaN` reaching any of those is the specific
 * failure this list exists to catch, and an empty string is the same failure with no evidence.
 */
const NOT_A_WORD = /undefined|null|NaN|\[object/;

/** Values a stored preference can actually hold, including the ones a bad write leaves behind. */
const RUBBISH = [
  null,
  undefined,
  '',
  '   ',
  'undefined',
  'null',
  'en_IN',
  'xx-YY-ZZ-!!',
  '₹₹₹',
  '12345',
];

describe('Which language and currency a person gets', () => {
  it('defaults to India in English, which is who this app is for', () => {
    expect(FALLBACK_LOCALE).toBe('en-IN');
    expect(resolveLocale(null, null)).toBe('en-IN');
    // Confirms the default is a real choice rather than a tag that happens to parse: `en-IN`
    // is what writes "1 March 2026" and "12,34,567" instead of "March 1, 2026" and "1,234,567".
    expect(new Intl.NumberFormat(resolveLocale(null, null)).format(1234567)).toBe('12,34,567');
  });

  it('defaults to rupees, and never reads a currency off the phone', () => {
    expect(FALLBACK_CURRENCY).toBe('INR');
    expect(resolveCurrency(null)).toBe('INR');
    // A phone bought in India and left on its en-US default is an ordinary phone. Taking a
    // currency from it would put a dollar sign on a rupee bill — a claim about somebody's money
    // that nobody made.
    expect(resolveLocale(null, 'en-US')).toBe('en-US');
    expect(resolveCurrency(null)).toBe('INR');
  });

  it('lets the account override the phone', () => {
    expect(resolveLocale('hi-IN', 'en-US')).toBe('hi-IN');
    expect(resolveCurrency('usd')).toBe('USD');
  });

  it('uses the phone when the account has chosen nothing', () => {
    // Somebody who set their phone to their own language has answered this question once
    // already, and should not have to answer it again.
    expect(resolveLocale(null, 'ta-IN')).toBe('ta-IN');
    expect(resolveLocale('', 'bn-IN')).toBe('bn-IN');
  });

  it('tidies a stored value into the form everything else expects', () => {
    expect(resolveLocale('  en-in  ', null)).toBe('en-IN');
    expect(resolveCurrency('  inr  ')).toBe('INR');
  });

  it('falls back rather than passing a bad value to the formatter', () => {
    // The reason this is checked at all: `toLocaleDateString('en_IN')` throws a RangeError, and
    // a date that throws while rendering takes the whole screen with it.
    for (const stored of RUBBISH) {
      const locale = resolveLocale(stored, null);
      expect(locale).toBe(FALLBACK_LOCALE);
      expect(() => new Date(0).toLocaleDateString(locale)).not.toThrow();
    }
  });

  it('falls back rather than printing a bad currency code beside an amount', () => {
    for (const stored of RUBBISH) {
      const currency = resolveCurrency(stored);
      expect(currency).toBe(FALLBACK_CURRENCY);
      expect(() =>
        new Intl.NumberFormat(FALLBACK_LOCALE, { style: 'currency', currency }).format(1),
      ).not.toThrow();
    }
  });

  it('survives a phone whose own setting is unreadable', () => {
    // `deviceLocale()` answers null when `Intl` cannot be read, and a rubbish device value is
    // the same case. Either way there is still a language to write the date in.
    for (const device of RUBBISH) {
      expect(resolveLocale(null, device as string | null)).toBe(FALLBACK_LOCALE);
    }
  });

  it('names a language as its own name rather than as a tag', () => {
    // `en-IN` is a developer's way of writing a setting. The row says what it does.
    expect(localeLabel('en-IN')).toBe('English (India)');
    expect(localeLabel('hi-IN')).toMatch(/\(/);
    // A language with no region is named without an empty bracket after it.
    expect(localeLabel('en')).toBe('English');
  });

  it('says nothing rather than showing a tag it cannot name', () => {
    // Null, so the settings row can describe the setting instead. Returning the tag would put
    // `xx-YY-ZZ-!!` on screen under somebody's name.
    for (const bad of ['', '   ', 'en_IN', 'xx-YY-ZZ-!!', '₹₹₹']) {
      expect(localeLabel(bad)).toBeNull();
    }
  });

  it('says nothing for a tag the platform has no name for, rather than repeating it', () => {
    // Two defects in one assertion, because `Intl.DisplayNames.of()` has two ways of not knowing
    // and neither of them is a failure it reports.
    //
    // For a language it cannot name it returns the subtag, so a stored `zz` was rendered as
    // "zz" — the "did we get a name" check passed, because a name was returned.
    for (const unnamed of ['zz', 'english', 'qpp']) {
      expect(localeLabel(unnamed)).toBeNull();
    }

    // For a region it cannot name it answers "Unknown Region", which is worse: it reads like a
    // sentence, so nothing looks wrong, and "English (Unknown Region)" is a developer's words
    // inside a statement about somebody's own settings. The bracket is dropped instead.
    expect(localeLabel('en-ZZ')).toBe('English');
    // The other unassigned codes come back as the subtag and are caught the first way.
    expect(localeLabel('en-QQ')).toBe('English');

    // Nothing above is allowed to cost a real setting its region.
    expect(localeLabel('en-IN')).toBe('English (India)');
  });

  it('keeps the currency code in its label, because that is the part people recognise', () => {
    // The code is what is printed on a bill and what somebody types to set this, so dropping it
    // would hide the one token they recognise.
    expect(currencyLabel('INR')).toContain('INR');
    expect(currencyLabel('INR')).toMatch(/rupee/i);
    expect(currencyLabel('USD')).toContain('USD');
  });

  it('never renders a label that is blank or a word a developer would write', () => {
    for (const stored of [...RUBBISH, 'INR', 'usd', 'en-IN', 'hi-IN']) {
      const currency = currencyLabel(stored as string);
      expect(currency.length).toBeGreaterThan(0);
      expect(currency).not.toMatch(NOT_A_WORD);

      const locale = localeLabel(String(stored));
      if (locale !== null) {
        expect(locale.length).toBeGreaterThan(0);
        expect(locale).not.toMatch(NOT_A_WORD);
      }
    }
  });

  it('accepts a tag that is well formed but means nothing, because it still cannot break a date', () => {
    // `english` is not a language the platform knows, but it *is* a structurally valid BCP-47
    // tag — a 5-to-8-letter primary subtag is legal — so `Intl` keeps it and resolves it to the
    // platform default when a date is actually formatted. Worth pinning rather than "fixing":
    // the check this file guards is that nothing reaches a formatter that would throw, and this
    // does not. A tag that is merely unknown costs a person nothing, and it is never shown —
    // `localeLabel` refuses to name it, which the case above covers.
    expect(resolveLocale('english', null)).toBe('english');
    expect(() => new Date(0).toLocaleDateString('english')).not.toThrow();
  });

  it('records a preference and converts nothing', () => {
    // Worth asserting because the opposite is the tempting feature: no total in this app is
    // converted, and anything already saved keeps the currency it was saved in. The same minor
    // units under two preferences differ in the symbol and in nothing else — changing the
    // preference must never restate an amount somebody saved in another one.
    expect(formatMoneyCompact(123_456_700, 'INR')).toBe('₹12,34,567');
    expect(formatMoneyCompact(123_456_700, 'USD')).toBe('$1,234,567');
    expect(resolveCurrency('USD')).toBe('USD');
    expect(resolveCurrency('INR')).toBe('INR');
  });
});
