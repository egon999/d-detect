import { describe, expect, it } from 'vitest';
import { deflateRaw } from 'pako';

import { extractOfficeText, officeKindFor } from '../src/services/ingestion/office-docs';

/**
 * These tests build real ZIP archives byte by byte rather than checking in binary
 * fixtures. A committed .docx would be opaque: when a test failed you could not see what
 * the input was, and adjusting the case would mean opening Word. Constructing the
 * container here means the archive under test is readable in the diff, and it exercises
 * the actual central-directory walk instead of a mock.
 */

const encoder = new TextEncoder();

interface Member {
  name: string;
  content: string;
  /** Stored instead of deflated, to cover the method-0 branch. */
  stored?: boolean;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

/** A minimal but structurally valid ZIP: local headers, central directory, EOCD. */
function buildZip(members: readonly Member[]): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];

  for (const member of members) {
    const name = encoder.encode(member.name);
    const raw = encoder.encode(member.content);
    const data = member.stored ? raw : deflateRaw(raw, { level: 6 });
    const method = member.stored ? 0 : 8;

    offsets.push(local.length);

    local.push(
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(method),
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(0), // crc32 — not verified by the reader
      ...u32(data.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0), // extra length
      ...name,
      ...data,
    );
  }

  members.forEach((member, index) => {
    const name = encoder.encode(member.name);
    const raw = encoder.encode(member.content);
    const data = member.stored ? raw : deflateRaw(raw, { level: 6 });

    central.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(member.stored ? 0 : 8),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(data.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk
      ...u16(0), // internal attrs
      ...u32(0), // external attrs
      ...u32(offsets[index]!),
      ...name,
    );
  });

  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(members.length),
    ...u16(members.length),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0), // comment length
  ];

  return Uint8Array.from([...local, ...central, ...eocd]);
}

function docx(body: string): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    { name: 'word/document.xml', content: `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>` },
  ]);
}

function paragraph(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

describe('officeKindFor', () => {
  it('maps the modern ZIP containers and refuses the legacy binaries', () => {
    expect(officeKindFor('.docx')).toBe('docx');
    expect(officeKindFor('.xlsx')).toBe('xlsx');
    expect(officeKindFor('.xlsm')).toBe('xlsx');
    expect(officeKindFor('.pptx')).toBe('pptx');
    expect(officeKindFor('.DOCX')).toBe('docx');
    expect(officeKindFor('.doc')).toBeNull();
    expect(officeKindFor('.odt')).toBeNull();
  });
});

describe('extractOfficeText — DOCX', () => {
  it('reads paragraphs as separate lines', () => {
    const result = extractOfficeText(docx(paragraph('Invoice No: 4471') + paragraph('Total: INR 1,000.00')), 'docx');

    expect(result.hadText).toBe(true);
    expect(result.error).toBeNull();
    expect(result.text).toContain('Invoice No: 4471');
    expect(result.text.split('\n')).toContain('Total: INR 1,000.00');
  });

  /*
    The reason the tag list in `xmlToText` is load-bearing. A two-column table of
    label/value pairs is how most invoices are laid out, and if the cell and row ends do
    not become a tab and a newline the whole table collapses into one line — at which
    point every `Label: value` pattern in the deterministic extractor stops matching and
    the document silently yields nothing usable.
  */
  it('keeps table rows on separate lines and separates cells', () => {
    const row = (a: string, b: string) =>
      `<w:tr><w:tc>${paragraph(a)}</w:tc><w:tc>${paragraph(b)}</w:tc></w:tr>`;
    const result = extractOfficeText(
      docx(`<w:tbl>${row('Bill No', '4471')}${row('Amount', 'INR 100.00')}</w:tbl>`),
      'docx',
    );

    const lines = result.text.split('\n').filter(Boolean);
    expect(lines.some((line) => line.includes('Bill No') && line.includes('4471'))).toBe(true);
    expect(lines.some((line) => line.includes('Amount') && line.includes('INR 100.00'))).toBe(true);
    // The two rows must not have merged into one.
    expect(lines.some((line) => line.includes('4471') && line.includes('INR 100.00'))).toBe(false);
  });

  it('decodes XML entities and explicit breaks', () => {
    const result = extractOfficeText(
      docx('<w:p><w:r><w:t>Ram &amp; Co &#8212; paid</w:t><w:br/><w:t>Second line</w:t></w:r></w:p>'),
      'docx',
    );

    expect(result.text).toContain('Ram & Co — paid');
    expect(result.text.split('\n')).toContain('Second line');
  });

  it('reads headers and footers after the body', () => {
    const bytes = buildZip([
      { name: 'word/document.xml', content: `<w:document><w:body>${paragraph('Body text')}</w:body></w:document>` },
      { name: 'word/header1.xml', content: `<w:hdr>${paragraph('Acme Pvt Ltd')}</w:hdr>` },
    ]);
    const result = extractOfficeText(bytes, 'docx');

    expect(result.text.indexOf('Body text')).toBeLessThan(result.text.indexOf('Acme Pvt Ltd'));
  });

  it('reads a stored (uncompressed) member', () => {
    const bytes = buildZip([
      {
        name: 'word/document.xml',
        content: `<w:document><w:body>${paragraph('Stored not deflated')}</w:body></w:document>`,
        stored: true,
      },
    ]);

    expect(extractOfficeText(bytes, 'docx').text).toContain('Stored not deflated');
  });
});

describe('extractOfficeText — XLSX', () => {
  function xlsx(sheet: string, strings: readonly string[] = []): Uint8Array {
    const si = strings.map((value) => `<si><t>${value}</t></si>`).join('');
    return buildZip([
      { name: 'xl/sharedStrings.xml', content: `<sst count="${strings.length}">${si}</sst>` },
      { name: 'xl/worksheets/sheet1.xml', content: `<worksheet><sheetData>${sheet}</sheetData></worksheet>` },
    ]);
  }

  it('resolves shared strings and tab-separates cells', () => {
    const sheet =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1000</v></c></row>';
    const result = extractOfficeText(xlsx(sheet, ['Item', 'Amount', 'Repair']), 'xlsx');

    expect(result.hadText).toBe(true);
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('Item\tAmount');
    expect(lines[1]).toBe('Repair\t1000');
  });

  it('takes a formula cell cached result and never the formula', () => {
    const sheet = '<row r="1"><c r="A1"><f>SUM(B1:B9)</f><v>2500</v></c></row>';
    const result = extractOfficeText(xlsx(sheet), 'xlsx');

    expect(result.text).toContain('2500');
    expect(result.text).not.toContain('SUM');
  });

  it('reads inline strings', () => {
    const sheet = '<row r="1"><c r="A1" t="inlineStr"><is><t>Paid to Big Bazaar</t></is></c></row>';
    expect(extractOfficeText(xlsx(sheet), 'xlsx').text).toContain('Paid to Big Bazaar');
  });

  it('drops rows where every cell is empty', () => {
    const sheet =
      '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
      '<row r="2"><c r="A2"><v></v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>1</v></c></row>';
    const result = extractOfficeText(xlsx(sheet, ['First value here', 'Second value here']), 'xlsx');

    expect(result.text.split('\n').filter(Boolean)).toHaveLength(2);
  });
});

describe('extractOfficeText — PPTX', () => {
  it('reads slides in numeric order, not lexical', () => {
    const slide = (text: string) => `<p:sld><p:cSld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:cSld></p:sld>`;
    const bytes = buildZip([
      { name: 'ppt/slides/slide10.xml', content: slide('Tenth slide') },
      { name: 'ppt/slides/slide2.xml', content: slide('Second slide') },
      { name: 'ppt/slides/slide1.xml', content: slide('First slide') },
    ]);
    const result = extractOfficeText(bytes, 'pptx');

    expect(result.text.indexOf('First slide')).toBeLessThan(result.text.indexOf('Second slide'));
    expect(result.text.indexOf('Second slide')).toBeLessThan(result.text.indexOf('Tenth slide'));
  });
});

describe('extractOfficeText — failure behaviour', () => {
  it('never throws on arbitrary non-archive bytes', () => {
    const junk = Uint8Array.from({ length: 2048 }, (_, index) => (index * 37) % 256);
    const result = extractOfficeText(junk, 'docx');

    expect(result.hadText).toBe(false);
    // The sentence is shown to the person who uploaded the file, so it is asserted on what
    // it has to tell them — what happened, and that the original is still held — rather
    // than on its exact wording. It must not reach for the format's internals: "archive"
    // and "zip" describe how a DOCX is built, which is not something a reader knows.
    expect(result.error).toMatch(/could not be opened/);
    expect(result.error).toMatch(/stored unchanged/);
    expect(result.error).not.toMatch(/archive|zip|parse|directory/i);
  });

  it('never throws on an empty buffer', () => {
    expect(() => extractOfficeText(new Uint8Array(0), 'xlsx')).not.toThrow();
    expect(extractOfficeText(new Uint8Array(0), 'xlsx').hadText).toBe(false);
  });

  it('reports no text — not an error — for a valid archive with an empty body', () => {
    const result = extractOfficeText(docx(paragraph('')), 'docx');

    expect(result.hadText).toBe(false);
    expect(result.error).toBeNull();
  });

  it('skips a member whose deflate stream is corrupt without losing the rest', () => {
    const good = buildZip([
      { name: 'word/document.xml', content: `<w:document><w:body>${paragraph('Readable body')}</w:body></w:document>` },
      { name: 'word/header1.xml', content: `<w:hdr>${paragraph('Header')}</w:hdr>` },
    ]);

    // Corrupt the first bytes of the *header* member's deflate payload. The body member
    // sits earlier in the archive and must still read.
    const corrupted = Uint8Array.from(good);
    const headerAt = corrupted.indexOf(0x50, good.length / 2);
    if (headerAt > 0) corrupted[headerAt + 40] = 0xff;

    const result = extractOfficeText(corrupted, 'docx');
    expect(result.text).toContain('Readable body');
  });

  it('caps a member so a decompression bomb cannot exhaust memory', () => {
    const huge = 'A'.repeat(12 * 1024 * 1024);
    const bytes = docx(paragraph(huge));
    const result = extractOfficeText(bytes, 'docx');

    // Either capped at the member ceiling or at the text ceiling — never the full 12 MB.
    expect(result.text.length).toBeLessThanOrEqual(1_000_000);
  });
});
