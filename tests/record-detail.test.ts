/**
 * What the detail screen says about a saved thing, without rendering it.
 *
 * The screen that shows one saved thing had a bug worth a test file of its own: it turned a
 * stored kind into a label with `kind.charAt(0).toUpperCase() + kind.slice(1)`, which is not
 * translation but capitalisation, so a kind the screen had not thought about reached three
 * places at once as `Bank_statement`. The fix is a table, and a table is only correct if
 * something checks it against the list the server can actually produce — which is what the
 * first block here does, by restating that list rather than importing it. The server is a
 * separate program the app does not build against; a test that imported its constant would
 * pass by tautology and would stop compiling the day the two are deployed apart.
 *
 * The rest covers the helpers the screen leans on for the three figures a person came to
 * check. These are in `src/ui/format.ts` rather than inside the component for exactly this
 * reason: a date that must never claim a precision the document did not have, and an amount
 * that must never be stored under a currency nobody wrote, are rules worth proving.
 *
 * Every timestamp here is built with `new Date(year, month, day, ...)`, which is local time,
 * because the formatters read local calendar fields. Writing them as epoch literals or `Z`
 * strings would make the expectations pass in one timezone and fail in the next.
 */

import { describe, expect, it } from 'vitest';

import {
  currencyInUserAmount,
  currencySymbol,
  documentWords,
  exportFileName,
  formatAbsoluteDate,
  formatClockTime,
  formatMoneyCompact,
  formatOccurredOn,
  formatTimestamp,
  isoDateOf,
  normalizeTypedDate,
  pictureDescription,
  readHasContent,
  readRecordDetails,
  recordKindFamily,
  recordKindLabel,
  recordShareText,
  recordStatusWords,
  relatedLink,
  relatedLinkHint,
  relatedLinkTitle,
  relatedRecords,
} from '../src/ui/format';

/**
 * The ten kinds the reader is allowed to answer with, restated from the server's
 * `RECORD_KINDS` in `server/src/extract.ts`. Stored kinds outside this set exist — a saved
 * entry can carry any short word — and are covered by the fallback tests further down.
 */
const SERVER_KINDS = [
  'payment',
  'purchase',
  'bill',
  'receipt',
  'ticket',
  'travel',
  'document',
  'message',
  'note',
  'other',
] as const;

/** Anything a person should never be shown in place of a word. */
function looksLikeAToken(label: string): boolean {
  if (label.includes('_') || label.includes('-')) return true;
  // A word in the middle of a phrase starting with a capital is a joined token, not English.
  const [, ...rest] = label.split(' ');
  return rest.some((word) => /^[A-Z]/.test(word));
}

describe('recordKindLabel', () => {
  it('gives every kind the server can produce a plain label', () => {
    for (const kind of SERVER_KINDS) {
      const label = recordKindLabel(kind);
      expect(label.length).toBeGreaterThan(0);
      expect(looksLikeAToken(label)).toBe(false);
      // The label is the word, not the token with its first letter pushed up.
      expect(label).not.toBe(kind);
    }
  });

  it('names the nine concrete kinds after themselves', () => {
    expect(recordKindLabel('payment')).toBe('Payment');
    expect(recordKindLabel('purchase')).toBe('Purchase');
    expect(recordKindLabel('bill')).toBe('Bill');
    expect(recordKindLabel('receipt')).toBe('Receipt');
    expect(recordKindLabel('ticket')).toBe('Ticket');
    expect(recordKindLabel('travel')).toBe('Travel');
    expect(recordKindLabel('document')).toBe('Document');
    expect(recordKindLabel('message')).toBe('Message');
    expect(recordKindLabel('note')).toBe('Note');
  });

  it('says something a person would say for the catch-all kind', () => {
    // `other` is also what a file is stored as while it is still being read, so its label
    // has to make sense before anything is known about the thing.
    expect(recordKindLabel('other')).toBe('Something you saved');
  });

  it('spells out a multi-word kind instead of showing the separator', () => {
    expect(recordKindLabel('bank_statement')).toBe('Bank statement');
    expect(recordKindLabel('boarding_pass')).toBe('Boarding pass');
  });

  it('never renders an unknown kind with an underscore or a raw capital', () => {
    const unknown = [
      'bank_transfer_receipt',
      'utility_bill_2025',
      'EMI_SCHEDULE',
      'gst_invoice',
      'kyc_form_v2',
      'misc',
      'xyz',
      'a',
      'PAYMENT_ADVICE',
      'some_internal_kind_name',
      'receipt_copy',
      '12345',
      '__proto__',
      'tds',
      'nach_mandate',
    ];
    for (const kind of unknown) {
      const label = recordKindLabel(kind);
      expect(label, kind).not.toContain('_');
      expect(looksLikeAToken(label), kind).toBe(false);
      expect(label, kind).not.toMatch(/[A-Z]{2}/);
      expect(label.length, kind).toBeGreaterThan(2);
    }
  });

  it('turns an unmapped kind made of real words into those words', () => {
    // Worth saying rather than shrugging: the reader occasionally answers with the obvious
    // eleventh word, and "Donation receipt" tells the person more than the catch-all does.
    expect(recordKindLabel('donation_receipt')).toBe('Donation receipt');
    expect(recordKindLabel('medical bill')).toBe('Medical bill');
  });

  it('falls back rather than dressing up a code as a label', () => {
    const shrug = recordKindLabel('other');
    expect(recordKindLabel('tds')).toBe(shrug);
    expect(recordKindLabel('xyz')).toBe(shrug);
    expect(recordKindLabel('frm_2a')).toBe(shrug);
    expect(recordKindLabel('a_b_c_d')).toBe(shrug);
  });

  it('has a word for a kind that is missing, empty or whitespace', () => {
    const shrug = recordKindLabel('other');
    expect(recordKindLabel(null)).toBe(shrug);
    expect(recordKindLabel(undefined)).toBe(shrug);
    expect(recordKindLabel('')).toBe(shrug);
    expect(recordKindLabel('   ')).toBe(shrug);
  });

  it('reads a stored kind whatever case or padding it arrived in', () => {
    expect(recordKindLabel('Payment')).toBe('Payment');
    expect(recordKindLabel('  BILL  ')).toBe('Bill');
    expect(recordKindLabel('Bank_Statement')).toBe('Bank statement');
  });
});

describe('recordKindFamily', () => {
  it('places every kind the server can produce in its own family', () => {
    for (const kind of SERVER_KINDS) {
      expect(recordKindFamily(kind), kind).toBe(kind);
    }
  });

  it('files a kind that arrived by another road under the family it belongs to', () => {
    // So a thing with a proper label also gets the right glyph: naming "Bank statement" and
    // then drawing it with the shrug icon would undo half the work.
    expect(recordKindFamily('bank_statement')).toBe('bill');
    expect(recordKindFamily('invoice')).toBe('bill');
    expect(recordKindFamily('refund')).toBe('payment');
    expect(recordKindFamily('boarding_pass')).toBe('ticket');
    expect(recordKindFamily('booking')).toBe('travel');
    expect(recordKindFamily('agreement')).toBe('document');
    expect(recordKindFamily('sms')).toBe('message');
  });

  it('puts anything it does not know in the catch-all family', () => {
    expect(recordKindFamily('kyc_form_v2')).toBe('other');
    expect(recordKindFamily(null)).toBe('other');
    expect(recordKindFamily('')).toBe('other');
  });
});

describe('formatOccurredOn', () => {
  const noon = new Date(2025, 7, 12, 14, 30).getTime();

  it('says the whole date when the whole date was read', () => {
    expect(formatOccurredOn(noon, 'day')).toBe('12 August 2025');
  });

  it('treats a missing precision as a full date, which is what a stored date is', () => {
    expect(formatOccurredOn(noon)).toBe('12 August 2025');
    expect(formatOccurredOn(noon, null)).toBe('12 August 2025');
  });

  it('adds the time only when the source gave one', () => {
    expect(formatOccurredOn(noon, 'minute')).toBe('12 August 2025, 2:30 pm');
  });

  it('stops at the month when only the month was on the slip', () => {
    // The point of the whole function. A slip that says "August 2025" must not come out as
    // the 1st of August, because that day is then a figure the app invented.
    expect(formatOccurredOn(noon, 'month')).toBe('August 2025');
  });

  it('stops at the year when only the year was on it', () => {
    expect(formatOccurredOn(noon, 'year')).toBe('2025');
  });

  it('says the month in the app’s own words, not the phone’s language', () => {
    for (const [index, name] of ['January', 'February', 'March', 'December'].entries()) {
      const month = index === 3 ? 11 : index;
      expect(formatOccurredOn(new Date(2025, month, 3).getTime(), 'day')).toBe(`3 ${name} 2025`);
    }
  });
});

describe('formatClockTime', () => {
  it('writes the time the way it is spoken', () => {
    expect(formatClockTime(new Date(2025, 0, 1, 14, 30).getTime())).toBe('2:30 pm');
    expect(formatClockTime(new Date(2025, 0, 1, 9, 5).getTime())).toBe('9:05 am');
  });

  it('calls both ends of the day twelve, not zero', () => {
    expect(formatClockTime(new Date(2025, 0, 1, 0, 0).getTime())).toBe('12:00 am');
    expect(formatClockTime(new Date(2025, 0, 1, 12, 0).getTime())).toBe('12:00 pm');
  });
});

describe('isoDateOf', () => {
  it('gives the local calendar date, padded', () => {
    expect(isoDateOf(new Date(2025, 7, 12, 14, 30).getTime())).toBe('2025-08-12');
    expect(isoDateOf(new Date(2025, 0, 5, 0, 0).getTime())).toBe('2025-01-05');
  });

  it('keeps the day the person is living in, not the one UTC is in', () => {
    // Late evening and early morning both have to answer with their own local day, or a
    // correction made at 11pm saves yesterday's date east of Greenwich.
    expect(isoDateOf(new Date(2025, 2, 31, 23, 45).getTime())).toBe('2025-03-31');
    expect(isoDateOf(new Date(2025, 3, 1, 0, 15).getTime())).toBe('2025-04-01');
  });
});

describe('normalizeTypedDate', () => {
  it('reads a date typed the way this audience writes one', () => {
    expect(normalizeTypedDate('12/08/2025')).toBe('2025-08-12');
    expect(normalizeTypedDate('5/8/2025')).toBe('2025-08-05');
    expect(normalizeTypedDate('12-08-2025')).toBe('2025-08-12');
    expect(normalizeTypedDate('12.8.2025')).toBe('2025-08-12');
    expect(normalizeTypedDate('  12 / 08 / 2025  ')).toBe('2025-08-12');
  });

  it('reads the day first, always', () => {
    // Both halves are valid months, so this is the one case where guessing would be silent:
    // 5 August, never 8 May.
    expect(normalizeTypedDate('05/08/2025')).toBe('2025-08-05');
  });

  it('puts a two-digit year in the century the person meant', () => {
    expect(normalizeTypedDate('12/08/25')).toBe('2025-08-12');
    expect(normalizeTypedDate('12/08/69')).toBe('2069-08-12');
    expect(normalizeTypedDate('12/08/70')).toBe('1970-08-12');
    expect(normalizeTypedDate('12/08/99')).toBe('1999-08-12');
  });

  it('refuses a day that does not exist rather than rolling it forward', () => {
    expect(normalizeTypedDate('31/02/2025')).toBeNull();
    expect(normalizeTypedDate('29/02/2025')).toBeNull();
    expect(normalizeTypedDate('31/04/2025')).toBeNull();
    expect(normalizeTypedDate('00/08/2025')).toBeNull();
    expect(normalizeTypedDate('12/13/2025')).toBeNull();
  });

  it('knows which Februaries have twenty-nine days', () => {
    expect(normalizeTypedDate('29/02/2024')).toBe('2024-02-29');
    expect(normalizeTypedDate('29/02/2000')).toBe('2000-02-29');
    expect(normalizeTypedDate('29/02/1900')).toBeNull();
    expect(normalizeTypedDate('29/02/2100')).toBeNull();
  });

  it('comes back empty-handed rather than guessing', () => {
    expect(normalizeTypedDate('')).toBeNull();
    expect(normalizeTypedDate(null)).toBeNull();
    expect(normalizeTypedDate(undefined)).toBeNull();
    expect(normalizeTypedDate('last Tuesday')).toBeNull();
    expect(normalizeTypedDate('12 August 2025')).toBeNull();
    expect(normalizeTypedDate('2025-08-12')).toBeNull();
    expect(normalizeTypedDate('12/08')).toBeNull();
  });
});

describe('currencyInUserAmount', () => {
  it('reads the currency somebody wrote around a figure', () => {
    expect(currencyInUserAmount('₹450')).toBe('INR');
    expect(currencyInUserAmount('Rs 1,250.50')).toBe('INR');
    expect(currencyInUserAmount('rs. 400')).toBe('INR');
    expect(currencyInUserAmount('INR 400')).toBe('INR');
    expect(currencyInUserAmount('$ 1,250.50')).toBe('USD');
    expect(currencyInUserAmount('£20')).toBe('GBP');
    expect(currencyInUserAmount('€99.99')).toBe('EUR');
  });

  it('reads it through the shorthand people write after a rupee figure', () => {
    expect(currencyInUserAmount('450/-')).toBeNull();
    expect(currencyInUserAmount('₹450/-')).toBe('INR');
  });

  it('says nothing when nobody named a currency', () => {
    // The caller must then keep the currency already on the entry, or ask. A figure stored
    // under an assumed currency is a figure the app made up.
    expect(currencyInUserAmount('450')).toBeNull();
    expect(currencyInUserAmount('1,250.50')).toBeNull();
    expect(currencyInUserAmount('')).toBeNull();
    expect(currencyInUserAmount(null)).toBeNull();
    expect(currencyInUserAmount(undefined)).toBeNull();
  });

  it('does not invent a currency out of a word it cannot parse an amount for', () => {
    // It knows exactly what `normalizeUserAmount` accepts and no more, so the pair can never
    // disagree about the same string.
    expect(currencyInUserAmount('450 dirhams')).toBeNull();
    expect(currencyInUserAmount('four hundred')).toBeNull();
  });
});

describe('documentWords and pictureDescription', () => {
  const both = '[TEXT]\nUPI/4477\nPaid to Acme\n\n[SCENE]\nA payment confirmation screen.';

  it('separates what was printed on the file from what the picture showed', () => {
    expect(documentWords(both)).toBe('UPI/4477\nPaid to Acme');
    expect(pictureDescription(both)).toBe('A payment confirmation screen.');
  });

  it('never lets the markers reach the screen', () => {
    for (const stored of [both, '[SCENE]\nA parcel on a doorstep.', '[TEXT]\nTotal 450']) {
      expect(documentWords(stored) ?? '').not.toContain('[');
      expect(pictureDescription(stored) ?? '').not.toContain('[');
    }
  });

  it('treats unmarked text as words off the document, because that is what it is', () => {
    // A PDF, a .docx and a plain text file are stored without markers at all.
    expect(documentWords('Invoice 22/A\nTotal 4,500')).toBe('Invoice 22/A\nTotal 4,500');
    expect(pictureDescription('Invoice 22/A\nTotal 4,500')).toBeNull();
  });

  it('reads a picture that had nothing printed on it', () => {
    expect(documentWords('[SCENE]\nA parcel on a doorstep.')).toBeNull();
    expect(pictureDescription('[SCENE]\nA parcel on a doorstep.')).toBe('A parcel on a doorstep.');
  });

  it('reads a document whose read found no description', () => {
    expect(documentWords('[TEXT]\nTotal 450')).toBe('Total 450');
    expect(pictureDescription('[TEXT]\nTotal 450')).toBeNull();
  });

  it('follows the markers in whatever case they came back in', () => {
    const lower = '[text]\nTotal 450\n\n[scene]\nA till receipt.';
    expect(documentWords(lower)).toBe('Total 450');
    expect(pictureDescription(lower)).toBe('A till receipt.');
  });

  it('has nothing to show for a read that produced nothing', () => {
    for (const empty of [null, undefined, '', '   ', '[TEXT]\n\n[SCENE]\n']) {
      expect(documentWords(empty)).toBeNull();
      expect(pictureDescription(empty)).toBeNull();
    }
  });

  it('keeps the whole of a description that runs past a bracket of its own', () => {
    const stored = '[SCENE]\nA screenshot showing "Paid [successful]" in green.';
    expect(pictureDescription(stored)).toBe('A screenshot showing "Paid [successful]" in green.');
  });
});

// ---------------------------------------------------------------------------
// Money: never a Western-grouped rupee, never an abbreviation
// ---------------------------------------------------------------------------

/**
 * A Western-grouped figure, as a pattern: one to three digits, then groups of exactly three.
 *
 * Used below in its negative form. Care is needed, because the two groupings agree below a lakh
 * — ₹1,111 is written the same way in both systems and is not evidence of anything. So the sweep
 * below starts where they part company (a lakh) and the regex is written so a match means a
 * three-digit group *after* the first comma rather than merely the presence of one.
 */
const WESTERN_GROUPS = /^\D?\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?$/;

/** Which of the two groupings a rendered figure is written with, read back off the string. */
function groupingOf(text: string): 'lakh' | 'western' | 'none' {
  // The fraction is dropped first: those digits are not a group and would read as one. Everything
  // before the first digit is a symbol or a code, and the figure starts there.
  const whole = text.split('.')[0] ?? '';
  const groups = whole.replace(/^[^\d]*/, '').split(',');
  if (groups.length < 2) return 'none';
  // A lakh figure is a final group of three with every group above it a pair; a Western figure
  // is the same shape with every group above it a triple.
  const head = groups.slice(0, -1);
  const tail = groups[groups.length - 1] ?? '';
  if (tail.length !== 3) return 'none';
  // Above the last group a lakh figure is bare or pairs; a Western one has a triad at its head.
  const pairs = head.slice(1).every((group) => group.length === 2);
  if (head[0]?.length === 3 && head.length >= 2 && pairs) return 'western';
  return head[0] !== undefined && pairs ? 'lakh' : 'none';
}

describe('formatMoneyCompact and the grouping of a rupee figure', () => {
  it('groups a rupee amount the way it is written in India', () => {
    expect(formatMoneyCompact(12345678, 'INR')).toBe('₹1,23,456.78');
    expect(formatMoneyCompact(150000, 'INR')).toBe('₹1,500');
    expect(formatMoneyCompact(3000000, 'INR')).toBe('₹30,000');
    expect(formatMoneyCompact(123456789, 'INR')).toBe('₹12,34,567.89');
    expect(formatMoneyCompact(10000000, 'INR')).toBe('₹1,00,000');
    expect(formatMoneyCompact(1000000000, 'INR')).toBe('₹1,00,00,000');
  });

  it('never writes a rupee figure in Western groups, at any size', () => {
    // The one shape that would look right to a reader who did not count the zeros and wrong to
    // the person holding the bill. Swept from a lakh upward — below that the two groupings are
    // identical and there is nothing to catch — and swept rather than spot-checked, because the
    // bug this guards was present at exactly one magnitude.
    for (let minor = 100_000_00; minor < 100_000_00 * 200; minor += 12_345_67) {
      const rendered = formatMoneyCompact(minor, 'INR');
      expect(rendered, String(minor)).not.toMatch(WESTERN_GROUPS);
      expect(groupingOf(rendered), `${minor} → ${rendered}`).toBe('lakh');
    }
  });

  it('writes a figure below a lakh identically in both systems, as it must', () => {
    // Below the first lakh the groupings agree; ₹1,111 is correct Indian writing and correct
    // Western writing at once. Stated so the sweep above is not read as claiming otherwise.
    expect(formatMoneyCompact(111105, 'INR')).toBe('₹1,111.05');
    expect(formatMoneyCompact(99999900, 'INR')).toBe('₹9,99,999');
  });

  it('groups a rupee figure the same way whichever case or padding it arrives in', () => {
    // The currency comes off a record the server wrote; `inr` and ` INR ` are the same money and
    // must not fall through to the Western branch by being spelled differently.
    for (const spelling of ['INR', 'inr', ' INR ', 'Inr']) {
      expect(formatMoneyCompact(12345678, spelling), spelling).toBe('₹1,23,456.78');
    }
  });

  it('groups the other rupee-family currencies the same way', () => {
    for (const code of ['PKR', 'LKR', 'NPR', 'BDT']) {
      expect(formatMoneyCompact(12345678, code), code).toContain('1,23,456');
    }
  });

  it('leaves a currency that is grouped in threes grouped in threes', () => {
    // The rule belongs to the currency, not the reader's phone: an Indian reader looking at a
    // dollar figure must still see 1,234,567.89, which is the only way it is ever written.
    expect(formatMoneyCompact(123456789, 'USD')).toBe('$1,234,567.89');
    expect(formatMoneyCompact(100000000, 'NZD')).toBe('NZD 1,000,000');
    expect(formatMoneyCompact(123456789, 'EUR')).toBe('€1,234,567.89');
  });

  it('never abbreviates a figure', () => {
    // "₹1.2L" and "₹123.5K" are both a different number from the one on the receipt. Nothing
    // that rounds is allowed anywhere near this function.
    const rendered = [
      formatMoneyCompact(12345678, 'INR'),
      formatMoneyCompact(123456789, 'INR'),
      formatMoneyCompact(1234567890, 'INR'),
    ];
    for (const amount of rendered) {
      expect(amount).not.toMatch(/[KkLl]|Cr/i);
      expect(amount).not.toContain('…');
    }
  });

  it('respects the minor-unit exponent of the currency rather than assuming two decimals', () => {
    // JPY and KRW have no minor unit and BHD and KWD have three, so the same stored number is a
    // hundred times or a tenth of the figure a two-decimal formatter would write. `tests/app.test.ts`
    // pins the exact strings; this pins the property behind them.
    expect(formatMoneyCompact(1500, 'JPY')).not.toContain('.');
    expect(formatMoneyCompact(12345, 'KWD')).toBe('KWD 12.345');
    expect(formatMoneyCompact(12345, 'USD')).toBe('$123.45');
  });

  it('drops the decimals only when they are zero', () => {
    expect(formatMoneyCompact(5050, 'INR')).toBe('₹50.50');
    expect(formatMoneyCompact(5005, 'INR')).toBe('₹50.05');
  });

  it('keeps the sign in front of the symbol', () => {
    expect(formatMoneyCompact(-50000, 'INR')).toBe('-₹500');
    expect(formatMoneyCompact(-1250, 'USD')).toBe('-$12.50');
  });

  it('says nothing rather than "NaN" when it is handed something that is not a number', () => {
    // A caller holding a value it should have checked gets the empty string, so the row simply
    // does not appear — rather than the word "NaN" over somebody's bill.
    for (const broken of [NaN, Infinity, -Infinity]) {
      expect(formatMoneyCompact(broken, 'INR')).toBe('');
    }
  });
});

describe('currencySymbol', () => {
  it('gives the symbol for a currency that has one, for use in an example', () => {
    expect(currencySymbol('INR')).toBe('₹');
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('GBP')).toBe('£');
  });

  it('falls back to the code when there is no symbol anybody would recognise', () => {
    expect(currencySymbol('NZD')).toBe('NZD');
    expect(currencySymbol('XYZ')).toBe('XYZ');
  });

  it('reads a code that arrived in either case', () => {
    expect(currencySymbol('inr')).toBe('₹');
    expect(currencySymbol('  usd ')).toBe('$');
  });
});

// ---------------------------------------------------------------------------
// Dates: month names that do not need the engine to know about India
// ---------------------------------------------------------------------------

describe('formatAbsoluteDate and formatTimestamp without Intl', () => {
  it('writes the month in the app’s own words', () => {
    // The app's own table, so this cannot pass or fail depending on which locale data the
    // engine that runs these tests happened to be built with.
    expect(formatAbsoluteDate(new Date(2025, 8, 12).getTime(), new Date(2025, 8, 20).getTime())).toBe('12 Sep');
    expect(formatAbsoluteDate(new Date(2025, 7, 3).getTime(), new Date(2025, 8, 20).getTime())).toBe('3 Aug');
    expect(formatTimestamp(new Date(2026, 8, 26, 14, 30).getTime())).toBe('26 Sep 2026, 14:30');
  });

  it('adds the year only when it is not the current one', () => {
    const now = new Date(2025, 8, 20).getTime();
    expect(formatAbsoluteDate(new Date(2024, 11, 31).getTime(), now)).toBe('31 Dec 2024');
    expect(formatAbsoluteDate(new Date(2025, 0, 1).getTime(), now)).toBe('1 Jan');
  });

  it('names all twelve months the same way in both formatters', () => {
    // The bug this catches is the one that was actually there: two month tables, one in the app's
    // words and one from the engine, so two dates on one screen came out in different languages.
    const short = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const long = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    for (let month = 0; month < 12; month += 1) {
      const stamp = new Date(2026, month, 4, 9, 5).getTime();
      expect(formatTimestamp(stamp).startsWith(`4 ${short[month]} 2026`), long[month]).toBe(true);
      expect(formatOccurredOn(stamp, 'day'), long[month]).toBe(`4 ${long[month]} 2026`);
    }
  });

  it('pads the clock to the minute', () => {
    expect(formatTimestamp(new Date(2025, 0, 5, 9, 5).getTime())).toBe('5 Jan 2025, 09:05');
    expect(formatTimestamp(new Date(2025, 0, 5, 0, 0).getTime())).toBe('5 Jan 2025, 00:00');
  });
});

// ---------------------------------------------------------------------------
// Reading an extraction: the whitelist
// ---------------------------------------------------------------------------

describe('readRecordDetails', () => {
  const full = {
    readBy: 'vision',
    readNote: 'The total was faint, so please check it.',
    reference: 'UPI/4477/2025',
    status: 'paid',
    summary: 'A payment confirmation for ₹450 to Acme.',
    sourceText: '[TEXT]\nPaid ₹450 to Acme\n\n[SCENE]\nA green confirmation screen.',
    unread: false,
    // Fields that are no longer sent, or never were. None of them may surface anywhere.
    provider: 'SomeVendor',
    model: 'some-model-4o',
    vendor: 'SomeVendor',
  };

  it('reads the seven fields the server sends and nothing else', () => {
    const read = readRecordDetails(full);
    expect(read.note).toBe('The total was faint, so please check it.');
    expect(read.reference).toBe('UPI/4477/2025');
    expect(read.marked).toBe('Paid');
    expect(read.summary).toBe('A payment confirmation for ₹450 to Acme.');
    expect(read.words).toBe('Paid ₹450 to Acme');
    expect(read.scene).toBe('A green confirmation screen.');
    expect(read.unread).toBe(false);
  });

  it('never carries the name of whoever read the file', () => {
    // Both the key the screen branches on and the names of the vendor and the model. A record is
    // a person's own receipt; the software that read it is not their business and not their word.
    const read = readRecordDetails(full) as unknown as Record<string, unknown>;
    const rendered = JSON.stringify(read);
    for (const leak of ['SomeVendor', 'some-model-4o', 'vision', 'readBy']) {
      expect(rendered, leak).not.toContain(leak);
    }
    expect(typeof read.isDocument).toBe('boolean');
  });

  it('calls the original a document only for the three reads that produce one', () => {
    // `readBy` reaches the screen as this one question and nothing else. A picture has something
    // to preview; a PDF, a docx or a text file does not.
    expect(readRecordDetails({ ...full, readBy: 'pdf' }).isDocument).toBe(true);
    expect(readRecordDetails({ ...full, readBy: 'docx' }).isDocument).toBe(true);
    expect(readRecordDetails({ ...full, readBy: 'text' }).isDocument).toBe(true);
    expect(readRecordDetails({ ...full, readBy: 'PDF' }).isDocument).toBe(true);
    expect(readRecordDetails({ ...full, readBy: 'vision' }).isDocument).toBe(false);
    expect(readRecordDetails({ ...full, readBy: 'ocr' }).isDocument).toBe(false);
    expect(readRecordDetails({ readBy: 'something-new' }).isDocument).toBe(false);
  });

  it('has nothing to show for an extraction that is not there, or is not an object', () => {
    // A record captured a second ago has no read yet, and the screen must survive every shape a
    // JSON body can be.
    for (const absent of [null, undefined, '', 0, false, 'a string', 42, [], [{ readBy: 'pdf' }]]) {
      const read = readRecordDetails(absent);
      expect(read).toEqual({
        isDocument: false,
        note: null,
        reference: null,
        marked: null,
        summary: null,
        words: null,
        scene: null,
        unread: false,
      });
    }
  });

  it('ignores a value stored under a key whose type or length makes no sense for it', () => {
    const read = readRecordDetails({
      readNote: { text: 'an object where a sentence belongs' },
      reference: 4477,
      status: true,
      summary: ['an', 'array'],
      sourceText: null,
      unread: 'yes',
    });
    expect(read.note).toBeNull();
    expect(read.reference).toBeNull();
    expect(read.marked).toBeNull();
    expect(read.summary).toBeNull();
    expect(read.words).toBeNull();
    expect(read.unread).toBe(false);
  });

  it('refuses a blob that is too long to be the thing it is stored as', () => {
    // A "reference" holding a paragraph is a stored blob, not a reference number, and setting it
    // in a value slot runs it off the row and pushes the rest of the screen down.
    const read = readRecordDetails({
      reference: 'R'.repeat(200),
      status: 'S'.repeat(200),
    });
    expect(read.reference).toBeNull();
    expect(read.marked).toBeNull();
  });

  it('keeps the document’s own word, with only its first letter raised', () => {
    // "SUCCESS" is what the slip printed. Turning it into "Success" is fine; turning it into
    // "Success" and then shouting about it in a pill is not something this function decides.
    expect(readRecordDetails({ status: 'paid' }).marked).toBe('Paid');
    expect(readRecordDetails({ status: 'SUCCESS' }).marked).toBe('SUCCESS');
    expect(readRecordDetails({ status: '  pending ' }).marked).toBe('Pending');
    expect(readRecordDetails({ status: '' }).marked).toBeNull();
    expect(readRecordDetails({ status: '   ' }).marked).toBeNull();
  });

  it('takes the unread flag only from a real boolean', () => {
    expect(readRecordDetails({ unread: true }).unread).toBe(true);
    expect(readRecordDetails({ unread: false }).unread).toBe(false);
    expect(readRecordDetails({ unread: 1 }).unread).toBe(false);
    expect(readRecordDetails({ unread: 'true' }).unread).toBe(false);
  });
});

describe('readHasContent', () => {
  it('says yes when there is anything at all to show', () => {
    expect(readHasContent(readRecordDetails({ summary: 'A till receipt.' }))).toBe(true);
    expect(readHasContent(readRecordDetails({ reference: 'INV-22' }))).toBe(true);
    expect(readHasContent(readRecordDetails({ status: 'paid' }))).toBe(true);
    expect(readHasContent(readRecordDetails({ sourceText: 'Total 450' }))).toBe(true);
    expect(readHasContent(readRecordDetails({ sourceText: '[SCENE]\nA doorstep.' }))).toBe(true);
  });

  it('says no when the section would be empty', () => {
    expect(readHasContent(readRecordDetails(null))).toBe(false);
    expect(readHasContent(readRecordDetails({}))).toBe(false);
    expect(readHasContent(readRecordDetails({ reference: '', summary: '   ' }))).toBe(false);
  });

  it('does not count a caveat or an apology as content', () => {
    // A heading that opens onto "nothing could be read" is a section saying nothing. The caveat
    // belongs beside the figures it is about, and the apology is the whole screen's news.
    expect(readHasContent(readRecordDetails({ readNote: 'The total was faint.', unread: false }))).toBe(false);
    expect(readHasContent(readRecordDetails({ unread: true }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What the screen says about where a record has got to
// ---------------------------------------------------------------------------

describe('recordStatusWords', () => {
  const STATUSES = ['processing', 'needs_context', 'complete', 'unreadable', 'failed'] as const;

  it('has a label and a meaning for every state the server can send', () => {
    for (const status of STATUSES) {
      const words = recordStatusWords(status);
      expect(words.label.length, status).toBeGreaterThan(0);
      expect(words.meaning.length, status).toBeGreaterThan(20);
      // Never the token the server used, and never a bare capitalised token either.
      expect(words.label.toLowerCase(), status).not.toBe(status);
      expect(looksLikeAToken(words.label), status).toBe(false);
    }
  });

  it('has a label that reads like a sentence somebody would say', () => {
    for (const status of STATUSES) {
      const { label } = recordStatusWords(status);
      expect(label, status).not.toContain('_');
      expect(label, status).not.toMatch(/[A-Z]{2}/);
      expect(label.trim(), status).toBe(label);
    }
  });

  it('tells the person what they can do about it, not only what happened', () => {
    expect(recordStatusWords('processing').meaning).toMatch(/leave the page|carries on/i);
    expect(recordStatusWords('unreadable').meaning).toMatch(/saved|fill in/i);
    expect(recordStatusWords('failed').meaning).toMatch(/again|type it in/i);
  });

  it('still says something for a state the app has never seen', () => {
    // The screen used to render no pill at all for an unknown status, which told the person
    // looking at an entry that behaved differently from the others precisely nothing.
    for (const unknown of ['', '   ', null, undefined, 'archived', 'QUEUED', 'unknown']) {
      const words = recordStatusWords(unknown);
      expect(words.label.length).toBeGreaterThan(0);
      expect(words.meaning.length).toBeGreaterThan(4);
    }
  });

  it('reads the status whatever case or padding it arrived in', () => {
    expect(recordStatusWords('  PROCESSING ').label).toBe(recordStatusWords('processing').label);
    expect(recordStatusWords('Complete').label).toBe(recordStatusWords('complete').label);
  });

  it('does not use the same words for two different states', () => {
    const labels = STATUSES.map((status) => recordStatusWords(status).label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ---------------------------------------------------------------------------
// Handing a record to somebody else
// ---------------------------------------------------------------------------

describe('recordShareText', () => {
  const record = {
    kind: 'payment',
    title: 'Paid Acme Electricals',
    amountLabel: '₹450',
    direction: 'out' as const,
    counterparty: 'Acme Electricals',
    occurredAt: new Date(2025, 7, 12, 14, 30).getTime(),
    occurredPrecision: 'minute',
  };

  it('writes one fact per line, in plain words', () => {
    const text = recordShareText(record, 'UPI/4477/2025');
    expect(text.split('\n')).toEqual([
      'Paid Acme Electricals',
      'Paid ₹450',
      'To Acme Electricals',
      'On 12 August 2025, 2:30 pm',
      'Reference UPI/4477/2025',
    ]);
  });

  it('does not let a private note travel with the message', () => {
    // A note is the person talking to themselves — "asked for a refund, keep the box". It is not
    // in the type this function accepts, and this is the test that keeps it out.
    const text = recordShareText(record as never, null);
    for (const leak of ['refund', 'keep the box', 'note']) {
      expect(text.toLowerCase()).not.toContain(leak);
    }
  });

  it('never writes an id, a status or a file name into the message', () => {
    const text = recordShareText(record, null);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(text).not.toMatch(/\b(complete|processing|needs_context|vision|ocr)\b/i);
  });

  it('leaves out what the record does not have rather than writing a blank', () => {
    // "Reference unknown" invites the reader to think there was one and it was lost.
    const bare = recordShareText(
      { ...record, amountLabel: null, counterparty: null, occurredAt: null },
      null,
    );
    expect(bare).toBe('Paid Acme Electricals');
    expect(bare).not.toMatch(/unknown|—|-$/);
  });

  it('turns a missing title into what the thing is, not an empty first line', () => {
    // `recordKindLabel` already has the words for this, and an empty first line would make the
    // message start with a blank in whatever app received it.
    expect(recordShareText({ ...record, title: '' }, null).startsWith('Payment\n')).toBe(true);
    expect(recordShareText({ ...record, title: '   ' }, null).startsWith('Payment\n')).toBe(true);
  });

  it('says which way the money went, because the direction is the whole point', () => {
    expect(recordShareText({ ...record, direction: 'in' }, null)).toContain('\nReceived ₹450\n');
    expect(recordShareText({ ...record, direction: 'out' }, null)).toContain('\nPaid ₹450\n');
    // A direction nobody recorded gets the neutral word rather than a guess.
    expect(recordShareText({ ...record, direction: null }, null)).toContain('\nAmount ₹450\n');
  });

  it('matches the preposition to the direction', () => {
    expect(recordShareText({ ...record, direction: 'in' }, null)).toContain('\nFrom Acme Electricals\n');
    expect(recordShareText({ ...record, direction: null }, null)).toContain('\nWith Acme Electricals\n');
  });

  it('states the date no more precisely than the document did', () => {
    // The same rule as everywhere else: a slip that says "August 2025" must not be reported as
    // the 12th of August to the shop that issued it.
    expect(recordShareText({ ...record, occurredPrecision: 'month' }, null)).toContain(
      'On August 2025',
    );
    expect(recordShareText({ ...record, occurredPrecision: 'year' }, null)).toContain('On 2025');
  });

  it('trims a reference rather than letting padding break the line', () => {
    expect(recordShareText(record, '  UPI/4477  ')).toContain('Reference UPI/4477');
    expect(recordShareText(record, '   ')).not.toContain('Reference');
    expect(recordShareText(record, null)).not.toContain('Reference');
  });
});

describe('exportFileName', () => {
  it('builds a name out of what the person called the thing', () => {
    expect(exportFileName('Electricity bill August')).toBe('Electricity bill August');
  });

  it('removes the characters a file system will refuse', () => {
    expect(exportFileName('Invoice 22/2025: paid')).toBe('Invoice 222025 paid');
    expect(exportFileName('Bill "final".pdf')).toBe('Bill final.pdf');
    expect(exportFileName('A\\B|C?D*E<F>G')).toBe('ABCDEFG');
  });

  it('never produces a name that starts with a dot', () => {
    // `.`, `..` and `.bashrc` are directory references and hidden files, not titles.
    expect(exportFileName('...invoice')).toBe('invoice');
    expect(exportFileName('.hidden')).toBe('hidden');
    expect(exportFileName('..')).toBe('The original');
    expect(exportFileName('. . .')).toBe('The original');
    expect(exportFileName('')).toBe('The original');
    expect(exportFileName('   ')).toBe('The original');
    expect(exportFileName(null)).toBe('The original');
    expect(exportFileName(undefined)).toBe('The original');
    expect(exportFileName('///')).toBe('The original');
  });

  it('keeps a dot inside the name, where it is just a character', () => {
    expect(exportFileName('Invoice 22.A')).toBe('Invoice 22.A');
    expect(exportFileName('Receipt 1.2')).toBe('Receipt 1.2');
  });

  it('keeps a name written in another script', () => {
    // The person's own words are more use to them than "The original".
    expect(exportFileName('बिजली बिल')).toBe('बिजली बिल');
    expect(exportFileName('மின் கட்டணம்')).toBe('மின் கட்டணம்');
  });

  it('keeps the name to a length every file system accepts', () => {
    expect(exportFileName('A'.repeat(500)).length).toBeLessThanOrEqual(80);
  });
});


// ---------------------------------------------------------------------------
// What else belongs next to this
// ---------------------------------------------------------------------------

/** A record as the related-records matcher sees it: an id and the two fields it may match on. */
function near(id: string, counterparty: string | null, category: string | null) {
  return { id, counterparty, category };
}

describe('relatedLink', () => {
  it('matches on the payee when there is one', () => {
    expect(relatedLink({ counterparty: 'Reliance Fresh', category: 'Groceries' })).toEqual({
      by: 'counterparty',
      value: 'Reliance Fresh',
    });
  });

  it('falls back to the folder the person filed it under', () => {
    // The case this exists for: a shop slip with no name on it anywhere, which used to show
    // no related panel at all even though the person had filed twenty of them together.
    expect(relatedLink({ counterparty: null, category: 'Medicines' })).toEqual({
      by: 'category',
      value: 'Medicines',
    });
  });

  it('offers nothing when the record carries neither field', () => {
    expect(relatedLink({ counterparty: null, category: null })).toBeNull();
    expect(relatedLink({})).toBeNull();
    expect(relatedLink({ counterparty: '   ', category: '' })).toBeNull();
  });

  it('prefers the payee, because it is the sharper of the two groupings', () => {
    const link = relatedLink({ counterparty: 'Dr Rao', category: 'Health' });
    expect(link?.by).toBe('counterparty');
  });

  it('keeps the name as the person has it, spacing tidied', () => {
    expect(relatedLink({ counterparty: '  Airtel  ', category: null })).toEqual({
      by: 'counterparty',
      value: 'Airtel',
    });
  });
});

describe('relatedLinkTitle and relatedLinkHint', () => {
  it('names the match in the heading, so the reader can judge it', () => {
    expect(relatedLinkTitle({ by: 'counterparty', value: 'Reliance Fresh' })).toBe(
      'More with Reliance Fresh',
    );
    expect(relatedLinkTitle({ by: 'category', value: 'Groceries' })).toBe('More under Groceries');
  });

  it('says in plain words what the rows have in common', () => {
    const forName = relatedLinkHint({ by: 'counterparty', value: 'Airtel' });
    const forFolder = relatedLinkHint({ by: 'category', value: 'Phone' });
    expect(forName).not.toBe(forFolder);
    for (const hint of [forName, forFolder]) {
      expect(hint.length).toBeGreaterThan(10);
      // Nothing a developer would write, and nothing claiming more than a shared field.
      expect(hint).not.toMatch(/match|filter|query|relate/i);
    }
  });

  it('never writes a heading that stands in for a missing name', () => {
    // The old heading read "More with them" when nothing was named, which told the person
    // nothing and implied the app knew who "them" was.
    expect(relatedLinkTitle({ by: 'category', value: 'Rent' })).not.toMatch(/\bthem\b/);
  });
});

describe('relatedRecords', () => {
  const page = [
    near('a', 'Reliance Fresh', 'Groceries'),
    near('b', 'reliance fresh ', 'Groceries'),
    near('c', 'Airtel', 'Phone'),
    near('d', ' RELIANCE FRESH', 'Groceries'),
    near('e', null, 'Groceries'),
  ];

  it('finds the other entries with the same name on them', () => {
    const found = relatedRecords('a', { by: 'counterparty', value: 'Reliance Fresh' }, page, 10);
    expect(found.map((entry) => entry.id)).toEqual(['b', 'd']);
  });

  it('treats one shop written three ways as one shop', () => {
    // These fields are typed by hand and read off slips. A matcher that is case- and
    // space-sensitive tells somebody looking at a pile of the same receipt that there is
    // nothing else like it.
    const found = relatedRecords('zzz', { by: 'counterparty', value: '  reliance FRESH ' }, page, 10);
    expect(found.map((entry) => entry.id)).toEqual(['a', 'b', 'd']);
  });

  it('never includes the record being read', () => {
    for (const id of ['a', 'b', 'd']) {
      const found = relatedRecords(id, { by: 'counterparty', value: 'Reliance Fresh' }, page, 10);
      expect(found.map((entry) => entry.id)).not.toContain(id);
    }
  });

  it('matches on the folder when that is the link', () => {
    const found = relatedRecords('a', { by: 'category', value: 'Groceries' }, page, 10);
    expect(found.map((entry) => entry.id)).toEqual(['b', 'd', 'e']);
  });

  it('does not match a record whose field is empty', () => {
    const blanks = [near('x', null, null), near('y', '', ''), near('z', '  ', '  ')];
    expect(relatedRecords('a', { by: 'counterparty', value: 'Airtel' }, blanks, 10)).toEqual([]);
    expect(relatedRecords('a', { by: 'category', value: 'Groceries' }, blanks, 10)).toEqual([]);
  });

  it('stops at the cap, keeping the order it was given', () => {
    const found = relatedRecords('a', { by: 'category', value: 'Groceries' }, page, 2);
    expect(found.map((entry) => entry.id)).toEqual(['b', 'd']);
    expect(relatedRecords('a', { by: 'category', value: 'Groceries' }, page, 0)).toEqual([]);
    expect(relatedRecords('a', { by: 'category', value: 'Groceries' }, [], 4)).toEqual([]);
  });

  it('matches only the field the link names', () => {
    // A name match must not quietly widen into a folder match: "more with Airtel" showing
    // every phone bill would be the app claiming a link the person can't see on the rows.
    const found = relatedRecords('c', { by: 'counterparty', value: 'Airtel' }, page, 10);
    expect(found).toEqual([]);
  });
});
