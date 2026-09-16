import { inflate, inflateRaw } from 'pako';

/**
 * Pulls the embedded page images out of a scanned PDF so they can be read by OCR.
 *
 * ## The gap this closes
 *
 * `./pdf-text` reads a PDF's *text layer* — the characters the producing program wrote
 * into the file. A PDF produced by a scanner, a photocopier, or the "print to PDF" button
 * on a phone camera app has no text layer at all: every page is one big image, and the
 * characters a human sees are pixels. `extractPdfText` correctly reports
 * `hadTextLayer: false` for those, and until now the pipeline stopped there and told the
 * user to read the document themselves and type it in as a statement.
 *
 * That is the wrong place to stop, for this product in this market. A scanned PDF is what
 * a bank grievance cell emails back, what a hospital hands over as a discharge summary,
 * and what most municipal and utility portals serve. Telling someone to retype a
 * fourteen-page statement is telling them the app cannot help — and the app has an OCR
 * engine sitting right there in `./ocr`, already used for photographs of the very same
 * documents.
 *
 * ## Why this is possible without a PDF renderer
 *
 * The obvious implementation is "rasterise each page, then OCR the bitmap", which needs a
 * full PDF renderer — a page tree, a resource graph, a font engine, a graphics stack. None
 * of that is available here and none of it could be added without a native module.
 *
 * It is also not necessary. A scanned page is not *drawn*; it is one image XObject painted
 * to fill the page. And a PDF image stream with `/DCTDecode` is **literally a JPEG file** —
 * the filter name is the format, and the stream body between `stream` and `endstream` is
 * the JFIF byte sequence, unmodified. So the page image can be lifted out with a byte copy
 * and handed to ML Kit, which reads JPEGs.
 *
 * This is a deliberately narrow claim. It works for `/DCTDecode`, which is what essentially
 * every scanner, phone camera and print-to-PDF path emits, because a scan is a photograph
 * and JPEG is what photographs are stored as.
 *
 * ## What this does NOT handle, and why each is left alone
 *
 * - **`/CCITTFaxDecode` and `/JBIG2Decode`** — fax-lineage bilevel codecs, used by some
 *   older office scanners. The compressed bytes are *not* a standalone file: producing a
 *   TIFF from them means synthesising a container and a header, and producing a bitmap
 *   means implementing the codec. Both are real work with real failure modes, for a
 *   shrinking share of documents.
 * - **`/JPXDecode`** (JPEG 2000). A standalone file in principle, but Android's decoder
 *   does not accept it and ML Kit would reject the temp file.
 * - **`/FlateDecode` images** — raw pixel samples with no header. Turning those into
 *   something a decoder accepts means writing a PNG or BMP encoder, including a CRC-32
 *   implementation and colour-space handling for `/DeviceCMYK` and `/Indexed`. That is a
 *   larger, riskier body of code than everything here put together, and it is worth doing
 *   only if real files turn out to need it.
 * - **Encrypted PDFs.** The stream bytes are ciphertext; a JPEG never appears.
 * - **Multiple images composited into one page**, which is what a "searchable PDF" with a
 *   separate text layer per region can contain. Each image is returned separately and OCR'd
 *   separately, so the text comes out per-fragment rather than in reading order.
 *
 * In every unhandled case this returns fewer images — never wrong ones — and the caller
 * keeps the honest "this could not be read" note it has today.
 *
 * ## Purity
 *
 * No native imports, no I/O, no clock. Everything here is a pure function of the input
 * bytes, which is what lets `tests/pdf-images.test.ts` build PDFs byte by byte and assert
 * on the output in a plain Node process. The native half — writing temp files and calling
 * ML Kit — lives in `./ingest`, where the rest of the native surface already is.
 *
 * ## Safety
 *
 * Same posture as `./pdf-text`, because this parses untrusted binary on the UI thread: it
 * never throws, every stream is handled inside its own guard, and the work is capped by
 * stream count, per-image size, and total images returned.
 */

/** Hard ceiling on streams examined. Matches `./pdf-text` so both walk the same distance. */
const MAX_STREAMS = 400;

/**
 * Most page images returned, however long the document.
 *
 * Each one costs a temp-file write plus two ML Kit passes (Latin and Devanagari, both run
 * by `recogniseText`), which is a few hundred milliseconds each on a mid-range handset. At
 * eight that is a handful of seconds with the user watching a progress bar — tolerable, and
 * enough to cover the bills, statements and letters this exists for. A forty-page scanned
 * contract would otherwise turn into a minutes-long freeze, and the note tells the user
 * exactly how many pages were read so a truncated reading is never mistaken for a complete
 * one.
 */
export const MAX_PAGE_IMAGES = 8;

/**
 * Largest single embedded image accepted (~12 MB).
 *
 * A 300 dpi A4 colour scan is around 2–4 MB, so this is generous for a real page and still
 * refuses the pathological case.
 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Smallest image worth OCR'ing.
 *
 * Below a few kilobytes a JPEG is a logo, a signature graphic, a QR code or a header rule —
 * never a page of text. Running two ML Kit passes over each of those on a document with a
 * letterhead on every page is pure latency for no reading.
 */
const MIN_IMAGE_BYTES = 8 * 1024;

/** How far back from `stream` to look for the owning object dictionary. Matches `./pdf-text`. */
const DICT_LOOKBEHIND = 2048;

export interface PdfImage {
  /** The image bytes, exactly as stored in the PDF. For `dct` this is a complete JPEG file. */
  bytes: Uint8Array;
  /** The only encoding currently lifted. Kept as a field so the set can widen without a shape change. */
  encoding: 'dct';
  /** File extension a temp file should use, so the decoder sniffs the right format. */
  extension: '.jpg';
  /** Byte offset in the PDF, used only to keep ordering stable and debuggable. */
  offset: number;
}

export interface PdfImageResult {
  images: PdfImage[];
  /**
   * True when images were found and dropped for being in a format that cannot be handed to
   * a decoder as-is. Lets the caller distinguish "this PDF has no images" from "this PDF's
   * images are in a format this build cannot read", which are different things to tell a
   * user.
   */
  skippedUnsupported: boolean;
  /** True when `MAX_PAGE_IMAGES` was hit and later pages were not returned. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Byte scanning
//
// These mirror `./pdf-text` rather than being imported from it. Both modules walk the same
// structure, and the duplication is deliberate: `pdf-text.ts` is the one piece of ingestion
// with the most callers and the least tolerance for regression, and exporting its internals
// to be shared here would mean every future change to this file could break that one.
// ---------------------------------------------------------------------------

/** Byte-for-byte latin1 decode, so string indices equal byte offsets. */
function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  const CHUNK = 0x8000;
  let out = '';
  for (let at = start; at < end; at += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(at, Math.min(at + CHUNK, end)));
  }
  return out;
}

function isDelimiterOrSpace(ch: string): boolean {
  return (
    ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\0' ||
    ch === '(' || ch === ')' || ch === '<' || ch === '>' || ch === '[' || ch === ']' ||
    ch === '{' || ch === '}' || ch === '/' || ch === '%'
  );
}

/** True when `index` starts a real `stream` keyword, not the tail of `endstream`. */
function isStreamKeywordAt(raw: string, index: number): boolean {
  if (index >= 3 && raw.slice(index - 3, index) === 'end') return false;
  const before = index === 0 ? '' : raw.charAt(index - 1);
  if (before !== '' && !isDelimiterOrSpace(before)) return false;
  const after = raw.charAt(index + 6);
  return after === '' || after === '\r' || after === '\n' || after === ' ' || after === '\t';
}

/** Skips the EOL that must follow the `stream` keyword before the body starts. */
function bodyStartAfterKeyword(raw: string, keywordEnd: number): number {
  let p = keywordEnd;
  while (p < raw.length && (raw.charAt(p) === ' ' || raw.charAt(p) === '\t')) p += 1;
  if (raw.charAt(p) === '\r') {
    p += 1;
    if (raw.charAt(p) === '\n') p += 1;
  } else if (raw.charAt(p) === '\n') {
    p += 1;
  }
  return p;
}

/** Reads `/Length 1234` from a dictionary. Null for indirect refs (`12 0 R`). */
function readLengthHint(dict: string): number | null {
  const match = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
  if (!match) return null;
  const value = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Locates the end of a stream body.
 *
 * The `/Length` hint is preferred and then *verified*, because for an image this is not a
 * nicety: JPEG data very often contains the literal bytes `endstream` by coincidence, and
 * searching for that marker first would truncate the image mid-scan. A truncated JPEG
 * usually still decodes — to a half-grey page — so the failure would be silent and would
 * look like OCR being bad at the document.
 */
function findStreamEnd(raw: string, bodyStart: number, lengthHint: number | null): number {
  if (lengthHint !== null && bodyStart + lengthHint <= raw.length) {
    const candidate = bodyStart + lengthHint;
    if (/^[\r\n \t]*endstream/.test(raw.slice(candidate, candidate + 24))) {
      return candidate;
    }
  }
  return raw.indexOf('endstream', bodyStart);
}

// ---------------------------------------------------------------------------
// JPEG validation
// ---------------------------------------------------------------------------

/**
 * True when the bytes open and close like a JPEG.
 *
 * `/DCTDecode` says the *encoding* is JPEG; it does not guarantee the producer wrote a
 * well-formed JFIF file, and a stream whose boundaries were mis-detected will fail here.
 * Checking both markers costs two comparisons and prevents handing the decoder a file that
 * makes it throw — or worse, one it decodes into noise that OCR then "reads".
 *
 * The trailing EOI is searched for near the end rather than required at the exact last
 * byte, because some producers pad the stream to an even length or leave a stray newline
 * before `endstream`.
 */
function looksLikeJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // SOI: FF D8 FF
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false;

  // EOI: FF D9, within the last few bytes.
  const from = Math.max(0, bytes.length - 8);
  for (let at = bytes.length - 2; at >= from; at -= 1) {
    if (bytes[at] === 0xff && bytes[at + 1] === 0xd9) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Finds the embedded page images in a PDF.
 *
 * Never throws. Returns an empty list for a PDF with no liftable images, which the caller
 * reports as "could not be read" exactly as it does today.
 */
export function extractPdfImages(bytes: Uint8Array): PdfImageResult {
  const empty: PdfImageResult = { images: [], skippedUnsupported: false, truncated: false };

  try {
    if (!bytes || bytes.length === 0) return empty;

    const raw = latin1(bytes);
    const images: PdfImage[] = [];
    let skippedUnsupported = false;
    let truncated = false;
    let streamsSeen = 0;
    let cursor = 0;

    while (streamsSeen < MAX_STREAMS) {
      const found = raw.indexOf('stream', cursor);
      if (found === -1) break;
      cursor = found + 6;
      if (!isStreamKeywordAt(raw, found)) continue;

      streamsSeen += 1;

      const windowStart = Math.max(0, found - DICT_LOOKBEHIND);
      const before = raw.slice(windowStart, found);
      const dictStart = before.lastIndexOf('<<');
      const dict = dictStart === -1 ? '' : before.slice(dictStart);

      // Only image XObjects. A content stream, a font program and a metadata blob all live
      // in the same `stream` … `endstream` shape and none of them is a picture of a page.
      if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;

      const bodyStart = bodyStartAfterKeyword(raw, found + 6);
      const lengthHint = readLengthHint(dict);
      const bodyEnd = findStreamEnd(raw, bodyStart, lengthHint);
      if (bodyEnd === -1 || bodyEnd <= bodyStart) continue;
      cursor = bodyEnd;

      // A soft mask is the transparency channel of *another* image — a greyscale shape, never
      // text — so OCR'ing it wastes two ML Kit passes and can return noise read off its edges.
      // `/Subtype /Image` is true of masks as well, which is why this is checked separately.
      // Note the asymmetry: a dictionary that *declares* `/SMask` is the parent image and is
      // kept; only the mask object itself, which declares `/ImageMask true`, is dropped.
      if (/\/ImageMask\s+true\b/.test(dict)) continue;

      if (images.length >= MAX_PAGE_IMAGES) {
        truncated = true;
        break;
      }

      const filters = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict)?.[1] ?? '';

      // JPEG, stored verbatim. This is the case that carries essentially every scan.
      if (/\/DCTDecode\b/.test(filters)) {
        // A `[/FlateDecode /DCTDecode]` chain means the JPEG was additionally deflated. Undo
        // that one wrapper; anything more exotic is left to the unsupported branch.
        let payload = bytes.subarray(bodyStart, bodyEnd);
        if (/\/FlateDecode\b/.test(filters)) {
          const unwrapped = tryInflate(payload);
          if (!unwrapped) {
            skippedUnsupported = true;
            continue;
          }
          payload = unwrapped;
        }

        if (payload.length > MAX_IMAGE_BYTES || payload.length < MIN_IMAGE_BYTES) continue;
        if (!looksLikeJpeg(payload)) {
          skippedUnsupported = true;
          continue;
        }

        images.push({
          // Copied, not referenced. A `subarray` is a view onto the whole PDF buffer, so
          // keeping one alive would pin the entire file in memory for as long as any image
          // is held — on a 40 MB scan, while eight of them queue for OCR.
          bytes: payload.slice(),
          encoding: 'dct',
          extension: '.jpg',
          offset: bodyStart,
        });
        continue;
      }

      // A real page image this build cannot hand to a decoder. Recorded so the caller can
      // say *why* nothing was read rather than implying the PDF was empty.
      if (/\/(JPXDecode|CCITTFaxDecode|JBIG2Decode)\b/.test(filters)) {
        skippedUnsupported = true;
        continue;
      }

      // `/FlateDecode` alone on an image means raw samples with no container. See the header.
      if (/\/FlateDecode\b/.test(filters)) {
        skippedUnsupported = true;
      }
    }

    return { images, skippedUnsupported, truncated };
  } catch {
    // Best-effort throughout: a scanned PDF that defeats this must degrade to the existing
    // "no text layer" note, never to a crash on the upload screen.
    return empty;
  }
}

/** One deflate wrapper off, tolerating both zlib-wrapped and raw streams. */
function tryInflate(body: Uint8Array): Uint8Array | null {
  try {
    return inflate(body);
  } catch {
    try {
      return inflateRaw(body);
    } catch {
      return null;
    }
  }
}
