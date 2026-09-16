import { describe, expect, it } from 'vitest';
import { deflate } from 'pako';
import { extractPdfText } from '@services/ingestion/pdf-text';

/**
 * These tests build PDF bytes by hand rather than loading fixture files.
 *
 * An uncompressed content stream is the whole of what the extractor needs to see,
 * so a few hundred bytes of hand-written PDF exercises the real code path — and
 * unlike a binary fixture, the input stays readable in the diff.
 */

/** Latin1 string to bytes: one char, one byte. Mirrors the extractor's decode. */
const bytes = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

/** Wraps a content stream in enough PDF scaffolding to look like a 1-page file. */
const pdfWithContent = (content: string): Uint8Array =>
  bytes(
    `%PDF-1.4\n` +
      `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n` +
      `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n` +
      `trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );

/** Same, but with the content stream FlateDecode-compressed for real. */
const pdfWithFlateContent = (content: string): Uint8Array => {
  const compressed = deflate(bytes(content));
  const head =
    `%PDF-1.4\n` +
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n` +
    `4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`;
  const tail = `\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  const headBytes = bytes(head);
  const tailBytes = bytes(tail);
  const out = new Uint8Array(headBytes.length + compressed.length + tailBytes.length);
  out.set(headBytes, 0);
  out.set(compressed, headBytes.length);
  out.set(tailBytes, headBytes.length + compressed.length);
  return out;
};

describe('extractPdfText', () => {
  it('reads a literal string shown with Tj', () => {
    const result = extractPdfText(
      pdfWithContent('BT /F1 12 Tf 72 720 Td (Invoice Number: INV-2024-018) Tj ET'),
    );
    expect(result.text).toContain('Invoice Number: INV-2024-018');
    expect(result.hadTextLayer).toBe(true);
  });

  it('concatenates the string parts of a TJ array', () => {
    const result = extractPdfText(
      pdfWithContent('BT [(Total: ) (INR ) (85,000.00)] TJ ET'),
    );
    expect(result.text).toContain('Total: INR 85,000.00');
  });

  it('treats a wide negative kerning gap in a TJ array as a word break', () => {
    // -250 thousandths of an em is a gap wide enough to be a space; -20 is not.
    const result = extractPdfText(pdfWithContent('BT [(Amount) -250 (paid)] TJ ET'));
    expect(result.text).toContain('Amount paid');
  });

  it('does not insert a space for a small kerning adjustment', () => {
    const result = extractPdfText(pdfWithContent('BT [(Inv) -20 (oice)] TJ ET'));
    expect(result.text).toContain('Invoice');
  });

  it('does not treat negative numbers outside a TJ array as spaces', () => {
    // The -500 here is a Td operand, not a kerning value inside an array.
    const result = extractPdfText(pdfWithContent('BT (Hello) Tj -500 0 Td (World) Tj ET'));
    expect(result.text).not.toContain('Hello World');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('World');
  });

  it('decodes hex strings', () => {
    const result = extractPdfText(
      pdfWithContent('BT <48656C6C6F2C20776F726C64> Tj ET'),
    );
    expect(result.text).toContain('Hello, world');
  });

  it('decodes a UTF-16BE hex string with a byte-order mark', () => {
    // FEFF BOM then "Hi" as two-byte code units.
    const result = extractPdfText(pdfWithContent('BT <FEFF00480069> Tj ET'));
    expect(result.text).toContain('Hi');
  });

  it('decodes three-digit octal escapes', () => {
    // \101\102\103 is "ABC".
    const result = extractPdfText(pdfWithContent('BT (\\101\\102\\103) Tj ET'));
    expect(result.text).toContain('ABC');
  });

  it('decodes the named string escapes', () => {
    const result = extractPdfText(
      pdfWithContent('BT (a\\tb) Tj (c\\(d\\)e) Tj (f\\\\g) Tj ET'),
    );
    // `\t` decodes to a real tab, which the final whitespace tidy-up then collapses
    // to a single space — hence `a b` rather than `a\tb`.
    expect(result.text).toContain('a b');
    expect(result.text).toContain('c(d)e');
    expect(result.text).toContain('f\\g');
  });

  it('decodes \\n inside a string to a real newline, not a literal backslash-n', () => {
    const result = extractPdfText(pdfWithContent('BT (first\\nsecond) Tj ET'));
    expect(result.text).not.toContain('\\n');
    const lines = result.text.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toContain('first');
    expect(lines).toContain('second');
  });

  it('is not confused by delimiters or operator names inside a string', () => {
    const result = extractPdfText(pdfWithContent('BT (ET (nested) [brackets]) Tj ET'));
    expect(result.text).toContain('ET (nested) [brackets]');
  });

  it("reads text shown by the ' and \" operators", () => {
    const result = extractPdfText(
      pdfWithContent("BT (first line) ' 0 0 (second line) \" ET"),
    );
    expect(result.text).toContain('first line');
    expect(result.text).toContain('second line');
  });

  it('keeps lines separate for Td, TD, T* and ET', () => {
    const result = extractPdfText(
      pdfWithContent(
        'BT (Invoice No: INV-1) Tj 0 -14 Td (Total: INR 500.00) Tj T* (Due: 2024-03-26) Tj ET',
      ),
    );
    const lines = result.text.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toContain('Invoice No: INV-1');
    expect(lines).toContain('Total: INR 500.00');
    expect(lines).toContain('Due: 2024-03-26');
  });

  it('reads a real FlateDecode-compressed content stream', () => {
    const result = extractPdfText(
      pdfWithFlateContent('BT (Payment received: INR 40,000.00) Tj ET'),
    );
    expect(result.text).toContain('Payment received: INR 40,000.00');
    expect(result.hadTextLayer).toBe(true);
  });

  it('skips a stream that claims FlateDecode but does not inflate, without throwing', () => {
    // The first stream is garbage labelled as compressed; the second is readable.
    const broken =
      `%PDF-1.4\n` +
      `3 0 obj\n<< /Type /Page >>\nendobj\n` +
      `4 0 obj\n<< /Length 20 /Filter /FlateDecode >>\nstream\n` +
      `\x00\x01\x02not-really-deflate\xff\n` +
      `endstream\nendobj\n` +
      `5 0 obj\n<< /Length 40 >>\nstream\nBT (Readable fallback text here) Tj ET\nendstream\nendobj\n` +
      `%%EOF\n`;
    const run = () => extractPdfText(bytes(broken));
    expect(run).not.toThrow();
    expect(run().text).toContain('Readable fallback text here');
  });

  it('reports no text layer for a scanned PDF that only holds an image', () => {
    const scanned = bytes(
      `%PDF-1.4\n` +
        `3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n` +
        `4 0 obj\n<< /Type /XObject /Subtype /Image /Width 800 /Height 1200 ` +
        `/Filter /DCTDecode /Length 12 >>\nstream\n\xff\xd8\xff\xe0jpegdata\nendstream\nendobj\n` +
        `%%EOF\n`,
    );
    const result = extractPdfText(scanned);
    expect(result.hadTextLayer).toBe(false);
    expect(result.text).toBe('');
  });

  it('reports no text layer when the text found is only a few characters', () => {
    const result = extractPdfText(pdfWithContent('BT (x) Tj ET'));
    expect(result.hadTextLayer).toBe(false);
  });

  it('counts pages from /Type /Page without counting /Type /Pages', () => {
    const threePages = bytes(
      `%PDF-1.4\n` +
        `2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R 6 0 R] /Count 3 >>\nendobj\n` +
        `3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n` +
        `5 0 obj\n<< /Type/Page /Contents 4 0 R >>\nendobj\n` +
        `6 0 obj\n<<  /Type   /Page  >>\nendobj\n` +
        `4 0 obj\n<< /Length 44 >>\nstream\nBT (Statement of account, page one) Tj ET\nendstream\nendobj\n` +
        `%%EOF\n`,
    );
    const result = extractPdfText(threePages);
    expect(result.pages).toBe(3);
  });

  it('falls back to one page when text was found but no page object was', () => {
    const noPageObject = bytes(
      `%PDF-1.4\n` +
        `4 0 obj\n<< /Length 46 >>\nstream\nBT (Some readable text with no page dict) Tj ET\nendstream\nendobj\n` +
        `%%EOF\n`,
    );
    const result = extractPdfText(noPageObject);
    expect(result.text).toContain('Some readable text with no page dict');
    expect(result.pages).toBe(1);
  });

  it('returns empty text for empty, tiny and non-PDF input instead of throwing', () => {
    for (const input of [
      new Uint8Array(0),
      bytes('not a pdf at all'),
      bytes('%PDF-1.4\n'),
      new Uint8Array([0, 255, 13, 10, 200, 7]),
    ]) {
      const result = extractPdfText(input);
      expect(result.hadTextLayer).toBe(false);
      expect(result.text).toBe('');
    }
  });

  it('survives a truncated stream with a wrong /Length', () => {
    const truncated = bytes(
      `%PDF-1.4\n4 0 obj\n<< /Length 99999 >>\nstream\nBT (Truncated but readable content) Tj ET`,
    );
    expect(() => extractPdfText(truncated)).not.toThrow();
  });

  it('handles an indirect /Length reference by finding endstream itself', () => {
    const indirect = bytes(
      `%PDF-1.4\n` +
        `3 0 obj\n<< /Type /Page >>\nendobj\n` +
        `4 0 obj\n<< /Length 7 0 R >>\nstream\nBT (Indirect length still readable) Tj ET\nendstream\nendobj\n` +
        `7 0 obj\n41\nendobj\n%%EOF\n`,
    );
    const result = extractPdfText(indirect);
    expect(result.text).toContain('Indirect length still readable');
  });

  it('does not mistake the word endstream for a stream start', () => {
    const result = extractPdfText(
      pdfWithContent('BT (Ends with endstream inside text) Tj ET'),
    );
    expect(result.text).toContain('Ends with endstream inside text');
  });

  it('skips a filter it cannot decode rather than emitting noise', () => {
    const lzw = bytes(
      `%PDF-1.4\n` +
        `3 0 obj\n<< /Type /Page >>\nendobj\n` +
        `4 0 obj\n<< /Length 18 /Filter /LZWDecode >>\nstream\n\x80\x0b\x60\x50\x22\x0c\x0c\x85\x01\nendstream\nendobj\n` +
        `%%EOF\n`,
    );
    const result = extractPdfText(lzw);
    expect(result.text).toBe('');
    expect(result.hadTextLayer).toBe(false);
  });

  it('is deterministic: the same bytes always give the same text', () => {
    const input = pdfWithContent('BT (Deterministic output matters) Tj ET');
    expect(extractPdfText(input)).toEqual(extractPdfText(input));
  });

  it('does not hang on a file with a huge number of streams', () => {
    // 900 streams, above the 400-stream cap. Must return promptly.
    let body = '%PDF-1.4\n3 0 obj\n<< /Type /Page >>\nendobj\n';
    for (let i = 0; i < 900; i += 1) {
      body += `${i} 0 obj\n<< /Length 24 >>\nstream\nBT (chunk ${i} text) Tj ET\nendstream\nendobj\n`;
    }
    const started = Date.now();
    const result = extractPdfText(bytes(body));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.text.length).toBeGreaterThan(0);
  });
});
