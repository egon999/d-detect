import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'detact-understand-'));
process.env.DATA_DIR = directory;

process.env.GROQ_API_KEY = '';

const {
  DOCUMENT_TYPES,
  RECORD_KINDS,
  expectsAmount,
  kindOf,
  readSource,
  readableSourceText,
  refineRecord,
  UnderstoodRecord,
} = await import('./extract.ts');
const { looksTechnical } = await import('./prose.ts');
const { db } = await import('./db.ts');

type Stored = Parameters<typeof readSource>[0];
type Record_ = typeof UnderstoodRecord extends { parse: (value: unknown) => infer R } ? R : never;

const OWNER = 'understand-owner';

after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

let serial = 0;
function stored(bytes: Uint8Array | string, mime: string, name: string): Stored {
  const body = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const path = join(directory, `probe-${serial++}`);
  writeFileSync(path, body);
  return {
    id: `file_${serial}`,
    user_id: OWNER,
    sha256: 'x'.repeat(64),
    mime,
    bytes: body.byteLength,
    original_name: name,
    stored_path: path,
    created_at: Date.now(),
  };
}

function pdfWithPages(pages: number): Uint8Array {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ');

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Count ${pages} /Kids [${kids}] >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  for (let i = 0; i < pages; i += 1) {
    const pageObj = 4 + i * 2;
    const contentObj = pageObj + 1;
    const line = `Page ${i + 1} line: Rs ${1000 + i}.00`;
    const stream = `BT /F1 18 Tf 72 700 Td (${line}) Tj ET`;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n += 1) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }

  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n += 1) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

function complete(over: Partial<Record_> = {}): Record_ {
  return UnderstoodRecord.parse({
    documentType: 'upi_payment',
    kind: 'payment',
    title: 'Paid Sharma Electronics',
    occurredAt: '2026-09-28T19:42:00+05:30',
    occurredPrecision: 'minute',
    amount: '4500.00',
    currency: 'INR',
    direction: 'out',
    counterparty: 'SHARMA ELECTRONICS',
    category: 'Electronics',
    reference: '462839175503',
    status: 'Completed',
    summary: 'Paid ₹4,500.00 to SHARMA ELECTRONICS.',
    missingContext: null,
    ...over,
  });
}

function source(text: string, method: Awaited<ReturnType<typeof readSource>>['method'] = 'vision') {
  return { text, method, note: null };
}

test('every document type lands in a bucket the rest of the app already groups by', () => {

  const kinds = new Set<string>(RECORD_KINDS);
  for (const name of Object.keys(DOCUMENT_TYPES) as Array<keyof typeof DOCUMENT_TYPES>) {
    assert.ok(kinds.has(kindOf(name)), `${name} derives an unknown kind`);
  }
  assert.equal(kindOf('other'), 'other');

  assert.equal(kindOf('nonsense_type' as keyof typeof DOCUMENT_TYPES), 'other');
  assert.equal(expectsAmount('nonsense_type' as keyof typeof DOCUMENT_TYPES), false);
});

test('a bank message counts as money and a kept paper does not', () => {

  assert.equal(kindOf('bank_message'), 'payment');
  assert.equal(expectsAmount('bank_message'), true);

  for (const kept of ['warranty_card', 'prescription', 'govt_document', 'fir_copy'] as const) {
    assert.equal(expectsAmount(kept), false, kept);
    assert.equal(kindOf(kept), 'document', kept);
  }

  assert.equal(expectsAmount('agreement'), true);
  assert.equal(kindOf('agreement'), 'document');

  assert.equal(expectsAmount('salary_slip'), true);
  assert.equal(kindOf('salary_slip'), 'document');
});

test('an unclassified document keeps a figure the document really did print', () => {

  for (const unclassified of ['other', 'note', 'chat_message', 'photo'] as const) {
    assert.equal(expectsAmount(unclassified), true, unclassified);
  }

  const typeless = refineRecord(
    UnderstoodRecord.parse({ ...complete(), documentType: undefined }),
    source('Paid Rs 500.00 to Sharma Kirana'),
  );
  assert.equal(typeless.documentType, 'other');
  assert.equal(typeless.amount, '4500.00');
  assert.equal(typeless.currency, 'INR');
});

test('an amount is dropped from a document that cannot have printed one', () => {

  const invented = refineRecord(
    complete({ documentType: 'warranty_card', amount: '45000.00', currency: 'INR', direction: 'out' }),
    source('Warranty card. Model: WM-6102. Two years from date of purchase.'),
  );
  assert.equal(invented.amount, null);
  assert.equal(invented.currency, null);
  assert.equal(invented.kind, 'document');

  const real = refineRecord(complete({ documentType: 'shop_bill' }), source('Total Rs 4500.00'));
  assert.equal(real.amount, '4500.00');
  assert.equal(real.currency, 'INR');
  assert.equal(real.kind, 'purchase');
});

test('a photo with no text in it cannot come back carrying a transaction', () => {

  const scene = refineRecord(
    complete({ documentType: 'photo', summary: 'A photograph of a dog on a terrace.' }),
    source('A photograph of a dog sitting on a terrace.', 'scene'),
  );
  assert.equal(scene.amount, null);
  assert.equal(scene.currency, null);
  assert.equal(scene.direction, null);
  assert.equal(scene.counterparty, null);
  assert.equal(scene.reference, null);
  assert.equal(scene.status, null);
  assert.equal(scene.category, null);
  assert.equal(scene.kind, 'other');

  const insistent = refineRecord(complete({ documentType: 'upi_payment' }), source('A dog.', 'scene'));
  assert.equal(insistent.amount, null);
  assert.equal(insistent.counterparty, null);
});

test('a document type the model made up is clamped instead of reaching a screen', () => {

  assert.throws(() => complete({ documentType: 'crypto_invoice' as never }));

  const unparsed = { ...complete(), documentType: 'crypto_invoice' as never, kind: 'payment' as const };
  const clamped = refineRecord(unparsed, source('Paid 4500'));
  assert.equal(clamped.documentType, 'other');
  assert.equal(clamped.kind, 'other');

  assert.equal(clamped.amount, '4500.00');

  const silent = UnderstoodRecord.parse({ ...complete(), documentType: undefined });
  assert.equal(silent.documentType, 'other');
});

test('which way the money went is taken off the document when the model will not say', () => {

  const debited = refineRecord(
    complete({ documentType: 'bank_message', direction: null }),
    source('Rs 4500.00 debited from your account XX4412 on 28-09-26'),
  );
  assert.equal(debited.direction, 'out');

  const credited = refineRecord(
    complete({ documentType: 'bank_message', direction: null }),
    source('Your account has been credited with Rs 45,000.00 salary'),
  );
  assert.equal(credited.direction, 'in');

  const both = refineRecord(
    complete({ documentType: 'bank_message', direction: null }),
    source('Rs 500 debited from your account and credited to the beneficiary'),
  );
  assert.equal(both.direction, null);

  const stated = refineRecord(
    complete({ documentType: 'bank_message', direction: 'in' }),
    source('Rs 4500.00 debited from your account'),
  );
  assert.equal(stated.direction, 'in');
});

test('a sentence about the machinery never survives as the thing a person reads', () => {
  const leaked = refineRecord(
    complete({
      title: 'OCR returned null',
      summary: 'Could not parse the JSON response from the vision model.',
      counterparty: 'unknown',
      reference: 'N/A',
      category: 'ENOENT',
    }),
    source('Paid 4500'),
  );
  assert.equal(leaked.title, 'Something saved');
  assert.equal(leaked.summary, 'Saved.');
  assert.equal(leaked.counterparty, null);
  assert.equal(leaked.reference, null);
  assert.equal(leaked.category, null);
  for (const text of [leaked.title, leaked.summary]) {
    assert.equal(looksTechnical(text), false, text);
  }
});

test('a summary in the language of the document is left in that language', () => {
  const hindi = refineRecord(
    complete({ summary: 'यह बिल अन्ना पूर्णा मेस का है।' }),
    source('अन्ना पूर्णा मेस, कुल ₹1,144.50'),
  );
  assert.equal(hindi.summary, 'यह बिल अन्ना पूर्णा मेस का है।');
});

test('nothing the document already states is asked about again', () => {

  const askedAmount = refineRecord(
    complete({ missingContext: { field: 'amount', question: 'How much was this?', options: ['₹100', '₹500'] } }),
    source('Paid Rs 4500.00 to Sharma Electronics'),
  );
  assert.equal(askedAmount.missingContext, null);

  const askedDate = refineRecord(
    complete({ missingContext: { field: 'date', question: 'When was this?', options: ['Today', 'Yesterday'] } }),
    source('28 Sep 2026, 7:42 PM'),
  );
  assert.equal(askedDate.missingContext, null);

  const askedWho = refineRecord(
    complete({
      missingContext: { field: 'counterparty', question: 'Who was this paid to?', options: ['A shop', 'A person'] },
    }),
    source('To SHARMA ELECTRONICS'),
  );
  assert.equal(askedWho.missingContext, null);

  const genuinelyMissing = refineRecord(
    complete({
      documentType: 'shop_bill',
      occurredAt: null,
      occurredPrecision: null,
      missingContext: { field: 'date', question: 'When did you buy this?', options: ['Today', 'Yesterday'] },
    }),
    source('Sharma Electronics. Total Rs 4500.00'),
  );
  assert.equal(genuinelyMissing.missingContext?.field, 'date');
});

test('a document that needs nothing is not given a question to make the screen look busy', () => {

  for (const settled of ['rent_receipt', 'utility_bill', 'travel_ticket', 'salary_slip', 'prescription'] as const) {
    const record = refineRecord(complete({ documentType: settled }), source('Printed document with every field'));
    assert.equal(record.missingContext, null, settled);
  }
});

test('a payment the document cannot explain gets exactly one question, answerable in one tap', () => {

  const upi = refineRecord(complete({ missingContext: null }), source('Paid Rs 4500.00 to SHARMA ELECTRONICS'));
  const question = upi.missingContext;
  assert.ok(question, 'a UPI payment should ask what it was for');
  assert.equal(question.field, 'purpose');
  assert.ok(question.question.endsWith('?'), question.question);
  assert.ok(question.options.length >= 2 && question.options.length <= 6, `${question.options.length} options`);
  for (const option of question.options) {

    assert.ok(option.length <= 40, option);
    assert.equal(looksTechnical(option), false, option);
  }
  assert.equal(looksTechnical(question.question), false, question.question);
});

test('a question the model wrote is cleaned the same way every other sentence is', () => {
  const messy = refineRecord(
    complete({
      documentType: 'shop_bill',
      missingContext: {
        field: 'category',
        question: 'Which category should the extraction use?',
        options: ['Groceries', 'unknown', 'N/A', 'Electronics'],
      },
    }),
    source('Sharma Electronics Rs 4500.00'),
  );

  assert.equal(messy.missingContext?.question, 'Can you tell us a little more?');

  assert.deepEqual(messy.missingContext?.options, ['Groceries', 'Electronics']);
});

test('a file that cannot be read says what to do next, in words a shopkeeper could act on', async () => {
  const cases: Array<[string, Stored]> = [
    ['empty', stored(new Uint8Array(0), 'image/png', 'photo.png')],
    ['heic', stored(heic(), 'image/heic', 'IMG_4417.HEIC')],
    ['video', stored(mp4(), 'video/mp4', 'clip.mp4')],
    ['truncated pdf', stored('%PDF-1.4\n1 0 obj\n<< /Type /Catalog', 'application/pdf', 'bill.pdf')],
    ['unknown format', stored(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]), 'application/x-thing', 'thing.bin')],
  ];

  for (const [name, file] of cases) {
    const read = await readSource(file, OWNER);
    assert.equal(read.text, '', name);
    assert.equal(read.method, 'none', name);
    assert.ok(read.note, `${name} left the person with no sentence at all`);

    assert.equal(looksTechnical(read.note), false, `${name}: ${read.note}`);
    assert.ok(/[.!?]$/.test(read.note!), `${name}: ${read.note}`);
    assert.ok(read.note!.length > 20, `${name}: ${read.note}`);
  }
});

test('the bytes decide which reader runs, not what the file is called', async () => {

  const lying = stored(pdfWithPages(1), 'image/png', 'receipt.png');
  const read = await readSource(lying, OWNER);
  assert.equal(read.method, 'pdf');
  assert.match(read.text, /Page 1 line/);

  const note = await readSource(stored('%PDF is the thing I need to ask about', 'text/plain', 'note.txt'), OWNER);
  assert.equal(note.method, 'text');
  assert.match(note.text, /ask about/);
});

test('every page of a multi-page document is read, and a longer one says what it left out', async () => {

  const short = await readSource(stored(pdfWithPages(4), 'application/pdf', 'bill.pdf'), OWNER);
  assert.equal(short.method, 'pdf');
  for (let page = 1; page <= 4; page += 1) {
    assert.match(short.text, new RegExp(`Page ${page} line`), `page ${page} was not read`);
  }
  assert.equal(short.note, null, 'a document read in full has nothing to disclose');

  const long = await readSource(stored(pdfWithPages(30), 'application/pdf', 'statement.pdf'), OWNER);
  assert.equal(long.method, 'pdf');
  assert.match(long.text, /Page 1 line/);
  assert.match(long.text, /Page 12 line/);
  assert.doesNotMatch(long.text, /Page 13 line/);
  assert.ok(long.note, 'a truncated read must say so');
  assert.equal(looksTechnical(long.note), false, long.note!);

  assert.match(long.note!, /pages/i);
});

test('a document in an Indian language is read as text, not refused', async () => {
  const hindi = 'विद्युत बिल\nउपभोक्ता: रमेश कुमार\nकुल देय राशि: ₹१,१४४.५०\nदिनांक: २९ सितंबर २०२६';
  const read = await readSource(stored(hindi, 'text/plain; charset=utf-8', 'bill.txt'), OWNER);
  assert.equal(read.method, 'text');
  assert.match(read.text, /विद्युत बिल/);
  assert.match(read.text, /१,१४४.५०/);
  assert.equal(read.note, null);
});

test('what a person is shown of the reading carries no headings from inside this server', () => {

  const stored = '[TEXT]\nPayment Successful\n₹ 4,500.00\n\n[SCENE]\nA payment confirmation screen.';
  const shown = readableSourceText(stored);
  assert.ok(shown);
  assert.doesNotMatch(shown, /\[TEXT\]|\[SCENE\]/);
  assert.match(shown, /Payment Successful/);
  assert.match(shown, /A payment confirmation screen\./);

  assert.match(shown, /4,500\.00\n\nA payment/);

  assert.equal(readableSourceText('Paid Rs 500 to Sharma Kirana'), 'Paid Rs 500 to Sharma Kirana');
  assert.equal(readableSourceText('[TEXT]\n\n[SCENE]'), null);
  assert.equal(readableSourceText(''), null);
  assert.equal(readableSourceText(null), null);
});

function heic(): Uint8Array {
  const head = [0x00, 0x00, 0x00, 0x18];
  const rest = new TextEncoder().encode('ftypheic\u0000\u0000\u0000\u0000mif1heic');
  return new Uint8Array([...head, ...rest]);
}

function mp4(): Uint8Array {
  const head = [0x00, 0x00, 0x00, 0x18];
  const rest = new TextEncoder().encode('ftypisom\u0000\u0000\u0002\u0000isomiso2');
  return new Uint8Array([...head, ...rest]);
}
