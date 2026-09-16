import { describe, expect, it } from 'vitest';
import {
  decodeQuotedPrintable,
  decodeUtf8,
  fileExtension,
  flattenCsvRows,
  looksBinary,
  parseCsv,
  parseEml,
} from '@services/ingestion/ingest';

/**
 * These cover the pure parsers only. `ingestFile` itself reads from the device
 * filesystem through the Expo `File` class, which does not exist in Node, so it is
 * deliberately not exercised here — the parsers are where the logic that can be
 * wrong actually lives.
 */

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
