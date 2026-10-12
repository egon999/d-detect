import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Account } from '../auth.ts';

import type { DrillDown } from './insights.ts';

const directory = mkdtempSync(join(tmpdir(), 'detact-workflows-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';
const { db, ensureUser } = await import('../db.ts');
const { cases } = await import('./cases.ts');
const { daybook } = await import('./daybook.ts');
const { assistant } = await import('./assistant.ts');
const { meetings } = await import('./meetings.ts');
const { insights } = await import('./insights.ts');
const { tasks } = await import('./tasks.ts');
const { storeUpload } = await import('../files.ts');
const { attention } = await import('./attention.ts');
const { fullTextAvailable, search } = await import('../search.ts');

const app = new Hono<{ Variables: { account: Account } }>();
app.use('*', async (context, next) => {
  const id = context.req.header('x-test-owner') ?? 'owner-a';
  ensureUser(id, null, null);
  context.set('account', { id, email: null, name: null });
  await next();
});
app.route('/cases', cases).route('/daybook', daybook).route('/daybook', assistant)
  .route('/meetings', meetings).route('/insights', insights).route('/tasks', tasks)
  .route('/attention', attention);
app.onError((error, context) => context.json({ error: error.message }, error instanceof HTTPException ? error.status : 500));

type ProviderBody = { messages?: Array<{ role: string; content: string }> };
let responder: (url: string, body: ProviderBody) => Promise<unknown> | unknown;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  assert.ok(url.includes('/chat/completions'), `Unexpected network call: ${url}`);
  const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) as ProviderBody : {};
  const result = await responder(url, parsed);
  return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
};

const SEARCH_WIPE = fullTextAvailable
  ? ' DELETE FROM records_fts; DELETE FROM meetings_fts; DELETE FROM tasks_fts;'
  : '';

beforeEach(() => {
  db.exec('DELETE FROM jobs; DELETE FROM signals; DELETE FROM signal_scans; DELETE FROM cases; DELETE FROM meetings; DELETE FROM records; DELETE FROM tasks; DELETE FROM budgets; DELETE FROM files; DELETE FROM users;' + SEARCH_WIPE);
  ensureUser('owner-a', null, null);
  responder = () => { throw new Error('This test did not authorize a model call.'); };
});

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-workflows-'));
  rmSync(target, { recursive: true, force: true });
});

type TestResponse = {
  duplicate: boolean;
  reused: boolean;
  retrying: boolean;
  record: {
    id: string; title: string; kind: string; amountMinor: number | null; currency: string | null;
    occurredAt: number | null; note: string | null; status: string; question: { field: string; prompt: string };
    extraction: Record<string, unknown>;
  };
  records: Array<{ id: string; extraction: Record<string, unknown> }>;
  item: { id: string; text: string; status: string };
  case: {
    id: string; analysisStale: boolean; hasAnalysis: boolean;
    signals: Array<{ kind: string; strength: string; itemIds: string[] }>;
  };
  task: { id: string };
  meeting: { id: string; status: string; tasks: Array<{ id: string; doneAt: number | null }> };
  spent: { amountMinor: number; amountLabel: string | null };
  currency: string | null;
  excludedRecordCount: number;

  excluded: Record<'missingCurrency' | 'otherCurrency' | 'unreadable', DrillDown>;
  categories: Array<{ name: string }>;
  budget: { remainingMinor: number };
  guidance: Array<{ kind: string; tone: string; text: string }>;
  recap: { currency: string | null; spentMinor: number; highlights: Array<{ kind: string; amountMinor?: number }> };
  signal: {
    id: string; status: string; title: string;
    sources: Array<{ kind: string; id: string; title: string }>;
  };
  signals: Array<{
    id: string; kind: string; rule: string; title: string; amountMinor: number | null;
    amountLabel: string | null; sources: Array<{ kind: string; id: string; title: string }>;
  }>;
  counts: { commitment: number; renewal: number; anomaly: number };
  total: number;
  answer: { text: string; followUp: string | null; sources: Array<{ type: string; id: string; title: string }> };
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

function captured() {
  return {
    kind: 'payment', title: 'Paid for groceries', occurredAt: '2026-09-26', occurredPrecision: 'day',
    amount: '500', currency: 'INR', direction: 'out', counterparty: 'Shop', category: null,
    reference: null, status: 'successful', summary: 'Paid Rs 500 at Shop.',
    missingContext: { field: 'purpose', question: 'What was this for?', options: ['Groceries', 'Household'] },
  };
}

function captureForm() {
  const body = new FormData();
  body.set('file', new File(['Paid Rs 500 at Shop on 26/09/2026. Successful.'], 'receipt.txt', { type: 'text/plain' }));
  return body;
}

function verdict(body: ProviderBody) {
  const prompt = body.messages?.filter((message) => message.role === 'user').map((message) => message.content).join('\n') ?? '';
  const ids = [...prompt.matchAll(/^id: (item_\w+)$/gm)].map((match) => match[1]!);
  return {
    headline: 'The records support the stated payment.', standing: 'your_account_is_better_supported', confidence: 'medium',
    summary: 'The submitted record states that Rs 500 was paid.',
    evidence: ids.map((itemId) => ({ itemId, strength: 'moderate', reason: 'This source states that Rs 500 was paid.' })),
    conflicts: [], openQuestions: ['Has the recipient checked the bank statement?'], nextStep: 'Ask the recipient to check the payment reference.',
  };
}

async function caseWithEvidence() {
  const created = await request('/cases', 'POST', { title: 'Payment', question: 'Was payment made?' });
  assert.equal(created.status, 201);
  const id = created.body.case.id as string;
  const added = await request(`/cases/${id}/items`, 'POST', { label: 'My account', text: 'Paid Rs 500', side: 'mine' });
  assert.equal(added.status, 201);
  return { id, itemId: added.body.item.id as string };
}

test('capture stores real text, asks context, and re-upload cannot double spending', async () => {
  responder = () => captured();
  const initial = await request('/daybook/capture', 'POST', captureForm());
  assert.equal(initial.status, 202);
  await eventually(jobFinished);
  const duplicate = await request('/daybook/capture', 'POST', captureForm());
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(initial.body.record.id, duplicate.body.record.id);
  assert.equal(duplicate.body.record.amountMinor, 50_000);
  assert.equal(duplicate.body.record.status, 'needs_context');
  const answered = await request(`/daybook/records/${initial.body.record.id}/answer`, 'POST', { answer: 'Groceries' });
  assert.equal(answered.body.record.status, 'complete');
  const summary = await request('/insights?month=2026-09');
  assert.equal(summary.body.spent.amountMinor, 50_000);
  assert.equal(summary.body.categories[0]?.name, 'Groceries');
  assert.equal((await request(`/daybook/records/${initial.body.record.id}`, 'GET', undefined, 'owner-b')).status, 404);
});

test('nothing naming who or what read a file reaches the app, including a field added after the rule', async () => {
  const now = Date.now();
  const stored = {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',

    promptCostUsd: 0.000_41,
    readBy: 'document',
    readNote: 'The second page could not be read.',
    reference: 'UTR3210987654321',
    status: 'successful',
    summary: 'A UPI payment to Sharma Electronics.',
    sourceText: 'UPI Payment Successful\nPaid to Sharma Electronics\n₹1,250.50',
    unread: false,
  };
  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, amount_minor, currency, direction, extraction, status, created_at, updated_at)
     VALUES ('rec-provenance', 'owner-a', 'payment', 'Paid Sharma Electronics', 125050, 'INR', 'out', ?, 'complete', ?, ?)`,
  ).run(JSON.stringify(stored), now, now);

  const shown = (await request('/daybook/records/rec-provenance')).body.record.extraction;
  assert.deepEqual(
    Object.keys(shown).sort(),
    ['readBy', 'readNote', 'reference', 'sourceText', 'status', 'summary', 'unread'],
    'the app is handed exactly the showable keys of a stored read — no more, and no fewer',
  );

  for (const leaked of ['provider', 'model', 'promptCostUsd']) {
    assert.equal(leaked in shown, false, `${leaked} reached the app`);
  }
  const serialised = JSON.stringify(shown);
  for (const internal of ['groq', 'gpt-oss', '0.00041']) {
    assert.ok(!serialised.includes(internal), `${internal} reached the app inside another field`);
  }

  assert.equal(shown.reference, stored.reference);
  assert.equal(shown.summary, stored.summary);
  assert.equal(shown.readNote, stored.readNote);
  assert.equal(shown.sourceText, stored.sourceText);

  const listed = (await request('/daybook/records')).body.records;
  assert.deepEqual(listed.find((row) => row.id === 'rec-provenance')?.extraction, shown);
});

test('unsupported model amounts become a question and invalid answers leave it open', async () => {
  responder = () => ({ ...captured(), amount: '5000' });
  const initial = await request('/daybook/capture', 'POST', captureForm());
  await eventually(jobFinished);
  const id = initial.body.record.id;
  const record = await request(`/daybook/records/${id}`);
  assert.equal(record.body.record.amountMinor, null);
  assert.equal(record.body.record.question.field, 'amount');
  const invalid = await request(`/daybook/records/${id}/answer`, 'POST', { answer: '50 and 70' });
  assert.equal(invalid.status, 400);
  assert.equal((await request(`/daybook/records/${id}`)).body.record.status, 'needs_context');
  assert.equal((db.prepare('SELECT answered_at FROM questions WHERE record_id = ?').get(id) as { answered_at: number | null }).answered_at, null);
  const valid = await request(`/daybook/records/${id}/answer`, 'POST', { answer: '500' });
  assert.equal(valid.body.record.amountMinor, 50_000);
  assert.equal(valid.body.record.status, 'complete');
});

test('record corrections reject invalid data, preserve currency value, and allow clearing dates', async () => {
  assert.equal((await request('/daybook/records', 'POST', { title: '   ' })).status, 400);
  assert.equal((await request('/daybook/records', 'POST', { title: 'Bad date', occurredAt: '2026-02-31' })).status, 400);
  const created = await request('/daybook/records', 'POST', { title: 'Cash payment', amount: '100', currency: 'INR', direction: 'out' });
  const id = created.body.record.id;
  const changed = await request(`/daybook/records/${id}`, 'PATCH', { currency: 'JPY', occurredAt: null });
  assert.equal(changed.body.record.amountMinor, 100);
  assert.equal(changed.body.record.occurredAt, null);
  assert.equal((await request(`/daybook/records/${id}`, 'PATCH', { amount: '50 plus 70' })).status, 400);
  assert.equal((await request(`/daybook/records/${id}`)).body.record.amountMinor, 100);
});

test('case cache and report are invalidated by question changes and equal-length source changes', async () => {
  responder = (_url, body) => verdict(body);
  const { id, itemId } = await caseWithEvidence();
  assert.equal((await request(`/cases/${id}/analyze`, 'POST')).status, 200);
  assert.equal((await request(`/cases/${id}/analyze`, 'POST')).body.reused, true);
  assert.equal((await request(`/cases/${id}/report`)).status, 200);
  await request(`/cases/${id}`, 'PATCH', { question: 'Was delivery made?' });
  assert.equal((await request(`/cases/${id}`)).body.case.analysisStale, true);
  assert.equal((await request(`/cases/${id}/report`)).status, 409);
  await request(`/cases/${id}/analyze`, 'POST');
  db.prepare("UPDATE case_items SET text = REPLACE(text, '500', '900'), extraction = REPLACE(extraction, '500', '900') WHERE id = ?").run(itemId);
  assert.equal((await request(`/cases/${id}`)).body.case.analysisStale, true);
  assert.equal((await request(`/cases/${id}/report`)).status, 409);
});

test('invented evidence citations are rejected instead of silently removed', async () => {
  const { id } = await caseWithEvidence();
  responder = (_url, body) => ({ ...verdict(body), evidence: [{ itemId: 'invented', strength: 'strong', reason: 'Unsupported citation' }] });
  assert.equal((await request(`/cases/${id}/analyze`, 'POST')).status, 502);
  assert.equal((await request(`/cases/${id}`)).body.case.hasAnalysis, false);
});

test('analysis refuses to save a result after the user changes its source', async () => {
  const { id } = await caseWithEvidence();
  responder = (_url, body) => {
    db.prepare('UPDATE cases SET question = ? WHERE id = ?').run('A changed question', id);
    return verdict(body);
  };
  assert.equal((await request(`/cases/${id}/analyze`, 'POST')).status, 409);
  assert.equal((await request(`/cases/${id}`)).body.case.hasAnalysis, false);
});

test('an account typed for the other side is opposing material, weighed below a document', async () => {
  const created = await request('/cases', 'POST', {
    title: 'Payment', question: 'Was payment made?', theirClaim: 'Amount due Rs 900 and nothing ever arrived.',
  });
  const id = created.body.case.id as string;
  await request(`/cases/${id}/items`, 'POST', { label: 'My receipt', text: 'Total Rs 500 paid on 10/09/2026', side: 'mine' });
  const signals = (await request(`/cases/${id}`)).body.case.signals;
  assert.equal(signals.some((signal) => signal.kind === 'no_opposing_material'), false);
  const mismatch = signals.find((signal) => signal.kind === 'amount_mismatch');
  assert.equal(mismatch?.strength, 'moderate');
  assert.ok(mismatch?.itemIds.some((itemId) => itemId.endsWith(':theirs_claim')));
});

test('full source retrieval and every case mutation stay owner isolated', async () => {
  const { id, itemId } = await caseWithEvidence();
  const longText = 'Source statement. '.repeat(100);
  db.prepare('UPDATE case_items SET text = ?, extraction = ? WHERE id = ?').run(longText, '{}', itemId);
  assert.equal((await request(`/cases/${id}/items/${itemId}`)).body.item.text, longText);
  for (const [path, method] of [
    [`/cases/${id}`, 'GET'], [`/cases/${id}/report`, 'GET'], [`/cases/${id}/items/${itemId}`, 'GET'],
    [`/cases/${id}/analyze`, 'POST'], [`/cases/${id}`, 'DELETE'], [`/cases/${id}/items/${itemId}`, 'DELETE'],
  ]) assert.equal((await request(path!, method, undefined, 'owner-b')).status, 404, `${method} ${path}`);
});

test('spending excludes failed transfers, unreadable records, unpaid bills and other owners', async () => {
  const insert = db.prepare(`INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction, extraction, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Payment', ?, ?, 'INR', ?, ?, ?, ?, ?)`);
  const at = new Date(2026, 8, 26).getTime();
  ensureUser('owner-b', null, null);
  for (const [id, user, kind, direction, status, extraction] of [
    ['good', 'owner-a', 'payment', 'out', 'complete', 'successful'],
    ['failed', 'owner-a', 'payment', 'out', 'complete', 'failed'],
    ['pending', 'owner-a', 'payment', 'out', 'needs_context', 'pending'],
    ['unreadable', 'owner-a', 'payment', 'out', 'failed', 'successful'],

    ['bill', 'owner-a', 'bill', null, 'complete', 'unpaid'],
    ['other', 'owner-b', 'payment', 'out', 'complete', 'successful'],
  ]) insert.run(id, user, kind, at, 50_000, direction, JSON.stringify({ status: extraction }), status, at, at);
  const summary = await request('/insights?month=2026-09');
  assert.equal(summary.body.spent.amountMinor, 50_000);
  assert.equal((await request('/insights?month=2026-08')).body.spent.amountMinor, 0);
  assert.equal((await request('/insights?month=2026-99')).status, 400);
  await request('/insights/budget', 'PUT', { amount: '30000', currency: 'INR' });
  assert.equal((await request('/insights?month=2026-09')).body.budget.remainingMinor, 2_950_000);
  assert.equal((await request('/insights/budget', 'GET', undefined, 'owner-b')).body.budget, null);
});

test('an amount with no currency is never summed as rupees and is counted once as left out', async () => {
  const insert = db.prepare(`INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction, extraction, status, created_at, updated_at)
    VALUES (?, 'owner-a', 'payment', 'Payment', ?, ?, ?, 'out', ?, 'complete', ?, ?)`);
  const at = new Date(2026, 8, 26).getTime();
  for (const [id, amount, currency, extraction] of [
    ['inr-a', 50_000, 'INR', JSON.stringify({ status: 'successful' })],
    ['inr-b', 10_000, 'INR', JSON.stringify({ status: 'successful' })],
    ['no-currency', 999_999, null, JSON.stringify({ status: 'successful' })],
    ['usd', 7_000, 'USD', JSON.stringify({ status: 'successful' })],
    ['corrupt', 4_444, 'INR', 'not json at all'],
  ]) insert.run(id, at, amount, currency, extraction, at, at);

  const summary = await request('/insights?month=2026-09');
  assert.equal(summary.body.currency, 'INR');

  assert.equal(summary.body.spent.amountMinor, 60_000);

  assert.deepEqual(summary.body.excluded, {
    missingCurrency: { count: 1, moreCount: 0, recordIds: ['no-currency'] },
    otherCurrency: { count: 1, moreCount: 0, recordIds: ['usd'] },
    unreadable: { count: 1, moreCount: 0, recordIds: ['corrupt'] },
  });

  assert.equal(summary.body.excludedRecordCount, 3);
});

test('the money screen explains the month rather than only counting it', async () => {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const at = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  db.prepare(`INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, category, direction, extraction, status, created_at, updated_at)
    VALUES ('spend', 'owner-a', 'payment', 'Paid Sharma Electricals', ?, 1500000, 'INR', 'Bills', 'out', ?, 'complete', ?, ?)`)
    .run(at, JSON.stringify({ status: 'successful' }), at, at);
  await request('/insights/budget', 'PUT', { amount: '10000', currency: 'INR' });

  const body = (await request(`/insights?month=${month}`)).body;
  const over = body.guidance.find((line) => line.kind === 'over');
  assert.equal(over?.tone, 'danger');

  assert.match(over!.text, /^₹5,000\.00 over the ₹10,000\.00 budget/);

  assert.equal(body.guidance.filter((line) => ['over', 'pace'].includes(line.kind)).length, 1);

  assert.deepEqual((await request('/insights?month=2026-01')).body.guidance, []);

  ensureUser('owner-b', null, null);
  db.prepare(`INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction, extraction, status, created_at, updated_at)
    VALUES ('bare-b', 'owner-b', 'payment', 'Payment', ?, 900000, NULL, 'out', ?, 'complete', ?, ?)`)
    .run(at, JSON.stringify({ status: 'successful' }), at, at);
  assert.deepEqual((await request(`/insights?month=${month}`, 'GET', undefined, 'owner-b')).body.guidance, []);
});

test('a month with no recognisable currency reports no currency instead of claiming rupees', async () => {
  const at = new Date(2026, 8, 26).getTime();
  db.prepare(`INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction, extraction, status, created_at, updated_at)
    VALUES ('bare', 'owner-a', 'payment', 'Payment', ?, 2500, NULL, 'out', ?, 'complete', ?, ?)`)
    .run(at, JSON.stringify({ status: 'successful' }), at, at);
  const summary = await request('/insights?month=2026-09');
  assert.equal(summary.body.currency, null);
  assert.equal(summary.body.spent.amountMinor, 0);
  assert.equal(summary.body.spent.amountLabel, null);
  assert.deepEqual(summary.body.excluded.missingCurrency, { count: 1, moreCount: 0, recordIds: ['bare'] });
});

test('the money screen and the daybook recap report the same spend for the same month', async () => {
  const at = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const insert = db.prepare(`INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction, extraction, status, created_at, updated_at)
    VALUES (?, 'owner-a', 'payment', 'Payment', ?, ?, 'INR', 'out', ?, ?, ?, ?)`);

  insert.run('settled', at, 50_000, JSON.stringify({ status: 'successful' }), 'complete', at, at);
  insert.run('open-question', at, 25_000, JSON.stringify({ status: 'successful' }), 'needs_context', at, at);

  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const screen = await request(`/insights?month=${month}`);
  const recap = await request('/daybook/recap?period=month');
  assert.equal(screen.body.spent.amountMinor, 75_000);
  assert.equal(recap.body.recap.spentMinor, screen.body.spent.amountMinor);
  assert.equal(recap.body.recap.currency, screen.body.currency);
});

test('recap highlights carry structured figures, not server-authored English', async () => {
  const at = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  db.prepare(`INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction, category, extraction, status, created_at, updated_at)
    VALUES ('spend', 'owner-a', 'payment', 'Payment', ?, 50000, 'INR', 'out', 'Food', ?, 'complete', ?, ?)`)
    .run(at, JSON.stringify({ status: 'successful' }), at, at);
  const recap = await request('/daybook/recap?period=month');
  const spent = recap.body.recap.highlights.find((entry) => entry.kind === 'spent');
  assert.equal(spent?.amountMinor, 50_000);
  for (const entry of recap.body.recap.highlights) assert.equal(typeof entry, 'object');
});

function seedMeeting(transcript = 'Priya will send the receipt by 2026-09-30.') {
  const id = 'meeting-test';
  const now = Date.now();
  db.prepare(`INSERT INTO meetings (id, user_id, title, transcript, language, status, started_at, created_at, updated_at)
    VALUES (?, 'owner-a', 'Meeting', ?, 'English', 'transcribed', ?, ?, ?)`).run(id, transcript, now, now, now);
  return id;
}

function meetingAnswer(text = 'Send the receipt') {
  return { title: 'Receipt discussion', summary: 'Priya agreed to send the receipt.', language: 'English',
    topics: ['Receipt'], keyPoints: [], decisions: [], attention: [],
    actionItems: [{ text, owner: 'Priya', priority: 'normal', due: '2026-09-30' }] };
}

test('meeting retries reuse transcript, reject concurrent retry and preserve completed actions', async () => {
  const id = seedMeeting();
  const doneAt = Date.now();
  db.prepare("INSERT INTO tasks (id,user_id,text,owner_name,done_at,meeting_id,created_at) VALUES ('existing-task','owner-a','Send the receipt','Priya',?,?,?)").run(doneAt, id, doneAt);
  let finish!: (value: unknown) => void;
  responder = () => new Promise((done) => { finish = done; });
  assert.equal((await request(`/meetings/${id}/retry`, 'POST')).status, 202);
  assert.equal((await request(`/meetings/${id}/retry`, 'POST')).status, 400);
  finish(meetingAnswer());
  await eventually(jobFinished);
  const result = await request(`/meetings/${id}`);
  assert.equal(result.body.meeting.status, 'complete');
  assert.equal(result.body.meeting.tasks.length, 1);
  assert.equal(result.body.meeting.tasks[0]?.id, 'existing-task');
  assert.equal(result.body.meeting.tasks[0]?.doneAt, doneAt);
});

test('deleting a meeting during analysis cannot restore it or create orphan tasks', async () => {
  const id = seedMeeting();
  let finish!: (value: unknown) => void;
  responder = () => new Promise((done) => { finish = done; });
  await request(`/meetings/${id}/retry`, 'POST');
  await request(`/meetings/${id}`, 'DELETE');
  finish(meetingAnswer());
  await eventually(jobFinished);
  assert.equal((await request(`/meetings/${id}`)).status, 404);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0);
});

test('long meetings include decisions after the old transcript truncation boundary', async () => {
  const id = seedMeeting('Discussion without action. '.repeat(1_000) + ' FINAL: Priya will send the receipt.');
  let calls = 0;
  responder = (_url, body) => {
    calls++;
    const content = body.messages?.at(-1)?.content ?? '';
    return { ...meetingAnswer(), actionItems: content.includes('FINAL:') ? meetingAnswer().actionItems : [] };
  };
  await request(`/meetings/${id}/retry`, 'POST');
  await eventually(jobFinished);
  assert.ok(calls > 1);
  assert.equal((await request(`/meetings/${id}`)).body.meeting.tasks.length, 1);
});

test('file reuse inside a case does not duplicate evidence and task dates reject invalid input', async () => {
  const { id } = await caseWithEvidence();
  const upload = new FormData();
  upload.set('file', new File(['Paid Rs 500'], 'payment.txt', { type: 'text/plain' }));
  const first = await request(`/cases/${id}/items`, 'POST', upload);
  await eventually(jobFinished);
  const second = await request(`/cases/${id}/items`, 'POST', upload);
  assert.equal(first.body.item.id, second.body.item.id);
  assert.equal(second.body.duplicate, true);
  assert.equal((await request('/tasks', 'POST', { text: '   ' })).status, 400);
  assert.equal((await request('/tasks', 'POST', { text: 'Follow up', due: '31/02/2026' })).status, 400);
  const task = await request('/tasks', 'POST', { text: 'Follow up', due: '30/09/2026' });
  assert.equal(task.status, 201);
  assert.equal((await request(`/tasks/${task.body.task.id}`, 'PATCH', { done: true }, 'owner-b')).status, 404);
});

test('duplicate audio upload returns the existing meeting without starting work', async () => {
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  const file = storeUpload('owner-a', bytes, 'audio/wav', 'meeting.wav');
  const id = seedMeeting();
  db.prepare('UPDATE meetings SET file_id = ? WHERE id = ?').run(file.id, id);
  const body = new FormData();
  body.set('audio', new File([bytes], 'meeting.wav', { type: 'audio/wav' }));
  const response = await request('/meetings', 'POST', body);
  assert.equal(response.status, 200);
  assert.equal(response.body.duplicate, true);
  assert.equal(response.body.meeting.id, id);
  assert.equal(jobFinished(), true);
});

test('failed records and evidence can retry while ownership and active states stay guarded', async () => {
  responder = () => captured();
  const initial = await request('/daybook/capture', 'POST', captureForm());
  await eventually(jobFinished);
  const id = initial.body.record.id;
  db.prepare("UPDATE records SET status = 'failed', note = 'Temporary read failure' WHERE id = ?").run(id);
  assert.equal((await request(`/daybook/records/${id}/retry`, 'POST', undefined, 'owner-b')).status, 404);
  assert.equal((await request(`/daybook/records/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);
  assert.equal((await request(`/daybook/records/${id}`)).body.record.status, 'needs_context');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM questions WHERE record_id = ? AND answered_at IS NULL').get(id) as { n: number }).n, 1);
  assert.equal((await request(`/daybook/records/${id}/retry`, 'POST')).status, 400);

  const caseId = (await caseWithEvidence()).id;
  const form = new FormData();
  form.set('file', new File(['Paid Rs 500'], 'receipt.txt', { type: 'text/plain' }));
  const created = await request(`/cases/${caseId}/items`, 'POST', form);
  await eventually(jobFinished);
  const itemId = created.body.item.id;
  db.prepare("UPDATE case_items SET status = 'failed' WHERE id = ?").run(itemId);
  assert.equal((await request(`/cases/${caseId}/items/${itemId}/retry`, 'POST', undefined, 'owner-b')).status, 404);
  assert.equal((await request(`/cases/${caseId}/items/${itemId}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);
  assert.equal((await request(`/cases/${caseId}/items/${itemId}`)).body.item.status, 'ready');
});

test('an amount the source states but no currency becomes a question, never a silent drop', async () => {
  responder = () => ({ ...captured(), currency: null });
  const initial = await request('/daybook/capture', 'POST', captureForm());
  await eventually(jobFinished);
  const id = initial.body.record.id;

  const record = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(record.amountMinor, null);
  assert.equal(record.currency, null);
  assert.equal(record.status, 'needs_context');
  assert.equal(record.question.field, 'amount');

  assert.equal((await request(`/daybook/records/${id}/answer`, 'POST', { answer: '500' })).status, 400);
  const answered = await request(`/daybook/records/${id}/answer`, 'POST', { answer: '₹500' });
  assert.equal(answered.body.record.amountMinor, 50_000);
  assert.equal(answered.body.record.currency, 'INR');
  assert.equal(answered.body.record.status, 'complete');
  assert.equal((await request('/insights?month=2026-09')).body.spent.amountMinor, 50_000);
});

test('a file with nothing readable still becomes a record that asks what it is', async () => {
  const body = new FormData();
  body.set('file', new File(['   \n \t '], 'IMG_2451.txt', { type: 'text/plain' }));
  const initial = await request('/daybook/capture', 'POST', body);
  assert.equal(initial.status, 202);

  await eventually(jobFinished);

  const id = initial.body.record.id;
  const record = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(record.status, 'needs_context');
  assert.equal(record.question.field, 'other');
  assert.ok(record.question.prompt.length > 0);

  const answered = await request(`/daybook/records/${id}/answer`, 'POST', { answer: 'Lunch with Priya' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.record.status, 'complete');
  assert.equal(answered.body.record.note, 'Lunch with Priya');
  assert.equal(answered.body.record.title, 'Lunch with Priya');
  assert.equal(answered.body.record.amountMinor, null);
});

test('a read that failed is read again on re-upload rather than handed back as a duplicate', async () => {
  responder = () => captured();
  const initial = await request('/daybook/capture', 'POST', captureForm());
  await eventually(jobFinished);
  const id = initial.body.record.id;
  db.prepare("UPDATE records SET status = 'unreadable', note = 'Nothing could be read.' WHERE id = ?").run(id);

  const again = await request('/daybook/capture', 'POST', captureForm());
  assert.equal(again.status, 202);
  assert.equal(again.body.record.id, id);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.retrying, true);
  assert.equal(again.body.record.note, null);
  await eventually(jobFinished);
  assert.equal((await request(`/daybook/records/${id}`)).body.record.status, 'needs_context');
});

test('an unusable model answer leaves a sentence on the record and the detail only in the job', async () => {
  responder = () => ({ kind: 'not-a-record-kind' });
  const initial = await request('/daybook/capture', 'POST', captureForm());
  await eventually(jobFinished);
  const id = initial.body.record.id;

  const record = (await request(`/daybook/records/${id}`)).body.record;
  assert.equal(record.status, 'failed');
  assert.ok(record.note);
  assert.ok(!/[{}[\]"]|invalid_|expected/i.test(record.note), `internal detail reached the record: ${record.note}`);
  const job = db.prepare('SELECT detail FROM jobs WHERE subject_id = ? ORDER BY created_at DESC LIMIT 1').get(id) as { detail: string | null };
  assert.ok(job.detail && job.detail.length > 0);
});

test('a listing of many records asks for their questions once, not once each', async () => {
  responder = () => captured();
  await request('/daybook/capture', 'POST', captureForm());
  await eventually(jobFinished);
  for (let index = 0; index < 4; index++) {
    await request('/daybook/records', 'POST', { title: `Typed ${index}`, amount: '100', currency: 'INR', direction: 'out' });
  }
  let questionQueries = 0;
  const seen = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = (sql: string) => {
    if (/FROM questions/i.test(sql)) questionQueries += 1;
    return seen(sql);
  };
  try {
    const listed = await request('/daybook/records');
    assert.equal(listed.body.records.length, 5);
  } finally {
    (db as unknown as { prepare: typeof db.prepare }).prepare = seen;
  }
  assert.equal(questionQueries, 1);
});

/**
 * Attention: the one list of things noticed but not dealt with.
 *
 * These pin the two rules the store exists to enforce — a resolved item stays resolved,
 * and a signal the person cannot trace back to their own material is not shown. Both are
 * about trust rather than correctness: a list that reopens what you dismissed is one you
 * stop reading, and a claim citing a record that is gone is indistinguishable from one
 * the app made up.
 *
 * The anomaly detectors need no model, so nothing here authorizes a network call.
 */
async function paidTwice(owner = 'owner-a') {
  const at = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  for (const _ of [0, 1]) {
    const created = await request('/daybook/records', 'POST', {
      title: 'Paid Sharma Electricals', amount: '2499', currency: 'INR',
      direction: 'out', counterparty: 'Sharma Electricals', occurredAt: at,
    }, owner);
    assert.equal(created.status, 201);
  }
}

test('the same payment made twice is noticed, and cites both records by name', async () => {
  await paidTwice();
  const listed = await request('/attention?refresh=1');

  assert.equal(listed.body.total, 1);
  const signal = listed.body.signals[0]!;
  assert.equal(signal.kind, 'anomaly');
  assert.equal(signal.rule, 'duplicate_charge');
  assert.equal(signal.amountMinor, 249_900);
  assert.equal(signal.amountLabel, '₹2,499.00');
  assert.deepEqual(listed.body.counts, { commitment: 0, renewal: 0, anomaly: 1 });

  // Both sources, resolved to the titles the person will actually see and tap.
  assert.equal(signal.sources.length, 2);
  for (const source of signal.sources) {
    assert.equal(source.kind, 'record');
    assert.equal(source.title, 'Paid Sharma Electricals');
  }
});

test('a dismissed item stays dismissed when the detectors run again', async () => {
  await paidTwice();
  const id = (await request('/attention?refresh=1')).body.signals[0]!.id;

  const resolved = await request(`/attention/${id}/resolve`, 'POST', { status: 'dismissed' });
  assert.equal(resolved.body.signal.status, 'dismissed');
  // The same shape as the list: sources carry the titles the app renders. Returning the
  // bare row here made resolving fail on the client, on a response that said it worked.
  assert.deepEqual(
    resolved.body.signal.sources.map((source) => source.title),
    ['Paid Sharma Electricals', 'Paid Sharma Electricals'],
  );
  assert.equal((await request('/attention')).body.total, 0);

  // The records are untouched, so the detector finds the same thing again. The person's
  // verdict is what decides whether it is shown, and a re-run must not overrule it.
  const after = await request('/attention?refresh=1');
  assert.equal(after.body.total, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n, 1);
});

test('an item whose records are gone is retired rather than shown unverifiable', async () => {
  await paidTwice();
  const listed = await request('/attention?refresh=1');
  assert.equal(listed.body.total, 1);

  for (const source of listed.body.signals[0]!.sources) {
    assert.equal((await request(`/daybook/records/${source.id}`, 'DELETE')).status, 200);
  }

  // Not merely hidden: nothing can cite it any more, so it is closed out for good.
  assert.equal((await request('/attention')).body.total, 0);
  const row = db.prepare('SELECT status FROM signals').get() as { status: string };
  assert.equal(row.status, 'dismissed');
});

test('attention is owner isolated, for reading and for resolving', async () => {
  await paidTwice('owner-a');
  const mine = await request('/attention?refresh=1', 'GET', undefined, 'owner-a');
  assert.equal(mine.body.total, 1);

  const theirs = await request('/attention?refresh=1', 'GET', undefined, 'owner-b');
  assert.equal(theirs.body.total, 0);

  const id = mine.body.signals[0]!.id;
  assert.equal((await request(`/attention/${id}`, 'GET', undefined, 'owner-b')).status, 404);
  assert.equal(
    (await request(`/attention/${id}/resolve`, 'POST', { status: 'done' }, 'owner-b')).status,
    404,
  );
  assert.equal((await request('/attention', 'GET', undefined, 'owner-a')).body.total, 1);
});

test('a single payment is not an anomaly, and an empty list says so plainly', async () => {
  await request('/daybook/records', 'POST', {
    title: 'Paid rent', amount: '15000', currency: 'INR', direction: 'out', counterparty: 'Landlord',
  });
  const listed = await request('/attention?refresh=1');
  assert.equal(listed.body.total, 0);
  assert.deepEqual(listed.body.signals, []);
  assert.deepEqual(listed.body.counts, { commitment: 0, renewal: 0, anomaly: 0 });
});

/**
 * Ask your daybook: what a question may reach, and what an answer may claim.
 *
 * Retrieval was once the newest few hundred rows inside a fixed lookback, so the two cases
 * below — a payee buried behind a year of groceries, and one older than the lookback
 * entirely — were not ranked low, they were unreachable, and the model answered from
 * whatever happened to be nearby. Most of these tests therefore assert on the prompt
 * itself: the entries the person would have to be shown for a right answer to be possible
 * at all. The rest hold the lines that widening retrieval must not cross — a month the
 * person named still decides what counts, an id the model was not given is still refused,
 * and a provider's own complaint is still not shown to anyone.
 */
const DAY_MS = 86_400_000;

/** The entries the last question actually put in front of the model. */
let shown = '';

/** Answers from whatever it was handed, and keeps a copy of what that was. */
function reading(sourceIds: string[] = []) {
  return (_url: string, body: ProviderBody) => {
    shown = body.messages?.filter((message) => message.role === 'user').map((message) => message.content).join('\n') ?? '';
    return { text: 'This is what those entries say.', sourceIds, followUp: null };
  };
}

function seedRecord(id: string, counterparty: string, at: number, title = 'Payment') {
  db.prepare(`INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction,
                                   counterparty, extraction, status, created_at, updated_at)
    VALUES (?, 'owner-a', 'payment', ?, ?, 249900, 'INR', 'out', ?, ?, 'complete', ?, ?)`)
    .run(id, title, at, counterparty, JSON.stringify({ status: 'successful' }), at, at);
  return id;
}

test('a question reaches the payee it names from behind a year of newer records', async () => {
  const now = Date.now();
  const plumber = seedRecord('rec-plumber', 'Anil the plumber', now - 200 * DAY_MS, 'Bathroom tap');
  // More than the recency slice holds, so nothing but the index can reach the answer.
  db.transaction(() => {
    for (let index = 0; index < 620; index += 1) {
      seedRecord(`rec-noise-${index}`, 'Big Bazaar', now - index, `Groceries ${index}`);
    }
  })();

  responder = reading([plumber]);
  const asked = await request('/daybook/ask', 'POST', { question: 'how much did I pay the plumber' });
  assert.equal(asked.status, 200);
  assert.ok(shown.includes(plumber), 'the only record that answers the question was never shown');
  assert.ok(shown.includes('Anil the plumber'));
  assert.deepEqual(asked.body.answer.sources, [{ type: 'record', id: plumber, title: 'Bathroom tap' }]);
});

test('a match older than the lookback is reachable, and only shown entries may be cited', async () => {
  const old = seedRecord('rec-gas', 'Bharat Gas', Date.now() - 500 * DAY_MS, 'Cylinder refill');
  seedRecord('rec-shop', 'Big Bazaar', Date.now() - DAY_MS, 'Groceries');

  responder = reading([old]);
  const asked = await request('/daybook/ask', 'POST', { question: 'what did I pay Bharat Gas' });
  assert.equal(asked.status, 200);
  assert.deepEqual(asked.body.answer.sources, [{ type: 'record', id: old, title: 'Cylinder refill' }]);

  // Grounding is not relaxed because retrieval got wider. An id the model was not handed
  // is still a refusal, not a citation quietly dropped from an answer that still ships.
  responder = reading(['rec-invented']);
  assert.equal((await request('/daybook/ask', 'POST', { question: 'what did I pay Bharat Gas' })).status, 502);
});

test("a question written in a person's own punctuation is searched, not rejected", async () => {
  const id = seedRecord('rec-sharma', 'Sharma & Co.', Date.now() - 30 * DAY_MS, 'Wiring work');
  responder = reading([id]);
  // Quotes, a bare OR, a hyphen and a NEAR are all FTS5 operators, and a malformed MATCH
  // raises rather than returning nothing: unescaped, this was a 500.
  const asked = await request('/daybook/ask', 'POST', {
    question: 'Did I pay "Sharma & Co." OR the NEAR-by shop -- 50% off?',
  });
  assert.equal(asked.status, 200);
  assert.ok(shown.includes(id));
});

test('editing and deleting a record through its own routes keeps the index in step', async () => {
  const created = await request('/daybook/records', 'POST', {
    title: 'Repair', amount: '2499', currency: 'INR', direction: 'out', counterparty: 'Anil the plumber',
  });
  assert.equal(created.status, 201);
  const id = created.body.record.id;
  assert.deepEqual(search('owner-a', 'plumber').record, [id]);

  assert.equal((await request(`/daybook/records/${id}`, 'PATCH', { counterparty: 'Ravi the electrician' })).status, 200);
  assert.deepEqual(search('owner-a', 'plumber').record, [], 'a correction the person made is still findable by the old word');
  assert.deepEqual(search('owner-a', 'electrician').record, [id]);

  assert.equal((await request(`/daybook/records/${id}`, 'DELETE')).status, 200);
  assert.deepEqual(search('owner-a', 'electrician').record, [], 'a deleted record can still be retrieved and cited');
});

test('a named month is not answered with a payment from outside it', async () => {
  const now = new Date();
  const recent = seedRecord(
    'rec-plumber-recent', 'Anil the plumber', new Date(now.getFullYear(), now.getMonth() - 1, 15).getTime(), 'Bathroom tap',
  );
  const ancient = seedRecord('rec-plumber-old', 'Anil the plumber', Date.now() - 500 * DAY_MS, 'Kitchen sink');

  responder = reading([recent]);
  const asked = await request('/daybook/ask', 'POST', { question: 'how much did I pay the plumber last month' });
  assert.equal(asked.status, 200);
  assert.ok(shown.includes(recent));
  assert.ok(!shown.includes(ancient), 'a hit from outside the month the person named was shown anyway');
});

test('a provider failure reaches the person as a sentence, not as provider internals', async () => {
  seedRecord('rec-any', 'Big Bazaar', Date.now() - DAY_MS, 'Groceries');
  responder = () => {
    throw new Error('429 rate_limit_exceeded for model openai/gpt-oss-120b in org org_01HZ, retry in 4.2s');
  };
  const asked = await request('/daybook/ask', 'POST', { question: 'what did I spend at Big Bazaar' });

  // The status still says "this may work in a moment", and the wording is ours, so the
  // detail below never has to be sanitised on its way out — it is simply not sent.
  assert.equal(asked.status, 502);
  assert.equal(asked.body.error, 'That answer could not be written just now. Try again in a moment.');
  for (const internal of ['openai/gpt-oss-120b', 'org_01HZ', 'rate_limit_exceeded', 'Groq', '429']) {
    assert.ok(!asked.body.error.includes(internal), `provider detail reached the client: ${asked.body.error}`);
  }
});
