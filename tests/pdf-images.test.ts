import { describe, expect, it } from 'vitest';
import { deflate } from 'pako';

import { extractPdfImages, MAX_PAGE_IMAGES } from '../src/services/ingestion/pdf-images';

/**
 * These tests build PDFs byte by byte rather than checking in a scanned fixture.
 *
 * A committed scan would be opaque — when a test failed you could not see what the input
 * was — and it would be a real document, which is the one kind of file that must never go
 * into a repository for this product. Constructing the container here means the PDF under
 * test is readable in the diff, and it exercises the real stream walk rather than a mock.
 */

const encoder = new TextEncoder();

function bytes(...parts: (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : part));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * A byte sequence that opens and closes like a JPEG.
 *
 * `0xFF 0xD8 0xFF` then filler then `0xFF 0xD9`, which is exactly what `looksLikeJpeg`
 * checks and what a decoder sniffs. The filler deliberately includes the literal ASCII
 * `endstream`, because real JPEG entropy data contains arbitrary byte runs and the stream
 * walker must not truncate on the first textual match — see the `/Length` test below.
 */
function fakeJpeg(size: number, poison = false): Uint8Array {
  const out = new Uint8Array(Math.max(size, 16));
  out[0] = 0xff;
  out[1] = 0xd8;
  out[2] = 0xff;
  for (let at = 3; at < out.length - 2; at += 1) out[at] = (at * 31) % 251;
  if (poison) out.set(encoder.encode('endstream'), Math.floor(out.length / 2));
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

interface ImageObject {
  filter: string;
  data: Uint8Array;
  /** Extra dictionary entries, e.g. `/ImageMask true`. */
  extra?: string;
  /** Omit `/Length`, forcing the reader to search for `endstream`. */
  noLength?: boolean;
  subtype?: string;
}

/** A minimal PDF carrying the given image XObjects. Not a valid page tree — none is needed. */
function pdfWith(objects: readonly ImageObject[]): Uint8Array {
  const parts: (string | Uint8Array)[] = ['%PDF-1.4\n'];

  objects.forEach((object, index) => {
    const length = object.noLength ? '' : `/Length ${object.data.length} `;
    parts.push(
      `${index + 1} 0 obj\n<< /Type /XObject /Subtype ${object.subtype ?? '/Image'} ` +
        `/Width 1700 /Height 2200 /Filter ${object.filter} ${length}${object.extra ?? ''}>>\nstream\n`,
    );
    parts.push(object.data);
    parts.push('\nendstream\nendobj\n');
  });

  parts.push('trailer\n<< /Size 1 >>\n%%EOF\n');
  return bytes(...parts);
}

describe('extractPdfImages', () => {
  it('lifts a DCTDecode stream out verbatim as a JPEG', () => {
    const jpeg = fakeJpeg(20_000);
    const result = extractPdfImages(pdfWith([{ filter: '/DCTDecode', data: jpeg }]));

    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.encoding).toBe('dct');
    expect(result.images[0]!.extension).toBe('.jpg');
    // Verbatim is the whole claim of this module: the stream body *is* the JPEG file, so a
    // byte that differs means something re-encoded it.
    expect(Array.from(result.images[0]!.bytes)).toEqual(Array.from(jpeg));
  });

  /*
    The failure this prevents is silent, which is why it gets its own test. JPEG entropy data
    contains arbitrary bytes, so the ASCII `endstream` turns up inside real scans by chance.
    A reader that searched for that marker instead of trusting a verified `/Length` would cut
    the image in half — and a truncated JPEG still decodes, to a half-grey page, so OCR would
    simply return less text and the document would look like a bad scan.
  */
  it('uses a verified /Length rather than the first "endstream" inside the image data', () => {
    const jpeg = fakeJpeg(20_000, true);
    const result = extractPdfImages(pdfWith([{ filter: '/DCTDecode', data: jpeg }]));

    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.bytes.length).toBe(jpeg.length);
  });

  it('unwraps a [/FlateDecode /DCTDecode] filter chain', () => {
    const jpeg = fakeJpeg(20_000);
    const deflated = deflate(jpeg);
    const result = extractPdfImages(
      pdfWith([{ filter: '[/FlateDecode /DCTDecode]', data: deflated }]),
    );

    expect(result.images).toHaveLength(1);
    expect(Array.from(result.images[0]!.bytes)).toEqual(Array.from(jpeg));
  });

  it('reads every page image in a multi-page scan, in file order', () => {
    const pages = [fakeJpeg(20_000), fakeJpeg(24_000), fakeJpeg(28_000)];
    const result = extractPdfImages(
      pdfWith(pages.map((data) => ({ filter: '/DCTDecode', data }))),
    );

    expect(result.images).toHaveLength(3);
    expect(result.images.map((image) => image.bytes.length)).toEqual([20_000, 24_000, 28_000]);
    expect(result.truncated).toBe(false);
  });

  it('caps the page count and says so', () => {
    const many = Array.from({ length: MAX_PAGE_IMAGES + 4 }, () => ({
      filter: '/DCTDecode',
      data: fakeJpeg(20_000),
    }));
    const result = extractPdfImages(pdfWith(many));

    expect(result.images).toHaveLength(MAX_PAGE_IMAGES);
    expect(result.truncated).toBe(true);
  });

  /*
    A letterhead logo is on every page of a scanned statement. Two ML Kit passes each, on a
    document with eight pages, is pure latency for text that was never there.
  */
  it('ignores images too small to be a page', () => {
    const result = extractPdfImages(
      pdfWith([
        { filter: '/DCTDecode', data: fakeJpeg(2_000) },
        { filter: '/DCTDecode', data: fakeJpeg(20_000) },
      ]),
    );

    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.bytes.length).toBe(20_000);
  });

  it('drops a stencil mask, which is a shape rather than a page', () => {
    const result = extractPdfImages(
      pdfWith([{ filter: '/DCTDecode', data: fakeJpeg(20_000), extra: '/ImageMask true ' }]),
    );

    expect(result.images).toHaveLength(0);
  });

  it('refuses bytes that are not a JPEG even when the filter claims DCTDecode', () => {
    const notJpeg = new Uint8Array(20_000).fill(0x41);
    const result = extractPdfImages(pdfWith([{ filter: '/DCTDecode', data: notJpeg }]));

    expect(result.images).toHaveLength(0);
    expect(result.skippedUnsupported).toBe(true);
  });

  /*
    `skippedUnsupported` is the difference between two sentences the user sees: "this PDF has
    no images in it" and "this PDF's pages are in a format this build cannot read". Only the
    second one tells them that re-saving or re-scanning would help.
  */
  it.each([['/JPXDecode'], ['/CCITTFaxDecode'], ['/JBIG2Decode'], ['/FlateDecode']])(
    'reports %s as an unsupported page image rather than as no image',
    (filter) => {
      const result = extractPdfImages(pdfWith([{ filter, data: fakeJpeg(20_000) }]));

      expect(result.images).toHaveLength(0);
      expect(result.skippedUnsupported).toBe(true);
    },
  );

  it('ignores non-image streams entirely', () => {
    const result = extractPdfImages(
      pdfWith([
        { filter: '/FlateDecode', data: fakeJpeg(20_000), subtype: '/Form' },
        { filter: '/DCTDecode', data: fakeJpeg(20_000), subtype: '/Form' },
      ]),
    );

    expect(result.images).toHaveLength(0);
    expect(result.skippedUnsupported).toBe(false);
  });

  it('falls back to searching for endstream when /Length is absent', () => {
    // No poison bytes here: without a length hint the marker search is all there is, so the
    // image must not contain the marker. This is the degraded path, and it is honest about
    // being degraded.
    const jpeg = fakeJpeg(20_000);
    const result = extractPdfImages(pdfWith([{ filter: '/DCTDecode', data: jpeg, noLength: true }]));

    expect(result.images).toHaveLength(1);
  });

  it('never throws on arbitrary non-PDF bytes', () => {
    const junk = Uint8Array.from({ length: 4096 }, (_, index) => (index * 37) % 256);

    expect(() => extractPdfImages(junk)).not.toThrow();
    expect(extractPdfImages(junk).images).toHaveLength(0);
  });

  it('never throws on an empty buffer', () => {
    expect(() => extractPdfImages(new Uint8Array(0))).not.toThrow();
    expect(extractPdfImages(new Uint8Array(0)).images).toHaveLength(0);
  });

  it('returns a copy, not a view onto the whole PDF buffer', () => {
    // A `subarray` would pin the entire file in memory for as long as any image is held —
    // eight of them, queued for OCR, on a 40 MB scan.
    const pdf = pdfWith([{ filter: '/DCTDecode', data: fakeJpeg(20_000) }]);
    const image = extractPdfImages(pdf).images[0]!;

    expect(image.bytes.buffer.byteLength).toBe(image.bytes.length);
  });
});
