import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Account } from '../auth.ts';

const directory = mkdtempSync(join(tmpdir(), 'detact-account-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';
const { db, ensureUser } = await import('../db.ts');
const { account, DELETE_CONFIRMATION } = await import('./account.ts');
const { storeUpload } = await import('../files.ts');

const app = new Hono<{ Variables: { account: Account } }>();
app.use('*', async (context, next) => {
  const id = context.req.header('x-test-owner') ?? 'owner-a';
  ensureUser(id, `${id}@example.com`, id === 'owner-a' ? 'Priya Sharma' : 'Someone Else');
  context.set('account', { id, email: `${id}@example.com`, name: null });
  await next();
});
app.route('/me', account);
app.onError((error, context) =>
  context.json({ error: error.message }, error instanceof HTTPException ? error.status : 500),
);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  assert.fail(`This test did not authorize a network call: ${String(input)}`);
}) as typeof globalThis.fetch;

beforeEach(() => {
  db.exec(
    `DELETE FROM jobs; DELETE FROM signals; DELETE FROM signal_scans; DELETE FROM analyses;
     DELETE FROM case_items; DELETE FROM cases; DELETE FROM questions; DELETE FROM tasks;
     DELETE FROM records; DELETE FROM meetings; DELETE FROM budgets; DELETE FROM files;
     DELETE FROM users;`,
  );
});

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-account-'));
  rmSync(target, { recursive: true, force: true });
});

type Stored = {
  entries: number;
  meetings: number;
  tasks: number;
  cases: number;
  files: number;
  bytes: number;
  sizeLabel: string;
};

type TestResponse = {
  id: string;
  email: string | null;
  name: string | null;
  displayName: string | null;
  currency: string | null;
  locale: string | null;
  createdAt: number;
  stored: Stored;
  note: string | null;
  deleted: boolean;
  removed: {
    entries: number;
    meetings: number;
    tasks: number;
    cases: number;
    evidencePieces: number;
    budgets: number;
    noticed: number;
    files: number;
  };
  message: string;
  error: string;
};

async function request(path: string, method = 'GET', body?: unknown, owner = 'owner-a') {
  const response = await app.request(path, {
    method,
    headers: { 'x-test-owner': owner, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as TestResponse };
}

async function download(owner = 'owner-a') {
  const response = await app.request('/me/export', { method: 'GET', headers: { 'x-test-owner': owner } });
  const raw = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    disposition: response.headers.get('content-disposition'),
    raw,
    document: JSON.parse(raw) as Record<string, any>,
  };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function signedIn(owner: string): void {
  ensureUser(owner, `${owner}@example.com`, owner === 'owner-a' ? 'Priya Sharma' : 'Someone Else');
}

const OWNED_TABLES = [
  'records',
  'meetings',
  'tasks',
  'cases',
  'case_items',
  'analyses',
  'budgets',
  'signals',
  'signal_scans',
  'jobs',
  'files',
] as const;

function rowCount(table: string, owner: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(owner) as { n: number }).n;
}

function questionCount(owner: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM questions WHERE record_id IN (SELECT id FROM records WHERE user_id = ?)')
      .get(owner) as { n: number }
  ).n;
}

function storedPaths(owner: string): string[] {
  return (db.prepare('SELECT stored_path FROM files WHERE user_id = ?').all(owner) as Array<{ stored_path: string }>)
    .map((row) => row.stored_path);
}

function seedEverything(owner: string) {
  signedIn(owner);
  const at = new Date(2026, 8, 26).getTime();
  const picture = storeUpload(owner, bytesOf(`screenshot bytes for ${owner} ${'.'.repeat(600)}`), 'text/plain', `screenshot-${owner}.txt`);
  const audio = storeUpload(owner, bytesOf(`audio bytes for ${owner} ${'.'.repeat(300)}`), 'audio/wav', `meeting-${owner}.wav`);

  const ids = {
    entryWithFile: `rec-paid-${owner}`,
    entryInDollars: `rec-dollars-${owner}`,
    meeting: `meet-${owner}`,
    taskFromMeeting: `task-meeting-${owner}`,
    taskTyped: `task-typed-${owner}`,
    openCase: `case-${owner}`,
    evidenceTyped: `item-typed-${owner}`,
    evidenceFile: `item-file-${owner}`,
    reading: `an-${owner}`,
    budget: `bud-${owner}`,
    noticed: `sig-${owner}`,
    job: `job-${owner}`,
    picture: picture.id,
    audio: audio.id,
  };

  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, occurred_precision, amount_minor, currency,
       direction, counterparty, category, note, file_id, extraction, status, created_at, updated_at)
     VALUES (?, ?, 'payment', ?, ?, 'month', 249900, 'INR', 'out', 'Sharma Electricals', 'Bills', ?, ?, ?, 'complete', ?, ?)`,
  ).run(
    ids.entryWithFile,
    owner,
    `Paid Sharma Electricals (${owner})`,
    at,
    'Paid in two parts',
    ids.picture,
    JSON.stringify({
      readBy: 'vision',
      readNote: 'Read from the picture.',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      summary: 'Paid Rs 2,499.00 to Sharma Electricals.',
      reference: 'UPI-55112200',
      sourceText: `Receipt text for ${owner}: Rs 2,499.00 paid.`,
    }),
    at,
    at,
  );

  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction,
       extraction, status, created_at, updated_at)
     VALUES (?, ?, 'purchase', ?, ?, 7000, 'USD', 'out', '{}', 'needs_context', ?, ?)`,
  ).run(ids.entryInDollars, owner, `Bought a book (${owner})`, at, at, at);

  db.prepare(
    `INSERT INTO questions (id, record_id, field, prompt, options, answer, answered_at, created_at)
     VALUES (?, ?, 'purpose', ?, '[]', 'Wiring work', ?, ?)`,
  ).run(`q-answered-${owner}`, ids.entryWithFile, `What was this payment for, ${owner}?`, at, at);

  db.prepare(
    `INSERT INTO questions (id, record_id, field, prompt, options, created_at)
     VALUES (?, ?, 'category', ?, '[]', ?)`,
  ).run(`q-open-${owner}`, ids.entryInDollars, `Which category is this book, ${owner}?`, at);

  db.prepare(
    `INSERT INTO meetings (id, user_id, title, note, file_id, language, duration_ms, transcript, summary,
       status, intelligence, started_at, started_at_estimated, ended_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'English', 600000, ?, ?, 'complete', ?, ?, 1, ?, ?, ?)`,
  ).run(
    ids.meeting,
    owner,
    `Call with the landlord (${owner})`,
    'About the deposit',
    ids.audio,
    `Transcript for ${owner}: the deposit will be returned.`,
    `Summary for ${owner}.`,
    JSON.stringify({ topics: ['Deposit'], keyPoints: ['The deposit is returnable'], decisions: [], provider: 'groq' }),
    at,
    at + 600000,
    at,
    at,
  );

  db.prepare(
    `INSERT INTO tasks (id, user_id, text, owner_name, due_at, done_at, meeting_id, record_id, priority, created_at)
     VALUES (?, ?, ?, 'Priya', ?, NULL, ?, NULL, 'high', ?)`,
  ).run(ids.taskFromMeeting, owner, `Send the receipt (${owner})`, at, ids.meeting, at);

  db.prepare(
    `INSERT INTO tasks (id, user_id, text, due_at, done_at, priority, created_at)
     VALUES (?, ?, ?, NULL, ?, 'normal', ?)`,
  ).run(ids.taskTyped, owner, `Call the shop (${owner})`, at, at);

  db.prepare(
    `INSERT INTO cases (id, user_id, title, question, status, my_claim, their_claim, source_record_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).run(
    ids.openCase,
    owner,
    `Deposit dispute (${owner})`,
    'Was the deposit returned?',
    `My account for ${owner}.`,
    `Their account for ${owner}.`,
    ids.entryWithFile,
    at,
    at,
  );

  db.prepare(
    `INSERT INTO case_items (id, case_id, user_id, side, label, text, file_id, extraction, status, kind, created_at)
     VALUES (?, ?, ?, 'mine', ?, ?, NULL, '{}', 'ready', 'statement', ?)`,
  ).run(ids.evidenceTyped, ids.openCase, owner, `My statement (${owner})`, `I paid the deposit, ${owner}.`, at);

  db.prepare(
    `INSERT INTO case_items (id, case_id, user_id, side, label, text, file_id, extraction, status, kind, created_at)
     VALUES (?, ?, ?, 'theirs', ?, '', ?, ?, 'needs_context', 'document', ?)`,
  ).run(
    ids.evidenceFile,
    ids.openCase,
    owner,
    `Their letter (${owner})`,
    ids.picture,
    JSON.stringify({ readBy: 'ocr', provider: 'groq', sourceText: `Letter text for ${owner}.` }),
    at,
  );

  db.prepare(
    `INSERT INTO analyses (id, case_id, user_id, result, provider, model, input_digest, created_at)
     VALUES (?, ?, ?, ?, 'groq', 'openai/gpt-oss-120b', 'digest', ?)`,
  ).run(
    ids.reading,
    ids.openCase,
    owner,
    JSON.stringify({ headline: `The deposit was paid (${owner}).`, confidence: 'medium', evidence: [] }),
    at,
  );

  db.prepare(
    `INSERT INTO budgets (id, user_id, period, amount_minor, currency, created_at, updated_at)
     VALUES (?, ?, 'monthly', 3000000, 'INR', ?, ?)`,
  ).run(ids.budget, owner, at, at);

  db.prepare(
    `INSERT INTO signals (id, user_id, kind, rule, title, detail, quote, due_at, amount_minor, currency,
       sources, status, fingerprint, created_at, updated_at)
     VALUES (?, ?, 'anomaly', 'duplicate_charge', ?, ?, ?, ?, 249900, 'INR', ?, 'open', ?, ?, ?)`,
  ).run(
    ids.noticed,
    owner,
    `Paid twice (${owner})`,
    'The same amount went to the same shop twice.',
    `Quote for ${owner}.`,
    at,
    JSON.stringify([{ kind: 'record', id: ids.entryWithFile }]),
    `fingerprint-${owner}`,
    at,
    at,
  );

  db.prepare(
    `INSERT INTO jobs (id, user_id, kind, subject_id, status, detail, attempts, created_at, updated_at)
     VALUES (?, ?, 'extract', ?, 'failed', ?, 1, ?, ?)`,
  ).run(
    ids.job,
    owner,
    ids.entryWithFile,
    '429 rate_limit_exceeded for model openai/gpt-oss-120b in org org_01HZ',
    at,
    at,
  );

  db.prepare('INSERT INTO signal_scans (user_id, subject_id, scanned_at) VALUES (?, ?, ?)').run(
    owner,
    ids.entryWithFile,
    at,
  );

  return { ids, bytes: picture.bytes + audio.bytes, paths: storedPaths(owner) };
}

test('the profile says who you are and what is stored, and nothing about sign-ins or devices', async () => {
  const seeded = seedEverything('owner-a');

  const response = await request('/me');
  assert.equal(response.status, 200);
  const me = response.body;

  assert.equal(me.id, 'owner-a');
  assert.equal(me.email, 'owner-a@example.com');
  assert.equal(me.name, 'Priya Sharma');

  assert.equal(me.displayName, null);
  assert.equal(me.currency, null);
  assert.equal(me.locale, null);
  assert.equal(
    me.createdAt,
    (db.prepare('SELECT created_at AS at FROM users WHERE id = ?').get('owner-a') as { at: number }).at,
  );

  assert.deepEqual(me.stored, {
    entries: 2,
    meetings: 1,
    tasks: 2,
    cases: 1,
    files: 2,
    bytes: seeded.bytes,
    sizeLabel: me.stored.sizeLabel,
  });
  assert.equal(
    me.stored.bytes,
    (db.prepare('SELECT SUM(bytes) AS n FROM files WHERE user_id = ?').get('owner-a') as { n: number }).n,
  );

  assert.deepEqual(Object.keys(me).sort(), [
    'createdAt',
    'currency',
    'displayName',
    'email',
    'id',
    'locale',
    'name',
    'stored',
  ]);
  const printed = JSON.stringify(me).toLowerCase();
  for (const forbidden of [
    'google.com',
    'password',
    'firebase',
    'provider',
    'token',
    'uid',
    'devicename',
    'deviceid',
    'platform',
    'osversion',
    'appversion',
    'apikey',
  ]) {
    assert.ok(!printed.includes(forbidden), `the profile leaked "${forbidden}": ${printed}`);
  }
});

test('the storage figure is the real bytes stored, counting shared bytes once and nobody else at all', async () => {
  const first = bytesOf('a'.repeat(1500));
  const second = bytesOf('b'.repeat(2500));
  signedIn('owner-a');
  signedIn('owner-b');

  storeUpload('owner-a', first, 'text/plain', 'receipt.txt');

  storeUpload('owner-a', first, 'text/plain', 'receipt-copy.txt');
  storeUpload('owner-a', second, 'text/plain', 'bill.txt');
  storeUpload('owner-b', bytesOf('c'.repeat(9999)), 'text/plain', 'theirs.txt');

  const me = (await request('/me')).body;
  assert.equal(me.stored.files, 2);
  assert.equal(me.stored.bytes, 4000);

  assert.equal(me.stored.sizeLabel, '3.9 KB');
});

test('a display name can be set, corrected and cleared, and clearing brings the sign-in name back', async () => {
  const set = await request('/me', 'PATCH', { displayName: '  Priya   S.  ' });
  assert.equal(set.status, 200);
  assert.equal(set.body.displayName, 'Priya S.');
  assert.equal(set.body.name, 'Priya S.');
  assert.equal(set.body.note, null);

  const corrected = await request('/me', 'PATCH', { displayName: 'Priya Sharma-Rao' });
  assert.equal(corrected.body.displayName, 'Priya Sharma-Rao');

  const cleared = await request('/me', 'PATCH', { displayName: '   ' });
  assert.equal(cleared.body.displayName, null);
  assert.equal(cleared.body.name, 'Priya Sharma', 'clearing your own name must fall back to the one the sign-in gave');

  await request('/me', 'PATCH', { displayName: 'Priya' });
  assert.equal((await request('/me', 'PATCH', { displayName: null })).body.displayName, null);

  const tooLong = await request('/me', 'PATCH', { displayName: 'x'.repeat(81) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /too long/i);
  assert.ok(!/[{}[\]]|invalid_|expected|zod/i.test(tooLong.body.error), tooLong.body.error);
  assert.equal((await request('/me')).body.displayName, null, 'a refused change must not have been written');

  const nothing = await request('/me', 'PATCH', {});
  assert.equal(nothing.status, 400);
  assert.equal(nothing.body.error, 'There was nothing to change.');
});

test('an unrecognised currency or language is refused in a sentence, never a schema dump', async () => {
  await request('/me', 'PATCH', { currency: 'INR' });

  for (const typed of ['XYZ', 'bananas', '123']) {
    const refused = await request('/me', 'PATCH', { currency: typed });
    assert.equal(refused.status, 400, `"${typed}" was accepted as a currency`);
    assert.match(refused.body.error, /currency/i);
    assert.ok(
      !/[{}[\]"]|invalid_|expected|received|zod|undefined/i.test(refused.body.error),
      refused.body.error,
    );
  }
  // Refusing has to leave the setting alone, not blank it.
  assert.equal((await request('/me')).body.currency, 'INR');

  // Wrong type rather than wrong value: still a sentence.
  const wrongType = await request('/me', 'PATCH', { currency: 42 });
  assert.equal(wrongType.status, 400);
  assert.ok(!/[{}[\]"]|invalid_|expected|zod/i.test(wrongType.body.error), wrongType.body.error);

  assert.equal((await request('/me', 'PATCH', { currency: 'jpy' })).body.currency, 'JPY');
  assert.equal((await request('/me', 'PATCH', { currency: '₹' })).body.currency, 'INR');
  assert.equal((await request('/me', 'PATCH', { currency: 'rupees' })).body.currency, 'INR');
  assert.equal((await request('/me', 'PATCH', { currency: null })).body.currency, null);

  const badLocale = await request('/me', 'PATCH', { locale: 'not a language!!' });
  assert.equal(badLocale.status, 400);
  assert.match(badLocale.body.error, /language/i);
  assert.ok(!/[{}[\]"]|invalid_|expected|zod/i.test(badLocale.body.error), badLocale.body.error);

  assert.equal((await request('/me', 'PATCH', { locale: 'hi-in' })).body.locale, 'hi-IN');
  assert.equal((await request('/me', 'PATCH', { locale: null })).body.locale, null);
});

test('changing the currency relabels nothing and converts nothing', async () => {
  const seeded = seedEverything('owner-a');
  const before = db.prepare('SELECT id, amount_minor, currency FROM records WHERE user_id = ? ORDER BY id').all('owner-a');
  const budgetBefore = db.prepare('SELECT amount_minor, currency FROM budgets WHERE user_id = ?').get('owner-a');
  const signalBefore = db.prepare('SELECT amount_minor, currency FROM signals WHERE user_id = ?').get('owner-a');

  const changed = await request('/me', 'PATCH', { currency: 'USD' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.currency, 'USD');
  assert.match(changed.body.note ?? '', /nothing is converted/i);
  assert.match(changed.body.note ?? '', /keeps the currency/i);

  // Every amount already recorded is untouched, down to the row.
  assert.deepEqual(
    db.prepare('SELECT id, amount_minor, currency FROM records WHERE user_id = ? ORDER BY id').all('owner-a'),
    before,
  );
  assert.deepEqual(db.prepare('SELECT amount_minor, currency FROM budgets WHERE user_id = ?').get('owner-a'), budgetBefore);
  assert.deepEqual(db.prepare('SELECT amount_minor, currency FROM signals WHERE user_id = ?').get('owner-a'), signalBefore);

  // And the export still states each entry in the currency it was recorded in.
  const exported = await download();
  const paid = exported.document.entries.find((entry: any) => entry.id === seeded.ids.entryWithFile);
  const book = exported.document.entries.find((entry: any) => entry.id === seeded.ids.entryInDollars);
  assert.equal(paid.amount.minorUnits, 249900);
  assert.equal(paid.amount.currency, 'INR');
  assert.match(paid.amount.label, /2,499\.00/);
  assert.equal(book.amount.currency, 'USD');
  assert.equal(book.amount.minorUnits, 7000);

  // Setting the same currency again says nothing new, because nothing changed.
  assert.equal((await request('/me', 'PATCH', { currency: 'USD' })).body.note, null);
});

// --- taking it out --------------------------------------------------------------

test('the export is a download that holds every row of yours, and not one of anybody else', async () => {
  const mine = seedEverything('owner-a');
  const theirs = seedEverything('owner-b');

  const exported = await download('owner-a');
  assert.equal(exported.status, 200);
  assert.equal(exported.contentType, 'application/json; charset=utf-8');
  assert.match(exported.disposition ?? '', /^attachment; filename="d-detect-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(exported.document.downloadName, (exported.disposition ?? '').replace(/^.*filename="|"$/g, ''));

  // Every single thing of theirs is in there.
  const { job, ...theirOwnThings } = mine.ids;
  for (const [name, id] of Object.entries(theirOwnThings)) {
    assert.ok(exported.raw.includes(id), `the export left out the ${name}`);
  }
  assert.ok(exported.raw.includes('What was this payment for, owner-a?'), 'the question asked is part of the record');
  assert.ok(exported.raw.includes('Wiring work'), 'the answer the person gave is theirs');
  assert.ok(exported.raw.includes('Which category is this book, owner-a?'), 'an unanswered question is still theirs');

  /**
   * The two things deliberately left out are the server's own bookkeeping, not the
   * person's records: a work-queue row saying it tried to read an entry and failed, and a
   * marker saying it has already looked at one. Neither says anything about this person's
   * life that the entry itself does not, and the queue row's detail is the vendor's own
   * error text. The delete still removes both, which the delete test holds.
   */
  assert.ok(!exported.raw.includes(job), 'the export carried a work-queue row');
  assert.ok(!exported.raw.includes('rate_limit_exceeded'), 'the export carried an internal failure message');

  // And nothing of anybody else's, by id or by content.
  for (const [name, id] of Object.entries(theirs.ids)) {
    assert.ok(!exported.raw.includes(id), `the export carried another account's ${name}`);
  }
  assert.ok(!exported.raw.includes('owner-b'), 'another account appeared in this export');

  assert.deepEqual(exported.document.totals, {
    entries: 2,
    meetings: 1,
    tasks: 2,
    cases: 1,
    evidencePieces: 2,
    budgets: 1,
    noticed: 1,
    storedFiles: 2,
    storedBytes: mine.bytes,
    storedSizeLabel: exported.document.totals.storedSizeLabel,
  });

  // Amounts as the database holds them: integer minor units and a code, never a float.
  for (const entry of exported.document.entries) {
    if (entry.amount === null) continue;
    assert.ok(Number.isInteger(entry.amount.minorUnits), `${entry.id} exported a fractional amount`);
    assert.match(entry.amount.currency, /^[A-Z]{3}$/);
  }
  const paid = exported.document.entries.find((entry: any) => entry.id === mine.ids.entryWithFile);
  // The precision the row recorded, not a day and an hour it never knew.
  assert.equal(paid.happenedAt, new Date(2026, 8, 26).getTime());
  assert.equal(paid.happenedAtKnown, 'To the month');
  assert.equal(paid.file, mine.ids.picture);
  assert.equal(paid.whatTheDocumentSaid, 'Receipt text for owner-a: Rs 2,499.00 paid.');

  // Times stay epoch milliseconds, so nothing is reinterpreted in some other timezone.
  assert.equal(typeof exported.document.exportedAt, 'number');
  assert.equal(exported.document.meetings[0].startedAt, new Date(2026, 8, 26).getTime());
  assert.equal(exported.document.meetings[0].startedAtWasEstimated, true);

  // It says plainly what is not in it rather than reading as though it were complete.
  assert.ok(Array.isArray(exported.document.whatIsNotHere));
  assert.match(exported.document.whatIsNotHere.join(' '), /not inside this file/i);
  assert.match(exported.document.howToReadThis.join(' '), /smallest unit/i);

  // No developer vocabulary, no stable detector id, and no vendor anywhere in it.
  //
  // The check holds for two different reasons. The entries above name a provider and a
  // model and the export picks fields out of that blob rather than spreading it; the
  // lines below name things no row holds — a stored path, a content hash, a key — and are
  // here for the case where somebody later spreads a row or an error payload into the
  // document. Either way, this is the one place a person reads every field at once, so it
  // is the one place worth scanning the whole payload for them.
  for (const forbidden of [
    'needs_context',
    'duplicate_charge',
    'groq',
    'openai/gpt-oss-120b',
    'rate_limit_exceeded',
    'org_01HZ',
    'provider',
    'model',
    'fingerprint',
    'input_digest',
    'user_id',
    'sha256',
    'stored_path',
    'gsk_',
    'xai-',
  ]) {
    assert.ok(!exported.raw.includes(forbidden), `the export printed "${forbidden}" at the person`);
  }

  // The absolute path and the digest the server stores the originals under, by value
  // rather than by column name: a person's export naming a directory on the server is a
  // map of the machine, and the hash is content they cannot check anything against.
  for (const stored of storedPaths('owner-a')) {
    assert.ok(!exported.raw.includes(stored), `the export carried the stored path ${stored}`);
  }
  assert.ok(!exported.raw.includes(directory), 'the export carried the data directory it lives in');
  const digests = db.prepare('SELECT sha256 FROM files WHERE user_id = ?').all('owner-a') as Array<{ sha256: string }>;
  for (const row of digests) {
    assert.ok(!exported.raw.includes(row.sha256), 'the export carried a file content hash');
  }
  assert.equal(
    exported.document.entries.find((entry: any) => entry.id === mine.ids.entryInDollars).state,
    'Waiting on one question',
  );
});

// --- deleting it ----------------------------------------------------------------

test('deleting an account without typing the words changes nothing', async () => {
  seedEverything('owner-a');

  // Every near miss, and every way of sending nothing, refused in the same words — a
  // person who gets this wrong has to be told what to type, not what shape to send.
  for (const body of [
    undefined,
    {},
    { confirm: true },
    { confirm: '' },
    { confirm: 'yes' },
    { confirm: 'delete' },
    { confirm: 'delete account' },
    { confirm: 'delete my acount' },
    { confirm: 'delete my account please' },
  ]) {
    const refused = await request('/me', 'DELETE', body);
    assert.equal(refused.status, 400, `"${JSON.stringify(body)}" was treated as confirmation`);
    assert.match(refused.body.error, /cannot be undone/i);
    assert.ok(refused.body.error.includes(DELETE_CONFIRMATION), refused.body.error);
    assert.ok(!/[{}[\]]|invalid_|expected|zod/i.test(refused.body.error), refused.body.error);
  }

  // And not from the query string, which the request log would keep a copy of.
  const throughTheUrl = await request(`/me?confirm=${encodeURIComponent(DELETE_CONFIRMATION)}`, 'DELETE');
  assert.equal(throughTheUrl.status, 400, 'the phrase was accepted from the query string');

  for (const table of OWNED_TABLES) {
    assert.ok(rowCount(table, 'owner-a') > 0, `${table} was emptied by a refused delete`);
  }
  assert.equal(questionCount('owner-a'), 2);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get('owner-a'));
});

test('deleting an account removes every row and every stored file, and says what went', async () => {
  const mine = seedEverything('owner-a');
  const theirs = seedEverything('owner-b');

  const deleted = await request('/me', 'DELETE', { confirm: '  Delete My Account  ' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.deepEqual(deleted.body.removed, {
    entries: 2,
    meetings: 1,
    tasks: 2,
    cases: 1,
    evidencePieces: 2,
    budgets: 1,
    noticed: 1,
    files: 2,
  });

  // Plain words and the real figures, with no leftover claim about files.
  assert.match(deleted.body.message, /Your account is deleted/);
  assert.match(deleted.body.message, /2 entries, 1 meeting, 2 tasks, 1 case, 2 pieces of evidence/);
  assert.match(deleted.body.message, /2 stored files/);
  assert.match(deleted.body.message, /cannot be undone/i);
  assert.ok(!/could not be removed/.test(deleted.body.message), deleted.body.message);

  // Not one row of theirs is left, in any table.
  for (const table of OWNED_TABLES) {
    assert.equal(rowCount(table, 'owner-a'), 0, `${table} still holds rows for the deleted account`);
  }
  assert.equal(questionCount('owner-a'), 0);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get('owner-a'), undefined);

  // Nor one byte on disk.
  for (const path of mine.paths) {
    assert.equal(existsSync(path), false, `a stored file survived the delete: ${path}`);
  }

  // The other account is untouched, rows and bytes alike.
  for (const table of OWNED_TABLES) {
    assert.ok(rowCount(table, 'owner-b') > 0, `${table} lost rows belonging to another account`);
  }
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get('owner-b'));
  for (const path of theirs.paths) {
    assert.equal(existsSync(path), true, `another account's file was deleted: ${path}`);
  }

  // Nothing was left dangling by the order the rows went in.
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  // Deleting an account with nothing in it is still honest about that.
  const again = await request('/me', 'DELETE', { confirm: DELETE_CONFIRMATION });
  assert.equal(again.status, 200);
  assert.equal(again.body.message, 'Your account is deleted. There was nothing stored in it.');
});

test('one account can never read, export or delete another account', async () => {
  const mine = seedEverything('owner-a');

  // What someone else sees of this account: nothing, and their own empty summary.
  const theirs = await request('/me', 'GET', undefined, 'owner-b');
  assert.equal(theirs.body.id, 'owner-b');
  assert.deepEqual(theirs.body.stored, {
    entries: 0,
    meetings: 0,
    tasks: 0,
    cases: 0,
    files: 0,
    bytes: 0,
    sizeLabel: '0 bytes',
  });

  const exported = await download('owner-b');
  for (const [name, id] of Object.entries(mine.ids)) {
    assert.ok(!exported.raw.includes(id), `another account exported the ${name}`);
  }
  assert.equal(exported.document.totals.storedBytes, 0);

  // Their name is their own, and changing it cannot reach anybody else's.
  await request('/me', 'PATCH', { displayName: 'Someone Else Entirely' }, 'owner-b');
  assert.equal((await request('/me')).body.displayName, null);

  // And deleting their account leaves every row and every file of this one standing.
  const removed = await request('/me', 'DELETE', { confirm: DELETE_CONFIRMATION }, 'owner-b');
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.removed, {
    entries: 0,
    meetings: 0,
    tasks: 0,
    cases: 0,
    evidencePieces: 0,
    budgets: 0,
    noticed: 0,
    files: 0,
  });
  for (const table of OWNED_TABLES) {
    assert.ok(rowCount(table, 'owner-a') > 0, `${table} lost rows when another account was deleted`);
  }
  for (const path of mine.paths) {
    assert.equal(existsSync(path), true, `another account's delete removed this one's file: ${path}`);
  }
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get('owner-a'));
});
