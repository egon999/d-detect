import { extractPdfText } from './pdf-text';
import { extractPdfImages } from './pdf-images';
import { extractOfficeText, officeKindFor } from './office-docs';
import { transcribeMedia } from './transcribe';
import { mergeMediaText, orderRecognisedLines, readVideoFrameText } from './video-frames';
import type { RecognitionOutcome } from './ocr';
import type { IngestResult, IngestSourceKind, PickedFile } from './types';

/**
 * File ingestion: a picked file in, plain text plus metadata out, so the
 * deterministic extractor has something to read.
 *
 * Routing is by filename extension first and mime type only as a fallback, because
 * Android document pickers routinely report `application/octet-stream` (or nothing)
 * for files whose names are perfectly clear.
 *
 * The guiding rule is honesty. Every branch either produces real text or says
 * plainly that it could not, via `method: 'none'` and a `note` the UI shows. This
 * layer never fabricates content, and it never claims a reading it did not make: the
 * `method` on the result distinguishes a PDF's own characters from a local ML Kit pass
 * over pixels from a machine transcription of speech, precisely so the UI cannot present
 * one as another.
 *
 * ## Which readings happen on the device, and which one does not
 *
 * PDFs, spreadsheets, emails, plain text and images are read entirely locally — the ML
 * Kit recogniser in `./ocr` runs with the radio off. Speech is the single exception:
 * there is no on-device speech model in this build, so audio and video go to Groq's
 * hosted Whisper via `./transcribe`, under the user's own key, and the note says so.
 * With no key configured a recording is still stored and hashed, and the note explains
 * that nothing was transcribed.
 *
 * The parsers below (`parseCsv`, `flattenCsvRows`, `parseEml`, `looksBinary`,
 * `decodeUtf8`, `formatMediaDuration`) are pure and exported so they can be unit-tested
 * in plain Node with no filesystem and no React Native.
 */

/** Images we recognise. Read locally by ML Kit; see the IMAGE branch of `ingestFile`. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.heic',
  '.heif',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
]);

/** Extensions we are willing to read as plain text. */
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.log',
  '.rtf',
  '.xml',
  '.html',
  '.htm',
  '.yml',
  '.yaml',
  '.ini',
  '.vcf',
]);

/** Audio recording formats. */
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.wma']);

/** Video recording and screen capture formats. */
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.3gp', '.m4v']);

/** Word processing and office documents. */
export const DOCUMENT_EXTENSIONS = new Set(['.docx', '.doc', '.rtf', '.odt']);

/**
 * ZIP-container office formats.
 *
 * The modern ones (`.docx`, `.xlsx`, `.xlsm`, `.pptx`) are parsed by `./office-docs`.
 * The legacy binaries (`.doc`, `.xls`, `.ppt`) and the ODF pair (`.odt`, `.ods`) are
 * listed here so they take the same branch and get an honest, specific note rather than
 * falling through to the plain-text decoder and producing mojibake.
 */
const ZIP_OFFICE_EXTENSIONS = new Set([
  '.xlsx',
  '.xlsm',
  '.docx',
  '.pptx',
  '.xls',
  '.doc',
  '.ppt',
  '.odt',
  '.ods',
]);

/** Sample size for the binary-content heuristic. */
const BINARY_SAMPLE = 4096;

/** Above this share of control/replacement characters we call a file binary. */
const BINARY_RATIO = 0.1;

/** Cap on flattened CSV output, so a huge sheet cannot balloon memory. */
const MAX_CSV_ROWS = 5000;

/**
 * Decodes UTF-8 bytes to a string.
 *
 * Hand-rolled rather than `TextDecoder`, which is not guaranteed on Hermes. Invalid
 * sequences become U+FFFD, which is also what the binary heuristic keys off. A
 * leading byte-order mark is stripped.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  // Strip UTF-8 BOM.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    i = 3;
  }
  const chunk: number[] = [];
  const flush = () => {
    if (chunk.length === 0) return;
    out += String.fromCharCode(...chunk);
    chunk.length = 0;
  };
  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    let code = -1;
    let size = 1;
    if (b0 < 0x80) {
      code = b0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      const b1 = bytes[i + 1];
      if (b1 !== undefined && (b1 & 0xc0) === 0x80) {
        code = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
        size = 2;
      }
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      if (b1 !== undefined && b2 !== undefined && (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80) {
        code = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
        size = 3;
      }
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      const b3 = bytes[i + 3];
      if (
        b1 !== undefined &&
        b2 !== undefined &&
        b3 !== undefined &&
        (b1 & 0xc0) === 0x80 &&
        (b2 & 0xc0) === 0x80 &&
        (b3 & 0xc0) === 0x80
      ) {
        code = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        size = 4;
      }
    }

    if (code < 0) {
      // Invalid lead or truncated sequence.
      chunk.push(0xfffd);
      i += 1;
    } else if (code > 0xffff) {
      // Outside the BMP: encode as a surrogate pair.
      const v = code - 0x10000;
      chunk.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += size;
    } else {
      chunk.push(code);
      i += size;
    }
    if (chunk.length >= 2048) flush();
  }
  flush();
  return out;
}

/**
 * Heuristic: does this look like binary rather than text?
 *
 * Any NUL byte is decisive — no plain-text document contains one. Otherwise we
 * measure the share of C0 control characters (excluding tab/newline/carriage
 * return) and U+FFFD replacement characters in a leading sample.
 */
export function looksBinary(text: string): boolean {
  if (text.length === 0) return false;
  const sample = text.slice(0, BINARY_SAMPLE);
  let suspicious = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;
    const isAllowedControl = code === 9 || code === 10 || code === 13;
    if ((code < 32 && !isAllowedControl) || code === 0xfffd || code === 0x7f) {
      suspicious += 1;
    }
  }
  return suspicious / sample.length > BINARY_RATIO;
}

/**
 * RFC 4180-style CSV/TSV parser.
 *
 * Handles quoted fields containing the delimiter, escaped `""` inside quotes, and
 * newlines inside quoted fields. Returns rows of raw (untrimmed) cell strings.
 */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  while (i < text.length) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          // `""` inside a quoted field is a literal quote.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush the final field/row unless the input ended with a clean newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Turns parsed CSV rows into readable `Header: value` lines, one block per row.
 *
 * The deterministic extractor looks for labelled values ("Total: INR 1,200.00") on
 * a line, so a bare grid of comma-separated numbers is useless to it. Pairing each
 * cell with its column header is what makes a spreadsheet extractable at all.
 */
export function flattenCsvRows(rows: string[][]): string {
  const clean = rows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (clean.length === 0) return '';

  const headerRow = clean[0];
  if (clean.length === 1 || headerRow === undefined) {
    return clean.map((row) => row.map((cell) => cell.trim()).join(' | ')).join('\n');
  }

  const headers = headerRow.map((cell, index) => {
    const label = cell.trim();
    return label.length > 0 ? label : `Column ${index + 1}`;
  });

  const blocks: string[] = [];
  const dataRows = clean.slice(1, MAX_CSV_ROWS + 1);
  dataRows.forEach((row, rowIndex) => {
    const lines: string[] = [`Row ${rowIndex + 1}`];
    row.forEach((cell, colIndex) => {
      const value = cell.trim();
      if (value.length === 0) return;
      const header = headers[colIndex] ?? `Column ${colIndex + 1}`;
      lines.push(`${header}: ${value}`);
    });
    if (lines.length > 1) blocks.push(lines.join('\n'));
  });

  return blocks.join('\n\n');
}

export interface ParsedEmail {
  /** Header names lowercased; values unfolded. */
  headers: Record<string, string>;
  /** The chosen body text (text/plain part of a multipart message when present). */
  body: string;
  /** `From/To/Subject/Date` surfaced as leading lines, then the body. */
  text: string;
}

/** Decodes quoted-printable to bytes, so multi-byte UTF-8 survives. */
function decodeQuotedPrintableBytes(input: string): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);
    if (ch === '=') {
      const next2 = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(next2)) {
        out.push(parseInt(next2, 16));
        i += 3;
        continue;
      }
      // Soft line break: `=` at end of line means "no break here".
      if (input.charAt(i + 1) === '\n') {
        i += 2;
        continue;
      }
      if (input.charAt(i + 1) === '\r' && input.charAt(i + 2) === '\n') {
        i += 3;
        continue;
      }
      if (i + 1 >= input.length) {
        i += 1;
        continue;
      }
    }
    out.push(ch.charCodeAt(0) & 0xff);
    i += 1;
  }
  return new Uint8Array(out);
}

/** Decodes quoted-printable to a string. */
export function decodeQuotedPrintable(input: string): string {
  return decodeUtf8(decodeQuotedPrintableBytes(input));
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes base64 to bytes. Hand-rolled: `atob`/`Buffer` are not both available. */
function decodeBase64Bytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean.charAt(i);
    if (ch === '=') break;
    const value = B64_ALPHABET.indexOf(ch);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Decodes RFC 2047 encoded-words, e.g. `=?utf-8?B?SGVsbG8=?=`, in a header value. */
function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?[^?]+\?([BbQq])\?([^?]*)\?=/g,
    (_match, encoding: string, payload: string) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          return decodeUtf8(decodeBase64Bytes(payload));
        }
        // Q-encoding is quoted-printable with `_` standing in for a space.
        return decodeUtf8(decodeQuotedPrintableBytes(payload.replace(/_/g, ' ')));
      } catch {
        return payload;
      }
    },
  );
}

/** Strips tags from an HTML body, keeping line structure. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits a raw header block into unfolded, lowercase-keyed entries. */
function parseHeaderBlock(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  // Unfold: a line starting with space/tab continues the previous header.
  const unfolded = block.replace(/\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name.length === 0) continue;
    // Repeated headers (Received:, …) keep the first occurrence.
    if (headers[name] === undefined) headers[name] = value;
  }
  return headers;
}

/** Applies the part's Content-Transfer-Encoding to its raw body. */
function decodePartBody(body: string, encoding: string): string {
  const normalized = encoding.trim().toLowerCase();
  if (normalized === 'quoted-printable') return decodeQuotedPrintable(body);
  if (normalized === 'base64') return decodeUtf8(decodeBase64Bytes(body));
  return body;
}

/**
 * Parses an RFC 822 / MIME email.
 *
 * Headers are split from the body on the first blank line and unfolded. For a
 * multipart message the `text/plain` part is preferred, falling back to a
 * tag-stripped `text/html` part. `From/To/Subject/Date` are surfaced as leading
 * lines so the deterministic extractor sees them as labelled values.
 */
export function parseEml(input: string): ParsedEmail {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const split = normalized.indexOf('\n\n');
  const headerBlock = split === -1 ? normalized : normalized.slice(0, split);
  const rawBody = split === -1 ? '' : normalized.slice(split + 2);
  const headers = parseHeaderBlock(headerBlock);

  const contentType = headers['content-type'] ?? '';
  const encoding = headers['content-transfer-encoding'] ?? '';
  let body = '';

  const boundaryMatch = /boundary\s*=\s*"?([^";\n]+)"?/i.exec(contentType);
  if (/multipart\//i.test(contentType) && boundaryMatch) {
    const boundary = (boundaryMatch[1] ?? '').trim();
    const parts = rawBody.split(`--${boundary}`);
    let plain: string | null = null;
    let html: string | null = null;
    for (const part of parts) {
      const trimmed = part.replace(/^\n/, '');
      if (trimmed.length === 0 || trimmed.startsWith('--')) continue;
      const partSplit = trimmed.indexOf('\n\n');
      if (partSplit === -1) continue;
      const partHeaders = parseHeaderBlock(trimmed.slice(0, partSplit));
      const partBody = trimmed.slice(partSplit + 2);
      const partType = partHeaders['content-type'] ?? '';
      const partEncoding = partHeaders['content-transfer-encoding'] ?? '';
      if (/text\/plain/i.test(partType) && plain === null) {
        plain = decodePartBody(partBody, partEncoding).trim();
      } else if (/text\/html/i.test(partType) && html === null) {
        html = htmlToText(decodePartBody(partBody, partEncoding));
      }
    }
    body = plain ?? html ?? '';
  } else {
    const decoded = decodePartBody(rawBody, encoding);
    body = /text\/html/i.test(contentType) ? htmlToText(decoded) : decoded;
  }

  body = body.replace(/\n{3,}/g, '\n\n').trim();

  const lead: string[] = [];
  for (const key of ['from', 'to', 'cc', 'subject', 'date'] as const) {
    const value = headers[key];
    if (value === undefined || value.length === 0) continue;
    const label = key === 'cc' ? 'Cc' : key.charAt(0).toUpperCase() + key.slice(1);
    lead.push(`${label}: ${decodeEncodedWords(value)}`);
  }

  const text = lead.length > 0 ? `${lead.join('\n')}\n\n${body}`.trim() : body;
  return { headers, body, text };
}

/** Lowercase extension including the dot, or '' when the name has none. */
export function fileExtension(name: string): string {
  const clean = name.split('?')[0] ?? name;
  const dot = clean.lastIndexOf('.');
  if (dot <= 0 || dot === clean.length - 1) return '';
  return clean.slice(dot).toLowerCase();
}

/**
 * A duration as a short human string, for a note the user reads.
 *
 * Coarse on purpose. The precise figure that matters — where in a recording a specific
 * sentence sits — is carried in `IngestResult.timedSegments` in milliseconds and rendered
 * by the evidence screen; this is the "how long is this file" sentence, where "24m 8s" is
 * more use than "1448.32 seconds". Seconds are dropped above an hour for the same reason.
 */
export function formatMediaDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Extension, falling back to the mime type when the name carries none. */
function resolveExtension(file: PickedFile): string {
  const fromName = fileExtension(file.name);
  if (fromName.length > 0) return fromName;
  const mime = (file.mimeType ?? '').toLowerCase();
  if (mime.includes('pdf')) return '.pdf';
  if (mime.startsWith('image/')) {
    const subtype = mime.slice('image/'.length).split(';')[0] ?? '';
    return subtype.length > 0 ? `.${subtype}` : '.png';
  }
  if (mime.startsWith('audio/') || mime.includes('audio')) return '.m4a';
  if (mime.startsWith('video/') || mime.includes('video')) return '.mp4';
  if (mime.includes('csv')) return '.csv';
  if (mime.includes('tab-separated')) return '.tsv';
  if (mime.includes('rfc822') || mime.includes('message/')) return '.eml';
  if (mime.includes('spreadsheetml')) return '.xlsx';
  if (mime.includes('wordprocessingml')) return '.docx';
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml')) return '.txt';
  return '';
}

function kindForExtension(ext: string): IngestSourceKind {
  if (ext === '.pdf') return 'PDF';
  if (IMAGE_EXTENSIONS.has(ext)) return 'IMAGE';
  if (AUDIO_EXTENSIONS.has(ext)) return 'AUDIO';
  if (VIDEO_EXTENSIONS.has(ext)) return 'VIDEO';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'DOCUMENT';
  if (ext === '.csv' || ext === '.tsv') return 'SPREADSHEET';
  if (ext === '.xlsx' || ext === '.xls' || ext === '.ods') return 'SPREADSHEET';
  if (ext === '.eml') return 'EMAIL';
  if (TEXT_EXTENSIONS.has(ext)) return 'TEXT';
  return 'OTHER';
}

/**
 * Reads a scanned PDF by OCR'ing its page images.
 *
 * Returns `null` when this is not a scan this build can read — no liftable page images, no
 * ML Kit, or nothing legible in the pixels — so the caller falls through to the existing
 * "no text layer" note rather than reporting a new kind of failure.
 *
 * ## Why this is worth the seconds it costs
 *
 * A scanned PDF is the single most common *unreadable* document this app is handed: it is
 * what a bank grievance cell emails back, what a utility portal serves, and what the
 * "scan to PDF" button on every phone produces. Before this, all of them ended at "someone
 * needs to read it and type it in", which for a fourteen-page statement means the app has
 * not helped.
 *
 * ## Why each page is written to a temp file
 *
 * ML Kit's binding takes a URI, not a buffer — see `./ocr`. The frame sampler in
 * `./video-frames` has exactly the same constraint and solves it the same way, so this
 * follows that shape deliberately rather than inventing a second one: write to the cache
 * directory, recognise, delete in a `finally`.
 *
 * ## What the result claims
 *
 * `method: 'pdf-page-ocr'`, never `pdf-text-layer`. Not one character here came from the
 * file's own text; every value is a machine's reading of pixels and is therefore
 * provisional under the same rule as a photograph (see `@domain/rules/provenance`). The
 * note says which pages were read, because a reading of pages 1–8 of a twenty-page
 * statement must never be mistaken for a reading of the statement.
 */
async function readScannedPdf(
  bytes: Uint8Array,
  pages: number,
): Promise<Omit<IngestResult, 'bytes' | 'sha256'> | null> {
  const { images, skippedUnsupported, truncated } = extractPdfImages(bytes);
  if (images.length === 0) {
    if (!skippedUnsupported) return null;
    return {
      kind: 'PDF',
      text: '',
      method: 'none',
      units: pages > 0 ? pages : null,
      // Nothing further this build can do with these pages, so re-running would only spend
      // the user's time again for the same answer.
      needsOcr: false,
      note:
        'This PDF has no text in it — its pages are stored as images in a format this app cannot read ' +
        '(some fax-style and older scanner formats). The file is stored unchanged. Re-saving it from a ' +
        'PDF viewer, or photographing the printed pages and adding those, will let it be read.',
    };
  }

  // Lazily imported for the same reason as everywhere else in this file: both statically
  // import native modules that do not exist in a plain Node process, so a top-level import
  // would make this module unimportable from the tests.
  let recogniseText: typeof import('./ocr').recogniseText;
  let FileClass: typeof import('expo-file-system').File;
  let PathsClass: typeof import('expo-file-system').Paths;
  try {
    const [ocr, fs] = await Promise.all([import('./ocr'), import('expo-file-system')]);
    recogniseText = ocr.recogniseText;
    FileClass = fs.File;
    PathsClass = fs.Paths;
  } catch {
    return null;
  }

  const pageTexts: string[] = [];
  let read = 0;
  let script: 'Latin' | 'Devanagari' | null = null;

  for (const [index, image] of images.entries()) {
    // A name unique per call, so two documents ingested concurrently cannot overwrite each
    // other's page and hand ML Kit half of the wrong file.
    const name = `pdf-page-${Date.now()}-${index}-${image.offset}${image.extension}`;
    let target: InstanceType<typeof FileClass> | null = null;

    try {
      target = new FileClass(PathsClass.cache, name);
      target.write(image.bytes);
    } catch {
      // A page that cannot be written to the cache is skipped, not fatal: a device low on
      // storage should still get whatever pages did fit.
      continue;
    }

    try {
      const outcome = await recogniseText(target.uri);
      if (outcome.ok) {
        read += 1;
        script ??= outcome.result.script;
        const lines = orderRecognisedLines(outcome.result.lines);
        // A page heading, so a value's page is recoverable from the text alone. The
        // deterministic extractor reads by line, and this line matches no value pattern.
        if (lines.length > 0) pageTexts.push(`[Page ${index + 1}]\n${lines.join('\n')}`);
      } else if (outcome.reason === 'UNAVAILABLE') {
        // ML Kit is not in this build. Every remaining page would say the same, so stop
        // rather than spend seconds per page learning it repeatedly.
        return null;
      }
      // `NO_TEXT` and `FAILED` are per-page: a blank back page, a page that is pure
      // photograph. Neither says anything about the next page.
    } finally {
      try {
        target.delete();
      } catch {
        // The cache is the OS's to reclaim. A page image that will not delete is not a
        // reason to fail an ingestion, and there is nothing the user could do about it.
      }
    }
  }

  const text = pageTexts.join('\n\n');
  if (text.trim().length === 0) return null;

  const pageWord = read === 1 ? 'page' : 'pages';
  const coverage =
    truncated && pages > images.length
      ? ` Only the first ${images.length} of ${pages} pages were read — the rest are in the stored file.`
      : truncated
        ? ` Only the first ${images.length} pages were read — the rest are in the stored file.`
        : '';

  return {
    kind: 'PDF',
    text,
    method: 'pdf-page-ocr',
    units: read,
    needsOcr: false,
    note:
      `This PDF has no text in it, so its ${read} ${pageWord} were read as pictures on this device, ` +
      `without uploading anything${script ? ` (${script} script)` : ''}. Text read from pixels is a ` +
      'reading of the scan, not the document itself, so check any figure or name against the original.' +
      coverage,
  };
}

/**
 * Reads a picked file and returns its text plus metadata.
 *
 * Never rejects for an unreadable or unsupported file: the failure is reported in
 * the returned `note` with `method: 'none'`, because the caller wants to store the
 * evidence either way and tell the user what happened.
 */
export async function ingestFile(file: PickedFile): Promise<IngestResult> {
  const ext = resolveExtension(file);
  const kind = kindForExtension(ext);

  // Lazily imported: `expo-file-system` cannot be loaded outside React Native, and a
  // static import here would make this module (and its pure parsers) unimportable in
  // tests. Metro resolves this fine.
  //
  // A recording is deliberately never read into memory. Audio and video are passed to
  // `transcribeMedia` and `readVideoFrameText` as a URI and their bytes are never decoded in
  // JavaScript, so the only thing the buffer was ever used for on these two paths was the size
  // and the hash — both of which can be had without it. Reading a 200 MB video here put the
  // whole file on the heap of a device whose per-process limit is often 192 MB, and hashed it
  // in one synchronous call that froze the UI thread. `sha256File` streams it a megabyte at a
  // time instead.
  const isRecording = kind === 'AUDIO' || kind === 'VIDEO';

  // Empty on the recording paths, which return before anything reads it. Every branch that
  // decodes this buffer — PDF, image, Office, CSV, email, text — is unreachable for an
  // extension that classified as AUDIO or VIDEO, because `kindForExtension` maps each
  // extension to exactly one kind.
  let bytes: Uint8Array = new Uint8Array();
  let size: number;
  let sha256: string;
  try {
    // Read through the namespace rather than destructuring every binding up front: the
    // recording path and the buffer path need different functions, and pulling in the ones
    // this file is not about to call would make the import fail for no reason.
    const readFile = await import('./read-file');
    if (isRecording) {
      const measured = await readFile.fileSize(file.uri);
      if (measured === null) throw new Error('the file is missing or unreadable');
      size = measured;
      // A zero-byte recording is reported by the shared empty-file branch below, and
      // `digestStream` over no bytes is the digest of no bytes — the same value the
      // whole-buffer path produced for an empty file.
      sha256 = await readFile.sha256File(file.uri, size);
    } else {
      bytes = await readFile.readBytes(file.uri);
      size = bytes.length;
      sha256 = readFile.sha256Hex(bytes);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return {
      kind,
      text: '',
      method: 'none',
      units: null,
      needsOcr: false,
      note: `The file could not be read from storage (${reason}). Nothing was extracted from it.`,
      bytes: 0,
      // No bytes were read, so there is nothing to hash. An empty string is the
      // honest answer; hashing zero bytes would look like a real digest.
      sha256: '',
    };
  }

  if (size === 0) {
    return {
      kind,
      text: '',
      method: 'none',
      units: null,
      needsOcr: false,
      note: 'The file is empty (0 bytes), so there was nothing to read.',
      bytes: 0,
      sha256,
    };
  }

  // --- PDF -----------------------------------------------------------------
  if (ext === '.pdf') {
    const { text, pages, hadTextLayer } = extractPdfText(bytes);
    if (!hadTextLayer) {
      // No characters in the file. Before giving up, try the pages as pictures: a scan is
      // one JPEG per page and ML Kit reads JPEGs, so the document that used to be
      // unreadable here is often entirely readable. See `./pdf-images` for why this needs
      // no PDF renderer, and what it deliberately does not attempt.
      const scanned = await readScannedPdf(bytes, pages);
      if (scanned) return { ...scanned, bytes: size, sha256 };

      return {
        kind: 'PDF',
        text: '',
        method: 'none',
        units: pages > 0 ? pages : null,
        needsOcr: true,
        note:
          'This PDF appears to be scanned images with no text layer, so no text could be read from it on this ' +
          'device. The original file is stored unchanged; someone needs to read it and add what it says as a statement.',
        bytes: size,
        sha256,
      };
    }
    return {
      kind: 'PDF',
      text,
      method: 'pdf-text-layer',
      units: pages > 0 ? pages : null,
      needsOcr: false,
      note: `Read the text layer of this PDF (${pages} ${pages === 1 ? 'page' : 'pages'}).`,
      bytes: size,
      sha256,
    };
  }

  // --- Images --------------------------------------------------------------
  if (IMAGE_EXTENSIONS.has(ext)) {
    // Lazily imported for the same reason as `./read-file` above: `./ocr` statically imports
    // the ML Kit binding, which cannot be loaded outside a native build. `recogniseText`
    // itself is documented never to throw, so this `catch` covers the import failing rather
    // than the recognition failing — the latter arrives as an outcome below.
    let outcome: RecognitionOutcome;
    try {
      const { recogniseText } = await import('./ocr');
      outcome = await recogniseText(file.uri);
    } catch {
      return {
        kind: 'IMAGE',
        text: '',
        method: 'none',
        units: null,
        needsOcr: true,
        note:
          'Reading text from images is not available in this build, so nothing was extracted. ' +
          'The image itself has been stored unchanged.',
        bytes: size,
        sha256,
      };
    }

    if (outcome.ok) {
      // Rebuilt from the lines rather than taken from `outcome.result.text`, because ML Kit
      // returns blocks in its own order and that order is not always top-to-bottom. On a chat
      // screenshot it will emit a later message before an earlier one, which would put a
      // reply above the message it answers — see `orderRecognisedLines`.
      const lines = orderRecognisedLines(outcome.result.lines);
      const text = lines.join('\n');
      if (text.trim().length > 0) {
        const otherScript = outcome.result.script === 'Latin' ? 'Devanagari' : 'Latin';
        return {
          kind: 'IMAGE',
          text,
          method: 'ocr',
          units: lines.length,
          needsOcr: false,
          note:
            `Read ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} of ${outcome.result.script} ` +
            'text from this image on this device, without uploading it. Text read from pixels is a ' +
            'reading of the picture, not the document itself, so check any figure or name against the image.' +
            // Surfaced rather than acted on: the two scripts are two separate readings of the
            // same picture and merging them would not produce a document. `recogniseText`
            // only reports this when the unused model found materially more, so it is worth
            // the sentence.
            (outcome.result.otherScriptLooksBetter
              ? ` Reading it as ${otherScript} found noticeably more text — re-read it in that script if this looks wrong.`
              : ''),
          bytes: size,
          sha256,
        };
      }
    }

    // `NO_TEXT` means the pass ran and there is nothing to read, so no further image pass
    // would help and `needsOcr` is false. `UNAVAILABLE` and `FAILED` both leave the image
    // genuinely unread, so the flag stays true and something can try again later.
    const reason = outcome.ok ? 'NO_TEXT' : outcome.reason;
    const message = outcome.ok
      ? 'No readable text was found in this image.'
      : outcome.message;
    return {
      kind: 'IMAGE',
      text: '',
      method: 'none',
      units: null,
      needsOcr: reason !== 'NO_TEXT',
      note: `${message} The image itself has been stored unchanged.`,
      bytes: size,
      sha256,
    };
  }

  // --- Audio recordings ---------------------------------------------------
  if (AUDIO_EXTENSIONS.has(ext)) {
    const transcript = await transcribeMedia({
      uri: file.uri,
      name: file.name,
      mimeType: file.mimeType,
      // The byte count read above, not `file.size`: the picker's figure is sometimes null and
      // occasionally wrong, and this one is what was actually on disk.
      sizeBytes: size,
    });

    if (!transcript.ok) {
      return {
        kind: 'AUDIO',
        text: '',
        method: 'none',
        units: null,
        needsOcr: false,
        // `transcript.error` is one of `./transcribe`'s own fixed sentences, already run
        // through `scrubKey`. A provider's own wording never reaches this note.
        note: transcript.error,
        bytes: size,
        sha256,
        // No `timedSegments` at all, deliberately. An absent list means the recording was
        // never transcribed; an empty one below means it was transcribed and nothing was
        // said. Collapsing the two would lose the difference between "add a key" and "this
        // recording is silent".
      };
    }

    const spans = transcript.segments.length;
    const duration = transcript.durationMs === null ? null : formatMediaDuration(transcript.durationMs);

    if (spans === 0) {
      return {
        kind: 'AUDIO',
        text: '',
        // Still `audio-transcript`: a transcription pass genuinely ran and this is its
        // result. `method` records how the text was obtained, not whether it was long.
        method: 'audio-transcript',
        units: 0,
        needsOcr: false,
        note: duration
          ? `Transcribed this recording (${duration}) and found no speech in it.`
          : 'Transcribed this recording and found no speech in it.',
        bytes: size,
        sha256,
        timedSegments: [],
      };
    }

    return {
      kind: 'AUDIO',
      text: transcript.text,
      method: 'audio-transcript',
      // Timed spans rather than a duration, because `units` is a count everywhere else in
      // this file and these are the pieces a citation can point at.
      units: spans,
      needsOcr: false,
      note:
        `Transcribed ${duration ? `${duration} of ` : ''}speech into ${spans} timed ${spans === 1 ? 'span' : 'spans'}` +
        `${transcript.language ? ` (detected language: ${transcript.language})` : ''}. ` +
        'This is a machine transcription of speech, with no confidence score and no speaker labels, ' +
        'so check any figure or name against the recording before relying on it.',
      bytes: size,
      sha256,
      timedSegments: transcript.segments,
    };
  }

  // --- Video recordings ---------------------------------------------------
  if (VIDEO_EXTENSIONS.has(ext)) {
    // Two independent readings, both attempted, neither sufficient on its own: a screen
    // recording of a payment confirmation has no speech, and a recorded call has no
    // on-screen text. See the argument in `./video-frames`.
    const transcript = await transcribeMedia({
      uri: file.uri,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: size,
    });

    // Whisper reports the container's real duration, and it is the only source of one
    // available here — `expo-video-thumbnails` exposes no metadata and this build has no
    // other media probe. Without it the sampler falls back to a fixed ladder and stops at the
    // first frame the decoder refuses; see `planFrameTimes`.
    const frames = await readVideoFrameText(file.uri, transcript.ok ? transcript.durationMs : null);
    const merged = mergeMediaText({
      speech: transcript.ok ? transcript.segments : [],
      frames: frames.frames,
    });

    const duration = transcript.ok && transcript.durationMs !== null
      ? formatMediaDuration(transcript.durationMs)
      : null;

    const sentences: string[] = [];

    if (!transcript.ok) {
      sentences.push(transcript.error);
    } else if (transcript.segments.length === 0) {
      sentences.push(
        duration
          ? `Transcribed the audio of this recording (${duration}) and found no speech in it.`
          : 'Transcribed the audio of this recording and found no speech in it.',
      );
    } else {
      const spans = transcript.segments.length;
      sentences.push(
        `Transcribed ${duration ? `${duration} of ` : ''}speech into ${spans} timed ${spans === 1 ? 'span' : 'spans'}.`,
      );
    }

    if (frames.limitations.includes('ocr-unavailable')) {
      sentences.push('Reading text from video frames is not available in this build.');
    } else if (frames.decoded === 0) {
      sentences.push('No frames could be decoded from this video, so no on-screen text was read.');
    } else {
      const kept = frames.frames.length;
      sentences.push(
        `Sampled ${frames.decoded} ${frames.decoded === 1 ? 'frame' : 'frames'} about every ` +
          `${formatMediaDuration(frames.intervalMs)} and found readable text on ${kept === 0 ? 'none' : kept} of them.`,
      );
      if (kept > 0) {
        sentences.push(
          'Frame sampling cannot see text that appeared between samples, and text read from pixels is ' +
            'a reading of the picture rather than the record itself — check it against the video.',
        );
      }
    }

    const hasText = merged.text.trim().length > 0;
    return {
      kind: 'VIDEO',
      text: merged.text,
      // `video-transcript` covers both signals. There is no separate member for "frame text
      // only" because the distinction the UI needs is already in the text itself, under the
      // headings `mergeMediaText` writes, and a fourth media method would give the UI a
      // difference it has no way to act on.
      method: hasText ? 'video-transcript' : 'none',
      units: hasText ? merged.timedSegments.length : null,
      // A frame pass that could not run leaves the pixels genuinely unread.
      needsOcr: frames.limitations.includes('ocr-unavailable'),
      note: sentences.join(' '),
      bytes: size,
      sha256,
      // Present whenever something with a clock was actually reached, empty or not, and
      // absent when neither pass ran at all — the same distinction as the audio branch.
      ...(transcript.ok || merged.timedSegments.length > 0
        ? { timedSegments: merged.timedSegments }
        : {}),
    };
  }

  // --- ZIP-container office formats ---------------------------------------
  if (ZIP_OFFICE_EXTENSIONS.has(ext)) {
    /*
      DOCX, XLSX and PPTX are read here. These used to be stored and never parsed, so a
      Word invoice contributed no text and every rule silently skipped it — the file was
      present in the case and invisible to the analysis, which is the worst of both.
      `office-docs` walks the ZIP directory and inflates the text parts with pako, which
      is already in the bundle for the PDF text layer. No native module, no new package.

      The legacy binaries (.doc, .xls, .ppt, .odt, .ods) are a different format
      altogether — OLE compound files, not ZIP — and still fall through to the honest
      "not extracted" note below.
    */
    const officeKind = officeKindFor(ext);

    if (officeKind) {
      const office = extractOfficeText(bytes, officeKind);
      const label = ext.replace('.', '').toUpperCase();

      if (office.hadText) {
        return {
          kind,
          text: office.text,
          method: 'office-xml',
          units: office.partsRead > 0 ? office.partsRead : null,
          needsOcr: false,
          note: office.truncated
            ? `Text was read from this ${label} file. It is long, so only the first part was ` +
              'kept — the rest is stored but not analysed.'
            : '',
          bytes: size,
          sha256,
        };
      }

      return {
        kind,
        text: '',
        method: 'none',
        units: null,
        // An Office file holds no pixels to re-read, so another pass would find nothing.
        needsOcr: false,
        note:
          office.error ??
          `This ${label} file was read but contained no text — it may hold only images, ` +
            'charts or an embedded scan. The file is stored unchanged and can be opened or ' +
            'shared from the case. A photo or screenshot of the relevant page can be read.',
        bytes: size,
        sha256,
      };
    }

    return {
      kind,
      text: '',
      method: 'none',
      units: null,
      needsOcr: false,
      note:
        `This ${ext.replace('.', '').toUpperCase()} file is an older binary format that cannot ` +
        'be read on the device, so no text was extracted from it. The file has been stored ' +
        'unchanged and can be opened or shared from the case. Saving it as DOCX, XLSX or PDF ' +
        'and re-uploading will let it be analysed.',
      bytes: size,
      sha256,
    };
  }

  // Everything below needs the bytes as text.
  const decoded = decodeUtf8(bytes);

  // --- CSV / TSV -----------------------------------------------------------
  if (ext === '.csv' || ext === '.tsv') {
    const rows = parseCsv(decoded, ext === '.tsv' ? '\t' : ',');
    const dataRows = Math.max(0, rows.length - 1);
    const text = flattenCsvRows(rows);
    if (text.length === 0) {
      return {
        kind: 'SPREADSHEET',
        text: '',
        method: 'none',
        units: 0,
        needsOcr: false,
        note: 'This spreadsheet file contains no readable rows.',
        bytes: size,
        sha256,
      };
    }
    const truncated = dataRows > MAX_CSV_ROWS;
    return {
      kind: 'SPREADSHEET',
      text,
      method: 'csv-flatten',
      units: dataRows,
      needsOcr: false,
      note: truncated
        ? `Read ${MAX_CSV_ROWS} of ${dataRows} rows from this file; the rest were skipped to keep the app responsive.`
        : `Read ${dataRows} ${dataRows === 1 ? 'row' : 'rows'} from this file, with each value labelled by its column.`,
      bytes: size,
      sha256,
    };
  }

  // --- Email ---------------------------------------------------------------
  if (ext === '.eml') {
    const parsed = parseEml(decoded);
    if (parsed.text.trim().length === 0) {
      return {
        kind: 'EMAIL',
        text: '',
        method: 'none',
        units: null,
        needsOcr: false,
        note: 'This email could not be parsed into readable text.',
        bytes: size,
        sha256,
      };
    }
    const subject = parsed.headers['subject'];
    return {
      kind: 'EMAIL',
      text: parsed.text,
      method: 'eml-parse',
      units: null,
      needsOcr: false,
      note: subject
        ? `Read this email, including its headers and message body ("${decodeEncodedWords(subject)}").`
        : 'Read this email, including its headers and message body.',
      bytes: size,
      sha256,
    };
  }

  // --- Plain text ----------------------------------------------------------
  if (TEXT_EXTENSIONS.has(ext)) {
    // A `.txt` that is actually binary is still binary; say so rather than
    // handing the extractor a page of mojibake.
    if (looksBinary(decoded)) {
      return {
        kind: 'TEXT',
        text: '',
        method: 'none',
        units: null,
        needsOcr: false,
        note:
          'This file has a text extension but its contents are not readable text, so nothing was extracted. ' +
          'The file has been stored unchanged.',
        bytes: size,
        sha256,
      };
    }
    return {
      kind: 'TEXT',
      text: decoded,
      method: 'plain-text',
      units: null,
      needsOcr: false,
      note: 'Read this file as plain text.',
      bytes: size,
      sha256,
    };
  }

  // --- Unknown: try text, detect binary -----------------------------------
  if (looksBinary(decoded)) {
    return {
      kind: 'OTHER',
      text: '',
      method: 'none',
      units: null,
      needsOcr: false,
      note:
        `This file type (${ext.length > 0 ? ext : 'no extension'}) is not readable in this build, ` +
        'so no text was extracted. The file has been stored and can be shared or exported.',
      bytes: size,
      sha256,
    };
  }

  return {
    kind: 'TEXT',
    text: decoded,
    method: 'plain-text',
    units: null,
    needsOcr: false,
    note: 'This file type is not formally supported, but its contents were readable as plain text.',
    bytes: size,
    sha256,
  };
}
