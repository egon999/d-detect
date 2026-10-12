import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Account } from '../auth.ts';
import type { UnderstoodRecord } from '../extract.ts';

const directory = mkdtempSync(join(tmpdir(), 'detact-daybook-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';
const { db, ensureUser } = await import('../db.ts');
const { daybook, resumeInterruptedReads, settleAbandonedReads, staleReadSweep, STALE_READ_AFTER_MS } = await import('./daybook.ts');
const { recoverInterruptedWork } = await import('../recovery.ts');

const { lookView } = await import('../signals/index.ts');

const app = new Hono<{ Variables: { account: Account } }>();
app.use('*', async (context, next) => {
  const id = context.req.header('x-test-owner') ?? 'owner-a';
  ensureUser(id, null, null);
  context.set('account', { id, email: null, name: null });
  await next();
});
app.route('/daybook', daybook);
app.onError((error, context) => context.json({ error: error.message }, error instanceof HTTPException ? error.status : 500));

type ProviderBody = { messages?: Array<{ role: string; content: string }> };

function promptOf(body: ProviderBody): string {
  return (body.messages ?? []).map((message) => message.content).join('\n');
}

const LABEL_MARKER = 'You label a personal spending record';

const SIGNAL_MARKER = 'commitments and renewals';

const refuse = (): never => {
  throw new Error('This test did not authorize a model call.');
};

let readFile: (body: ProviderBody) => unknown = refuse;

let labelWith: (body: ProviderBody) => unknown = refuse;

let labelPrompts: string[] = [];

let materialRead = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  assert.ok(url.includes('/chat/completions'), `Unexpected network call: ${url}`);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as ProviderBody : {};
  const prompt = promptOf(body);

  let result: unknown;
  if (prompt.includes(LABEL_MARKER)) {
    labelPrompts.push(prompt);
    result = await labelWith(body);
  } else if (prompt.includes(SIGNAL_MARKER)) {
    materialRead += 1;
    result = { commitments: [], renewals: [] };
  } else {
    result = await readFile(body);
  }
  return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
};

beforeEach(() => {
  db.exec('DELETE FROM jobs; DELETE FROM signals; DELETE FROM signal_scans; DELETE FROM questions; DELETE FROM cases; DELETE FROM meetings; DELETE FROM records; DELETE FROM tasks; DELETE FROM budgets; DELETE FROM files; DELETE FROM users;');
  ensureUser('owner-a', null, null);
  readFile = refuse;
  labelWith = refuse;
  labelPrompts = [];
  materialRead = 0;
});

after(() => {
  globalThis.fetch = realFetch;

  clearInterval(staleReadSweep);
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-daybook-'));
  rmSync(target, { recursive: true, force: true });
});

type PresentedRecord = {
  id: string;
  kind: string;
  title: string;
  occurredAt: number | null;
  occurredPrecision: string | null;
  amountMinor: number | null;
  currency: string | null;
  amountLabel: string | null;
  direction: string | null;
  counterparty: string | null;
  category: string | null;
  note: string | null;
  fileId: string | null;
  status: string;

  progress: string | null;
  extraction: Record<string, unknown>;
  question: { id: string; field: string; prompt: string; options: string[] } | null;
};

type TestResponse = {
  record: PresentedRecord;
  records: PresentedRecord[];
  nextCursor: number | null;
  duplicate: boolean;
  retrying: boolean;

  answerApplied: boolean;
  deleted: boolean;
  error: string;
};

async function request(path: string, method = 'GET', body?: unknown, owner = 'owner-a') {
  const response = await app.request(path, {
    method,
    headers: { 'x-test-owner': owner, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as TestResponse };
}

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail('Background work did not settle within one second.');
}

function jobFinished() {
  return (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status NOT IN ('done', 'failed', 'cancelled')").get() as { n: number }).n === 0;
}

function rows(table: 'records' | 'files' | 'questions'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function categoryOf(recordId: string): string | null {
  return (db.prepare('SELECT category FROM records WHERE id = ?').get(recordId) as { category: string | null }).category;
}

function statusOf(recordId: string): string {
  return (db.prepare('SELECT status FROM records WHERE id = ?').get(recordId) as { status: string }).status;
}

function jobStatusOf(recordId: string): string | null {
  const row = db
    .prepare(`SELECT status FROM jobs WHERE kind = 'capture' AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(recordId) as { status: string } | undefined;
  return row?.status ?? null;
}

function questionRow(recordId: string): { field: string; answer: string | null; answered_at: number | null } {
  return db.prepare('SELECT field, answer, answered_at FROM questions WHERE record_id = ?').get(recordId) as {
    field: string;
    answer: string | null;
    answered_at: number | null;
  };
}

async function passSettled() {
  await eventually(() => !lookView('owner-a').looking);
}

function plantSignal(id: string, rule: string, sources: Array<{ kind: 'record' | 'meeting'; id: string }>): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO signals (id, user_id, kind, rule, title, detail, sources, status, fingerprint, created_at, updated_at)
     VALUES (?, 'owner-a', 'anomaly', ?, 'Something to check', '', ?, 'open', ?, ?, ?)`,
  ).run(id, rule, JSON.stringify(sources), id, now, now);
}

function signalStatus(id: string): string | null {
  const row = db.prepare('SELECT status FROM signals WHERE id = ?').get(id) as { status: string } | undefined;
  return row?.status ?? null;
}

function abandon(recordId: string, ageMs = STALE_READ_AFTER_MS + 60_000): void {
  const when = Date.now() - ageMs;
  db.prepare(`UPDATE records SET status = 'processing', note = NULL, updated_at = ? WHERE id = ?`).run(when, recordId);
  db.prepare(`UPDATE jobs SET status = 'reading', updated_at = ? WHERE kind = 'capture' AND subject_id = ?`).run(when, recordId);
}

function heldRead(result: () => unknown): () => void {
  let release = (): void => {};
  const gate = new Promise<void>((done) => {
    release = () => done();
  });
  readFile = async () => {
    await gate;
    return result();
  };
  return () => release();
}

function actionable(message: string): void {
  assert.equal(typeof message, 'string', 'a refusal has to carry something to read');
  assert.ok(message.length > 0 && message.length <= 160, `not a sentence a person can read: ${message}`);
  assert.match(message, /^[A-Z].*[.!]$/s, `not a sentence a person can read: ${message}`);
  assert.ok(
    !/[{}[\]]|zod|invalid_type|\bissues\b|undefined|\[object/i.test(message),
    `this refusal leaked the machine's own words: ${message}`,
  );
}

const RECEIPT = [
  'UPI Payment Successful',
  'Paid to Sharma Electronics',
  '₹1,250.50',
  '05/09/2026, 2:32 pm',
  'UTR 3210987654321',
].join('\n');

const RECEIPT_COPY = `${RECEIPT}\nCounter copy`;

const UNPRICED = 'Counter slip from Sharma Electronics, handed over on 05/09/2026. No amount is printed on it.';

const UNDATED = 'Sharma Electronics — paid ₹1,250.50 by UPI. Reference UTR3210987654.';

function understood(overrides: Partial<UnderstoodRecord> = {}): UnderstoodRecord {
  return {
    documentType: 'upi_payment',
    kind: 'payment',
    title: 'Paid Sharma Electronics',
    occurredAt: '2026-09-05T14:32:00',
    occurredPrecision: 'minute',
    amount: '1250.50',
    currency: 'INR',
    direction: 'out',
    counterparty: 'Sharma Electronics',
    category: null,
    reference: 'UTR3210987654321',
    status: 'Completed',
    summary: 'A UPI payment to a shop.',
    missingContext: { field: 'purpose', question: 'What was this payment for?', options: ['Repairs', 'Appliance'] },
    ...overrides,
  };
}

function upload(text: string, name = 'receipt.txt') {
  const body = new FormData();
  body.set('file', new File([text], name, { type: 'text/plain' }));
  return body;
}

async function capture(text: string, name?: string, owner = 'owner-a') {
  const started = await request('/daybook/capture', 'POST', upload(text, name), owner);
  assert.equal(started.status, 202);
  assert.equal(started.body.record.status, 'processing');
  await eventually(jobFinished);
  return started.body.record.id;
}

test('a payment receipt becomes a dated record with the money in it, asking only the one thing the receipt could not say', async () => {
  readFile = () => understood();
  const id = await capture(RECEIPT);

  const record = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(record.kind, 'payment');
  assert.equal(record.amountMinor, 125_050, 'the amount is held as whole minor units, never as a float');
  assert.equal(record.currency, 'INR');
  assert.match(record.amountLabel ?? '', /1,250\.50/);
  assert.equal(record.direction, 'out');
  assert.equal(record.counterparty, 'Sharma Electronics');
  assert.equal(record.occurredPrecision, 'minute');
  const when = new Date(record.occurredAt ?? 0);
  assert.deepEqual([when.getFullYear(), when.getMonth() + 1, when.getDate()], [2026, 9, 5]);

  assert.equal(record.status, 'needs_context');
  assert.equal(record.question?.field, 'purpose');
  assert.ok((record.question?.prompt ?? '').length > 0, 'the person has to be told what is being asked');
  assert.equal(rows('questions'), 1);

  const answered = await request(`/daybook/records/${id}/answer`, 'POST', { answer: 'Repairs' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.record.status, 'complete');
  assert.equal(answered.body.record.question, null, 'an answered record stops asking');
  assert.equal(answered.body.record.category, 'Repairs');
  assert.equal(answered.body.record.amountMinor, 125_050, 'answering the question does not disturb the money');

  const listed = (await request('/daybook/records')).body.records;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.status, 'complete');
  assert.equal(listed[0]?.question, null);
});

test('a figure the receipt never printed is refused as the amount and asked about instead', async () => {

  readFile = () => understood({ amount: '9999.00', missingContext: null });
  const id = await capture(RECEIPT);

  const record = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(record.amountMinor, null, 'a figure the source does not state must never become the amount');
  assert.equal(record.amountLabel, null);
  assert.equal(record.status, 'needs_context');
  assert.equal(record.question?.field, 'amount');
  assert.match(record.question?.prompt ?? '', /amount/i);
  assert.ok(
    !JSON.stringify(record).includes('9999'),
    'the unsupported figure must not reach the person anywhere in the record',
  );

  const stored = db.prepare('SELECT amount_minor FROM records WHERE id = ?').get(id) as { amount_minor: number | null };
  assert.equal(stored.amount_minor, null);

  const answered = await request(`/daybook/records/${id}/answer`, 'POST', { answer: '₹1,250.50' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.record.amountMinor, 125_050);
  assert.equal(answered.body.record.status, 'complete');

  readFile = () => understood({ amount: 'about two thousand', missingContext: null });
  const vague = await capture(RECEIPT_COPY, 'counter-copy.txt');
  const asking = (await request(`/daybook/records/${vague}`)).body.record;
  assert.equal(asking.amountMinor, null);
  assert.equal(asking.status, 'needs_context');
  assert.equal(asking.question?.field, 'amount');
  assert.ok(!JSON.stringify(asking).includes('about two thousand'), 'the words are not a figure and not a note');
});

test('nobody is asked for something their own receipt prints, however insistently the reading asks it', async () => {

  const asked: Array<[field: 'amount' | 'date' | 'counterparty', question: string]> = [
    ['amount', 'How much was this?'],
    ['date', 'When was this paid?'],
    ['counterparty', 'Who was this paid to?'],
  ];

  for (const [field, question] of asked) {
    readFile = () => understood({ missingContext: { field, question, options: [] } });

    const id = await capture(`${RECEIPT}\nTill ${field}`, `till-${field}.txt`);

    const record = (await request(`/daybook/records/${id}`)).body.record;
    assert.equal(record.question, null, `the person was asked for the ${field} their own receipt states`);
    assert.equal(record.status, 'complete', 'nothing is missing from this record, so it must not say it is');
    assert.equal(record.note, null);

    assert.equal(record.amountMinor, 125_050);
    assert.equal(record.counterparty, 'Sharma Electronics');
    assert.ok((record.occurredAt ?? 0) > 0);
  }
  assert.equal(rows('questions'), 0, 'not one of those questions was written down to be asked later');

  readFile = () => understood({ category: 'Electronics' });
  const standing = await capture(RECEIPT_COPY, 'counter-copy.txt');
  const waiting = (await request(`/daybook/records/${standing}`)).body.record;
  assert.equal(waiting.status, 'needs_context');
  assert.equal(waiting.question?.field, 'purpose');
  assert.equal(waiting.category, 'Electronics', 'the reading’s own guess is kept — it is just not an answer');
  assert.equal(rows('questions'), 1);
});

test('an amount answered without a currency is refused with something the person can fix, and a written one is counted', async () => {
  readFile = () => understood({
    amount: null,
    currency: null,
    occurredAt: '2026-09-05',
    occurredPrecision: 'day',
    missingContext: { field: 'amount', question: 'How much was this?', options: [] },
  });
  const id = await capture(UNPRICED, 'counter-slip.txt');
  assert.equal((await request(`/daybook/records/${id}`)).body.record.question?.field, 'amount');

  const bare = await request(`/daybook/records/${id}/answer`, 'POST', { answer: '1250' });
  assert.equal(bare.status, 400, 'a bare number could be rupees or dollars, and guessing is how money goes wrong');
  actionable(bare.body.error);
  assert.match(bare.body.error, /currenc/i, 'the refusal has to name what is missing');

  const impossible = await request(`/daybook/records/${id}/answer`, 'POST', { answer: '₹ -5' });
  assert.equal(impossible.status, 400);
  actionable(impossible.body.error);

  const untouched = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(untouched.amountMinor, null);
  assert.equal(untouched.currency, null);
  assert.equal(untouched.status, 'needs_context');
  assert.equal(untouched.question?.field, 'amount');

  const accepted = await request(`/daybook/records/${id}/answer`, 'POST', { answer: '₹1,250.50' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.record.amountMinor, 125_050);
  assert.equal(accepted.body.record.currency, 'INR');
  assert.match(accepted.body.record.amountLabel ?? '', /1,250\.50/);
  assert.equal(accepted.body.record.status, 'complete');
  assert.equal(accepted.body.record.note, null, 'the amount is a number on the record, not a comment about it');
});

test('a date the person supplies becomes the date on the timeline, and one nobody could place is refused', async () => {
  readFile = () => understood({
    occurredAt: null,
    occurredPrecision: null,
    missingContext: { field: 'date', question: 'When was this paid?', options: [] },
  });
  const id = await capture(UNDATED, 'undated.txt');
  const before = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(before.occurredAt, null);
  assert.equal(before.question?.field, 'date');

  const refused = await request(`/daybook/records/${id}/answer`, 'POST', { answer: 'sometime last winter' });
  assert.equal(refused.status, 400);
  actionable(refused.body.error);
  assert.match(refused.body.error, /date/i);
  assert.equal((await request(`/daybook/records/${id}`)).body.record.occurredAt, null, 'nothing was guessed from it');

  const accepted = await request(`/daybook/records/${id}/answer`, 'POST', { answer: '26/09/2026' });
  assert.equal(accepted.status, 200);
  const when = new Date(accepted.body.record.occurredAt ?? 0);
  assert.deepEqual([when.getFullYear(), when.getMonth() + 1, when.getDate()], [2026, 9, 26]);
  assert.equal(accepted.body.record.occurredPrecision, 'day', 'a day is not widened into a timestamp');
  assert.equal(accepted.body.record.status, 'complete');
  assert.equal(accepted.body.record.note, null);
});

test('naming the other party in an answer puts the name where the timeline reads it from', async () => {
  readFile = () => understood({
    counterparty: null,
    missingContext: { field: 'counterparty', question: 'Who was this paid to?', options: [] },
  });
  const id = await capture(RECEIPT);
  assert.equal((await request(`/daybook/records/${id}`)).body.record.counterparty, null);

  const answered = await request(`/daybook/records/${id}/answer`, 'POST', { answer: 'Sharma Electronics' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.record.counterparty, 'Sharma Electronics');
  assert.equal(answered.body.record.note, null, 'a named party is data, not a comment');
  assert.equal(answered.body.record.category, null, 'answering who does not invent what for');
  assert.equal(answered.body.record.status, 'complete');
});

test('a tapped option becomes the group name exactly as it was offered', async () => {
  readFile = () => understood();
  const id = await capture(RECEIPT);
  assert.deepEqual((await request(`/daybook/records/${id}`)).body.record.question?.options, ['Repairs', 'Appliance']);

  const tapped = await request(`/daybook/records/${id}/answer`, 'POST', { answer: 'repairs' });
  assert.equal(tapped.status, 200);
  assert.equal(tapped.body.record.category, 'Repairs', 'the group is the option as offered, not as it was typed');
  assert.equal(tapped.body.record.note, null, 'a tapped option is a label, not a comment');

  readFile = () => understood({ title: 'Paid the shop' });
  const second = await capture(RECEIPT_COPY, 'counter-copy.txt');
  const typed = await request(`/daybook/records/${second}/answer`, 'POST', { answer: 'Kitchen fridge' });
  assert.equal(typed.status, 200);
  assert.equal(typed.body.record.category, 'Kitchen fridge');
  assert.equal(typed.body.record.note, null);
  assert.equal(typed.body.record.status, 'complete');
  assert.equal(labelPrompts.length, 0, 'an answer already short enough to be a group name needs no model call');
});

test('a written-out reason is kept word for word as the note and grouped under a short label, never under the sentence', async () => {
  const sentence = 'Replacing the compressor in the kitchen fridge after it stopped cooling last week';
  assert.ok(sentence.length > 40, 'this has to be longer than a label for the test to mean anything');

  readFile = () => understood();
  const id = await capture(RECEIPT);

  labelWith = () => ({ category: 'Appliance Repair' });
  const answered = await request(`/daybook/records/${id}/answer`, 'POST', { answer: sentence });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.record.note, sentence, "the person's own words are kept exactly");
  assert.notEqual(answered.body.record.category, sentence, 'a sentence as a group name is a group of exactly one');
  assert.equal(answered.body.record.status, 'complete');

  await eventually(() => categoryOf(id) === 'Appliance Repair');
  const grouped = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(grouped.category, 'Appliance Repair');
  assert.equal(grouped.note, sentence, 'deriving a label does not overwrite what was written');
  assert.ok((grouped.category ?? '').length <= 40, 'a group name has to fit on the money screen');
  assert.ok(
    labelPrompts.some((prompt) => prompt.includes(sentence) && prompt.includes('Sharma Electronics')),
    'the label is derived from what the person wrote and who they paid, not from anything else',
  );

  readFile = () => understood({ title: 'Paid the shop', counterparty: 'Anand Bhavan' });
  const second = await capture(RECEIPT_COPY, 'counter-copy.txt');
  labelWith = () => ({ category: sentence });
  const unlabelled = await request(`/daybook/records/${second}/answer`, 'POST', { answer: sentence });
  assert.equal(unlabelled.status, 200);
  await eventually(() => labelPrompts.length >= 3);
  assert.equal(categoryOf(second), null);
  assert.equal((await request(`/daybook/records/${second}`)).body.record.note, sentence);
});

test('a hand-typed payment is grouped like a captured one, and nothing that does not need a label is sent for one', async () => {
  labelWith = () => ({ category: 'Eating Out' });

  const rent = await request('/daybook/records', 'POST', {
    title: 'September rent', amount: '15000', currency: 'INR', direction: 'out', category: 'Rent',
  });
  const reminder = await request('/daybook/records', 'POST', { title: 'Call the landlord back' });
  const dinner = await request('/daybook/records', 'POST', {
    title: 'Dinner at Anand Bhavan', amount: '640', currency: 'INR', direction: 'out',
  });
  for (const created of [rent, reminder, dinner]) assert.equal(created.status, 201);
  assert.equal(dinner.body.record.category, null, 'the record is saved first; the label is an improvement on it');
  assert.equal(dinner.body.record.amountMinor, 64_000);

  await eventually(() => categoryOf(dinner.body.record.id) === 'Eating Out');

  assert.equal(categoryOf(rent.body.record.id), 'Rent', 'a label the person gave is never replaced');
  assert.equal(categoryOf(reminder.body.record.id), null, 'a record with no money in it has nothing to group');
  assert.equal(labelPrompts.length, 1, 'exactly one record needed a label, so exactly one call was paid for');
  assert.ok(labelPrompts[0]?.includes('Dinner at Anand Bhavan'));
  assert.ok(!labelPrompts[0]?.includes('September rent'));
  assert.ok(!labelPrompts[0]?.includes('Call the landlord back'));
});

test('another account can neither read, change, answer, retry nor delete a record that is not theirs', async () => {
  readFile = () => understood();
  const id = await capture(RECEIPT);
  const mine = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(mine.status, 'needs_context');

  const attempts: Array<[string, string, unknown]> = [
    ['GET', `/daybook/records/${id}`, undefined],
    ['PATCH', `/daybook/records/${id}`, { title: 'Mine now', category: 'Rent' }],
    ['POST', `/daybook/records/${id}/answer`, { answer: 'Groceries' }],
    ['POST', `/daybook/records/${id}/question/skip`, undefined],
    ['POST', `/daybook/records/${id}/retry`, undefined],
    ['DELETE', `/daybook/records/${id}`, undefined],
  ];

  for (const [method, path, body] of attempts) {
    const refused = await request(path, method, body, 'owner-b');
    assert.equal(refused.status, 404, `${method} ${path} must answer as though the record does not exist`);
    const text = JSON.stringify(refused.body);
    assert.equal('record' in refused.body, false, 'a refusal must not hand back the record it is refusing');
    assert.ok(!text.includes('Sharma'), 'a refusal must not leak who the record is about');
    assert.ok(!text.includes('1250') && !text.includes('125050'), 'a refusal must not leak the amount');
    actionable(refused.body.error);
  }

  assert.deepEqual((await request('/daybook/records', 'GET', undefined, 'owner-b')).body.records, []);

  const survivor = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(survivor.title, mine.title);
  assert.equal(survivor.category, null);
  assert.equal(survivor.status, 'needs_context');
  assert.equal(survivor.question?.field, 'purpose');
  assert.equal(rows('records'), 1);
});

test('every refusal of a typed record is a sentence the person can act on, and nothing is written', async () => {
  const refusals: Array<[string, Record<string, unknown>]> = [
    ['a record with no title', {}],
    ['a title of nothing but spaces', { title: '   ' }],
    ['a currency this app cannot hold', { title: 'Coffee', amount: '200', currency: 'ZZZ' }],
    ['an amount that is not a figure', { title: 'Coffee', amount: 'a couple of hundred', currency: 'INR' }],
    ['two numbers where one amount belongs', { title: 'Coffee', amount: '50 and 70', currency: 'INR' }],
    ['a negative amount', { title: 'Coffee', amount: '-200', currency: 'INR' }],
    ['a date nobody could place', { title: 'Coffee', occurredAt: 'sometime last winter' }],
  ];

  for (const [what, payload] of refusals) {
    const refused = await request('/daybook/records', 'POST', payload);
    assert.equal(refused.status, 400, `${what} must be refused`);
    actionable(refused.body.error);
  }

  assert.equal(rows('records'), 0, 'a refused record is not half-saved');
  assert.equal((await request('/daybook/records')).body.records.length, 0);
});

test('a body that is not an object is a sentence, not a crash', async () => {
  readFile = () => understood();
  const id = await capture(RECEIPT);
  assert.equal(statusOf(id), 'needs_context');

  const bodies: unknown[] = [null, 4, 'answer', [1, 2], true];
  for (const body of bodies) {
    const written = JSON.stringify(body);
    for (const [method, path] of [
      ['POST', `/daybook/records/${id}/answer`],
      ['POST', '/daybook/records'],
      ['PATCH', `/daybook/records/${id}`],
    ] as const) {
      const sent = await request(path, method, body);
      assert.ok(sent.status < 500, `${method} ${path} answered a body of ${written} with a crash`);
      if (sent.status !== 200) {
        actionable(sent.body.error);
        assert.ok(
          !/\bnull\b|properties|undefined|TypeError/i.test(sent.body.error),
          `the refusal of ${written} quoted the machine: ${sent.body.error}`,
        );
      }
    }
  }

  assert.equal(rows('records'), 1, 'a body with nothing in it created a record');
  const after = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(after.status, 'needs_context');
  assert.equal(after.question?.field, 'purpose');
  assert.equal(after.category, null);
  assert.equal(after.note, null);
});

test('answering a record that is not waiting on anything leaves it, and its account of what went wrong, exactly as it was', async () => {

  const id = await capture(RECEIPT);
  const failed = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(failed.status, 'failed');
  assert.ok((failed.note ?? '').length > 0, 'a failure has to say something');
  actionable(failed.note ?? '');
  assert.ok(
    !/groq|gemini|provider|fetch|401|500/i.test(failed.note ?? ''),
    'the person is told what to do next, not what broke inside the server',
  );
  assert.equal(failed.question, null);

  const refused = await request(`/daybook/records/${id}/answer`, 'POST', { answer: 'Groceries' });
  assert.equal(refused.status, 409, 'a record that asked nothing cannot be answered into looking fine');
  actionable(refused.body.error);

  const later = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(later.status, 'failed');
  assert.equal(later.note, failed.note);
  assert.equal(later.category, null);

  const blank = await request(`/daybook/records/${id}/answer`, 'POST', { answer: '   ' });
  assert.equal(blank.status, 400);
  actionable(blank.body.error);
});

test('a record whose read failed can be read again, without a second record or a second copy of the file', async () => {
  const id = await capture(RECEIPT);
  const failed = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(failed.status, 'failed');

  readFile = () => understood();
  const retried = await request(`/daybook/records/${id}/retry`, 'POST');
  assert.equal(retried.status, 202);
  assert.equal(retried.body.record.id, id, 'a retry is the same record, not a new one');
  assert.equal(retried.body.record.status, 'processing');
  assert.equal(retried.body.record.note, null, 'the old failure is off the card while a fresh attempt runs');
  await eventually(jobFinished);

  const reread = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(reread.status, 'needs_context');
  assert.equal(reread.amountMinor, 125_050);
  assert.equal(reread.counterparty, 'Sharma Electronics');
  assert.equal(reread.note, null);
  assert.equal(rows('records'), 1, 'reading again does not duplicate the record');
  assert.equal(rows('files'), 1, 'reading again does not store the bytes twice');
  assert.equal(rows('questions'), 1, 'reading again leaves one question, not two');
  assert.equal((await request('/daybook/records')).body.records.length, 1);

  const again = await request(`/daybook/records/${id}/retry`, 'POST');
  assert.equal(again.status, 400);
  actionable(again.body.error);
});

test('the same file uploaded twice stays one record, and one that failed gets another attempt rather than the old failure back', async () => {
  let reads = 0;
  readFile = () => {
    reads += 1;
    return understood();
  };
  const id = await capture(RECEIPT);

  const resent = await request('/daybook/capture', 'POST', upload(RECEIPT));
  assert.equal(resent.status, 200);
  assert.equal(resent.body.duplicate, true);
  assert.equal(resent.body.record.id, id);
  await eventually(jobFinished);
  assert.equal(reads, 1, 'the same bytes are not read — or paid for — a second time');
  assert.equal(rows('records'), 1);
  assert.equal(rows('files'), 1);

  readFile = refuse;
  const broken = await capture(RECEIPT_COPY, 'counter-copy.txt');
  assert.equal(statusOf(broken), 'failed');

  readFile = () => understood({ title: 'Paid the shop' });
  const secondTry = await request('/daybook/capture', 'POST', upload(RECEIPT_COPY, 'counter-copy.txt'));
  assert.equal(secondTry.status, 202, 'a file that failed must not be handed back as a permanent failure');
  assert.equal(secondTry.body.record.id, broken);
  assert.equal(secondTry.body.retrying, true);
  await eventually(jobFinished);

  assert.equal(statusOf(broken), 'needs_context');
  assert.equal(rows('records'), 2);
  assert.equal(rows('files'), 2);
});

test('a record left mid-read by a process that died is settled with something the person can act on, and can then be read again', async () => {
  readFile = () => understood();
  const id = await capture(RECEIPT);
  abandon(id);

  const stuck = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(stuck.status, 'processing');
  actionable(stuck.progress ?? '');

  assert.equal(settleAbandonedReads(), 1);
  assert.equal(settleAbandonedReads(), 0, 'a record settled once is not settled again');

  const settled = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(settled.status, 'failed');
  actionable(settled.note ?? '');
  assert.ok(
    !/groq|gemini|provider|model|timeout|ocr|queue|job|null|undefined/i.test(settled.note ?? ''),
    `the person is told what happened to their file, not what happened inside the server: ${settled.note}`,
  );
  assert.equal(settled.progress, null, 'a record nothing is reading must not say it is being read');
  assert.ok(jobFinished(), 'the read that never finished is closed too, rather than left open forever');
  assert.equal(settled.amountMinor, 125_050, 'settling a stuck record does not throw away what was already read');

  readFile = () => understood();
  const retried = await request(`/daybook/records/${id}/retry`, 'POST');
  assert.equal(retried.status, 202, 'a record nothing is reading must be offered another attempt');
  assert.equal(retried.body.record.status, 'processing');
  assert.equal(retried.body.record.note, null);
  await eventually(jobFinished);
  assert.equal(statusOf(id), 'needs_context');
  assert.equal(rows('records'), 1, 'none of this made a second record');
  assert.equal(rows('files'), 1);
  assert.equal(rows('questions'), 1);
});

test('a read that is slow but alive is left alone by the sweep and refused another attempt, and its result still lands', async () => {
  const release = heldRead(() => understood());

  const started = await request('/daybook/capture', 'POST', upload(RECEIPT));
  assert.equal(started.status, 202);
  const id = started.body.record.id;
  assert.equal(started.body.record.status, 'processing');
  actionable(started.body.record.progress ?? '');

  await eventually(() => jobStatusOf(id) === 'understanding');
  db.prepare('UPDATE records SET updated_at = ? WHERE id = ?').run(Date.now() - STALE_READ_AFTER_MS * 3, id);

  assert.equal(settleAbandonedReads(), 0, 'a read this process is still working on must never be settled');
  assert.equal(statusOf(id), 'processing');

  const refused = await request(`/daybook/records/${id}/retry`, 'POST');
  assert.equal(refused.status, 400, 'a live read is not restarted, however old its row looks');
  actionable(refused.body.error);
  assert.equal(jobStatusOf(id), 'understanding', 'and nothing about the read in progress was disturbed');

  release();
  await eventually(jobFinished);

  const landed = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(landed.status, 'needs_context', 'the slow read finished, and finished intact');
  assert.equal(landed.amountMinor, 125_050);
  assert.equal(landed.note, null, 'nothing wrote a failure over a result that arrived');
  assert.equal(landed.progress, null);
  assert.equal(rows('records'), 1);
});

test('the sweep keeps its own clock, and that clock can neither hold the server open nor hang a test run', () => {

  assert.equal(staleReadSweep.hasRef(), false, 'an idle process must be free to exit');
  assert.ok(STALE_READ_AFTER_MS > 5 * 60_000, 'the ceiling has to be longer than a genuinely slow read');
  assert.ok(STALE_READ_AFTER_MS < 60 * 60_000, 'and short enough that nobody waits an hour to be told');
});

test('a read interrupted by a restart is settled at boot, and work that was cancelled keeps the ending it already had', async () => {
  readFile = () => understood();
  const id = await capture(RECEIPT);

  abandon(id, 0);

  const ending = 'The record was deleted while it was being read.';
  const when = Date.now();
  db.prepare(
    `INSERT INTO jobs (id, user_id, kind, subject_id, status, detail, attempts, created_at, updated_at)
     VALUES (?, 'owner-a', 'capture', ?, 'cancelled', ?, 1, ?, ?)`,
  ).run('job-cancelled', 'rec-already-deleted', ending, when, when);

  const summary = recoverInterruptedWork();
  assert.equal(summary.records, 1);
  assert.equal(summary.jobs, 1, 'the interrupted read is closed, and only it');

  const settled = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(settled.status, 'failed');
  actionable(settled.note ?? '');
  assert.equal(settled.progress, null);

  const left = db.prepare('SELECT status, detail FROM jobs WHERE id = ?').get('job-cancelled') as {
    status: string;
    detail: string;
  };
  assert.equal(left.status, 'cancelled', 'work that was cancelled had already ended; it did not fail');
  assert.equal(left.detail, ending, 'and the account of how it ended is not overwritten');
});

test('a read this server interrupted is taken up again at boot, from the file already stored', async () => {
  readFile = () => understood();
  const id = await capture(RECEIPT);
  const held = db.prepare('SELECT file_id FROM records WHERE id = ?').get(id) as { file_id: string };

  abandon(id, 0);

  assert.equal(recoverInterruptedWork().records, 1);
  assert.equal(statusOf(id), 'failed');

  readFile = () => understood();
  assert.equal(resumeInterruptedReads(), 1);
  const resumed = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(resumed.status, 'processing', 'the person watches the read carry on, not a chore appear');
  assert.equal(resumed.note, null, 'and is not told to try again about work that is already running');
  actionable(resumed.progress ?? '');
  await eventually(jobFinished);

  const read = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(read.status, 'needs_context');
  assert.equal(read.amountMinor, 125_050);
  assert.equal(read.counterparty, 'Sharma Electronics');
  assert.equal(rows('records'), 1, 'resuming is the same record, not a second one');
  assert.equal(rows('files'), 1, 'and the same stored bytes — nothing was uploaded again');
  assert.equal(
    (db.prepare('SELECT file_id FROM records WHERE id = ?').get(id) as { file_id: string }).file_id,
    held.file_id,
  );

  abandon(id, 0);
  db.prepare(`UPDATE jobs SET status = 'failed', updated_at = ? WHERE subject_id = ? AND attempts = 1`)
    .run(Date.now() - 60_000, id);
  const nextBoot = Date.now();
  recoverInterruptedWork();
  assert.equal(resumeInterruptedReads(nextBoot), 0, 'a file that has had its free attempt is not re-read at every boot');
  const stopped = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(stopped.status, 'failed');

  actionable(stopped.note ?? '');
});

test('typing the asked-about detail into the record answers the question, and is kept as the person’s own words', async () => {
  readFile = () => understood();
  const id = await capture(RECEIPT);
  assert.equal(statusOf(id), 'needs_context');
  assert.equal(questionRow(id).field, 'purpose');

  const edited = await request(`/daybook/records/${id}`, 'PATCH', { category: 'Repairs' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.record.category, 'Repairs');
  assert.equal(edited.body.record.status, 'complete', 'the detail is on the record, so nothing is missing from it');
  assert.equal(edited.body.record.question, null, 'the app must stop asking about something now on screen');

  const closed = questionRow(id);
  assert.equal(closed.answer, 'Repairs', "the edit is recorded as the person's own answer, not as a blank");
  assert.ok((closed.answered_at ?? 0) > 0);

  const listed = (await request('/daybook/records')).body.records;
  assert.equal(listed[0]?.status, 'complete');
  assert.equal(listed[0]?.question, null);
});

test('an edit that supplies something else leaves the question standing, and the asked-about field completes it', async () => {
  readFile = () => understood({
    amount: null,
    currency: null,
    occurredAt: '2026-09-05',
    occurredPrecision: 'day',
    counterparty: null,
    missingContext: { field: 'amount', question: 'How much was this?', options: [] },
  });
  const id = await capture(UNPRICED, 'counter-slip.txt');
  assert.equal((await request(`/daybook/records/${id}`)).body.record.question?.field, 'amount');

  const elsewhere = await request(`/daybook/records/${id}`, 'PATCH', { counterparty: 'Sharma Electronics' });
  assert.equal(elsewhere.status, 200);
  assert.equal(elsewhere.body.record.counterparty, 'Sharma Electronics');
  assert.equal(elsewhere.body.record.status, 'needs_context', 'the amount is still missing, so the record still says so');
  assert.equal(elsewhere.body.record.question?.field, 'amount');
  assert.equal(questionRow(id).answered_at, null, 'nothing was recorded as an answer to a question nobody answered');

  const supplied = await request(`/daybook/records/${id}`, 'PATCH', { amount: '1250.50', currency: 'INR' });
  assert.equal(supplied.status, 200);
  assert.equal(supplied.body.record.amountMinor, 125_050);
  assert.equal(supplied.body.record.status, 'complete');
  assert.equal(supplied.body.record.question, null);
  assert.equal(questionRow(id).answer, '1250.50');
});

test('a record whose read failed becomes the person’s own once they type the details in, and renaming it alone keeps the offer to read it again', async () => {

  const id = await capture(RECEIPT);
  assert.equal(statusOf(id), 'failed');
  const failureNote = (await request(`/daybook/records/${id}`)).body.record.note;
  assert.ok((failureNote ?? '').length > 0);

  const renamed = await request(`/daybook/records/${id}`, 'PATCH', { title: 'Receipt from the shop' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.record.title, 'Receipt from the shop');
  assert.equal(renamed.body.record.status, 'failed', 'tidying up a name must not quietly take away Try again');
  assert.equal(renamed.body.record.note, failureNote);

  const typed = await request(`/daybook/records/${id}`, 'PATCH', {
    amount: '1250.50', currency: 'INR', direction: 'out', counterparty: 'Sharma Electronics',
  });
  assert.equal(typed.status, 200);
  assert.equal(typed.body.record.status, 'complete', 'the person did the work the server could not');
  assert.equal(typed.body.record.amountMinor, 125_050);
  assert.equal(typed.body.record.note, null, 'the failure note went with the failure it described');
  assert.equal(typed.body.record.category, null, 'nothing was invented to fill the gaps they left');
  assert.equal(typed.body.record.occurredAt, null);
  assert.equal(rows('questions'), 0, 'a failed read asked nothing, so nothing was closed on their behalf');

  const again = await request(`/daybook/records/${id}/retry`, 'POST');
  assert.equal(again.status, 400);
  actionable(again.body.error);
});

test('a question nobody can answer can be put aside, and nothing is invented in place of the answer', async () => {
  readFile = () => understood({
    amount: null,
    currency: null,
    occurredAt: '2026-09-05',
    occurredPrecision: 'day',
    missingContext: { field: 'amount', question: 'How much was this?', options: [] },
  });
  const id = await capture(UNPRICED, 'counter-slip.txt');
  assert.equal((await request(`/daybook/records/${id}`)).body.record.question?.field, 'amount');

  const skipped = await request(`/daybook/records/${id}/question/skip`, 'POST');
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.record.status, 'complete', 'nobody is waiting on anybody, so the chore stops');
  assert.equal(skipped.body.record.question, null);
  assert.equal(skipped.body.record.amountMinor, null, 'skipping must never put a figure on the record');
  assert.equal(skipped.body.record.currency, null);
  assert.equal(skipped.body.record.amountLabel, null);
  assert.equal(skipped.body.record.note, null, 'and must never read as though the person had said something');
  assert.equal(skipped.body.record.category, null);
  assert.equal(skipped.body.record.counterparty, 'Sharma Electronics', 'what the file did say is untouched');

  const closed = questionRow(id);
  assert.equal(closed.answer, null, 'a question put aside holds no answer, not an empty one');
  assert.ok((closed.answered_at ?? 0) > 0, 'and it is closed, so it is never asked again');

  const again = await request(`/daybook/records/${id}/question/skip`, 'POST');
  assert.equal(again.status, 409);
  actionable(again.body.error);
  const answered = await request(`/daybook/records/${id}/answer`, 'POST', { answer: '₹1,250.50' });
  assert.equal(answered.status, 409);
  actionable(answered.body.error);

  const listed = (await request('/daybook/records')).body.records;
  assert.equal(listed[0]?.status, 'complete');
  assert.equal(listed[0]?.question, null);
  assert.equal(listed[0]?.amountMinor, null);
});

test('a reply that arrives after the record already holds the fact closes the question without overwriting it', async () => {

  const cases: Array<{
    field: 'amount' | 'date' | 'counterparty';
    source: string;
    read: Partial<UnderstoodRecord>;

    found: (recordId: string) => void;
    reply: string;

    absent: string[];
    kept: (record: PresentedRecord) => void;
  }> = [
    {
      field: 'amount',
      source: UNPRICED,
      read: {
        amount: null,
        currency: null,
        missingContext: { field: 'amount', question: 'How much was this?', options: [] },
      },
      found: (id) => {
        db.prepare(`UPDATE records SET amount_minor = 125050, currency = 'INR' WHERE id = ?`).run(id);
      },
      reply: '₹9,999.00',
      absent: ['9999', '999900'],
      kept: (record) => {
        assert.equal(record.amountMinor, 125_050, 'a typed figure replaced the one the document states');
        assert.equal(record.currency, 'INR');
        assert.match(record.amountLabel ?? '', /1,250\.50/);
      },
    },
    {
      field: 'date',
      source: UNDATED,
      read: {
        occurredAt: null,
        occurredPrecision: null,
        missingContext: { field: 'date', question: 'When was this paid?', options: [] },
      },
      found: (id) => {
        db.prepare(`UPDATE records SET occurred_at = ?, occurred_precision = 'day' WHERE id = ?`)
          .run(Date.UTC(2026, 8, 5), id);
      },
      reply: '26/09/2026',
      absent: [],
      kept: (record) => {
        const when = new Date(record.occurredAt ?? 0);
        assert.deepEqual(
          [when.getUTCFullYear(), when.getUTCMonth() + 1, when.getUTCDate()],
          [2026, 9, 5],
          'a typed date moved the record off the day the document states',
        );
      },
    },
    {
      field: 'counterparty',
      source: RECEIPT,
      read: {
        counterparty: null,
        missingContext: { field: 'counterparty', question: 'Who was this paid to?', options: [] },
      },
      found: (id) => {
        db.prepare(`UPDATE records SET counterparty = 'Sharma Electronics' WHERE id = ?`).run(id);
      },
      reply: 'Gupta Traders',
      absent: ['Gupta'],
      kept: (record) => {
        assert.equal(record.counterparty, 'Sharma Electronics', 'a typed name replaced the one on the slip');
      },
    },
  ];

  for (const { field, source, read, found, reply, absent, kept } of cases) {
    readFile = () => understood(read);
    const id = await capture(source, `late-${field}.txt`);
    assert.equal((await request(`/daybook/records/${id}`)).body.record.question?.field, field);
    found(id);

    const late = await request(`/daybook/records/${id}/answer`, 'POST', { answer: reply });
    assert.equal(late.status, 200, 'the reply is not an error — the person did nothing wrong');
    assert.equal(late.body.answerApplied, false, `the ${field} reply was written over what the file said`);
    kept(late.body.record);
    assert.equal(late.body.record.status, 'complete', 'the question is answered, so the chore is over');
    assert.equal(late.body.record.question, null, 'and it is never asked again');
    assert.equal(late.body.record.note, null, 'an unused reply is not parked in a note either');
    for (const text of absent) {
      assert.ok(!JSON.stringify(late.body.record).includes(text), `the unused reply reached the app as ${text}`);
    }

    kept((await request(`/daybook/records/${id}`)).body.record);
    const closed = questionRow(id);
    assert.equal(closed.answer, null, 'the reply was not recorded as the answer that settled this');
    assert.ok((closed.answered_at ?? 0) > 0, 'the question is closed, not left open to be asked again');

    const again = await request(`/daybook/records/${id}/answer`, 'POST', { answer: reply });
    assert.equal(again.status, 409);
    actionable(again.body.error);
  }
});

test('a reply is still applied to a gap the record genuinely still has', async () => {

  readFile = () => understood({
    counterparty: null,
    missingContext: { field: 'counterparty', question: 'Who was this paid to?', options: [] },
  });
  const id = await capture(RECEIPT);

  const answered = await request(`/daybook/records/${id}/answer`, 'POST', { answer: 'Gupta Traders' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.answerApplied, true);
  assert.equal(answered.body.record.counterparty, 'Gupta Traders');
  assert.equal(questionRow(id).answer, 'Gupta Traders', "and it is kept as the person's own answer");
});

test('a file being read says so in plain words, says a second attempt is a second attempt, and says nothing once it is read', async () => {
  const release = heldRead(() => understood());
  const started = await request('/daybook/capture', 'POST', upload(RECEIPT));
  const id = started.body.record.id;

  await eventually(() => jobStatusOf(id) === 'understanding');
  const reading = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(reading.status, 'processing');
  actionable(reading.progress ?? '');
  assert.ok(
    !/\b(ocr|vision|model|provider|groq|gemini|job|queue|capture|extract|pipeline|status|processing)\b/i.test(reading.progress ?? ''),
    `what somebody is told while they wait has to be their language, not the server's: ${reading.progress}`,
  );
  assert.equal(
    (await request('/daybook/records')).body.records[0]?.progress,
    reading.progress,
    'the timeline says the same thing as the record it came from',
  );

  release();
  await eventually(jobFinished);
  const read = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(read.status, 'needs_context');
  assert.equal(read.progress, null, 'nothing is still being read, so nothing claims to be');

  readFile = refuse;
  const broken = await capture(RECEIPT_COPY, 'counter-copy.txt');
  assert.equal(statusOf(broken), 'failed');
  assert.equal((await request(`/daybook/records/${broken}`)).body.record.progress, null);

  const releaseSecond = heldRead(() => understood({ title: 'Paid the shop' }));
  const retried = await request(`/daybook/records/${broken}/retry`, 'POST');
  assert.equal(retried.status, 202);
  actionable(retried.body.record.progress ?? '');
  assert.match(
    retried.body.record.progress ?? '',
    /again/i,
    'somebody watching a second attempt should be told it is a second attempt',
  );
  releaseSecond();
  await eventually(jobFinished);
  assert.equal((await request(`/daybook/records/${broken}`)).body.record.progress, null);
});

test('the timeline pages with a cursor that neither drops nor repeats a record, including records sharing a day and records with no date at all', async () => {

  const ids: string[] = [];
  for (const title of ['Bill one', 'Bill two', 'Bill three', 'Note one', 'Note two', 'Bill four']) {
    const created = await request('/daybook/records', 'POST', { title });
    assert.equal(created.status, 201);
    ids.push(created.body.record.id);
  }
  const day = 24 * 60 * 60_000;
  const fifth = Date.UTC(2026, 8, 5, 10, 30);
  const placed = db.prepare('UPDATE records SET occurred_at = ?, created_at = ? WHERE id = ?');
  placed.run(fifth, fifth, ids[0]);
  placed.run(fifth, fifth, ids[1]);
  placed.run(fifth - day, fifth - day, ids[2]);
  placed.run(null, fifth - 2 * day, ids[3]);
  placed.run(null, fifth - 2 * day, ids[4]);
  placed.run(fifth - 3 * day, fifth - 3 * day, ids[5]);

  const whole = (await request('/daybook/records')).body;
  assert.equal(whole.records.length, 6);
  assert.equal(whole.nextCursor, null, 'a list that fits in one page says so by having no cursor');

  const seen: string[] = [];
  let cursor: number | null = null;
  let pages = 0;
  for (; pages < 10; pages++) {
    const page = await request(`/daybook/records?limit=1${cursor === null ? '' : `&before=${cursor}`}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.records.length > 0, 'a page offered by a cursor is never empty');
    seen.push(...page.body.records.map((record) => record.id));
    cursor = page.body.nextCursor;
    assert.ok(cursor === null || Number.isInteger(cursor), 'a cursor is an instant in milliseconds, or nothing');
    if (cursor === null) break;
  }

  assert.equal(cursor, null, 'the walk ends, and ends because the list said it had');
  assert.ok(pages < 9, 'the walk has to make progress, not go round forever');
  assert.equal(seen.length, 6, 'every record came back on exactly one page');
  assert.equal(new Set(seen).size, 6, 'and no record came back on two');
  assert.deepEqual(seen, whole.records.map((record) => record.id), 'paging gives the same order as one long list');

  const first = await request('/daybook/records?limit=1');
  assert.equal(first.body.records.length, 2, 'a page is extended rather than splitting one instant in two');
  assert.deepEqual(first.body.records.map((record) => record.id).sort(), [ids[0], ids[1]].sort());

  const undated = await request(`/daybook/records?limit=1&before=${fifth - day}`);
  assert.equal(undated.body.records.length, 2);
  assert.deepEqual(undated.body.records.map((record) => record.occurredAt), [null, null]);
  assert.equal(undated.body.nextCursor, fifth - 2 * day);

  const nonsense = await request('/daybook/records?before=yesterday');
  assert.equal(nonsense.status, 400, 'a cursor the app could not have produced is refused, not guessed at');
  actionable(nonsense.body.error);
});

test('answering or putting aside the one question re-runs the pass that raised it, and so does deleting the record', async () => {

  readFile = () => understood();

  const VERBOSE = `${RECEIPT}
The shopkeeper said the warranty papers would be sent by Friday, and the AMC on this counter runs out in March. Nothing else was promised.`;

  const captureVerbose = async (name: string): Promise<string> => {
    const formed = new FormData();
    formed.set('file', new File([`${VERBOSE}\n${name}`], `${name}.txt`, { type: 'text/plain' }));
    const started = await request('/daybook/capture', 'POST', formed);
    assert.equal(started.status, 202);
    await eventually(jobFinished);

    await passSettled();
    return started.body.record.id;
  };

  const freshMaterial = async (label: string): Promise<void> => {
    const created = await request('/daybook/records', 'POST', {
      title: `Note ${label}`,
      note: `${VERBOSE} This one is filed under ${label}.`,
    });
    assert.equal(created.status, 201);
  };

  const answered = await captureVerbose('unfinished-answer');
  assert.equal(statusOf(answered), 'needs_context', 'the record has to be waiting on something for this to mean anything');

  await freshMaterial('answer');
  const afterCapture = materialRead;
  await request(`/daybook/records/${answered}/answer`, 'POST', { answer: 'Repairs' });
  await passSettled();
  assert.ok(materialRead > afterCapture, 'answering the question left the pass that raised it un-rerun');

  readFile = () => understood({ amount: null, currency: null, missingContext: { field: 'amount', question: 'How much was this?', options: [] } });
  const skipped = await captureVerbose('unfinished-skip');
  assert.equal(statusOf(skipped), 'needs_context');

  await freshMaterial('skip');
  const beforeSkip = materialRead;
  await request(`/daybook/records/${skipped}/question/skip`, 'POST');
  await passSettled();
  assert.ok(materialRead > beforeSkip, 'putting the question aside left the pass that raised it un-rerun');

  readFile = () => understood();
  const doomed = await captureVerbose('unfinished-delete');
  plantSignal('sig-answer', 'unfinished_entries', [{ kind: 'record', id: doomed }]);

  await freshMaterial('delete');
  const beforeDelete = materialRead;
  const removed = await request(`/daybook/records/${doomed}`, 'DELETE');
  assert.equal(removed.status, 200);
  await passSettled();
  assert.equal(signalStatus('sig-answer'), 'dismissed');
  assert.ok(materialRead > beforeDelete, 'deleting a record did not run a detector pass over the rest of the account');
});

test('the timeline narrows to one other party or one label, on the server, without showing anything that does not match', async () => {

  const ids: Record<string, string> = {};

  ensureUser('owner-b', null, null);
  for (const [key, body] of Object.entries({
    exact: { title: 'Counter bill', counterparty: 'Sharma Electronics', category: 'Repairs', amount: '450', direction: 'out' as const },
    other: { title: 'Different shop', counterparty: 'Gupta Traders', category: 'Repairs', amount: '120', direction: 'out' as const },
    near: { title: 'Similar name', counterparty: 'Sharma Electronics Repairs', category: 'Travel', amount: '60', direction: 'out' as const },
    elsewhere: { title: 'Another account', counterparty: 'Navrang Tools', category: 'Repairs', amount: '90', direction: 'out' as const },
  })) {
    const created = await request('/daybook/records', 'POST', body, key === 'elsewhere' ? 'owner-b' : 'owner-a');
    assert.equal(created.status, 201);
    ids[key] = created.body.record.id;
  }

  const byParty = await request('/daybook/records?counterparty=Sharma%20Electronics');
  assert.deepEqual(byParty.body.records.map((record) => record.id), [ids.exact], 'a filtered list showed records it was not asked for');
  assert.equal(byParty.body.nextCursor, null, 'the whole filtered list fits on one page and says so');

  const loose = await request('/daybook/records?counterparty=sharma%20electronics');
  assert.deepEqual(loose.body.records.map((record) => record.id), [ids.exact]);
  const padded = await request('/daybook/records?counterparty=%20Sharma+Electronics%20');
  assert.deepEqual(padded.body.records.map((record) => record.id), [ids.exact]);

  const byCategory = await request('/daybook/records?category=Repairs');
  assert.deepEqual(new Set(byCategory.body.records.map((record) => record.id)), new Set([ids.exact, ids.other]), 'the label filter dropped a record that carries it');

  const both = await request('/daybook/records?counterparty=Sharma%20Electronics&category=Repairs');
  assert.deepEqual(both.body.records.map((record) => record.id), [ids.exact]);

  const blank = await request('/daybook/records?counterparty=&category=');
  assert.equal(blank.status, 200);
  assert.equal(blank.body.records.length, 3, 'a blank filter was read as a filter for nothing');

  assert.ok(!blank.body.records.some((record) => record.id === ids.elsewhere), 'the unfiltered list carried another account’s record');
  const notMine = await request('/daybook/records?counterparty=Navrang%20Tools');
  assert.equal(notMine.status, 200);
  assert.deepEqual(notMine.body.records, [], 'a filter reached across accounts for a matching record');

  const nothing = await request('/daybook/records?counterparty=Nobody%20at%20all');
  assert.equal(nothing.status, 200);
  assert.deepEqual(nothing.body.records, [], 'a filter nobody matches is an empty list, not an error');

  const tooLong = await request(`/daybook/records?counterparty=${'a'.repeat(121)}`);
  assert.equal(tooLong.status, 400);
  actionable(tooLong.body.error);
  const tooLongLabel = await request(`/daybook/records?category=${'a'.repeat(61)}`);
  assert.equal(tooLongLabel.status, 400);
  actionable(tooLongLabel.body.error);
});

test('a filtered list pages through the matching records only, and never offers a cursor to a page with nothing on it', async () => {

  const mine: string[] = [];
  for (const title of ['Shop one', 'Shop two', 'Shop three']) {
    const created = await request('/daybook/records', 'POST', { title, counterparty: 'Sharma Electronics' });
    mine.push(created.body.record.id);
  }
  for (const title of ['Other one', 'Other two']) {
    await request('/daybook/records', 'POST', { title, counterparty: 'Gupta Traders' });
  }

  const seen: string[] = [];
  let cursor: number | null = null;
  for (let pages = 0; pages < 8; pages++) {
    const page = await request(`/daybook/records?counterparty=Sharma%20Electronics&limit=1${cursor === null ? '' : `&before=${cursor}`}`);
    assert.equal(page.status, 200);
    seen.push(...page.body.records.map((record) => record.id));
    cursor = page.body.nextCursor;
    if (cursor === null) break;
  }

  assert.equal(cursor, null, 'the filtered walk has to end, and end because the list said it had');
  assert.equal(new Set(seen).size, 3, 'a filtered page carried a record that does not match, or lost one that does');
  assert.deepEqual(new Set(seen), new Set(mine));
});
