import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pure parsers, and how much of a file `ingestFile` reads before it hands them anything.
 *
 * The parsers need nothing but a string, and they are where the logic that can be wrong
 * actually lives. `ingestFile` is exercised too, through the one seam that cannot exist in
 * Node — the byte layer in `./read-file` — because *how much* of a file is read is not a
 * property of any parser: a 100 MB `.log` or `.csv` is inside the store's own limit and used
 * to arrive here as a 100 MB buffer plus three copies of a 100 MB string, which is an
 * out-of-memory kill on a handset before a single one of these parsers sees it.
 */

const mocks = vi.hoisted(() => ({
  /** The one file the stand-in filesystem holds, in full. */
  fileBytes: new Uint8Array(),
  /** Every call ingestion made into the byte layer, in order, so a test can see what it did *not* do. */
  reads: [] as string[],
  /** How many bytes the ZIP-office parser was handed, to pin that it still gets the whole archive. */
  officeBytesSeen: 0,
}));

/**
 * Stands in for the byte layer.
 *
 * Hand-listed rather than spread from `importOriginal`: `./read-file` statically imports
 * `expo-file-system`, whose package exports point at untranspiled TypeScript, so the real
 * module cannot be loaded in this process at all. That is the same reason `ingest.ts` reaches
 * it through a dynamic import, and the three other suites that go through `ingestFile` stand it
 * up the same way.
 *
 * It is a faithful little filesystem rather than a bag of return values, because the properties
 * under test are relations between these calls — that the prefix is bounded while the digest is
 * not, that a short file takes the plain read — and a stub that answered each call in isolation
 * could not tell them apart.
 */
vi.mock('../src/services/ingestion/read-file', async () => {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  const { digestStream } = await import('../src/services/storage/stream-copy');
  return {
    readBytes: async () => {
      mocks.reads.push('readBytes');
      return mocks.fileBytes;
    },
    readPrefix: async (_uri: string, limit: number) => {
      mocks.reads.push(`readPrefix:${limit}`);
      const totalBytes = mocks.fileBytes.length;
      return { bytes: mocks.fileBytes.slice(0, Math.min(limit, totalBytes)), totalBytes };
    },
    sha256Hex: (bytes: Uint8Array) => bytesToHex(sha256(bytes)),
    sha256File: async (_uri: string, totalBytes: number) => {
      mocks.reads.push(`sha256File:${totalBytes}`);
      // The real streaming digest over a cursor on the whole file, so this stands in for the
      // device read instead of short-circuiting the thing the test is about to assert on.
      let offset = 0;
      return await digestStream({
        source: {
          readBytes: (length: number) => {
            const chunk = mocks.fileBytes.subarray(offset, offset + length);
            offset += chunk.length;
            return chunk;
          },
        },
        totalBytes,
        yieldToHost: async () => {},
      });
    },
    fileSize: async () => mocks.fileBytes.length,
  };
});

/**
 * The real ZIP reader, with a note of how many bytes it was given.
 *
 * Spread from `importOriginal` — `./office-docs` is pure and loads here — so the archive walk
 * is the production one and only the observation is added.
 */
vi.mock('../src/services/ingestion/office-docs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/ingestion/office-docs')>();
  return {
    ...original,
    extractOfficeText: (bytes: Uint8Array, kind: Parameters<typeof original.extractOfficeText>[1]) => {
      mocks.officeBytesSeen = bytes.length;
      return original.extractOfficeText(bytes, kind);
    },
  };
});

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  decodeQuotedPrintable,
  decodeUtf8,
  fileExtension,
  flattenCsvRows,
  ingestFile,
  looksBinary,
  parseCsv,
  parseEml,
  stripRtf,
  trimPartialUtf8,
  TEXT_PREFIX_BYTES,
} from '@services/ingestion/ingest';
import type { PickedFile } from '@services/ingestion/types';

describe('parseCsv', () => {
  it('splits a simple grid', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps a comma that sits inside a quoted field', () => {
    // The whole reason a real parser is needed instead of split(',').
    expect(parseCsv('name,amount\n"Harbour Retail, Pvt Ltd",85000')).toEqual([
      ['name', 'amount'],
      ['Harbour Retail, Pvt Ltd', '85000'],
    ]);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parseCsv('note\n"He said ""paid in full"" on Tuesday"')).toEqual([
      ['note'],
      ['He said "paid in full" on Tuesday'],
    ]);
  });

  it('keeps a newline that sits inside a quoted field', () => {
    const rows = parseCsv('id,description\n1,"line one\nline two"');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['1', 'line one\nline two']);
  });

  it('preserves empty fields rather than dropping them', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
    expect(parseCsv('a,b,')).toEqual([['a', 'b', '']]);
    expect(parseCsv(',b,c')).toEqual([['', 'b', 'c']]);
  });

  it('does not emit a trailing empty row for a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('normalizes CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('parses tab-separated input when told to', () => {
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles an unterminated quote without throwing or looping', () => {
    expect(() => parseCsv('a,"unterminated')).not.toThrow();
    expect(parseCsv('a,"unterminated')).toEqual([['a', 'unterminated']]);
  });

  it('returns no rows for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('flattenCsvRows', () => {
  it('labels each value with its column header so the extractor can find it', () => {
    const text = flattenCsvRows(
      parseCsv('Invoice No,Total,Date\nINV-2024-018,INR 85000.00,2024-03-12'),
    );
    expect(text).toContain('Invoice No: INV-2024-018');
    expect(text).toContain('Total: INR 85000.00');
    expect(text).toContain('Date: 2024-03-12');
  });

  it('separates rows into blocks', () => {
    const text = flattenCsvRows(parseCsv('Ref,Amount\nA-1,100\nA-2,200'));
    expect(text).toContain('Row 1');
    expect(text).toContain('Row 2');
    expect(text).toContain('Ref: A-1');
    expect(text).toContain('Ref: A-2');
  });

  it('names unlabelled columns rather than emitting a bare colon', () => {
    const text = flattenCsvRows(parseCsv('Ref,\nA-1,extra'));
    expect(text).toContain('Column 2: extra');
    expect(text).not.toContain(': extra\n: ');
  });

  it('skips empty cells', () => {
    const text = flattenCsvRows(parseCsv('Ref,Amount,Note\nA-1,,hello'));
    expect(text).toContain('Ref: A-1');
    expect(text).toContain('Note: hello');
    expect(text).not.toContain('Amount:');
  });

  it('falls back to a joined line for a single-row file with no data rows', () => {
    expect(flattenCsvRows(parseCsv('just,one,row'))).toBe('just | one | row');
  });

  it('returns an empty string when there is nothing readable', () => {
    expect(flattenCsvRows([])).toBe('');
    expect(flattenCsvRows(parseCsv('\n\n'))).toBe('');
  });
});

describe('parseEml', () => {
  const simple = [
    'From: Ravi Menon <ravi@harbourretail.example>',
    'To: accounts@pixelwave.example',
    'Subject: Invoice INV-2024-018',
    'Date: Tue, 12 Mar 2024 09:15:00 +0530',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please find the invoice attached. Total is INR 85,000.00.',
    '',
  ].join('\n');

  it('splits headers from the body on the first blank line', () => {
    const parsed = parseEml(simple);
    expect(parsed.headers['subject']).toBe('Invoice INV-2024-018');
    expect(parsed.headers['from']).toBe('Ravi Menon <ravi@harbourretail.example>');
    expect(parsed.body).toBe('Please find the invoice attached. Total is INR 85,000.00.');
  });

  it('surfaces From/To/Subject/Date as leading lines', () => {
    const lines = parseEml(simple).text.split('\n');
    expect(lines[0]).toBe('From: Ravi Menon <ravi@harbourretail.example>');
    expect(lines).toContain('Subject: Invoice INV-2024-018');
    expect(lines).toContain('Date: Tue, 12 Mar 2024 09:15:00 +0530');
    expect(parseEml(simple).text).toContain('Total is INR 85,000.00');
  });

  it('lowercases header names so lookups are predictable', () => {
    const parsed = parseEml('SUBJECT: Shouty\nFrOm: a@b.example\n\nbody');
    expect(parsed.headers['subject']).toBe('Shouty');
    expect(parsed.headers['from']).toBe('a@b.example');
  });

  it('unfolds a header continued on the next line', () => {
    const parsed = parseEml(
      'Subject: Invoice INV-2024-018\n for the March\n\tretainer\n\nbody text',
    );
    expect(parsed.headers['subject']).toBe('Invoice INV-2024-018 for the March retainer');
  });

  it('decodes a quoted-printable body', () => {
    const raw = [
      'Subject: Payment',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      // The trailing `=` is a soft line break, so these two source lines are one
      // logical line once decoded.
      'Total is =E2=82=B985,000 and the balance =',
      'is due on Tuesday=2E',
    ].join('\n');
    const parsed = parseEml(raw);
    // =E2=82=B9 is the rupee sign.
    expect(parsed.body).toContain('₹85,000');
    expect(parsed.body).toContain('balance is due on Tuesday.');
  });

  it('decodes a base64 body', () => {
    const raw = [
      'Subject: Encoded',
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: base64',
      '',
      'UGFpZCBJTlIgNDAsMDAwLjAwIG9uIDI2LzAzLzIwMjQ=',
    ].join('\n');
    expect(parseEml(raw).body).toBe('Paid INR 40,000.00 on 26/03/2024');
  });

  it('prefers the text/plain part of a multipart message', () => {
    const raw = [
      'Subject: Multipart',
      'Content-Type: multipart/alternative; boundary="sep123"',
      '',
      '--sep123',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This is the plain text part with INR 1,200.00.',
      '',
      '--sep123',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><p>This is the HTML part.</p></body></html>',
      '',
      '--sep123--',
      '',
    ].join('\n');
    const parsed = parseEml(raw);
    expect(parsed.body).toContain('plain text part with INR 1,200.00');
    expect(parsed.body).not.toContain('HTML part');
  });

  it('falls back to stripped HTML when there is no plain part', () => {
    const raw = [
      'Subject: HTML only',
      'Content-Type: multipart/alternative; boundary=sep',
      '',
      '--sep',
      'Content-Type: text/html',
      '',
      '<html><body><p>Balance outstanding:</p><p>INR 45,000.00</p></body></html>',
      '',
      '--sep--',
      '',
    ].join('\n');
    const parsed = parseEml(raw);
    expect(parsed.body).toContain('Balance outstanding:');
    expect(parsed.body).toContain('INR 45,000.00');
    expect(parsed.body).not.toContain('<p>');
  });

  it('decodes an RFC 2047 encoded-word subject in the surfaced text', () => {
    const raw = 'Subject: =?utf-8?B?SW52b2ljZSBvdmVyZHVl?=\nFrom: a@b.example\n\nbody';
    expect(parseEml(raw).text).toContain('Subject: Invoice overdue');
  });

  it('handles an email with headers but no body', () => {
    const parsed = parseEml('Subject: Empty\nFrom: a@b.example');
    expect(parsed.headers['subject']).toBe('Empty');
    expect(parsed.body).toBe('');
    expect(parsed.text).toContain('Subject: Empty');
  });

  it('does not throw on empty or malformed input', () => {
    expect(() => parseEml('')).not.toThrow();
    expect(() => parseEml('no headers at all, just text')).not.toThrow();
    expect(parseEml('').text).toBe('');
  });
});

/**
 * The RTF reader.
 *
 * `.rtf` used to sit only in `TEXT_EXTENSIONS`, so a letter written in Word had its *markup*
 * stored as its text — `{\rtf1\ansi\deff0{\fonttbl{\f0\fnil\fcharset0 Calibri;}}` and all. Every
 * instruction after that reached the rule engine, the entity pass and any citation drawn from the
 * file, which is how a conflict finding could quote `\sa200\sl276\slmult1` as if it were a
 * sentence. These tests pin what comes out instead: the document's own characters, with only the
 * instructions that draw them removed.
 */
describe('stripRtf', () => {
  it('returns null for a file that is not RTF at all', () => {
    // The caller falls through to the plain-text branch on null, so a `.txt` someone renamed to
    // `.rtf` still reads as text rather than being handed to a stripper that would mangle it.
    expect(stripRtf('PAYMENT CONFIRMATION\nTotal: INR 40,000.00\n')).toBeNull();
    expect(stripRtf('')).toBeNull();
  });

  it('reads the text of a document and drops the instructions that draw it', () => {
    const source =
      '{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}\n' +
      '{\\*\\generator Riched20 10.0.19041}\\viewkind4\\uc1 \n' +
      '\\pard\\sa200\\sl276\\slmult1\\f0\\fs22\\lang9 Payment of INR 40,000.00 was made on 26/03/2024.\\par\n' +
      'Invoice No: INV-4471\\par\n}';

    expect(stripRtf(source)).toBe(
      'Payment of INR 40,000.00 was made on 26/03/2024.\nInvoice No: INV-4471',
    );
  });

  it('keeps font, colour and style tables out of the text', () => {
    const source =
      '{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}{\\f1\\fnil\\fcharset0 Times New Roman;}}' +
      '{\\colortbl;\\red0\\green0\\blue0;\\red255\\green0\\blue0;}' +
      '{\\stylesheet{\\s0 Normal;}}{\\*\\generator Riched20}Total: INR 1,200.00\\par}';

    const text = stripRtf(source);

    expect(text).toBe('Total: INR 1,200.00');
    expect(text).not.toContain('Calibri');
    expect(text).not.toContain('Times New Roman');
    expect(text).not.toContain('Normal');
    expect(text).not.toContain('red');
  });

  it('drops a destination the writer marked as ignorable', () => {
    const source = '{\\rtf1\\ansi{\\*\\company ABC Limited}Payment received\\par}';

    expect(stripRtf(source)).toBe('Payment received');
  });

  it('turns paragraph marks into newlines and cell boundaries into tabs', () => {
    const source = '{\\rtf1\\ansi Invoice No:\\tab INV-4471\\par Amount:\\tab INR 1,200.00\\par}';

    expect(stripRtf(source)).toBe('Invoice No:\tINV-4471\nAmount:\tINR 1,200.00');
  });

  it('decodes byte escapes through Windows-1252, not Latin-1', () => {
    // 0x93 and 0x94 are the curly quotes Word substitutes for every " — the whole reason the
    // CP1252 table exists, since read as Latin-1 these bytes are invisible control codes.
    const source = "{\\rtf1\\ansi He said \\'93paid in full\\'94 on 26/03/2024\\par}";

    expect(stripRtf(source)).toBe('He said \u201cpaid in full\u201d on 26/03/2024');
  });

  it('takes a Unicode character and discards the ASCII stand-in beside it', () => {
    const source = '{\\rtf1\\ansi Amount due: \\u8377?INR 1,200.00\\par}';

    expect(stripRtf(source)).toBe('Amount due: \u20b9INR 1,200.00');
  });

  it('honours \\uc0, where the file itself states there is no stand-in to skip', () => {
    // Skipping a character here would eat the first digit of the amount.
    const source = '{\\rtf1\\ansi\\uc0 Total: \\u8377 2400\\par}';

    expect(stripRtf(source)).toBe('Total: \u20b92400');
  });

  it('keeps an escaped brace a character rather than a group boundary', () => {
    const source = '{\\rtf1\\ansi Total: INR 1,200.00 \\{per the note\\}\\par}';

    expect(stripRtf(source)).toBe('Total: INR 1,200.00 {per the note}');
  });

  it('reads a hard-wrapped source line as a space rather than joining the words', () => {
    const source = '{\\rtf1\\ansi\\fs22 ANY\nMONEY OR OTHER\nCONSIDERATION\\par}';

    expect(stripRtf(source)).toBe('ANY MONEY OR OTHER CONSIDERATION');
  });

  it('does not turn the line a control word ends on into a space', () => {
    // Word's own shape: the newline after `\uc1` is source layout. Turning it into a space would
    // split the reference in half.
    const source = '{\\rtf1\\ansi\\fs22\\uc1 \nINV-4471\\par}';

    expect(stripRtf(source)).toBe('INV-4471');
  });

  it('reports an RTF file holding no text as empty, not as not-RTF', () => {
    // The distinction is what lets the caller say honestly that the file has no text, instead of
    // storing markup as though it were the document.
    const source = '{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}\\pard\\f0\\fs22\\par}';

    expect(stripRtf(source)).toBe('');
  });

  it('never throws on a malformed file', () => {
    // Untrusted bytes, walked on the UI thread: every position has to be bounds-checked.
    for (const source of [
      '{\\rtf1\\ansi broken',
      '{\\rtf1\\ansi }}}',
      '{\\rtf1\\ansi trailing\\',
      '{\\rtf1\\ansi\\bin5\\par}',
      '{\\rtf1',
      '{\\rtf1\\ansi{\\*unterminated destination',
    ]) {
      expect(() => stripRtf(source)).not.toThrow();
    }
  });

  it('caps how much text one file can contribute', () => {
    const source = `{\\rtf1\\ansi ${'A'.repeat(1_200_000)}\\par}`;

    const text = stripRtf(source);

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(1_000_000);
  });
});

describe('looksBinary', () => {
  it('accepts ordinary text', () => {
    expect(looksBinary('Invoice Number: INV-2024-018\nTotal: INR 85,000.00\n')).toBe(false);
  });

  it('accepts text containing tabs and CRLF', () => {
    expect(looksBinary('a\tb\r\nc\td\r\n')).toBe(false);
  });

  it('treats any NUL byte as decisive', () => {
    expect(looksBinary('mostly fine text\u0000with a nul')).toBe(true);
  });

  it('rejects a run of control characters', () => {
    expect(looksBinary('\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u000e\u000f\u0010')).toBe(true);
  });

  it('rejects text that is mostly replacement characters', () => {
    expect(looksBinary('\ufffd'.repeat(50) + 'text')).toBe(true);
  });

  it('tolerates a small number of odd characters in a long document', () => {
    expect(looksBinary(`${'normal readable text. '.repeat(50)}\u0001`)).toBe(false);
  });

  it('calls empty input text, not binary', () => {
    expect(looksBinary('')).toBe(false);
  });
});

describe('decodeUtf8', () => {
  const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('round-trips ASCII', () => {
    expect(decodeUtf8(enc('Invoice INV-2024-018'))).toBe('Invoice INV-2024-018');
  });

  it('decodes multi-byte characters', () => {
    expect(decodeUtf8(enc('Total ₹85,000'))).toBe('Total ₹85,000');
    expect(decodeUtf8(enc('café'))).toBe('café');
  });

  it('decodes characters outside the BMP', () => {
    expect(decodeUtf8(enc('receipt \u{1F9FE}'))).toBe('receipt \u{1F9FE}');
  });

  it('strips a UTF-8 byte-order mark', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('Ref: A-1')]);
    expect(decodeUtf8(withBom)).toBe('Ref: A-1');
  });

  it('replaces invalid sequences instead of throwing', () => {
    expect(() => decodeUtf8(new Uint8Array([0xff, 0xfe, 0x41]))).not.toThrow();
    expect(decodeUtf8(new Uint8Array([0xff, 0xfe, 0x41]))).toContain('A');
    expect(decodeUtf8(new Uint8Array([0xe2, 0x82]))).toContain('\ufffd');
  });

  it('returns an empty string for empty input', () => {
    expect(decodeUtf8(new Uint8Array(0))).toBe('');
  });

  it('handles input longer than its internal flush chunk', () => {
    const long = 'x'.repeat(5000);
    expect(decodeUtf8(enc(long))).toBe(long);
  });
});

describe('decodeQuotedPrintable', () => {
  it('decodes hex escapes', () => {
    expect(decodeQuotedPrintable('Tuesday=2E')).toBe('Tuesday.');
  });

  it('joins soft line breaks', () => {
    expect(decodeQuotedPrintable('one =\ntwo')).toBe('one two');
  });

  it('leaves a lone equals sign alone rather than throwing', () => {
    expect(() => decodeQuotedPrintable('a = b')).not.toThrow();
  });
});

describe('fileExtension', () => {
  it('returns the lowercase extension including the dot', () => {
    expect(fileExtension('Invoice.PDF')).toBe('.pdf');
    expect(fileExtension('scan.jpeg')).toBe('.jpeg');
    expect(fileExtension('archive.tar.gz')).toBe('.gz');
  });

  it('returns an empty string when there is no usable extension', () => {
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('.gitignore')).toBe('');
    expect(fileExtension('trailing.')).toBe('');
  });
});

describe('trimPartialUtf8', () => {
  const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('leaves a buffer that ends on a complete character exactly as it is', () => {
    const bytes = enc('Total ₹85,000');
    // The same buffer back, not a copy: nothing dangles, so there is nothing to do.
    expect(trimPartialUtf8(bytes)).toBe(bytes);
  });

  it('drops a three-byte character the read stopped inside', () => {
    const full = enc('Total ₹');
    for (const cut of [full.length - 1, full.length - 2]) {
      const short = full.subarray(0, cut);
      // Without the trim this is what the text branch would have decoded, and U+FFFD is what
      // `looksBinary` counts towards calling the file binary.
      expect(decodeUtf8(short)).toContain('�');
      expect(decodeUtf8(trimPartialUtf8(short))).toBe('Total ');
    }
  });

  it('drops a four-byte character the read stopped inside', () => {
    const full = enc('receipt \u{1F9FE}');
    expect(decodeUtf8(trimPartialUtf8(full.subarray(0, full.length - 3)))).toBe('receipt ');
  });

  it('leaves bytes that were already invalid in the file rather than tidying them away', () => {
    const bytes = new Uint8Array([0x41, 0xff]);
    expect(trimPartialUtf8(bytes)).toBe(bytes);
  });

  it('returns empty input unchanged', () => {
    const bytes = new Uint8Array(0);
    expect(trimPartialUtf8(bytes)).toBe(bytes);
  });
});

describe('ingestFile — how much of a file it reads', () => {
  const encoder = new TextEncoder();
  const digestOfWholeFile = (): string => bytesToHex(sha256(mocks.fileBytes));

  /** The picked file, as `requestEvidenceProcessing` builds it from a stored record. */
  const picked = (name: string, size: number | null = mocks.fileBytes.length): PickedFile => ({
    uri: 'file:///stored-original',
    name,
    mimeType: null,
    size,
  });

  /** A log longer than the prefix, marked at both ends so a test can see where reading stopped. */
  function longLog(): string {
    const line = 'INFO  transfer queued for settlement\n';
    const filler = line.repeat(Math.ceil(TEXT_PREFIX_BYTES / line.length) + 64);
    return `Paid INR 40,000.00 on 26/03/2024\n${filler}LAST LINE closing balance INR 12,000.00\n`;
  }

  beforeEach(() => {
    mocks.fileBytes = new Uint8Array();
    mocks.reads = [];
    mocks.officeBytesSeen = 0;
  });

  it('reads only the start of a large log, and still hashes every byte of it', async () => {
    mocks.fileBytes = encoder.encode(longLog());

    const result = await ingestFile(picked('gateway.log'));

    // The bounded read is the only read there was: the whole file never became a buffer, and
    // the string of it and `parseCsv`'s two copies of that string never happened either.
    expect(mocks.reads).toEqual([
      `readPrefix:${TEXT_PREFIX_BYTES}`,
      `sha256File:${mocks.fileBytes.length}`,
    ]);
    expect(result.text.length).toBeLessThanOrEqual(TEXT_PREFIX_BYTES);
    expect(result.text).toContain('Paid INR 40,000.00 on 26/03/2024');
    expect(result.text).not.toContain('LAST LINE');

    // The digest is of the file, not of the part of it that was read. It is the stored
    // original's fingerprint: `requestEvidenceProcessing` checks it against the one taken at
    // store time and `verifyEvidenceFile` re-reads the stored file against it later, so a hash
    // of the prefix would be a valid hash of the wrong bytes and would verify forever after.
    expect(result.sha256).toBe(digestOfWholeFile());
    expect(result.sha256).not.toBe(bytesToHex(sha256(mocks.fileBytes.slice(0, TEXT_PREFIX_BYTES))));
    expect(result.bytes).toBe(mocks.fileBytes.length);
  });

  it('says plainly in the note that only part of the file was read', async () => {
    mocks.fileBytes = encoder.encode(longLog());

    const result = await ingestFile(picked('gateway.log'));

    expect(result.note).toContain('Read this file as plain text.');
    expect(result.note).toContain('only its first 2 MB were read');
    expect(result.note).toContain('The whole file is stored unchanged');
    // The reading is the same reading it always was — there was simply less of the file behind
    // it — so `method` must not claim a different kind of pass.
    expect(result.method).toBe('plain-text');
  });

  it('leaves a small file on exactly the path it took before: one plain read, one direct hash', async () => {
    const text = 'PAYMENT CONFIRMATION\nTotal amount paid: INR 40,000.00 on 26/03/2024\n';
    mocks.fileBytes = encoder.encode(text);

    const result = await ingestFile(picked('confirmation.txt'));

    expect(mocks.reads).toEqual(['readBytes']);
    expect(result).toMatchObject({
      kind: 'TEXT',
      text,
      method: 'plain-text',
      units: null,
      needsOcr: false,
      note: 'Read this file as plain text.',
      bytes: mocks.fileBytes.length,
      sha256: digestOfWholeFile(),
    });
  });

  it('reads a short file whole even when the record carries no size for it', async () => {
    // A record old enough to have no recorded size takes the bounded path, which measures the
    // file and finds there is nothing to bound. The result has to be identical in every part —
    // this is a ceiling on how much is read, not a second way of reading.
    const text = 'Total: INR 1,200.00\n';
    mocks.fileBytes = encoder.encode(text);

    const result = await ingestFile(picked('note.txt', null));

    expect(mocks.reads).toEqual([`readPrefix:${TEXT_PREFIX_BYTES}`]);
    expect(result.text).toBe(text);
    expect(result.note).toBe('Read this file as plain text.');
    expect(result.sha256).toBe(digestOfWholeFile());
  });

  it('drops the row a CSV prefix was cut in the middle of', async () => {
    const row = (n: number): string => `A-${String(n).padStart(6, '0')},${'note '.repeat(200)},1200.00\n`;
    // The row the cut lands in: everything up to the first three digits of its amount is inside
    // the prefix, so `parseCsv` would flush `999` as if it were the whole of `99999.99`.
    const cutRow = `B-999999,${'y'.repeat(1000)},99999.99\n`;
    const target = TEXT_PREFIX_BYTES - 'B-999999,'.length - 1000 - ','.length - '999'.length;

    let head = 'Ref,Notes,Amount\n';
    let complete = 0;
    for (; head.length + row(complete).length <= target; complete += 1) head += row(complete);
    // A short final row, so the cut lands exactly where this test says it does.
    const pad = target - head.length;
    if (pad > 0) {
      head += `${'P'.repeat(pad - 1)}\n`;
      complete += 1;
    }

    mocks.fileBytes = encoder.encode(`${head}${cutRow}${row(900).repeat(20)}`);

    const result = await ingestFile(picked('transactions.csv'));

    expect(result.method).toBe('csv-flatten');
    // Gone entirely, rather than presented among the complete rows with `999` where its amount
    // should be. A half-written figure read as a whole one is the error this product exists to
    // prevent, and at roughly two thousand rows this file is well inside `MAX_CSV_ROWS`, so
    // nothing else would have kept the cut row out of the flattened text.
    expect(result.text).not.toContain('B-999999');
    expect(result.text).not.toContain('Amount: 999');
    // Exactly one row was dropped: every complete row in the prefix is still counted and read.
    expect(result.units).toBe(complete);
    expect(complete).toBeGreaterThan(1000);
    expect(result.text).toContain('Ref: A-000000');
    expect(result.text).toContain('Amount: 1200.00');
    expect(result.note).toContain('only its first 2 MB were read');
    expect(result.sha256).toBe(digestOfWholeFile());
  });

  it('does not let a prefix that ends mid-character become a replacement character', async () => {
    // The rupee sign is three bytes and the read stops after the first of them. Left in place it
    // decodes to U+FFFD, which `looksBinary` counts towards calling the whole file unreadable.
    mocks.fileBytes = encoder.encode(`${'A'.repeat(TEXT_PREFIX_BYTES - 1)}₹${'B'.repeat(4096)}`);

    const result = await ingestFile(picked('statement.txt'));

    expect(result.method).toBe('plain-text');
    expect(result.text).not.toContain('�');
    expect(result.text.length).toBe(TEXT_PREFIX_BYTES - 1);
  });

  it('reads a PDF whole, because what makes it readable is at the end of the file', async () => {
    // The text object sits past the prefix. A bounded read would take the filler and report a
    // PDF with no text layer — a document that reads perfectly today, suddenly unreadable.
    const content = 'BT /F1 12 Tf 72 720 Td (Paid INR 40,000.00 on 26/03/2024) Tj ET';
    mocks.fileBytes = encoder.encode(
      '%PDF-1.4\n' +
        `%${'x'.repeat(TEXT_PREFIX_BYTES)}\n` +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
        `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n` +
        'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    );

    const result = await ingestFile(picked('bank-reply.pdf'));

    expect(mocks.reads).toEqual(['readBytes']);
    expect(result.method).toBe('pdf-text-layer');
    expect(result.text).toContain('Paid INR 40,000.00 on 26/03/2024');
    expect(result.note).not.toContain('only its first');
    // Hashed in chunks rather than in one synchronous pass over the whole buffer, and the value
    // is the same value that pass produced.
    expect(result.sha256).toBe(digestOfWholeFile());
  });

  it('reads a ZIP-office file whole, because its central directory is at the end', async () => {
    mocks.fileBytes = encoder.encode(`PK${'x'.repeat(TEXT_PREFIX_BYTES + 1024)}`);

    const result = await ingestFile(picked('contract.docx'));

    expect(mocks.reads).toEqual(['readBytes']);
    // The archive walk got every byte, not the first two megabytes of them.
    expect(mocks.officeBytesSeen).toBe(mocks.fileBytes.length);
    expect(result.bytes).toBe(mocks.fileBytes.length);
    expect(result.sha256).toBe(digestOfWholeFile());
  });
});

/**
 * `.rtf` end to end, through `ingestFile`.
 *
 * The parser has its own suite above; what these pin is that the file reaches it at all. `.rtf`
 * is a member of both `TEXT_EXTENSIONS` and `DOCUMENT_EXTENSIONS`, so before the RTF branch
 * existed the file fell through to the plain-text read and its markup was stored as its text.
 */
describe('ingestFile — RTF', () => {
  const encoder = new TextEncoder();

  const picked = (name: string): PickedFile => ({
    uri: 'file:///stored-original',
    name,
    mimeType: null,
    size: mocks.fileBytes.length,
  });

  beforeEach(() => {
    mocks.fileBytes = new Uint8Array();
    mocks.reads = [];
  });

  it("stores a letter's text instead of its markup", async () => {
    mocks.fileBytes = encoder.encode(
      '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}\n' +
        '\\pard\\f0\\fs22\\lang9 Payment of INR 40,000.00 was made on 26/03/2024.\\par\n' +
        'Invoice No: INV-4471\\par\n}',
    );

    const result = await ingestFile(picked('letter.rtf'));

    expect(result).toMatchObject({
      kind: 'DOCUMENT',
      text: 'Payment of INR 40,000.00 was made on 26/03/2024.\nInvoice No: INV-4471',
      // The document's own characters, with only its instructions removed — the same trust as
      // decoding a `.txt`, and deliberately not `ocr`, because nothing was read off pixels.
      method: 'plain-text',
      units: null,
      needsOcr: false,
      bytes: mocks.fileBytes.length,
    });
    // The two things that used to be stored as evidence: the header, and a font name.
    expect(result.text).not.toContain('{\\rtf');
    expect(result.text).not.toContain('Calibri');
    expect(result.note).toBe('Read this file as text, with its formatting instructions removed.');
  });

  it('says so, rather than storing markup, when the RTF holds no text of its own', async () => {
    mocks.fileBytes = encoder.encode(
      '{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}\\pard\\f0\\fs22\\par}',
    );

    const result = await ingestFile(picked('blank.rtf'));

    expect(result.text).toBe('');
    expect(result.method).toBe('none');
    expect(result.needsOcr).toBe(false);
    expect(result.note).toContain('holds no text of its own');
  });

  it('still reads a file that is merely named `.rtf` as plain text', async () => {
    const text = 'PAYMENT CONFIRMATION\nTotal: INR 40,000.00\n';
    mocks.fileBytes = encoder.encode(text);

    const result = await ingestFile(picked('mislabelled.rtf'));

    expect(result.text).toBe(text);
    expect(result.method).toBe('plain-text');
    expect(result.note).toBe('Read this file as plain text.');
  });

  it('says plainly when it could only read the start of a large RTF', async () => {
    // Well past the prefix, so the reader is handed a document cut off mid-sentence. What it
    // extracted is still real text; what it must not do is present it as the whole file.
    mocks.fileBytes = encoder.encode(
      `{\\rtf1\\ansi ${'Paid INR 40,000.00 on 26/03/2024 '.repeat(80_000)}\\par}`,
    );

    const result = await ingestFile(picked('statement.rtf'));

    expect(mocks.reads).toEqual([
      `readPrefix:${TEXT_PREFIX_BYTES}`,
      `sha256File:${mocks.fileBytes.length}`,
    ]);
    expect(result.method).toBe('plain-text');
    expect(result.note).toContain('Read this file as text, with its formatting instructions removed.');
    expect(result.note).toContain('only its first 2 MB were read');
    // The digest is of the file, not of the part of it that was read.
    expect(result.sha256).toBe(bytesToHex(sha256(mocks.fileBytes)));
  });
});
