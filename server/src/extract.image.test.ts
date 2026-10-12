import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { deflateSync } from 'node:zlib';

const directory = mkdtempSync(join(tmpdir(), 'detact-vision-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = '';

const { db, ensureUser } = await import('./db.ts');
const { config } = await import('./env.ts');
const { storeUpload, fileById } = await import('./files.ts');
const { readSource, withCeiling, OcrTimeout, TEXT_PART, SCENE_PART, shutdownOcr } = await import('./extract.ts');
const { readImage, visionAvailable, ProviderError, MAX_VISION_BYTES } = await import('./ai/index.ts');

const ai = config.ai as unknown as {
  groqKey: string;
};

function configure(providers: 'none' | 'vision'): void {
  ai.groqKey = providers === 'vision' ? 'test-fixture-only' : '';
}

const GLYPHS: Record<string, string> = {
  '0': '01110,10001,10001,10001,10001,10001,01110', '1': '00100,01100,00100,00100,00100,00100,01110',
  '2': '01110,10001,00001,00010,00100,01000,11111', '3': '11111,00010,00100,00010,00001,10001,01110',
  '4': '00010,00110,01010,10010,11111,00010,00010', '5': '11111,10000,11110,00001,00001,10001,01110',
  '6': '00110,01000,10000,11110,10001,10001,01110', '7': '11111,00001,00010,00100,01000,01000,01000',
  '8': '01110,10001,10001,01110,10001,10001,01110', '9': '01110,10001,10001,01111,00001,00010,01100',
  A: '01110,10001,10001,11111,10001,10001,10001', B: '11110,10001,10001,11110,10001,10001,11110',
  C: '01110,10001,10000,10000,10000,10001,01110', D: '11110,10001,10001,10001,10001,10001,11110',
  E: '11111,10000,10000,11110,10000,10000,11111', F: '11111,10000,10000,11110,10000,10000,10000',
  G: '01110,10001,10000,10111,10001,10001,01111', H: '10001,10001,10001,11111,10001,10001,10001',
  I: '11111,00100,00100,00100,00100,00100,11111', L: '10000,10000,10000,10000,10000,10000,11111',
  M: '10001,11011,10101,10101,10001,10001,10001', N: '10001,10001,11001,10101,10011,10001,10001',
  O: '01110,10001,10001,10001,10001,10001,01110', P: '11110,10001,10001,11110,10000,10000,10000',
  R: '11110,10001,10001,11110,10100,10010,10001', S: '01111,10000,10000,01110,00001,00001,11110',
  T: '11111,00100,00100,00100,00100,00100,00100', U: '10001,10001,10001,10001,10001,10001,01110',
  V: '10001,10001,10001,10001,10001,01010,00100', Y: '10001,10001,01010,00100,00100,00100,00100',
  '.': '00000,00000,00000,00000,00000,01100,01100', ' ': '00000,00000,00000,00000,00000,00000,00000',
};
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

let CRC_TABLE: number[] | null = null;
function crc32(buffer: Buffer): number {
  CRC_TABLE ??= Array.from({ length: 256 }, (_unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function receiptPng(lines: string[], { scale = 12, pad = 40, gap = 4, lead = 6 } = {}): Buffer {
  const columns = Math.max(1, ...lines.map((line) => line.length));
  const width = pad * 2 + columns * (GLYPH_WIDTH + gap) * scale;
  const height = pad * 2 + Math.max(1, lines.length) * (GLYPH_HEIGHT + lead) * scale;
  const drawn = new Uint8Array(width * height).fill(255);

  lines.forEach((line, row) => {
    const top = pad + row * (GLYPH_HEIGHT + lead) * scale;
    [...line.toUpperCase()].forEach((character, column) => {
      const left = pad + column * (GLYPH_WIDTH + gap) * scale;
      (GLYPHS[character] ?? GLYPHS[' ']!).split(',').forEach((bits, y) => {
        [...bits].forEach((bit, x) => {
          if (bit !== '1') return;
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              drawn[(top + y * scale + dy) * width + (left + x * scale + dx)] = 0;
            }
          }
        });
      });
    });
  });

  const blurred = new Uint8Array(drawn);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += drawn[(y + dy) * width + (x + dx)]!;
      blurred[y * width + x] = Math.round(sum / 9);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; 
  header[9] = 0; 
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; 
    Buffer.from(blurred.subarray(y * width, (y + 1) * width)).copy(raw, y * (width + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const RECEIPT = ['PAID 4500.00 TO', 'SHARMA TRADERS', 'ON 05 SEP 2026'];

function upload(bytes: Buffer, name: string) {
  const stored = storeUpload('owner-a', new Uint8Array(bytes), 'image/png', name);
  return fileById(stored.id, 'owner-a')!;
}

function uploadAs(bytes: Uint8Array, mime: string, name: string) {
  const stored = storeUpload('owner-a', bytes, mime, name);
  return fileById(stored.id, 'owner-a')!;
}

function pdfWithNoText(): Uint8Array {
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n += 1) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n += 1) {
    body += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

function receiptFile() {
  return upload(receiptPng(RECEIPT), 'screenshot.png');
}

function blankFile() {
  return upload(receiptPng([' '], { scale: 4, pad: 8 }), 'blank.png');
}

const GROQ_HOST = 'api.groq.com';

type Responder = () => Response;
const calls: string[] = [];

const bodies: string[] = [];
let groq: Responder;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === 'object' && 'url' in input ? input.url : input);
  calls.push(url);
  assert.ok(typeof init?.body === 'string' && init.body.length > 0, `A vision call carried no body: ${url}`);
  bodies.push(init.body);
  if (url.includes(GROQ_HOST)) return groq();
  throw new Error(`Unexpected network call: ${url}`);
};

const down: Responder = () => {
  throw new Error('fetch failed');
};
const unauthorized: Responder = () => {
  throw new Error('This test did not authorize that provider.');
};
const answering = (text: string): Responder => () =>
  Response.json({ choices: [{ message: { content: text } }] });

function visionAnswer(transcribed: string, scene = 'NONE'): string {
  return `${TEXT_PART}\n${transcribed}\n\n${SCENE_PART}\n${scene}`;
}

function hostsCalled(): string[] {
  return calls.map((url) => (url.includes(GROQ_HOST) ? 'groq' : url));
}

function looksTranscribed(text: string): boolean {
  return /\d{3,}/.test(text) && /[A-Za-z]{3,}/.test(text) && text.trim().length > 15;
}

beforeEach(() => {
  db.exec('DELETE FROM files; DELETE FROM users;');
  ensureUser('owner-a', null, null);
  calls.length = 0;
  groq = unauthorized;
  configure('none');
});

after(async () => {

  await shutdownOcr();
  globalThis.fetch = realFetch;
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-vision-'));
  rmSync(target, { recursive: true, force: true });
});

test('with no vision provider configured a PNG is read by the server\'s own OCR, over no network', async () => {
  assert.equal(visionAvailable(), false);

  const source = await readSource(receiptFile(), 'owner-a');

  assert.equal(source.method, 'ocr');
  assert.ok(looksTranscribed(source.text), `OCR returned nothing usable: ${JSON.stringify(source.text)}`);
  assert.match(source.note ?? '', /check the amount/i);
  assert.deepEqual(calls, [], 'OCR must not reach the network to read an image');
});

test('a vendor nobody can reach does not lose the read: the picture still reaches OCR', async () => {
  configure('vision');
  groq = down;

  const source = await readSource(receiptFile(), 'owner-a');

  assert.deepEqual(hostsCalled(), ['groq'], 'an unreachable vendor is asked once, not repeatedly');
  assert.equal(source.method, 'ocr');
  assert.ok(looksTranscribed(source.text), `OCR returned nothing usable: ${JSON.stringify(source.text)}`);
});

test('a Groq answer is the whole read, and nothing else is called for it', async () => {
  configure('vision');
  groq = answering(visionAnswer('Paid 4,500.00 to Sharma Traders'));

  const source = await readSource(receiptFile(), 'owner-a');

  assert.equal(source.method, 'vision');
  assert.match(source.text, /Sharma Traders/);
  assert.deepEqual(hostsCalled(), ['groq']);
});

test('a rate limit is waited out on the same vendor rather than failed over or given up on', async () => {

  configure('vision');
  let attempt = 0;
  groq = () => {
    attempt += 1;
    if (attempt === 1) return new Response('{"error":{"message":"rate limit reached"}}', { status: 429 });
    return Response.json({ choices: [{ message: { content: visionAnswer('Paid 4,500.00 to Sharma Traders') } }] });
  };

  const source = await readSource(receiptFile(), 'owner-a');

  assert.equal(source.method, 'vision');
  assert.deepEqual(hostsCalled(), ['groq', 'groq'], 'the same vendor is asked again after the wait');
});

test('when vision fails the picture still reaches OCR', async () => {
  configure('vision');
  groq = () => new Response('{"error":{"message":"service unavailable"}}', { status: 503 });

  const source = await readSource(receiptFile(), 'owner-a');

  assert.deepEqual(hostsCalled(), ['groq'], 'vision is tried before OCR, and only once');
  assert.equal(source.method, 'ocr');
  assert.ok(looksTranscribed(source.text), `OCR returned nothing usable: ${JSON.stringify(source.text)}`);
});

test('a vision answer that only says there is no text falls through to OCR, and never becomes the record', async () => {
  configure('vision');
  groq = answering(visionAnswer('There is no text in this image.', 'NONE'));

  const source = await readSource(receiptFile(), 'owner-a');

  assert.equal(source.method, 'ocr');
  assert.ok(!/no text in this image/i.test(source.text), 'a denial must never be stored as the transcription');
  assert.ok(looksTranscribed(source.text));
});

test('an image is normalised before it is sent, so a camera original is not refused for its size', async () => {
  configure('vision');
  groq = answering(visionAnswer('Paid 4500.00 to Sharma Traders'));

  const wide = upload(receiptPng(RECEIPT, { scale: 34, pad: 80 }), 'camera.png');
  const source = await readSource(wide, 'owner-a');

  assert.equal(source.method, 'vision');
  const body = JSON.parse(bodies.at(-1)!) as {
    messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
  };
  const dataUrl = body.messages[0]!.content.find((part) => part.image_url)!.image_url!.url;
  const [header, base64] = dataUrl.split(',');

  assert.equal(
    header,
    'data:image/jpeg;base64',
    'a picture over either ceiling is re-encoded, not sent as it is',
  );
  const sentBytes = Buffer.from(base64!, 'base64').byteLength;
  assert.ok(sentBytes > 0 && sentBytes <= MAX_VISION_BYTES, `sent ${sentBytes} bytes`);
});

test('a picture nothing can read is an empty read with a sentence, not a throw and not a hang', async () => {
  const source = await readSource(blankFile(), 'owner-a');

  assert.equal(source.text.trim(), '');
  assert.equal(source.method, 'none');
  assert.ok(source.note && source.note.length > 0, 'an unreadable picture must carry a sentence for the person');
  assert.match(source.note, /read/i);
});

test('an OCR pass is bounded, so a stalled read cannot wedge the capture or the ones behind it', async () => {

  const stalled = withCeiling(new Promise<string>(() => {}), 25);
  await assert.rejects(() => stalled, (error: unknown) => error instanceof OcrTimeout);

  assert.equal(await withCeiling(Promise.resolve('read'), 60_000), 'read');

  const [first, second] = await Promise.all([
    readSource(receiptFile(), 'owner-a'),
    readSource(receiptFile(), 'owner-a'),
  ]);
  assert.equal(first.method, 'ocr');
  assert.equal(second.method, 'ocr');
});

test('a scanned PDF is a picture of a page, and is read as one', async () => {

  configure('vision');
  groq = answering(visionAnswer('PAID 4500.00 TO SHARMA TRADERS'));

  const source = await readSource(uploadAs(pdfWithNoText(), 'application/pdf', 'scan.pdf'), 'owner-a');

  assert.equal(source.method, 'vision', 'a scan should reach the picture reader, not stop at the text reader');
  assert.match(source.text, /SHARMA TRADERS/);
  assert.deepEqual(hostsCalled(), ['groq']);

  const sent = JSON.parse(bodies.at(-1)!);
  const url = JSON.stringify(sent).match(/data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(url, 'the rendered page was not attached to the vision call');
  assert.ok(Buffer.from(url, 'base64').byteLength > 1_000, 'the rendered page was suspiciously small');
});

test('with nothing configured the vision layer refuses plainly instead of pretending to retry', async () => {
  const failure = await readImage({ prompt: 'read this', imageBase64: 'AAAA', mime: 'image/png' }).then(
    () => null,
    (cause: unknown) => cause,
  );

  assert.ok(failure instanceof ProviderError);
  assert.match(failure.message, /No vision provider is configured/);
  assert.equal(failure.retryable, false, 'an unconfigured provider is not a transient failure');
  assert.deepEqual(calls, []);
});
