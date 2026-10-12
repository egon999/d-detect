import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Account } from '../auth.ts';

const directory = mkdtempSync(join(tmpdir(), 'detact-cases-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';
const { db, ensureUser } = await import('../db.ts');
const { cases } = await import('./cases.ts');
const { fileById, storeUpload } = await import('../files.ts');
const { readSource } = await import('../extract.ts');

const app = new Hono<{ Variables: { account: Account } }>();
app.use('*', async (context, next) => {
  const id = context.req.header('x-test-owner') ?? 'owner-a';
  ensureUser(id, null, null);
  context.set('account', { id, email: null, name: null });
  await next();
});
app.route('/cases', cases);
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

beforeEach(() => {
  db.exec('DELETE FROM jobs; DELETE FROM signals; DELETE FROM signal_scans; DELETE FROM cases; DELETE FROM meetings; DELETE FROM records; DELETE FROM tasks; DELETE FROM budgets; DELETE FROM files; DELETE FROM users;');
  ensureUser('owner-a', null, null);
  responder = () => { throw new Error('This test did not authorize a model call.'); };
});

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-cases-'));
  rmSync(target, { recursive: true, force: true });
});

type Item = {
  id: string;
  side: string;
  label: string;
  status: string;
  readBy: string | null;
  readNote: string | null;
  question: string | null;
  excerpt: string;
  hasMoreText: boolean;
  fileHadMoreText: boolean;
  facts: {
    amounts: Array<{ minor: number; currency: string }>;
    dates: Array<{ at: number }>;
    partial?: string[];
  };
};

type Coverage = {
  complete: boolean;
  itemsInCase: number;
  itemsAnalysed: number;
  omitted: string[];
  shortened: string[];
  partlySaved: string[];
  notWeighed: string[];
  note: string | null;
};

type Verdict = {
  headline: string;
  yourAccount: string;
  theirAccount: string;
  standing: string;
  confidence: string;
  evidence: Array<{ itemId: string; strength: string }>;
  conflicts: Array<{ point: string; yourSources: string[]; theirSources: string[] }>;
  supported: Array<{ point: string; sources: string[] }>;
  notSupported: Array<{ point: string; sources: string[] }>;
  missing: Array<{ point: string; wouldShow: string }>;
} & Record<string, unknown>;

type Analysis = {
  id: string;
  createdAt: number;
  itemCount: number;
  coverage: Coverage;
  sources: Array<{ id: string; label: string; side: string; kind: string }>;
  verdict: Verdict;
} & Record<string, unknown>;

type Case = {
  id: string;
  items: Item[];
  analysis: Analysis | null;
  hasAnalysis: boolean;
  analysisStale: boolean;
  sources: Array<{ id: string; label: string; side: string; kind: string }>;
};

type TestResponse = {
  case: Case;
  item: Item;
  analysis: Analysis | null;
  analysisCleared: boolean;
  cleared: boolean;
  existing: boolean;
  reused: boolean;
  report: { items: Item[]; coverage: Coverage | null; text: string } & Record<string, unknown>;
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

function blankFile(name = 'screenshot.txt') {
  const body = new FormData();
  body.set('file', new File(['   \n\t  \n'], name, { type: 'text/plain' }));
  body.set('side', 'mine');
  body.set('label', 'Bank screenshot');
  return body;
}

async function openCase(title = 'Rent') {
  const created = await request('/cases', 'POST', { title, question: 'Was the rent paid?' });
  assert.equal(created.status, 201);
  return created.body.case.id;
}

async function addStatement(id: string, label: string, text: string, side = 'mine') {
  const added = await request(`/cases/${id}/items`, 'POST', { label, text, side });
  assert.equal(added.status, 201);
  return added.body.item.id;
}

async function addBlankFile(id: string, name?: string) {
  const added = await request(`/cases/${id}/items`, 'POST', blankFile(name));
  assert.equal(added.status, 202);
  await eventually(jobFinished);
  return added.body.item.id;
}

function verdictCiting(itemIds: string[], extra: Record<string, unknown> = {}) {
  return {
    headline: 'The rent was paid.',
    yourAccount: 'You say the rent was paid.',
    theirAccount: 'They say nothing arrived.',
    standing: 'your_account_is_better_supported',
    confidence: 'medium',
    summary: 'The submitted material states the rent was paid.',
    evidence: itemIds.map((itemId) => ({ itemId, strength: 'moderate', reason: 'This states the rent was paid.' })),
    conflicts: [],
    supported: [],
    notSupported: [],
    missing: [],
    nextStep: 'Ask the landlord to confirm in writing.',
    ...extra,
  };
}

function promptOf(body: ProviderBody): string {
  return body.messages?.filter((message) => message.role === 'user').map((message) => message.content).join('\n') ?? '';
}

function idsInPrompt(body: ProviderBody): string[] {
  return [...promptOf(body).matchAll(/^id: (item_\w+)$/gm)].map((match) => match[1]!);
}

function addRecord(id = 'rec_from_daybook') {
  const now = Date.now();
  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, occurred_precision, amount_minor, currency,
       direction, counterparty, category, note, file_id, extraction, status, created_at, updated_at)
     VALUES (?, 'owner-a', 'payment', 'September rent', ?, 'day', 450000, 'INR', 'out', 'the landlord',
       NULL, NULL, NULL, '{}', 'ready', ?, ?)`,
  ).run(id, now, now, now);
  return id;
}

function countOf(sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

test('a file nothing can be read from becomes a question, not a dead end', async () => {
  const id = await openCase();
  await addBlankFile(id);

  const detail = await request(`/cases/${id}`);
  const item = detail.body.case.items[0]!;
  assert.equal(item.status, 'needs_context');
  assert.ok(item.question && item.question.length > 0, 'an unread file must carry the question to ask');
  assert.match(item.readNote ?? '', /read/i);

  const job = db.prepare('SELECT status FROM jobs WHERE subject_id = ?').get(item.id) as { status: string };
  assert.equal(job.status, 'done');
});

test('a described file is weighed, and every place that names its source says it was described', async () => {
  const id = await openCase();
  const itemId = await addBlankFile(id);

  const described = await request(`/cases/${id}/items/${itemId}/describe`, 'POST', {
    text: 'The bank app showed Rs 4,500 paid to the landlord on 2026-09-05.',
  });
  assert.equal(described.status, 200);
  assert.equal(described.body.item.status, 'ready');
  assert.equal(described.body.item.readBy, 'described');
  assert.match(described.body.item.readNote ?? '', /your own description/i);
  assert.equal(described.body.item.question, null);

  assert.equal(described.body.item.facts.amounts[0]?.minor, 450_000);
  assert.equal(described.body.item.facts.amounts[0]?.currency, 'INR');
  assert.equal(described.body.item.facts.dates.length, 1);

  const report = await request(`/cases/${id}/report`);
  assert.match(report.body.report.text, /unreadable — described by you/);
  assert.ok(
    !/uploaded file, read by/.test(report.body.report.text),
    'a description must never be printed as text read out of the document',
  );
});

test('only a piece actually waiting on the question can be described', async () => {
  const id = await openCase();
  const itemId = await addBlankFile(id);
  const typed = await addStatement(id, 'My account', 'I paid the rent in cash.');

  assert.equal((await request(`/cases/${id}/items/${typed}/describe`, 'POST', { text: 'Something else' })).status, 409);
  assert.equal((await request(`/cases/${id}/items/${itemId}/describe`, 'POST', { text: '   ' })).status, 400);
  assert.equal((await request(`/cases/${id}/items/${itemId}/describe`, 'POST', { text: 'A receipt' }, 'owner-b')).status, 404);

  const item = (await request(`/cases/${id}`)).body.case.items.find((row) => row.id === itemId)!;
  assert.equal(item.status, 'needs_context');
  assert.equal(item.excerpt, '');

  const described = await request(`/cases/${id}/items/${itemId}/describe`, 'POST', { text: 'A receipt from the landlord.' });
  assert.equal(described.status, 200);
  assert.equal((await request(`/cases/${id}/items/${itemId}/describe`, 'POST', { text: 'Again' })).status, 409);
});

test('coverage reports what the analysis left out rather than implying it read everything', async () => {
  const id = await openCase();
  const mine = await addStatement(id, 'My account', 'I paid Rs 4,500 rent on 2026-09-05.');
  await addStatement(id, 'Their account', 'They say nothing was received.', 'theirs');
  const unread = await addBlankFile(id, 'receipt.txt');

  responder = (_url, body) => {
    const ids = idsInPrompt(body);
    assert.equal(ids.length, 2, 'a piece waiting on a description must not be sent as though it were read');
    return verdictCiting([mine]);
  };
  const analyzed = await request(`/cases/${id}/analyze`, 'POST');
  assert.equal(analyzed.status, 200);

  const coverage = analyzed.body.analysis!.coverage;
  assert.equal(coverage.complete, false);
  assert.equal(coverage.itemsInCase, 3);
  assert.equal(coverage.itemsAnalysed, 2);
  assert.deepEqual(coverage.omitted, ['Bank screenshot']);
  assert.deepEqual(coverage.notWeighed, ['Their account']);
  assert.match(coverage.note ?? '', /Bank screenshot/);
  assert.match(coverage.note ?? '', /Their account/);

  const report = await request(`/cases/${id}/report`);
  assert.equal(report.body.report.coverage?.note, coverage.note);
  assert.match(report.body.report.text, /What this analysis covers/);

  await request(`/cases/${id}/items/${unread}/describe`, 'POST', { text: 'A landlord receipt for Rs 4,500.' });
  responder = (_url, body) => verdictCiting(idsInPrompt(body));
  const again = await request(`/cases/${id}/analyze`, 'POST');
  const second = again.body.analysis!.coverage;
  assert.equal(second.complete, true);
  assert.equal(second.note, null);
  assert.equal(second.itemsInCase, 3);
  assert.equal(second.itemsAnalysed, 3);
  assert.deepEqual(second.notWeighed, []);
});

test('no case response names the vendor or the model, and the row still records both', async () => {
  const id = await openCase();
  const mine = await addStatement(id, 'My account', 'I paid Rs 4,500 rent on 2026-09-05.');
  responder = () => verdictCiting([mine]);

  const analyzed = await request(`/cases/${id}/analyze`, 'POST');
  const detail = await request(`/cases/${id}`);
  const report = await request(`/cases/${id}/report`);

  for (const [name, payload] of [
    ['analyze', analyzed.body.analysis],
    ['case detail', detail.body.case.analysis],
    ['report', report.body.report],
  ] as const) {
    assert.ok(payload, `${name} returned nothing to check`);
    assert.equal('provider' in payload, false, `${name} must not send the provider`);
    assert.equal('model' in payload, false, `${name} must not send the model`);
  }
  assert.ok(!/groq|llama|provider|model/i.test(report.body.report.text), 'the exported report must not name the vendor');

  const row = db.prepare('SELECT provider, model FROM analyses WHERE id = ?').get(analyzed.body.analysis!.id) as
    { provider: string | null; model: string | null };
  assert.ok(row.provider);
  assert.ok(row.model);
});

test('reading a stored file re-checks who owns it', async () => {
  const stored = storeUpload('owner-a', new TextEncoder().encode('Paid Rs 4,500.'), 'text/plain', 'receipt.txt');
  const file = fileById(stored.id, 'owner-a')!;

  assert.equal((await readSource(file, 'owner-a')).text.trim(), 'Paid Rs 4,500.');
  await assert.rejects(() => readSource(file, 'owner-b'), /does not exist/);
});

test('a piece can be renamed and moved to the other side without being read again', async () => {
  const id = await openCase();
  const itemId = await addStatement(id, 'Their refusal', 'They say nothing was received.');

  const renamed = await request(`/cases/${id}/items/${itemId}`, 'PATCH', { label: 'What they told me' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.item.label, 'What they told me');
  assert.equal(renamed.body.item.side, 'mine');

  const moved = await request(`/cases/${id}/items/${itemId}`, 'PATCH', { side: 'theirs' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.item.side, 'theirs');
  assert.equal(moved.body.item.label, 'What they told me', 'a side change must not disturb the name');

  assert.equal(moved.body.item.excerpt, 'They say nothing was received.');
  assert.equal(moved.body.item.readBy, 'typed');

  const nothing = await request(`/cases/${id}/items/${itemId}`, 'PATCH', {});
  assert.equal(nothing.status, 400);
  assert.match(nothing.body.error, /short name|whose side/i);
  assert.equal((await request(`/cases/${id}/items/${itemId}`, 'PATCH', { side: 'elsewhere' })).status, 400);
  assert.equal((await request(`/cases/${id}/items/item_nothing`, 'PATCH', { label: 'x' })).status, 404);
  assert.equal((await request(`/cases/${id}/items/${itemId}`, 'PATCH', { label: 'x' }, 'owner-b')).status, 404);
});

test('moving a piece to the other side throws away a comparison built on the old arrangement', async () => {
  const id = await openCase();
  const mine = await addStatement(id, 'My account', 'I paid Rs 4,500 rent on 2026-09-05.');
  responder = () => verdictCiting([mine]);
  assert.equal((await request(`/cases/${id}/analyze`, 'POST')).status, 200);

  const renamed = await request(`/cases/${id}/items/${mine}`, 'PATCH', { label: 'My bank app' });
  assert.equal(renamed.body.analysisCleared, false);
  let detail = await request(`/cases/${id}`);
  assert.equal(detail.body.case.hasAnalysis, true);
  assert.equal(detail.body.case.analysisStale, true);

  const moved = await request(`/cases/${id}/items/${mine}`, 'PATCH', { side: 'theirs' });
  assert.equal(moved.body.analysisCleared, true);
  detail = await request(`/cases/${id}`);
  assert.equal(detail.body.case.hasAnalysis, false);
  assert.equal(detail.body.case.analysisStale, false, 'a cleared case is not compared yet, not out of date');
  assert.equal(detail.body.case.analysis, null);
  assert.equal(countOf('SELECT COUNT(*) AS n FROM analyses'), 0);
  assert.equal(detail.body.case.items.length, 1, 'the evidence itself survives');
});

test('a comparison can be thrown away deliberately, and clearing nothing is not an error', async () => {
  const id = await openCase();
  const mine = await addStatement(id, 'My account', 'I paid Rs 4,500 rent on 2026-09-05.');
  responder = () => verdictCiting([mine]);
  await request(`/cases/${id}/analyze`, 'POST');

  const cleared = await request(`/cases/${id}/analysis`, 'DELETE');
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, true);
  assert.equal(cleared.body.case.hasAnalysis, false);
  assert.equal(cleared.body.case.analysis, null);
  assert.equal(cleared.body.case.items.length, 1, 'clearing a comparison must not touch the evidence');

  const again = await request(`/cases/${id}/analysis`, 'DELETE');
  assert.equal(again.status, 200);
  assert.equal(again.body.cleared, false);
  assert.equal((await request(`/cases/${id}/analysis`, 'DELETE', undefined, 'owner-b')).status, 404);

  responder = () => verdictCiting([mine]);
  assert.equal((await request(`/cases/${id}/analyze`, 'POST')).status, 200);
});

test('two taps on "use this as evidence" open one case, not two', async () => {
  const recordId = addRecord();
  const [first, second] = await Promise.all([
    request(`/cases/from-record/${recordId}`, 'POST'),
    request(`/cases/from-record/${recordId}`, 'POST'),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(first.body.case.id, second.body.case.id, 'the second tap must open the case the first one made');
  assert.equal(countOf('SELECT COUNT(*) AS n FROM cases'), 1);
  assert.equal(countOf('SELECT COUNT(*) AS n FROM case_items'), 1, 'the losing tap must leave no half-built case');

  const opened = [first, second].find((response) => response.status === 200)!;
  assert.equal(opened.body.existing, true);

  assert.throws(
    () => db.prepare(
      `INSERT INTO cases (id, user_id, title, question, status, my_claim, their_claim, source_record_id, created_at, updated_at)
       VALUES ('case_duplicate', 'owner-a', 'September rent', '', 'open', '', '', ?, 1, 1)`,
    ).run(recordId),
    /UNIQUE/,
  );
});

const LONG_FILE_TEXT = 'The landlord refused to give a receipt. '.repeat(400);
const LONG_STATEMENT = 'They told me on the phone that nothing had arrived. '.repeat(120);

test('every place that shortens something says so, including the cut nothing can undo', async () => {
  const id = await openCase();

  const upload = new FormData();
  upload.set('file', new File([LONG_FILE_TEXT], 'letter.txt', { type: 'text/plain' }));
  upload.set('side', 'mine');
  upload.set('label', 'Landlord letter');
  const added = await request(`/cases/${id}/items`, 'POST', upload);
  assert.equal(added.status, 202);
  await eventually(jobFinished);
  const fileItem = added.body.item.id;

  await addStatement(id, 'My account', LONG_STATEMENT);

  const detail = await request(`/cases/${id}`);
  const stored = detail.body.case.items.find((item) => item.id === fileItem)!;
  assert.equal(stored.fileHadMoreText, true, 'a file cut at store time must say so on the piece itself');
  assert.equal(stored.hasMoreText, true);
  const typed = detail.body.case.items.find((item) => item.id !== fileItem)!;
  assert.equal(typed.fileHadMoreText, false, 'a statement that was saved whole must not claim it was cut');

  let prompt = '';
  responder = (_url, body) => {
    prompt = promptOf(body);
    return verdictCiting(idsInPrompt(body));
  };
  const analyzed = await request(`/cases/${id}/analyze`, 'POST');
  assert.equal(analyzed.status, 200);
  assert.match(prompt, /the file held more text than could be saved/);
  assert.match(prompt, /only the first part of the saved text is given below/);

  const coverage = analyzed.body.analysis!.coverage;
  assert.deepEqual(coverage.partlySaved, ['Landlord letter']);
  assert.deepEqual(coverage.shortened, ['My account']);
  assert.equal(coverage.complete, false);
  assert.match(coverage.note ?? '', /Landlord letter held more text than could be saved/);
  assert.match(coverage.note ?? '', /Only the first part of My account/);

  const report = await request(`/cases/${id}/report`);
  assert.match(report.body.report.text, /Only part of this file could be saved/);
  assert.equal(report.body.report.coverage?.note, coverage.note);
});

test('a piece holding more figures than are kept says so wherever it is shown', async () => {
  const id = await openCase();
  const bill = Array.from({ length: 15 }, (_, index) => `Line ${index + 1}: Rs ${201 + index}`).join('\n');
  const itemId = await addStatement(id, 'The bill', bill);

  const item = (await request(`/cases/${id}`)).body.case.items.find((row) => row.id === itemId)!;
  assert.equal(item.facts.amounts.length, 12);
  assert.deepEqual(item.facts.partial, ['amounts']);

  const report = await request(`/cases/${id}/report`);
  assert.match(report.body.report.text, /holds more amounts than are listed here/);

  let prompt = '';
  responder = (_url, body) => {
    prompt = promptOf(body);
    return verdictCiting([itemId]);
  };
  assert.equal((await request(`/cases/${id}/analyze`, 'POST')).status, 200);
  assert.match(prompt, /more amounts appear in this piece than are listed above/);
});

test('a point with nothing behind it is refused, after exactly one chance to cite it', async () => {
  const id = await openCase();
  await request(`/cases/${id}`, 'PATCH', { myClaim: 'I paid the rent in cash.' });
  const mine = await addStatement(id, 'My account', 'I paid Rs 4,500 rent on 2026-09-05.');

  let calls = 0;
  responder = () => {
    calls += 1;
    return verdictCiting([mine], { supported: [{ point: 'The rent was paid.', sources: [] }] });
  };
  const refused = await request(`/cases/${id}/analyze`, 'POST');
  assert.equal(refused.status, 502);
  assert.equal(calls, 2, 'one repair attempt, then the answer is refused rather than shown uncited');
  assert.ok(!/zod|schema|invalid_|issues/i.test(refused.body.error), 'validator output must not reach a person');
  assert.equal(countOf('SELECT COUNT(*) AS n FROM analyses'), 0, 'an ungrounded comparison is not stored');

  responder = () => verdictCiting([mine], {
    supported: [{ point: 'The rent was paid.', sources: ['piece 1'] }],
    notSupported: [{ point: 'Nothing here shows the money reaching their account.', sources: ['yours'] }],
  });
  const accepted = await request(`/cases/${id}/analyze`, 'POST');
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.analysis!.verdict.supported, [{ point: 'The rent was paid.', sources: [mine] }]);
  assert.deepEqual(accepted.body.analysis!.verdict.notSupported[0]?.sources, ['yours']);
});

test('a figure that appears nowhere in the material fails the comparison', async () => {
  const id = await openCase();
  const mine = await addStatement(id, 'My account', 'I paid Rs 4,500 rent on 2026-09-05.');

  responder = () => verdictCiting([mine], {
    notSupported: [{ point: 'The arrears come to Rs 98,765 in total.', sources: [mine] }],
  });
  assert.equal((await request(`/cases/${id}/analyze`, 'POST')).status, 502);
  assert.equal(countOf('SELECT COUNT(*) AS n FROM analyses'), 0);

  responder = () => verdictCiting([mine], {
    notSupported: [{ point: 'Nothing shows the Rs 4,500 reaching their account.', sources: [mine] }],
  });
  assert.equal((await request(`/cases/${id}/analyze`, 'POST')).status, 200);
});

test('what both sides agree on is not filed under what does not line up', async () => {
  const id = await openCase();
  await addStatement(id, 'My receipt', 'UTR: 462318905577 Total Rs 900 paid on 10/09/2026.');
  await addStatement(id, 'Their email', 'UTR: 462318905577 Amount due Rs 900 unpaid.', 'theirs');

  const text = (await request(`/cases/${id}/report`)).body.report.text;
  const agreed = text.indexOf('WHAT BOTH SIDES AGREE ON');
  const disagreed = text.indexOf('WHAT DOES NOT LINE UP');
  assert.ok(agreed > 0, 'a shared reference number is the strongest thing here and needs its own heading');
  assert.ok(disagreed > agreed, 'what they agree on comes before what they do not');
  const agreement = text.slice(agreed, disagreed);
  assert.match(agreement, /Both sides name the same reference 462318905577/);
  assert.ok(!agreement.includes('do not line up'));
  assert.match(text.slice(disagreed), /paid|unpaid/);
});

test('the report is a document somebody else can read, not a row from a database', async () => {
  const id = await openCase();
  await request(`/cases/${id}`, 'PATCH', {
    myClaim: 'I paid Rs 4,500 in cash on 5 September.',
    theirClaim: 'They say no money ever arrived.',
  });
  const mine = await addStatement(id, 'Receipt photo', 'Received Rs 4,500 towards September rent.');
  const theirs = await addStatement(id, 'What they wrote', 'Nothing was received for September.', 'theirs');
  await addBlankFile(id, 'blurred.txt');

  responder = () => verdictCiting([mine, theirs], {
    conflicts: [{
      point: 'Whether the September rent reached them',
      about: 'status',
      yourSide: 'Your receipt records the rent as received.',
      yourValue: 'Received Rs 4,500',
      yourSources: ['piece 1', 'yours'],
      theirSide: 'They say nothing arrived.',
      theirValue: 'Nothing was received',
      theirSources: ['piece 2'],
      reading: 'A receipt written at the time carries more weight than a denial given later.',
    }],
    supported: [{ point: 'A receipt records Rs 4,500 against September rent.', sources: ['piece 1'] }],
    notSupported: [{ point: 'Nothing here shows the money reaching their bank account.', sources: ['piece 1'] }],
    missing: [{ point: 'A bank line for 5 September.', wouldShow: 'It would show the money leaving your account.' }],
  });
  assert.equal((await request(`/cases/${id}/analyze`, 'POST')).status, 200);

  const text = (await request(`/cases/${id}/report`)).body.report.text;
  for (const heading of [
    'WHAT EACH SIDE SAYS',
    'THE MATERIAL',
    'WHAT DOES NOT LINE UP',
    'WHAT THE MATERIAL SUPPORTS',
    'WHAT THE MATERIAL DOES NOT SUPPORT',
    'WHAT IS MISSING',
    'HOW EACH PIECE WAS WEIGHED',
    'WHICH ACCOUNT THE MATERIAL BETTER SUPPORTS',
  ]) {
    assert.ok(text.includes(heading), `the report must contain ${heading}`);
  }
  assert.match(text, /^Prepared /m);
  assert.match(text, /Your account: I paid Rs 4,500 in cash/);
  assert.match(text, /Their account: They say no money ever arrived/);
  assert.match(text, /Your material says: Received Rs 4,500/);
  assert.match(text, /Their material says: Nothing was received/);

  assert.match(text, /From: Receipt photo; Your own account/);
  assert.match(text, /Having it would show: It would show the money leaving/);
  assert.match(text, /What to do next: Ask the landlord/);
  assert.match(text, /not legal advice/);

  assert.ok(!text.includes('WHAT BOTH SIDES AGREE ON'));

  assert.ok(!/\b(item|case|file|analysis|job|rec)_[0-9a-f]{6,}/.test(text), 'the report must never print an id');
  for (const token of [
    'needs_context', 'not_enough_evidence', 'your_account_is_better_supported', 'what_happened',
    'moderate', 'medium', 'confidence:', 'groq', 'gemini', 'llama', 'extraction', 'pipeline',
  ]) {
    assert.ok(!text.toLowerCase().includes(token), `the report must not contain "${token}"`);
  }
});
