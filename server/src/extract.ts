import { resolve } from 'node:path';

import { z } from 'zod';

import { askJson, MAX_VISION_BYTES, MAX_VISION_EDGE, readImage, visionAvailable } from './ai/index.ts';
import { config, SERVER_ROOT } from './env.ts';
import { fileBytes, isImage, type StoredFile } from './files.ts';
import { directionOf } from './money.ts';
import { asSentence, looksTechnical, withoutPlaceholders } from './prose.ts';

const TESSDATA_DIR = resolve(SERVER_ROOT, 'tessdata');

export type SourceText = {
  text: string;

  method: 'text' | 'pdf' | 'docx' | 'vision' | 'scene' | 'ocr' | 'none';

  note: string | null;
};

const PDF_PAGE_CAP = 12;

type PdfRead =
  | { kind: 'text'; text: string; truncated: number | null }
  | { kind: 'locked' }
  | { kind: 'broken' }
  | { kind: 'imageOnly'; page: Uint8Array | null };

async function pdfRead(bytes: Uint8Array): Promise<PdfRead> {
  const { PDFParse, PasswordException } = await import('pdf-parse');
  let parser: InstanceType<typeof PDFParse> | null = null;
  try {
    parser = new PDFParse({ data: Buffer.from(bytes) });
    const parsed = await parser.getText({ first: PDF_PAGE_CAP });

    const text = (parsed.text ?? '').replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '').trim();
    const total = parsed.total ?? 0;

    if (text) {
      return { kind: 'text', text, truncated: total > PDF_PAGE_CAP ? total : null };
    }

    const page = await renderFirstPage(parser);
    return { kind: 'imageOnly', page };
  } catch (cause) {
    if (cause instanceof PasswordException) return { kind: 'locked' };

    const named = cause instanceof Error ? cause.name : '';
    const said = cause instanceof Error ? cause.message : '';
    if (named === 'PasswordException' || /password/i.test(said)) return { kind: 'locked' };
    return { kind: 'broken' };
  } finally {
    await parser?.destroy().catch(() => {});
  }
}

async function renderFirstPage(parser: InstanceType<typeof import('pdf-parse')['PDFParse']>): Promise<Uint8Array | null> {
  try {
    const shot = await parser.getScreenshot({ first: 1, desiredWidth: MAX_VISION_EDGE, imageBuffer: true });
    const data = shot.pages?.[0]?.data;
    return data && data.length > 0 ? new Uint8Array(data) : null;
  } catch {
    return null;
  }
}

async function docxText(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import('mammoth')) as unknown as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const parsed = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return parsed.value ?? '';
}

type OcrWorker = {
  recognize: (input: Buffer) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<void>;
};

let worker: Promise<OcrWorker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function ocrWorker(): Promise<OcrWorker> {
  worker ??= (async () => {
    const { createWorker } = (await import('tesseract.js')) as unknown as {
      createWorker: (
        langs: string,
        oem?: number,
        options?: { cachePath?: string },
      ) => Promise<OcrWorker>;
    };

    return createWorker('eng+hin', undefined, { cachePath: TESSDATA_DIR });
  })().catch((cause: unknown) => {
    worker = null;
    throw cause;
  });
  return worker;
}

export async function shutdownOcr(): Promise<void> {
  const active = worker;
  worker = null;
  await active?.then((w) => w.terminate()).catch(() => {});
}

export class OcrTimeout extends Error {
  constructor(readonly ms: number) {
    super(`OCR did not finish within ${ms}ms.`);
    this.name = 'OcrTimeout';
  }
}

export function withCeiling<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OcrTimeout(ms)), ms);

    timer.unref();
  });
  return Promise.race([work, clock]).finally(() => clearTimeout(timer));
}

function abandonWorker(): void {
  const stuck = worker;
  worker = null;
  void stuck?.then((active) => active.terminate()).catch(() => {});
}

async function ocrPass(bytes: Uint8Array): Promise<string> {
  const active = await ocrWorker();
  try {
    const result = await active.recognize(Buffer.from(bytes));
    return result.data.text ?? '';
  } catch (cause) {
    worker = null;
    await active.terminate().catch(() => {});
    throw cause;
  }
}

async function ocrText(bytes: Uint8Array): Promise<string> {
  const slot = queue;
  const run = (async () => {

    await slot.catch(() => {});
    try {
      return await withCeiling(ocrPass(bytes), config.ai.timeoutMs);
    } catch (cause) {
      if (cause instanceof OcrTimeout) abandonWorker();
      throw cause;
    }
  })();

  queue = run.catch(() => {});
  return run;
}

export const TEXT_PART = '[TEXT]';
export const SCENE_PART = '[SCENE]';

export function readableSourceText(text: string | null | undefined): string | null {
  if (!text) return null;
  const stripped = text
    .split('\n')
    .filter((line) => line.trim() !== TEXT_PART && line.trim() !== SCENE_PART)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped.length > 0 ? stripped : null;
}

const IMAGE_READ_PROMPT = [
  `Report what is in this image under these two headings, and write nothing else.`,
  '',
  TEXT_PART,
  'Every piece of text visible in the image, transcribed exactly as it appears: the same language and script, the same reading order, the same line breaks. Include amounts, names, dates, times, reference numbers, status words and small print. Do not translate, correct, summarise or comment on it.',
  `If the image contains no text at all, write NONE here and nothing else.`,
  '',
  SCENE_PART,
  'What the image shows: the place, the objects, the food or goods, how many people are in it, any brand or shop name on a sign, and anything visible that indicates where or when it was taken.',
  'Describe only what is visible. Never state a price, a total, a date or who owns anything unless the image itself prints it, in which case it belongs under the first heading.',
  `If the image shows nothing identifiable, write NONE here and nothing else.`,
].join('\n');

function absent(part: string): boolean {
  const value = part.trim().replace(/^[[\]\s*_:-]+/, '').replace(/[.\s]+$/, '');
  if (!value) return true;
  if (value.length > 120 || /\d/.test(value)) return false;
  if (/^(none|nothing|n\/?a|empty|null)$/i.test(value)) return true;
  return /\b(no|not|none|nothing|without)\b/i.test(value) &&
    /\b(text|words?|writing|content|readable|legible|visible|identifiable|discernible|subject)\b/i.test(value);
}

function visionParts(answer: string): { transcribed: string; scene: string } {
  const upper = answer.toUpperCase();
  const textAt = upper.indexOf(TEXT_PART);
  const sceneAt = upper.indexOf(SCENE_PART);
  if (sceneAt === -1) {
    return { transcribed: textAt === -1 ? answer : answer.slice(textAt + TEXT_PART.length), scene: '' };
  }
  return {
    transcribed: textAt === -1 || textAt > sceneAt ? '' : answer.slice(textAt + TEXT_PART.length, sceneAt),
    scene: answer.slice(sceneAt + SCENE_PART.length),
  };
}

function readPicture(answer: string): SourceText | null {
  const parts = visionParts(answer);
  const transcribed = absent(parts.transcribed) ? '' : parts.transcribed.trim();
  const scene = absent(parts.scene) ? '' : parts.scene.trim();

  if (transcribed) {
    return {
      text: scene ? `${TEXT_PART}\n${transcribed}\n\n${SCENE_PART}\n${scene}` : transcribed,
      method: 'vision',
      note: null,
    };
  }
  if (scene) return { text: `${SCENE_PART}\n${scene}`, method: 'scene', note: null };
  return null;
}

async function imageForVision(
  bytes: Uint8Array,
  mime: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  let resize: (typeof import('sharp'))['default'];
  try {
    const mod = await import('sharp');
    resize = mod.default;
    if (typeof resize !== 'function') throw new Error('sharp did not load');
  } catch {

    return bytes.byteLength <= MAX_VISION_BYTES ? { bytes, mime } : null;
  }

  const source = Buffer.from(bytes);
  const size = await resize(source)
    .metadata()
    .then((data) => Math.max(data.width ?? 0, data.height ?? 0))
    .catch(() => 0);

  if (size > 0 && size <= MAX_VISION_EDGE && bytes.byteLength <= MAX_VISION_BYTES) {
    return { bytes, mime };
  }

  for (const [edge, quality] of [
    [MAX_VISION_EDGE, 82],
    [1100, 68],
  ] as const) {
    const resized = await resize(source)

      .rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer()
      .catch(() => null);
    if (resized && resized.byteLength <= MAX_VISION_BYTES) {
      return { bytes: new Uint8Array(resized), mime: 'image/jpeg' };
    }
  }
  return null;
}

function sniffMime(bytes: Uint8Array): string | null {
  const at = (offset: number, expected: string): boolean =>
    expected.split('').every((character, index) => bytes[offset + index] === character.charCodeAt(0));

  if (bytes.length >= 4 && at(0, '%PDF')) return 'application/pdf';
  if (bytes.length >= 8 && at(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif';
  if (bytes.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (bytes.length >= 2 && at(0, 'BM')) return 'image/bmp';
  if (bytes.length >= 4 && at(0, 'II*\x00')) return 'image/tiff';
  if (bytes.length >= 4 && at(0, 'MM\x00*')) return 'image/tiff';

  if (bytes.length >= 12 && at(4, 'ftyp')) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (/^(?:heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1|avif)$/.test(brand)) return 'image/heic';
    if (/^(?:isom|iso2|mp41|mp42|M4A|qt)/.test(brand)) return 'video/mp4';
  }
  if (bytes.length >= 4 && at(0, 'PK\x03\x04')) return 'application/zip';
  return null;
}

async function readAsPicture(bytes: Uint8Array, mime: string): Promise<SourceText> {
  if (visionAvailable()) {
    try {
      const sized = await imageForVision(bytes, mime);
      if (sized) {
        const answer = await readImage({
          prompt: IMAGE_READ_PROMPT,
          imageBase64: Buffer.from(sized.bytes).toString('base64'),
          mime: sized.mime,
        });
        const read = readPicture(answer.text);
        if (read) return read;
      }
    } catch {

    }
  }
  const text = await ocrText(bytes).catch(() => '');
  if (text.trim()) {
    return { text, method: 'ocr', note: 'Check the amount and the date against the picture.' };
  }
  return {
    text: '',
    method: 'none',
    note: 'Nothing could be read in this picture. Try taking a fresh photo in good light, with the whole page in the frame.',
  };
}

function readableText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

export async function readSource(file: StoredFile, owner?: string): Promise<SourceText> {
  let mime = file.mime.toLowerCase();
  const bytes = fileBytes(file, owner);

  if (bytes.byteLength === 0) {
    return {
      text: '',
      method: 'none',
      note: 'That file is empty. Try uploading it again.',
    };
  }

  if (mime.startsWith('text/') || mime === 'application/json') {
    return { text: readableText(bytes), method: 'text', note: null };
  }

  const sniffed = sniffMime(bytes);
  if (sniffed && sniffed !== 'application/zip') {

    if (sniffed === 'image/heic') {
      return {
        text: '',
        method: 'none',
        note: 'This photo is in a format the app cannot read. Take a screenshot of it and upload that instead.',
      };
    }
    if (sniffed === 'video/mp4') {
      return {
        text: '',
        method: 'none',
        note: 'That is a video. Upload a screenshot of it instead.',
      };
    }
    mime = sniffed;
  }

  if (mime === 'application/pdf') {
    const read = await pdfRead(bytes).catch((): PdfRead => ({ kind: 'broken' }));

    if (read.kind === 'text') {
      return {
        text: read.text,
        method: 'pdf',
        note: read.truncated === null
          ? null
          : `Only the first ${PDF_PAGE_CAP} pages of this file were read. Upload the later pages separately if you need them.`,
      };
    }
    if (read.kind === 'imageOnly') {

      if (!read.page) {
        return {
          text: '',
          method: 'none',
          note: 'This PDF is a scan with no text in it. Take a photo of the page and upload that instead.',
        };
      }
      return readAsPicture(read.page, 'image/png');
    }
    if (read.kind === 'locked') {
      return {
        text: '',
        method: 'none',
        note: 'This PDF is locked with a password. Save a copy without the password and upload that, or take a photo of the page instead.',
      };
    }
    return {
      text: '',
      method: 'none',
      note: 'This PDF could not be opened — the file may be incomplete. Try uploading it again, or take a photo of the page instead.',
    };
  }

  if (mime.endsWith('wordprocessingml.document')) {
    const text = await docxText(bytes).catch(() => '');
    if (!text.trim()) {
      return {
        text: '',
        method: 'none',
        note: 'Nothing could be read from this document. Try uploading it as a PDF or a picture instead.',
      };
    }
    return { text, method: 'docx', note: null };
  }

  if (isImage(mime)) {
    return readAsPicture(bytes, mime);
  }

  return { text: '', method: 'none', note: 'This kind of file cannot be read yet. Upload a photo, a screenshot, a PDF or a document.' };
}

export const RECORD_KINDS = [
  'payment',
  'purchase',
  'bill',
  'receipt',
  'ticket',
  'travel',
  'document',
  'message',
  'note',
  'other',
] as const;

export const DOCUMENT_TYPES = {

  upi_payment: { kind: 'payment', money: true },
  card_payment: { kind: 'payment', money: true },
  bank_message: { kind: 'payment', money: true },
  bank_statement: { kind: 'document', money: true },
  cheque: { kind: 'payment', money: true },
  loan_statement: { kind: 'document', money: true },

  restaurant_bill: { kind: 'bill', money: true },
  shop_bill: { kind: 'purchase', money: true },
  tax_invoice: { kind: 'bill', money: true },
  delivery_receipt: { kind: 'receipt', money: true },

  utility_bill: { kind: 'bill', money: true },
  rent_receipt: { kind: 'receipt', money: true },
  insurance_premium: { kind: 'bill', money: true },
  fee_receipt: { kind: 'receipt', money: true },
  salary_slip: { kind: 'document', money: true },
  medical_bill: { kind: 'bill', money: true },
  challan: { kind: 'bill', money: true },

  travel_ticket: { kind: 'ticket', money: true },
  hotel_booking: { kind: 'travel', money: true },

  warranty_card: { kind: 'document', money: false },
  prescription: { kind: 'document', money: false },
  govt_document: { kind: 'document', money: false },
  fir_copy: { kind: 'document', money: false },

  agreement: { kind: 'document', money: true },

  chat_message: { kind: 'message', money: true },
  note: { kind: 'note', money: true },
  photo: { kind: 'other', money: true },
  other: { kind: 'other', money: true },
} as const satisfies Record<string, { kind: (typeof RECORD_KINDS)[number]; money: boolean }>;

export type DocumentType = keyof typeof DOCUMENT_TYPES;

export const DOCUMENT_TYPE_NAMES = Object.keys(DOCUMENT_TYPES) as [DocumentType, ...DocumentType[]];

const DOCUMENT_TYPE_SET = new Set<string>(DOCUMENT_TYPE_NAMES);

export function kindOf(documentType: DocumentType): (typeof RECORD_KINDS)[number] {
  return DOCUMENT_TYPES[documentType]?.kind ?? 'other';
}

export function expectsAmount(documentType: DocumentType): boolean {
  return DOCUMENT_TYPES[documentType]?.money ?? false;
}

export const UnderstoodRecord = z.object({

  documentType: z.enum(DOCUMENT_TYPE_NAMES).default('other'),
  kind: z.enum(RECORD_KINDS),

  title: z.string().min(1).max(200),

  occurredAt: z.string().nullable(),
  occurredPrecision: z.enum(['minute', 'day', 'month', 'year']).nullable(),

  amount: z.string().nullable(),

  currency: z.string().nullable(),
  direction: z.enum(['out', 'in']).nullable(),
  counterparty: z.string().nullable(),
  category: z.string().nullable(),
  reference: z.string().nullable(),
  status: z.string().nullable(),

  summary: z.string().max(1_000),

  missingContext: z
    .object({
      field: z.enum(['purpose', 'category', 'counterparty', 'amount', 'date', 'other']),
      question: z.string().max(300),
      options: z.array(z.string().max(100)).transform((items) => items.slice(0, 8)),
    })
    .nullable(),
});

export type UnderstoodRecord = z.infer<typeof UnderstoodRecord>;

const UNDERSTAND_SYSTEM = [
  'You read one document, screenshot or note and describe what it records.',
  '',
  'Return JSON in exactly this shape:',
  '{',
  `  "documentType": one of ${DOCUMENT_TYPE_NAMES.map((type) => `"${type}"`).join(' | ')},`,
  `  "kind": one of ${RECORD_KINDS.map((kind) => `"${kind}"`).join(' | ')},`,
  '  "title": string,',
  '  "occurredAt": ISO 8601 string or null,',
  '  "occurredPrecision": "minute" | "day" | "month" | "year" | null,',
  '  "amount": decimal string or null,',
  '  "currency": ISO 4217 code or null,',
  '  "direction": "out" | "in" | null,',
  '  "counterparty": string or null,',
  '  "category": string or null,',
  '  "reference": string or null,',
  '  "status": string or null,',
  '  "summary": string,',
  '  "missingContext": { "field": "purpose" | "category" | "counterparty" | "amount" | "date" | "other", "question": string, "options": string[] } or null',
  '}',
  '',
  'Which kind of document — "documentType" is the sort of thing this is. Choose the one that',
  'matches, which is not always the one named after the file: a UPI confirmation and a bank',
  'debit SMS are both about money leaving, but the first is "upi_payment" and the second is',
  '"bank_message". Use "other" only when nothing here fits, and "photo" when the picture is a',
  'scene with nothing written in it. "kind" is the coarse bucket and follows from "documentType";',
  'set it consistently with the type you chose.',
  '',
  'Rules:',
  '- Report only what the text states. If a field is not in the text, it is null. Never guess a value.',
  `- A picture read is given in two parts. Everything under ${TEXT_PART} is printed in the image and may be`,
  `  quoted. Everything under ${SCENE_PART} is a description of what the picture shows: use it for "documentType",`,
  `  "kind", "title" and "summary" only. It can never supply an amount, a currency, a counterparty, a reference or a`,
  `  date, and a picture that has only a ${SCENE_PART} part is "photo" — never a payment, purchase, bill or receipt.`,
  '- Keep names, references and status words exactly as written, in their original script.',
  '- "title" names the event and the other party, the way a person would recall it:',
  '  "Paid Sharma Electronics", "Electricity bill", "Flight to Delhi". Never name the app or the',
  '  file — "Google Pay", "PhonePe", "Screenshot_2026.png" are not titles.',
  '- "amount" is the single headline amount of the transaction as a decimal string, without',
  '  separators or a currency symbol. If several amounts appear, use the total actually paid or due.',
  '  A document that carries no amount — a warranty card, a prescription, a government paper — has',
  '  null here. Do not estimate one and do not carry the amount over from a nearby figure.',
  '- "direction" is "out" when the owner of this file paid, "in" when they received.',
  '- "occurredAt" is when the event happened, not when the file was made. Use the precision the',
  '  text supports: a full timestamp, a date, a month, or a year. A bill that says only "March 2026"',
  '  was issued in March, on no particular day — do not invent a day for it.',
  '- "category" is only set when the text itself says what sort of spend this is. A payment screenshot',
  '  names a person or shop, not a category, so it is usually null. Do not infer one.',
  '',
  'About "missingContext" — this is the one question the person will be asked, so it matters:',
  '- At most one question, about the one thing that genuinely matters and is genuinely absent.',
  '- A payment or purchase screenshot records who, how much and when. It almost never records WHY.',
  '  Unless the text itself names the goods, the invoice, the bill or the reason, ask what it was for.',
  '  Do not treat a merchant name as the reason — "Sharma Electronics" says where, not what.',
  '- Never ask for anything the text already states. If the amount is on it, the amount is not a question.',
  '- Ask the question that fits this sort of document, not a generic one. A ticket is missing where you',
  '  are going, not what you bought. A warranty card is missing which appliance it covers. A rent',
  '  receipt is complete and should have no question at all.',
  '- Give up to four likely "options" the person could tap instead of typing, drawn from what this',
  '  particular counterparty or this sort of document plausibly means. Keep each under four words.',
  '- Set it to null when the file genuinely states everything that matters. That is the common case',
  '  for a receipt with an itemised heading and a date.',
  `- A picture with only a ${SCENE_PART} part never states why it was kept, so ask what it is for.`,
  '- Write "title", "summary" and "question" in the language the source is written in.',
].join('\n');

export type Understanding = {
  record: UnderstoodRecord;
  provider: string;
  model: string;
};

const DEFAULT_QUESTION: Partial<Record<DocumentType, { field: 'purpose' | 'category' | 'other'; question: string; options: string[] }>> = {
  upi_payment: {
    field: 'purpose',
    question: 'What was this payment for?',
    options: ['Groceries', 'Food delivery', 'Recharge', 'Transfer to a person', 'Bill'],
  },
  card_payment: {
    field: 'purpose',
    question: 'What was this payment for?',
    options: ['Shopping', 'Food', 'Travel', 'Subscription', 'Fuel'],
  },
  bank_message: {
    field: 'purpose',
    question: 'What was this spent on?',
    options: ['Groceries', 'Bills', 'Transfer', 'Cash withdrawal', 'Subscription'],
  },
  cheque: {
    field: 'purpose',
    question: 'What was this cheque for?',
    options: ['Rent', 'Fees', 'Repayment', 'Purchase', 'Advance'],
  },
  restaurant_bill: {
    field: 'purpose',
    question: 'Was this a meal out or a delivery?',
    options: ['Dining out', 'Delivery', 'Takeaway', 'Office order'],
  },
  shop_bill: {
    field: 'purpose',
    question: 'What did you buy?',
    options: ['Groceries', 'Clothes', 'Household', 'Electronics', 'Medicine'],
  },
  chat_message: {
    field: 'other',
    question: 'What is this about?',
    options: ['Payment', 'Appointment', 'Order', 'Work', 'Family'],
  },
  photo: {
    field: 'purpose',
    question: 'What is this a picture of?',
    options: ['Something bought', 'A place', 'An event', 'A document'],
  },
};

const MISSING_CONTEXT_FIELDS = new Set(['purpose', 'category', 'counterparty', 'amount', 'date', 'other']);

function plain(value: string | null | undefined, limit: number): string | null {
  const cleaned = withoutPlaceholders(value);
  if (cleaned === null) return null;
  if (looksTechnical(cleaned)) return null;
  return cleaned.slice(0, limit).trim() || null;
}

function plainSentence(value: string, fallback: string, limit: number): string {
  const cleaned = plain(value, limit);
  if (cleaned === null) return fallback;

  return /^[\x20-\x7e]*$/.test(cleaned) ? asSentence(cleaned) : cleaned;
}

export function refineRecord(record: UnderstoodRecord, source: SourceText): UnderstoodRecord {
  const documentType: DocumentType = DOCUMENT_TYPE_SET.has(record.documentType)
    ? record.documentType
    : 'other';

  const sceneOnly = source.method === 'scene';
  const money = expectsAmount(documentType) && !sceneOnly;

  const amount = money ? plain(record.amount, 40) : null;

  const direction = sceneOnly ? null : record.direction ?? directionOf(source.text);
  const counterparty = sceneOnly ? null : plain(record.counterparty, 200);
  const missing = record.missingContext;
  const fallback = DEFAULT_QUESTION[documentType];

  const missingContext = !missing && fallback
    ? {
        field: fallback.field,
        question: plainSentence(fallback.question, fallback.question, 300),
        options: fallback.options,
      }
    : missing && MISSING_CONTEXT_FIELDS.has(missing.field)
      ? {
          field: missing.field,
          question: plainSentence(missing.question, 'Can you tell us a little more?', 300),
          options: missing.options
            .map((option) => plain(option, 100))
            .filter((option): option is string => option !== null)
            .slice(0, 6),
        }
      : null;

  const alreadyAnswered =
    missingContext !== null &&
    ((missingContext.field === 'amount' && amount !== null) ||
      (missingContext.field === 'date' && record.occurredAt !== null) ||
      (missingContext.field === 'counterparty' && counterparty !== null));

  return {
    ...record,
    documentType,
    kind: kindOf(documentType),
    title: plain(record.title, 200) ?? 'Something saved',
    amount,
    currency: amount && !sceneOnly ? plain(record.currency, 3) : null,
    direction,
    counterparty,
    reference: sceneOnly ? null : plain(record.reference, 200),
    status: sceneOnly ? null : plain(record.status, 200),
    category: sceneOnly ? null : plain(record.category, 80),
    summary: plainSentence(record.summary, 'Saved.', 1_000),
    missingContext: alreadyAnswered ? null : missingContext,
  };
}

export async function understand(source: SourceText, originalName: string): Promise<Understanding> {
  const answer = await askJson(UnderstoodRecord, {
    messages: [
      { role: 'system', content: UNDERSTAND_SYSTEM },
      {
        role: 'user',
        content: `File name: ${originalName}\nRead by: ${source.method}\n\n--- text ---\n${source.text.slice(0, 20_000)}`,
      },
    ],
    temperature: 0,
  });

  return {
    record: refineRecord(answer.value, source),
    provider: answer.provider,
    model: answer.model,
  };
}
