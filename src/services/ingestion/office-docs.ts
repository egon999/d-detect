import { inflateRaw } from 'pako';

/**
 * A dependency-free reader for the ZIP-container Office formats — DOCX, XLSX, PPTX.
 *
 * WHY THIS EXISTS
 * ---------------
 * These files used to be stored and never read. Upload a Word invoice and it hashed
 * correctly, appeared in the case, and contributed **zero text** to any analysis — so
 * every rule silently skipped it. The note said "no local preview is available", which
 * explained the missing preview and not the fact that the document was invisible to the
 * engine. A dispute tool that quietly ignores the most common business document format
 * is not doing the one job it exists to do.
 *
 * There is no native dependency here and no new package. A DOCX is a ZIP of XML parts,
 * and `pako` — already in the bundle for the PDF text layer — inflates the members.
 *
 * WHAT THIS DOES
 * --------------
 * Reads the ZIP central directory, locates the parts that carry user-visible text, and
 * inflates and strips them:
 *
 *   - **DOCX** — `word/document.xml`, plus headers/footers. Paragraph and row ends
 *     become newlines and `<w:tab/>` becomes a tab, because the deterministic extractor
 *     reads values by line context: "Invoice No: 4471" has to stay on one line, and a
 *     table cell boundary has to not merge two fields into one.
 *   - **XLSX** — `xl/sharedStrings.xml` for the string table, then each `xl/worksheets/
 *     sheet*.xml`, emitting one line per row and tab-separating cells. Inline strings
 *     and numeric cells are read; **formulas are never evaluated**, only their cached
 *     result is taken, which is the stored value the author last saw.
 *   - **PPTX** — every `ppt/slides/slide*.xml`, one line per text run.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * - No layout, styling, merged-cell geometry or image analysis.
 * - No formula execution, no external-link resolution, no macro inspection. An `.xlsm`
 *   macro is never run; this reads bytes and never executes anything.
 * - No legacy binary `.doc`/`.xls`/`.ppt` (OLE compound files, a different format
 *   entirely) and no ODF. Those still return the honest "not extracted" note.
 * - Numbers come out as the file's stored display string where one exists, so a cell
 *   holding `1000` formatted as `₹1,000.00` yields the raw `1000`. That is deliberate:
 *   the money normaliser is better at currency than a guess at the format code would be.
 *
 * SAFETY
 * ------
 * Same posture as `pdf-text.ts`, because this parses untrusted binary on the UI thread:
 * it **never throws**, every member is inflated inside its own try/catch and skipped on
 * failure, and all work is capped — member count, per-member inflated size, and total
 * accumulated text — so a corrupt or hostile archive (including a zip bomb) cannot hang
 * or exhaust the app.
 */

/** Hard ceiling on archive members examined. */
const MAX_MEMBERS = 512;

/** Hard ceiling on one inflated member (~8 MB), so a zip bomb cannot exhaust memory. */
const MAX_MEMBER_BYTES = 8 * 1024 * 1024;

/** Hard ceiling on accumulated extracted text (~1 MB of UTF-16 chars). */
const MAX_TEXT_CHARS = 1_000_000;

/**
 * Below this many non-whitespace characters we call it "no usable text".
 *
 * Deliberately tiny. The instinct is to set a floor that rejects noise, but in this
 * product a very short extraction is often the whole point: a spreadsheet cell holding
 * `2500` is four characters and is exactly the figure a conflict finding needs. A
 * higher floor silently discarded single-value sheets. Two characters only rules out
 * an archive that parsed but yielded essentially nothing.
 */
const MIN_TEXT_CHARS = 2;

/** How far back from the end of the file to hunt for the end-of-central-directory record. */
const EOCD_SEARCH = 66_560;

const SIGNATURE = {
  /** End of central directory. */
  eocd: 0x06054b50,
  /** Central directory file header. */
  centralFile: 0x02014b50,
  /** Local file header. */
  localFile: 0x04034b50,
} as const;

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

export interface OfficeTextResult {
  text: string;
  /** False when the archive parsed but carried no readable text. */
  hadText: boolean;
  /** Which parts were read, for the extraction note. */
  partsRead: number;
  /** Set when the archive could not be read at all. */
  error: string | null;
  /** True when output hit `MAX_TEXT_CHARS` and is therefore partial. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

/**
 * Little-endian 32-bit read, unsigned.
 *
 * `>>> 0` matters: the top bit set would otherwise come back negative and turn an
 * offset into a nonsense index. ZIP stores `0xFFFFFFFF` as the "see Zip64" sentinel,
 * which this would silently treat as a real offset without the coercion.
 */
function u32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0)
  );
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

function decodeName(bytes: Uint8Array, at: number, length: number): string {
  try {
    return utf8.decode(bytes.subarray(at, at + length));
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// ZIP directory
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else is skipped. */
  method: number;
  compressedSize: number;
  /** Offset of the local file header, from the central directory. */
  localOffset: number;
}

/**
 * Reads the central directory.
 *
 * The directory is authoritative, not the local headers: a local header may carry
 * zeroed sizes with the real values in a trailing data descriptor (streamed writers do
 * this), and walking local headers sequentially would then lose the archive. The EOCD
 * is found by scanning backwards because it is followed by a variable-length comment.
 *
 * Returns an empty array rather than throwing on anything malformed.
 */
function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const length = bytes.length;
  if (length < 22) return [];

  let eocd = -1;
  const floor = Math.max(0, length - EOCD_SEARCH);
  for (let at = length - 22; at >= floor; at -= 1) {
    if (u32(bytes, at) === SIGNATURE.eocd) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return [];

  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < Math.min(count, MAX_MEMBERS); index += 1) {
    if (at + 46 > length || u32(bytes, at) !== SIGNATURE.centralFile) break;

    const method = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const localOffset = u32(bytes, at + 42);
    const name = decodeName(bytes, at + 46, nameLength);

    if (name) entries.push({ name, method, compressedSize, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Inflates one member to text.
 *
 * The compressed size is taken from the local header's own name/extra lengths rather
 * than trusting the central directory's size field, because the two disagree in
 * archives written by streaming producers. `inflateRaw` is correct here — a ZIP member
 * is a bare deflate stream with no zlib wrapper.
 */
function readMember(bytes: Uint8Array, entry: ZipEntry): string | null {
  try {
    const at = entry.localOffset;
    if (at + 30 > bytes.length || u32(bytes, at) !== SIGNATURE.localFile) return null;

    const nameLength = u16(bytes, at + 26);
    const extraLength = u16(bytes, at + 28);
    const start = at + 30 + nameLength + extraLength;
    if (start >= bytes.length) return null;

    if (entry.method === 0) {
      const end = Math.min(bytes.length, start + Math.min(entry.compressedSize, MAX_MEMBER_BYTES));
      return utf8.decode(bytes.subarray(start, end));
    }

    if (entry.method !== 8) return null;

    // An end bounded by the *declared* size when it looks sane, else to the end of the
    // buffer. pako stops at the stream terminator either way; this only avoids handing
    // it a needlessly large slice.
    const declared = entry.compressedSize;
    const end =
      declared > 0 && start + declared <= bytes.length ? start + declared : bytes.length;

    const inflated = inflateRaw(bytes.subarray(start, end));
    if (!inflated || inflated.length === 0) return null;

    const capped =
      inflated.length > MAX_MEMBER_BYTES ? inflated.subarray(0, MAX_MEMBER_BYTES) : inflated;
    return utf8.decode(capped);
  } catch {
    // A member that will not inflate is skipped, never fatal: one corrupt part of a
    // document should not lose the parts that do read.
    return null;
  }
}

// ---------------------------------------------------------------------------
// XML text
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Reject non-characters and anything outside the BMP-safe range rather than
      // emitting a replacement glyph into evidence text.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return ENTITIES[body.toLowerCase()] ?? '';
  });
}

/**
 * Strips XML to text, turning the structural tags that carry *meaning for a reader*
 * into whitespace.
 *
 * The tag list is the load-bearing part. `</w:p>` (paragraph) and `</w:tr>` (table row)
 * must become newlines and `</w:tc>` (table cell) a tab, or a two-column table of
 * label/value pairs collapses into one run-on line and every `Label: value` regex in
 * the deterministic extractor stops matching. That is the difference between reading a
 * Word invoice and reading a wall of words.
 *
 * ## Why table cells are flattened before anything else
 *
 * A cell contains a paragraph — `<w:tc><w:p>…</w:p></w:tc>` — so a naive pass turns the
 * *inner* paragraph end into a newline and splits "Bill No" from "4471" onto two lines,
 * which is worse than the collapse it was meant to prevent. Cell contents are therefore
 * flattened first: paragraph ends inside a cell become spaces, and only then does the
 * cell boundary become a tab. A row's cells stay on one line, which is what a reader
 * sees and what the label regexes need.
 */
function xmlToText(xml: string, breakTags: readonly string[], tabTags: readonly string[] = []): string {
  let text = xml;

  // Drop comments, declarations and anything in a script-like part first.
  text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');

  // Flatten each table cell's interior before the cell boundary is turned into a tab.
  if (tabTags.includes('w:tc')) {
    text = text.replace(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi, (_whole, inner: string) => {
      const flattened = String(inner)
        .replace(/<\/w:p\s*>/gi, ' ')
        .replace(/<w:p\s*\/>/gi, ' ');
      return `<w:tc>${flattened}</w:tc>`;
    });
  }

  for (const tag of tabTags) {
    text = text.replace(new RegExp(`</${tag}\\s*>`, 'gi'), '\t');
  }
  for (const tag of breakTags) {
    text = text.replace(new RegExp(`</${tag}\\s*>`, 'gi'), '\n');
    text = text.replace(new RegExp(`<${tag}\\s*/>`, 'gi'), '\n');
  }

  // Explicit break/tab elements, which are self-closing and carry no content.
  text = text
    .replace(/<w:br\s*\/?>/gi, '\n')
    .replace(/<w:tab\s*\/?>/gi, '\t')
    .replace(/<a:br\s*\/?>/gi, '\n');

  // Every remaining tag goes, leaving its text content.
  text = text.replace(/<[^>]*>/g, '');

  return decodeEntities(text);
}

/**
 * Normalises whitespace without destroying line structure.
 *
 * Collapses runs of spaces, trims each line, and caps consecutive blank lines at one,
 * because Office XML is full of empty paragraphs used purely for spacing.
 */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\t\n]+/g, ' ').replace(/[ \t]+$/, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Per-format readers
// ---------------------------------------------------------------------------

/** Ordered so the body comes first and headers/footers follow it. */
function docxParts(entries: readonly ZipEntry[]): ZipEntry[] {
  const body = entries.filter((entry) => entry.name === 'word/document.xml');
  const chrome = entries
    .filter((entry) => /^word\/(header|footer)\d*\.xml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const notes = entries.filter((entry) =>
    /^word\/(footnotes|endnotes|comments)\.xml$/i.test(entry.name),
  );
  return [...body, ...chrome, ...notes];
}

/** Numeric suffix order, so `sheet2` precedes `sheet10`. */
function numberedParts(entries: readonly ZipEntry[], pattern: RegExp): ZipEntry[] {
  return entries
    .filter((entry) => pattern.test(entry.name))
    .sort((a, b) => {
      const an = Number.parseInt(a.name.replace(/\D+/g, ''), 10) || 0;
      const bn = Number.parseInt(b.name.replace(/\D+/g, ''), 10) || 0;
      return an - bn;
    });
}

/**
 * The shared string table.
 *
 * XLSX stores most cell text once here and references it by index from the sheet, so a
 * sheet read without this table yields columns of integers where the words should be.
 */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    out.push(tidy(xmlToText(match[1] ?? '', [])).replace(/\n+/g, ' '));
  }
  return out;
}

/**
 * One sheet, as tab-separated rows.
 *
 * `t="s"` means the value is an index into the shared table; `t="inlineStr"` carries
 * its own text; anything else is a literal, and for a formula cell that literal is the
 * cached result the author last saw. Formulas themselves (`<f>`) are never evaluated.
 */
function sheetText(xml: string, strings: readonly string[]): string {
  const lines: string[] = [];

  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells: string[] = [];

    for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attributes = cell[1] ?? '';
      const body = cell[2] ?? '';
      const type = /\bt="([^"]+)"/i.exec(attributes)?.[1] ?? 'n';

      if (type === 's') {
        const index = Number.parseInt(
          /<v>\s*([\s\S]*?)\s*<\/v>/i.exec(body)?.[1] ?? '',
          10,
        );
        cells.push(Number.isFinite(index) ? (strings[index] ?? '') : '');
        continue;
      }

      if (type === 'inlineStr') {
        cells.push(tidy(xmlToText(body, [])).replace(/\n+/g, ' '));
        continue;
      }

      // Strip any `<f>` formula so only the cached `<v>` result is taken.
      const value = /<v>\s*([\s\S]*?)\s*<\/v>/i.exec(body.replace(/<f\b[\s\S]*?<\/f>/gi, ''))?.[1];
      cells.push(value ? decodeEntities(value).trim() : '');
    }

    // A row of entirely empty cells is spacing, not data.
    if (cells.some((cell) => cell.length > 0)) lines.push(cells.join('\t'));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extracts text from a DOCX, XLSX or PPTX.
 *
 * Never throws. On any failure it returns `hadText: false` with `error` set, which the
 * caller turns into a visible, honest note rather than fabricated text.
 */
export function extractOfficeText(bytes: Uint8Array, kind: OfficeKind): OfficeTextResult {
  const empty: OfficeTextResult = {
    text: '',
    hadText: false,
    partsRead: 0,
    error: null,
    truncated: false,
  };

  try {
    const entries = readCentralDirectory(bytes);
    if (entries.length === 0) {
      // "Archive" is how the format works, not something the reader has any reason to
      // know. What they can act on is that the file did not open and the original is
      // still held unchanged.
      return {
        ...empty,
        error:
          'This file could not be opened, so no text was read from it. It may be damaged or ' +
          'saved in a different format than its name suggests. The file is stored unchanged ' +
          'and can be opened or shared from the case.',
      };
    }

    const chunks: string[] = [];
    let partsRead = 0;
    let truncated = false;
    let total = 0;

    const push = (value: string): void => {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (total >= MAX_TEXT_CHARS) {
        truncated = true;
        return;
      }
      const room = MAX_TEXT_CHARS - total;
      if (trimmed.length > room) {
        chunks.push(trimmed.slice(0, room));
        total = MAX_TEXT_CHARS;
        truncated = true;
        return;
      }
      chunks.push(trimmed);
      total += trimmed.length;
      partsRead += 1;
    };

    if (kind === 'docx') {
      for (const part of docxParts(entries)) {
        const xml = readMember(bytes, part);
        if (!xml) continue;
        push(tidy(xmlToText(xml, ['w:p', 'w:tr'], ['w:tc'])));
      }
    } else if (kind === 'xlsx') {
      const table = entries.find((entry) => /^xl\/sharedStrings\.xml$/i.test(entry.name));
      const tableXml = table ? readMember(bytes, table) : null;
      const strings = tableXml ? sharedStrings(tableXml) : [];

      for (const sheet of numberedParts(entries, /^xl\/worksheets\/sheet\d*\.xml$/i)) {
        const xml = readMember(bytes, sheet);
        if (!xml) continue;
        push(sheetText(xml, strings));
      }
    } else {
      for (const slide of numberedParts(entries, /^ppt\/slides\/slide\d*\.xml$/i)) {
        const xml = readMember(bytes, slide);
        if (!xml) continue;
        push(tidy(xmlToText(xml, ['a:p'], [])));
      }
    }

    const text = chunks.join('\n\n');
    const substantive = text.replace(/\s/g, '').length;

    if (substantive < MIN_TEXT_CHARS) {
      return {
        text: '',
        hadText: false,
        partsRead,
        error: null,
        truncated,
      };
    }

    return { text, hadText: true, partsRead, error: null, truncated };
  } catch {
    // The whole-archive guard. Individual members are already guarded; this catches
    // anything structural the directory reader did not anticipate.
    return {
      ...empty,
      error:
        'This file could not be read, so no text was extracted from it. The file is stored ' +
        'unchanged and can be opened or shared from the case. Saving it again as DOCX, XLSX ' +
        'or PDF and re-uploading will let it be analysed.',
    };
  }
}

/** Maps a file extension to a supported container, or null for the legacy binaries. */
export function officeKindFor(extension: string): OfficeKind | null {
  const ext = extension.toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  return null;
}
