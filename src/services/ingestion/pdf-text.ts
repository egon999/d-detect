import { inflate, inflateRaw } from 'pako';

/**
 * A dependency-free PDF *text-layer* reader.
 *
 * WHAT THIS DOES
 * --------------
 * Walks the raw bytes of a PDF looking for `stream` … `endstream` pairs, inflates
 * the ones whose object dictionary says `/FlateDecode` (via pako), and pulls the
 * operands of the text-showing operators (`Tj`, `TJ`, `'`, `"`) out of the decoded
 * content streams. It also reads uncompressed content streams, which is what small
 * or generated PDFs usually contain. Line structure is preserved by emitting a
 * newline for the line-positioning operators (`Td`, `TD`, `T*`) and at `ET`,
 * because the downstream deterministic extractor reads values by line context
 * ("Invoice No: …" has to stay on one line).
 *
 * WHAT THIS DOES *NOT* DO
 * -----------------------
 * - It is NOT a full PDF parser. There is no xref table parsing, no object graph,
 *   no page tree traversal, no resource/font resolution.
 * - It does NOT do OCR. A PDF that is just scanned images has no text layer, and
 *   this returns `hadTextLayer: false` for it. That is the honest answer, not an
 *   error — the caller surfaces it to the user rather than inventing text.
 * - It does NOT map glyphs through font encodings (`/Differences`, CMaps). Text
 *   drawn with a subset font that has a non-standard encoding can come out as
 *   mojibake. Simple/UTF-16BE cases are handled; exotic CID fonts are not.
 * - It does NOT decrypt encrypted PDFs, and does not decode filters other than
 *   Flate (LZW, ASCII85, RunLength, DCT/JPX image codecs are skipped).
 * - Text order follows the order operators appear in the file, which is usually but
 *   not always visual reading order (multi-column layouts can interleave).
 *
 * SAFETY
 * ------
 * This function parses untrusted, possibly malformed binary on the UI thread, so:
 * never throws (everything is wrapped; a stream that fails to inflate is skipped),
 * and work is capped — at most `MAX_STREAMS` streams and `MAX_TEXT_CHARS` of
 * accumulated text — so a hostile or corrupt file cannot hang the app.
 */

/** Hard ceiling on streams examined, so a malformed file cannot spin forever. */
const MAX_STREAMS = 400;

/** Hard ceiling on extracted text (~2 MB of UTF-16 chars). */
const MAX_TEXT_CHARS = 2_000_000;

/**
 * A PDF `TJ` array interleaves strings with horizontal adjustments in thousandths
 * of an em. A large negative adjustment moves the pen *right* by a wide gap, which
 * is how many generators encode an inter-word space instead of emitting " ".
 * Anything beyond this is treated as a word break.
 */
const KERN_SPACE_THRESHOLD = -100;

/** Below this many non-whitespace characters we call it "no usable text layer". */
const MIN_TEXT_LAYER_CHARS = 20;

/** How far back from `stream` to look for the owning object dictionary. */
const DICT_LOOKBEHIND = 2048;

export interface PdfTextResult {
  text: string;
  pages: number;
  hadTextLayer: boolean;
}

/**
 * Byte-for-byte latin1 decode: byte 0x41 becomes U+0041, byte 0xFF becomes U+00FF.
 *
 * This is deliberate and load-bearing. It makes string indices identical to byte
 * offsets, so we can scan for ASCII markers like `stream` with plain `indexOf`
 * and then slice the *original* `Uint8Array` at the same index to hand real bytes
 * to pako. A UTF-8 decode would collapse multi-byte sequences and desynchronise
 * the two.
 */
function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  const from = Math.max(0, start);
  const to = Math.min(bytes.length, end);
  if (to <= from) return '';
  let out = '';
  // Chunked to stay well clear of the argument-count limit on `apply`/spread.
  const CHUNK = 4096;
  for (let i = from; i < to; i += CHUNK) {
    const stop = Math.min(to, i + CHUNK);
    let piece = '';
    for (let j = i; j < stop; j += 1) {
      piece += String.fromCharCode(bytes[j] as number);
    }
    out += piece;
  }
  return out;
}

/** Decodes the escape sequences legal inside a PDF literal `(string)`. */
function decodeLiteralEscapes(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw.charAt(i);
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const next = raw.charAt(i + 1);
    switch (next) {
      case 'n':
        out += '\n';
        i += 2;
        break;
      case 'r':
        out += '\r';
        i += 2;
        break;
      case 't':
        out += '\t';
        i += 2;
        break;
      case 'b':
        out += '\b';
        i += 2;
        break;
      case 'f':
        out += '\f';
        i += 2;
        break;
      case '(':
        out += '(';
        i += 2;
        break;
      case ')':
        out += ')';
        i += 2;
        break;
      case '\\':
        out += '\\';
        i += 2;
        break;
      case '\r':
        // Line continuation: backslash-EOL produces nothing. Eat CRLF as one.
        i += raw.charAt(i + 2) === '\n' ? 3 : 2;
        break;
      case '\n':
        i += 2;
        break;
      default: {
        // Octal: \d, \dd or \ddd (1-3 digits).
        if (next >= '0' && next <= '7') {
          let digits = next;
          let k = i + 2;
          while (k < raw.length && digits.length < 3) {
            const d = raw.charAt(k);
            if (d < '0' || d > '7') break;
            digits += d;
            k += 1;
          }
          out += String.fromCharCode(parseInt(digits, 8) & 0xff);
          i = k;
        } else if (next === '') {
          // Trailing backslash at end of input.
          i += 1;
        } else {
          // Unknown escape: the spec says drop the backslash, keep the char.
          out += next;
          i += 2;
        }
        break;
      }
    }
  }
  return out;
}

/**
 * Decodes a PDF hex string body (the part between `<` and `>`).
 * `<48656C6C6F>` → "Hello". Odd digit counts are padded with a trailing 0 per spec.
 * A leading UTF-16BE byte-order mark is honoured, since that is how many producers
 * write non-ASCII text.
 */
function decodeHexString(body: string): string {
  const hex = body.replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length === 0) return '';
  const padded = hex.length % 2 === 1 ? `${hex}0` : hex;
  const codes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    const byte = parseInt(padded.slice(i, i + 2), 16);
    codes.push(Number.isNaN(byte) ? 0 : byte);
  }
  if (codes.length >= 2 && codes[0] === 0xfe && codes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < codes.length; i += 2) {
      out += String.fromCharCode(((codes[i] as number) << 8) | (codes[i + 1] as number));
    }
    return out;
  }
  let out = '';
  for (const code of codes) out += String.fromCharCode(code);
  return out;
}

/**
 * Pulls text out of one decoded content stream.
 *
 * A hand-rolled scanner rather than a regex sweep: strings can contain the very
 * delimiters and operator names we are looking for (`(ET) Tj` is legal), so the
 * only correct way to find operators is to walk the stream and skip string bodies
 * as units.
 */
function extractFromContentStream(content: string, budget: number): string {
  let out = '';
  /** Strings seen since the last operator, awaiting a text-showing operator. */
  let pending: string[] = [];
  /** `[` depth, so the kerning rule only applies inside a `TJ` array. */
  let arrayDepth = 0;
  let i = 0;

  const flushText = () => {
    if (pending.length > 0) {
      out += pending.join('');
      pending = [];
    }
  };

  while (i < content.length) {
    if (out.length >= budget) break;
    const ch = content.charAt(i);

    // Whitespace and structural separators.
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0') {
      i += 1;
      continue;
    }

    // Comment: runs to end of line.
    if (ch === '%') {
      while (i < content.length) {
        const c = content.charAt(i);
        if (c === '\n' || c === '\r') break;
        i += 1;
      }
      continue;
    }

    if (ch === '[') {
      arrayDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ']') {
      if (arrayDepth > 0) arrayDepth -= 1;
      i += 1;
      continue;
    }

    // Literal string: track nesting, honour backslash escapes.
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      const start = j;
      while (j < content.length && depth > 0) {
        const c = content.charAt(j);
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        j += 1;
      }
      const body = content.slice(start, Math.max(start, j - 1));
      pending.push(decodeLiteralEscapes(body));
      i = j;
      continue;
    }

    if (ch === '<') {
      // `<<` opens a dictionary; a single `<` opens a hex string.
      if (content.charAt(i + 1) === '<') {
        i += 2;
        continue;
      }
      const close = content.indexOf('>', i + 1);
      if (close === -1) break;
      pending.push(decodeHexString(content.slice(i + 1, close)));
      i = close + 1;
      continue;
    }

    if (ch === '>') {
      i += content.charAt(i + 1) === '>' ? 2 : 1;
      continue;
    }

    if (ch === '{' || ch === '}' || ch === ')') {
      i += 1;
      continue;
    }

    // Name object: /F1, /Type. Never text, so just skip it.
    if (ch === '/') {
      let j = i + 1;
      while (j < content.length && !isDelimiterOrSpace(content.charAt(j))) j += 1;
      i = j;
      continue;
    }

    // Number (possibly the kerning adjustment inside a TJ array).
    if ((ch >= '0' && ch <= '9') || ch === '-' || ch === '+' || ch === '.') {
      let j = i;
      while (j < content.length) {
        const c = content.charAt(j);
        if ((c >= '0' && c <= '9') || c === '-' || c === '+' || c === '.' || c === 'e' || c === 'E') {
          j += 1;
        } else break;
      }
      const num = Number.parseFloat(content.slice(i, j));
      if (
        arrayDepth > 0 &&
        Number.isFinite(num) &&
        num < KERN_SPACE_THRESHOLD &&
        pending.length > 0
      ) {
        pending.push(' ');
      }
      i = j;
      continue;
    }

    // `'` and `"` are single-character operators that also show text.
    if (ch === "'" || ch === '"') {
      flushText();
      out += '\n';
      i += 1;
      continue;
    }

    // Otherwise: an operator token made of letters (and `*`, as in `T*`).
    if (isOperatorChar(ch)) {
      let j = i;
      while (j < content.length && isOperatorChar(content.charAt(j))) j += 1;
      const op = content.slice(i, j);
      i = j;
      switch (op) {
        case 'Tj':
        case 'TJ':
          flushText();
          break;
        case 'Td':
        case 'TD':
        case 'T*':
        case 'ET':
          // Line-positioning and end-of-text both end the current line. The
          // downstream extractor reads by line, so this structure matters.
          flushText();
          out += '\n';
          break;
        default:
          // Any other operator: its operands were not text after all.
          pending = [];
          break;
      }
      continue;
    }

    // Unrecognised byte (binary noise): skip it.
    i += 1;
  }

  flushText();
  return out;
}

function isOperatorChar(ch: string): boolean {
  // `*` so `T*`, `W*`, `f*` and `B*` scan as single tokens.
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '*';
}

function isDelimiterOrSpace(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\t' ||
    ch === '\f' ||
    ch === '\0' ||
    ch === '(' ||
    ch === ')' ||
    ch === '<' ||
    ch === '>' ||
    ch === '[' ||
    ch === ']' ||
    ch === '{' ||
    ch === '}' ||
    ch === '/' ||
    ch === '%'
  );
}

/** Counts `/Type /Page` (not `/Pages`), tolerating whitespace variations. */
function countPageObjects(text: string): number {
  const matches = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return matches ? matches.length : 0;
}

/** Reads `/Length 1234` from a dictionary. Returns null for indirect refs (`12 0 R`). */
function readLengthHint(dict: string): number | null {
  // The `\b` after the digits matters: without it the regex backtracks and matches
  // a one-digit prefix of `12 0 R` (reading `/Length 12 0 R` as length 1).
  const match = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
  if (!match) return null;
  const value = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Locates the end of a stream body. Prefers the `/Length` hint, but only when
 * `endstream` actually appears there — many real files have a wrong `/Length`.
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

/**
 * True when `index` is the start of a real `stream` keyword, rather than the tail
 * of `endstream` or a substring of some longer name.
 */
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

/** Collapses runs of spaces and blank lines without destroying line structure. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts the text layer of a PDF.
 *
 * Never throws. On anything unexpected it returns empty text with
 * `hadTextLayer: false`, which the caller reports as "no readable text".
 */
export function extractPdfText(bytes: Uint8Array): PdfTextResult {
  try {
    if (!bytes || bytes.length === 0) {
      return { text: '', pages: 0, hadTextLayer: false };
    }

    const raw = latin1(bytes);
    let collected = '';
    let streamsSeen = 0;
    /** `/Type /Page` markers found inside decoded object streams. */
    let pagesInStreams = 0;

    let cursor = 0;
    while (streamsSeen < MAX_STREAMS && collected.length < MAX_TEXT_CHARS) {
      const found = raw.indexOf('stream', cursor);
      if (found === -1) break;
      cursor = found + 6;
      if (!isStreamKeywordAt(raw, found)) continue;

      streamsSeen += 1;

      // The owning dictionary sits just before the keyword. We do not parse the
      // object graph; we take the nearest preceding `<<` within a window. That is
      // enough to read `/Filter` and `/Length`, and a miss only costs us one stream.
      const windowStart = Math.max(0, found - DICT_LOOKBEHIND);
      const before = raw.slice(windowStart, found);
      const dictStart = before.lastIndexOf('<<');
      const dict = dictStart === -1 ? '' : before.slice(dictStart);

      const bodyStart = bodyStartAfterKeyword(raw, found + 6);
      const lengthHint = readLengthHint(dict);
      const bodyEnd = findStreamEnd(raw, bodyStart, lengthHint);
      if (bodyEnd === -1 || bodyEnd <= bodyStart) continue;
      cursor = bodyEnd;

      // Image and other binary payloads: decoding them yields pixel noise, not text.
      if (/\/Subtype\s*\/Image/.test(dict) || /\/Type\s*\/XObject/.test(dict)) continue;
      if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|RunLengthDecode)\b/.test(dict)) {
        continue;
      }
      // Embedded font programs and metadata are not page text.
      if (/\/Type\s*\/(Metadata|EmbeddedFile)\b/.test(dict) || /\/FontFile\d?\b/.test(dict)) {
        continue;
      }

      let content: string | null = null;
      if (/\/(FlateDecode|Fl)\b/.test(dict)) {
        // A stream that will not inflate is skipped, never fatal: truncated,
        // encrypted and mislabelled streams are all common in the wild.
        const body = bytes.subarray(bodyStart, bodyEnd);
        try {
          content = latin1(inflate(body));
        } catch {
          try {
            // Some producers write raw deflate with no zlib wrapper.
            content = latin1(inflateRaw(body));
          } catch {
            content = null;
          }
        }
      } else if (!/\/Filter\b/.test(dict)) {
        // No filter at all: the body is already plain content. Common in small,
        // generated and linearised-by-hand PDFs.
        content = raw.slice(bodyStart, bodyEnd);
      } else {
        // A filter we do not implement (LZW, ASCII85, …).
        content = null;
      }

      if (content === null) continue;

      // Object streams (`/Type /ObjStm`) hold compressed object definitions, which
      // is where page objects hide in modern PDFs. Count them, don't scan for text.
      if (/\/Type\s*\/ObjStm/.test(dict)) {
        pagesInStreams += countPageObjects(content);
        continue;
      }

      const budget = MAX_TEXT_CHARS - collected.length;
      if (budget <= 0) break;
      const piece = extractFromContentStream(content, budget);
      if (piece.length > 0) collected += `${piece}\n`;
    }

    const text = tidy(collected);
    const nonWhitespace = text.replace(/\s/g, '').length;
    const hadTextLayer = nonWhitespace >= MIN_TEXT_LAYER_CHARS;

    let pages = countPageObjects(raw) + pagesInStreams;
    // A file whose page objects we could not see, but which clearly had text,
    // is at least one page. Reporting 0 pages alongside real text would be wrong.
    if (pages === 0 && nonWhitespace > 0) pages = 1;

    return { text, pages, hadTextLayer };
  } catch {
    // The whole extractor is best-effort. A crash here must not take the UI down.
    return { text: '', pages: 0, hadTextLayer: false };
  }
}
