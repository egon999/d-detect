import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { Account } from './auth.ts';

const directory = mkdtempSync(join(tmpdir(), 'detact-tenancy-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';

const { db, ensureUser } = await import('./db.ts');
const { cases } = await import('./routes/cases.ts');
const { daybook } = await import('./routes/daybook.ts');
const { assistant } = await import('./routes/assistant.ts');
const { meetings } = await import('./routes/meetings.ts');
const { insights } = await import('./routes/insights.ts');
const { tasks } = await import('./routes/tasks.ts');
const { attention } = await import('./routes/attention.ts');
const { search } = await import('./routes/search.ts');
const { account } = await import('./routes/account.ts');
const { collectOrphanFiles, fileById, storeUpload } = await import('./files.ts');
const { accountOf, requireAccount } = await import('./auth.ts');

const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';

const app = new Hono<{ Variables: { account: Account } }>();
app.use('*', async (context, next) => {
  const id = context.req.header('x-test-owner') ?? OWNER_A;
  ensureUser(id, null, null);
  context.set('account', { id, email: null, name: null });
  await next();
});
app.route('/cases', cases);
app.route('/daybook', daybook);
app.route('/daybook', assistant);
app.route('/meetings', meetings);
app.route('/insights', insights);
app.route('/tasks', tasks);
app.route('/attention', attention);
app.route('/search', search);
app.route('/me/account', account);
app.get('/files/:id', (context) => {
  const who = accountOf(context);
  const file = fileById(context.req.param('id'), who.id);
  if (!file) throw new HTTPException(404, { message: 'That file does not exist.' });
  return context.json({ file: { id: file.id, name: file.original_name } });
});

let lastInternalError: unknown = null;

app.onError((error, context) => {
  if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
  lastInternalError = error;
  return context.json({ error: 'Something went wrong on our side. Try again.' }, 500);
});

type ProviderBody = { messages?: Array<{ role: string; content: string }> };
let responder: (url: string, body: ProviderBody) => Promise<unknown> | unknown;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input);

  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as ProviderBody) : {};
  const result = await responder(url, body);
  return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
};

function armWithAnything(): void {
  responder = (_url, body) => {
    const asked = JSON.stringify(body.messages ?? []);
    if (asked.includes('verdict')) {
      return {
        headline: 'Spending is steady this month.',
        verdict: 'on_track',
        reasons: [],
        moves: [],
        watch: [],
      };
    }
    return {};
  };
}

const SEARCH_WIPE = 'DELETE FROM records_fts; DELETE FROM meetings_fts; DELETE FROM tasks_fts; '
  + 'DELETE FROM cases_fts; DELETE FROM case_items_fts; ';

function wipe(): void {
  db.exec(
    'DELETE FROM jobs; DELETE FROM signals; DELETE FROM signal_scans; DELETE FROM analyses; '
    + 'DELETE FROM case_items; DELETE FROM cases; DELETE FROM questions; DELETE FROM meetings; '
    + 'DELETE FROM records; DELETE FROM tasks; DELETE FROM budgets; DELETE FROM files; '
    + 'DELETE FROM users; '

    + (searching ? SEARCH_WIPE : ''),
  );
}

const searching = (() => {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records_fts'`)
    .get() as { name: string } | undefined;
  return row !== undefined;
})();

beforeEach(() => {
  wipe();
  ensureUser(OWNER_A, null, null);
  ensureUser(OWNER_B, null, null);
  responder = () => {
    throw new Error('This test did not authorize a model call.');
  };
});

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-tenancy-'));
  rmSync(target, { recursive: true, force: true });
});

type Answer = { status: number; body: Record<string, unknown>; text: string };

async function request(path: string, method = 'GET', body?: unknown, owner = OWNER_A): Promise<Answer> {
  const form = body instanceof FormData;
  const response = await app.request(path, {
    method,
    headers: {
      'x-test-owner': owner,
      ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}),
    },
    body: form ? (body as FormData) : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed, text };
}

function png(): Uint8Array {

  const header = [137, 80, 78, 71, 13, 10, 26, 10];
  const bytes = new Uint8Array(64);
  bytes.set(header, 0);
  return bytes;
}

async function exported(): Promise<Record<string, any>> {
  const answer = await request('/me/account/export', 'GET', undefined, OWNER_A);
  assert.equal(answer.status, 200, 'the owner cannot read their own export');
  return JSON.parse(answer.text) as Record<string, any>;
}

type Probe = {
  what: string;
  verbs: Array<{ method: string; path: () => string; body?: () => unknown }>;
};

async function aRecord(): Promise<string> {
  const created = await request('/daybook/records', 'POST', {
    title: 'Sharma Electronics bill',
    kind: 'bill',
    amount: '2499',
    currency: 'INR',
    direction: 'out',
    counterparty: 'Sharma Electronics',

    category: 'Repairs',
    occurredAt: '2026-03-04',
  }, OWNER_A);
  assert.equal(created.status, 201, `fixture record: ${created.text}`);
  return String((created.body.record as { id: string }).id);
}

async function aCase(): Promise<string> {
  const created = await request('/cases', 'POST', { title: 'Wrong charge at Sharma Electronics' }, OWNER_A);
  assert.equal(created.status, 201, `fixture case: ${created.text}`);
  return String((created.body.case as { id: string }).id);
}

async function aCaseItem(caseId: string): Promise<string> {
  const created = await request(`/cases/${caseId}/items`, 'POST', {
    side: 'mine',
    label: 'The bill',
    text: 'They charged me twice for the same repair on 4 March.',
  }, OWNER_A);
  assert.equal(created.status, 201, `fixture item: ${created.text}`);
  return String((created.body.item as { id: string }).id);
}

async function aTask(recordId: string): Promise<string> {
  const created = await request('/tasks', 'POST', {
    text: 'Call the shop about the double charge',
    recordId,
  }, OWNER_A);
  assert.equal(created.status, 201, `fixture task: ${created.text}`);
  return String((created.body.task as { id: string }).id);
}

async function aFileId(): Promise<string> {
  const stored = storeUpload(OWNER_A, png(), 'image/png', 'bill.png');
  return stored.id;
}

async function aSignal(): Promise<string> {

  const now = Date.now();
  db.prepare(
    `INSERT INTO signals (id, user_id, kind, rule, title, detail, fingerprint, sources, status, created_at, updated_at)
     VALUES ('sig_a', ?, 'anomaly', 'duplicate_charge', 'Charged twice', 'Two identical charges.', 'fp-a', '[{"kind":"record","id":"rec_x"}]', 'open', ?, ?)`,
  ).run(OWNER_A, now, now);
  return 'sig_a';
}

function aMeetingFromDb(): string {

  const now = Date.now();
  db.prepare(
    `INSERT INTO meetings (id, user_id, title, status, started_at, created_at, updated_at)
     VALUES ('mtg_a', ?, 'Site visit with the contractor', 'transcribed', ?, ?, ?)`,
  ).run(OWNER_A, now, now, now);
  return 'mtg_a';
}

describe('owner B cannot reach anything that belongs to owner A', () => {
  test('every endpoint refuses another owner with 404 and no content', async () => {
    armWithAnything();
    const recordId = await aRecord();
    const caseId = await aCase();
    const itemId = await aCaseItem(caseId);
    const taskId = await aTask(recordId);
    const fileId = await aFileId();
    const meetingId = aMeetingFromDb();
    const signalId = await aSignal();
    const analysisPath = `/cases/${caseId}/analysis`;

    const document = await exported();
    const exportedRecord = String(document.entries[0]?.id ?? recordId);
    const exportedFile = String(document.storedFiles[0]?.id ?? fileId);

    const probes: Probe[] = [

      {
        what: 'a record',
        verbs: [
          { method: 'GET', path: () => `/daybook/records/${recordId}` },
          { method: 'GET', path: () => `/daybook/records/${exportedRecord}` },
          { method: 'POST', path: () => `/daybook/records/${recordId}/answer`, body: () => ({ answer: '2500' }) },
          { method: 'POST', path: () => `/daybook/records/${recordId}/question/skip` },
          { method: 'PATCH', path: () => `/daybook/records/${recordId}`, body: () => ({ title: 'B was here' }) },
          { method: 'POST', path: () => `/daybook/records/${recordId}/retry` },
          { method: 'DELETE', path: () => `/daybook/records/${recordId}` },
        ],
      },

      {
        what: 'a meeting',
        verbs: [
          { method: 'GET', path: () => `/meetings/${meetingId}` },
          { method: 'PATCH', path: () => `/meetings/${meetingId}`, body: () => ({ title: 'B was here' }) },
          { method: 'POST', path: () => `/meetings/${meetingId}/retry` },
          { method: 'DELETE', path: () => `/meetings/${meetingId}` },
        ],
      },

      {
        what: 'a task',
        verbs: [
          { method: 'GET', path: () => `/tasks/${taskId}` },
          { method: 'PATCH', path: () => `/tasks/${taskId}`, body: () => ({ text: 'B was here' }) },
          { method: 'DELETE', path: () => `/tasks/${taskId}` },
        ],
      },

      {
        what: 'a case',
        verbs: [
          { method: 'GET', path: () => `/cases/${caseId}` },
          { method: 'PATCH', path: () => `/cases/${caseId}`, body: () => ({ title: 'B was here' }) },
          { method: 'DELETE', path: () => `/cases/${caseId}` },
          { method: 'GET', path: () => `/cases/${caseId}/report` },
          { method: 'POST', path: () => `/cases/${caseId}/analyze` },
          { method: 'DELETE', path: () => analysisPath },
          { method: 'POST', path: () => `/cases/${caseId}/items`, body: () => ({ side: 'mine', label: 'Mine now', text: 'B was here.' }) },
        ],
      },
      {
        what: 'a piece of evidence',
        verbs: [
          { method: 'GET', path: () => `/cases/${caseId}/items/${itemId}` },
          { method: 'PATCH', path: () => `/cases/${caseId}/items/${itemId}`, body: () => ({ label: 'B was here' }) },
          { method: 'DELETE', path: () => `/cases/${caseId}/items/${itemId}` },
          { method: 'POST', path: () => `/cases/${caseId}/items/${itemId}/retry` },
          { method: 'POST', path: () => `/cases/${caseId}/items/${itemId}/describe`, body: () => ({ text: 'B was here.' }) },
        ],
      },

      {
        what: 'a signal',
        verbs: [
          { method: 'GET', path: () => `/attention/${signalId}` },
          { method: 'POST', path: () => `/attention/${signalId}/resolve`, body: () => ({ verdict: 'done' }) },
        ],
      },

      {
        what: 'a stored file',
        verbs: [
          { method: 'GET', path: () => `/files/${fileId}` },
          { method: 'GET', path: () => `/files/${exportedFile}` },
        ],
      },
    ];

    let requests = 0;
    const wrongStatus: string[] = [];
    const succeeded: string[] = [];

    for (const probe of probes) {
      for (const verb of probe.verbs) {
        const path = verb.path();
        const answer = await request(path, verb.method, verb.body?.(), OWNER_B);
        requests += 1;
        if (answer.status >= 200 && answer.status < 300) {
          succeeded.push(`${verb.method} ${path} → ${answer.status}`);
        } else if (answer.status !== 404) {
          wrongStatus.push(`${verb.method} ${path} → ${answer.status}: ${answer.text.slice(0, 120)}`);
        }
      }
    }

    assert.deepEqual(succeeded, [], 'owner B reached something that belongs to owner A');
    assert.deepEqual(
      wrongStatus,
      [],
      'a refusal was not a 404 — anything else confirms the thing exists or leaks a diagnostic',
    );

    assert.equal(requests, 30, 'the probe table changed size; add the new endpoint to it');
  });

  test('B reading A exports gives nothing of A', async () => {
    await aRecord();
    await aCase();

    const own = await exported();
    assert.equal(own.entries.length, 1, 'A cannot see their own record');

    const others = await request('/me/account/export', 'GET', undefined, OWNER_B);
    assert.equal(others.status, 200);

    const viewed = JSON.parse(others.text) as Record<string, any>;
    assert.deepEqual(viewed.entries, [], 'B\'s export carries A\'s records');
    assert.deepEqual(viewed.cases, [], 'B\'s export carries A\'s cases');
    assert.deepEqual(viewed.storedFiles, [], 'B\'s export carries A\'s files');

    for (const [path, key] of [
      ['/daybook/records', 'records'],
      ['/cases', 'cases'],
      ['/tasks', 'tasks'],
      ['/meetings', 'meetings'],
      ['/attention', 'signals'],
    ] as const) {
      const answer = await request(path, 'GET', undefined, OWNER_B);
      assert.equal(answer.status, 200, `${path} is unreadable for B`);
      assert.deepEqual(answer.body[key], [], `${path} returned A's rows to B`);
    }

    const found = await request('/search?q=Sharma', 'GET', undefined, OWNER_B);
    assert.equal(found.status, 200);
    const results = (found.body.results ?? found.body.matches ?? []) as unknown[];
    assert.deepEqual(results, [], 'search found A\'s material for B');
  });

  test('B cannot make A\'s case out of A\'s record', async () => {
    const recordId = await aRecord();
    const answer = await request(`/cases/from-record/${recordId}`, 'POST', undefined, OWNER_B);
    assert.equal(answer.status, 404, 'a record of A\'s opened a case for B');
  });

  test('B cannot attach one of A\'s records to a task of their own', async () => {
    const recordId = await aRecord();
    const answer = await request('/tasks', 'POST', { text: 'Mine now', recordId }, OWNER_B);
    assert.equal(answer.status, 404, 'B filed a task against a record of A\'s');
  });

  test('B cannot list tasks by one of A\'s records', async () => {
    const recordId = await aRecord();
    const answer = await request(`/tasks?recordId=${encodeURIComponent(recordId)}`, 'GET', undefined, OWNER_B);
    assert.equal(answer.status, 404, 'B filtered their task list by a record of A\'s');
  });
});

describe('the export is A\'s own, and stays that way', () => {
  test('an id from A\'s export does not resolve for B', async () => {
    const recordId = await aRecord();
    const document = await exported();
    const ids = (document.entries as Array<{ id: string }>).map((entry) => entry.id);
    assert.ok(ids.includes(recordId), 'the export did not carry the record it was made from');

    for (const id of ids) {
      const answer = await request(`/daybook/records/${encodeURIComponent(id)}`, 'GET', undefined, OWNER_B);
      assert.equal(answer.status, 404, `an exported id (${id}) resolved for B`);
    }
  });
});

describe('a signed-out caller reaches nothing', () => {
  test('requireAccount refuses a garbage bearer token without asking Google', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error('the shape of this token should never have reached the network');
    };
    process.env.FIREBASE_WEB_API_KEY = 'test-fixture-only';

    const app2 = new Hono();
    app2.use('/api/*', requireAccount);
    app2.get('/api/thing', (context) => context.json({ ok: true }));

    for (const token of ['undefined', 'a.b', 'not-a-token', `a.${Buffer.from('{').toString('base64url')}.c`]) {
      const answer = await app2.request('/api/thing', {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(answer.status, 401, `"${token}" was not refused`);
    }
    assert.equal(calls, 0, 'a malformed token cost a round trip to the identity lookup');

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as ProviderBody) : {};
      return Response.json({ choices: [{ message: { content: JSON.stringify(await responder(url, body)) } }] });
    };
    delete process.env.FIREBASE_WEB_API_KEY;
  });

  test('a device id is refused in production, by the code that guards it', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app2 = new Hono();
      app2.use('/api/*', requireAccount);
      app2.get('/api/thing', (context) => context.json({ ok: true }));

      const answer = await app2.request('/api/thing', { headers: { 'x-device-id': 'device-aaaaaa' } });
      assert.equal(answer.status, 401, 'a header-chosen identity was accepted under NODE_ENV=production');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

describe('deleting a record releases only what nothing else needs', () => {
  test('bytes shared with a case item survive the record they came from', async () => {
    const fileId = await aFileId();
    const stored = fileById(fileId, OWNER_A);
    assert.ok(stored);

    const now = Date.now();
    db.prepare(
      `INSERT INTO records (id, user_id, kind, title, file_id, extraction, status, created_at, updated_at)
       VALUES ('rec_shared', ?, 'bill', 'The bill', ?, '{}', 'complete', ?, ?)`,
    ).run(OWNER_A, fileId, now, now);
    db.prepare(`INSERT INTO cases (id, user_id, title, created_at, updated_at) VALUES ('case_shared', ?, 'Dispute', ?, ?)`)
      .run(OWNER_A, now, now);
    db.prepare(
      `INSERT INTO case_items (id, case_id, user_id, side, label, file_id, extraction, created_at)
       VALUES ('item_shared', 'case_shared', ?, 'mine', 'The bill', ?, '{}', ?)`,
    ).run(OWNER_A, fileId, now);

    db.prepare('UPDATE files SET created_at = 0 WHERE id = ?').run(fileId);

    assert.equal(db.prepare('DELETE FROM records WHERE id = ?').run('rec_shared').changes, 1);
    assert.equal(collectOrphanFiles(OWNER_A), 0, 'collection took bytes a case item still points at');
    assert.ok(fileById(fileId, OWNER_A), 'the file row was released while evidence still used it');

    assert.equal(db.prepare('DELETE FROM case_items WHERE id = ?').run('item_shared').changes, 1);
    assert.equal(collectOrphanFiles(OWNER_A), 1, 'the last referent went and the bytes stayed');
    assert.equal(fileById(fileId, OWNER_A), null, 'the file row outlived its last referent');
  });

  test('one owner\'s delete cannot collect another owner\'s identical bytes', async () => {

    const a = storeUpload(OWNER_A, png(), 'image/png', 'bill.png');
    const b = storeUpload(OWNER_B, png(), 'image/png', 'bill.png');
    assert.notEqual(a.id, b.id);

    db.prepare('UPDATE files SET created_at = 0').run();
    assert.equal(collectOrphanFiles(OWNER_A), 1);
    assert.equal(fileById(a.id, OWNER_A), null);
    assert.ok(fileById(b.id, OWNER_B), 'B lost bytes because A deleted theirs');
  });
});

const HOSTILE: Array<[string, string]> = [
  ['a very long string', 'x'.repeat(20_000)],
  ['a null byte', 'a\u0000b'],
  ['a newline', 'line one\nline two'],
  ['SQL metacharacters', `'; DROP TABLE records; --`],
  ['an FTS5 operator soup', 'NEAR("a" "b", 2) OR * AND ^x -"y"'],
  ['an unbalanced FTS5 quote', 'bill" OR col:'],
  ['a negative number', '-5'],
  ['a non-integer number', '3.9e2'],
  ['a huge number', '99999999999999999999999999'],
  ['a lone surrogate half', 'bill \ud800 end'],
  ['a path traversal', '../../../../etc/passwd'],
  ['a windows path traversal', '..\\..\\..\\windows\\win.ini'],
  ['an html fragment', '<script>alert(1)</script>'],
  ['a json fragment', '{"$ne": null}'],
];

function segment(value: string): string {
  return encodeURIComponent(value.replace(/[\uD800-\uDFFF]/g, (unit) =>
    `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

const MACHINE_TOKENS: Array<[string, RegExp]> = [
  ['a Groq key', /gsk_[A-Za-z0-9_-]{4,}/],
  ['a provider name', /\b(groq|grok|gemini|openai|anthropic|whisper|xai)\b/i],
  ['a model id', /\b(gpt-oss|qwen3?[.\d]*-\d+b|whisper-large|gemini-[\d.]+-\w+)\b/i],
  ['an errno code', /\b(E[A-Z]{3,}|SQLITE_[A-Z]+)\b/],
  ['a stack frame', /\bat [\w$.<>]+ \(/],
  ['a windows absolute path', /[A-Za-z]:[\\/](?:Users|Project|Windows)/i],
  ['a posix absolute path', /(?:^|[^\w])\/(?:home|root|usr|var|tmp|etc)\//],
  ['a node_modules path', /node_modules/],
  ['a sha-256 digest', /\b[0-9a-f]{64}\b/],
  ['a stored-path column', /"stored_path"/],
  ['a provider column', /"provider"\s*:/],
  ['a model column', /"model"\s*:/],
  ['a fingerprint column', /"fingerprint"\s*:/],
];

function machineTokensIn(text: string): string[] {
  return MACHINE_TOKENS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

describe('hostile input is refused in a sentence, never with a 500', () => {
  test('every path parameter survives every hostile string', async () => {
    armWithAnything();
    const caseId = await aCase();
    const itemId = await aCaseItem(caseId);

    const shapes: Array<{ method: string; path: (value: string) => string; body?: unknown }> = [
      { method: 'GET', path: (value) => `/daybook/records/${value}` },
      { method: 'PATCH', path: (value) => `/daybook/records/${value}`, body: { title: 'x' } },
      { method: 'DELETE', path: (value) => `/daybook/records/${value}` },
      { method: 'POST', path: (value) => `/daybook/records/${value}/answer`, body: { answer: 'x' } },
      { method: 'POST', path: (value) => `/daybook/records/${value}/question/skip` },
      { method: 'POST', path: (value) => `/daybook/records/${value}/retry` },
      { method: 'GET', path: (value) => `/meetings/${value}` },
      { method: 'PATCH', path: (value) => `/meetings/${value}`, body: { title: 'x' } },
      { method: 'DELETE', path: (value) => `/meetings/${value}` },
      { method: 'POST', path: (value) => `/meetings/${value}/retry` },
      { method: 'GET', path: (value) => `/tasks/${value}` },
      { method: 'PATCH', path: (value) => `/tasks/${value}`, body: { text: 'x' } },
      { method: 'DELETE', path: (value) => `/tasks/${value}` },
      { method: 'GET', path: (value) => `/cases/${value}` },
      { method: 'PATCH', path: (value) => `/cases/${value}`, body: { title: 'x' } },
      { method: 'DELETE', path: (value) => `/cases/${value}` },
      { method: 'GET', path: (value) => `/cases/${value}/report` },
      { method: 'POST', path: (value) => `/cases/${value}/analyze` },
      { method: 'DELETE', path: (value) => `/cases/${value}/analysis` },
      { method: 'GET', path: (value) => `/cases/${caseId}/items/${value}` },
      { method: 'PATCH', path: (value) => `/cases/${caseId}/items/${value}`, body: { label: 'x' } },
      { method: 'DELETE', path: (value) => `/cases/${caseId}/items/${value}` },
      { method: 'POST', path: (value) => `/cases/${caseId}/items/${value}/retry` },
      { method: 'POST', path: (value) => `/cases/${caseId}/items/${value}/describe`, body: { text: 'x' } },
      { method: 'POST', path: (value) => `/cases/from-record/${value}` },
      { method: 'GET', path: (value) => `/attention/${value}` },
      { method: 'POST', path: (value) => `/attention/${value}/resolve`, body: { verdict: 'done' } },
      { method: 'GET', path: (value) => `/files/${value}` },
    ];
    assert.ok(itemId);

    const broke: string[] = [];
    const leaked: string[] = [];

    for (const shape of shapes) {
      for (const [label, value] of HOSTILE) {

        const path = shape.path(segment(value));
        const answer = await request(path, shape.method, shape.body, OWNER_A);
        if (answer.status >= 500) {
          broke.push(`${shape.method} ${shape.path(':id')} with ${label} → ${answer.status}: ${answer.text.slice(0, 160)}`);
        }
        const tokens = machineTokensIn(answer.text);
        if (tokens.length > 0) {
          leaked.push(`${shape.method} ${shape.path(':id')} with ${label} leaked ${tokens.join(', ')}: ${answer.text.slice(0, 160)}`);
        }
      }
    }

    assert.deepEqual(broke, [], 'a path parameter produced a server error');
    assert.deepEqual(leaked, [], 'a refusal carried something only the machine should see');
  });

  test('every query parameter survives every hostile string', async () => {
    const shapes: Array<(value: string) => string> = [
      (value) => `/search?q=${value}`,
      (value) => `/search?q=bill&limit=${value}`,
      (value) => `/search?q=bill&kind=${value}`,
      (value) => `/daybook/records?limit=${value}`,
      (value) => `/daybook/records?before=${value}`,
      (value) => `/daybook/upcoming?days=${value}`,
      (value) => `/daybook/recap?period=${value}`,
      (value) => `/meetings?limit=${value}`,
      (value) => `/tasks?state=${value}`,
      (value) => `/tasks?recordId=${value}`,
      (value) => `/insights?period=${value}`,
      (value) => `/insights/budget?period=${value}`,
      (value) => `/insights/digest?period=${value}`,
      (value) => `/attention?state=${value}`,
      (value) => `/attention?refresh=${value}`,
    ];

    const broke: string[] = [];
    const leaked: string[] = [];

    for (const shape of shapes) {
      for (const [label, value] of HOSTILE) {
        const path = shape(segment(value));
        const answer = await request(path, 'GET', undefined, OWNER_A);
        if (answer.status >= 500) {
          broke.push(`GET ${shape('<value>')} with ${label} → ${answer.status}: ${answer.text.slice(0, 160)}`);
        }
        const tokens = machineTokensIn(answer.text);
        if (tokens.length > 0) {
          leaked.push(`GET ${shape('<value>')} with ${label} leaked ${tokens.join(', ')}: ${answer.text.slice(0, 160)}`);
        }
      }
    }

    assert.deepEqual(broke, [], 'a query parameter produced a server error');
    assert.deepEqual(leaked, [], 'a refusal carried something only the machine should see');
  });

  test('a body that is not an object is a sentence, not a crash', async () => {
    armWithAnything();
    const caseId = await aCase();
    const recordId = await aRecord();

    const bodies: unknown[] = [
      [],
      ['a', 'b'],
      'just a string',
      42,
      null,
      true,
      { title: null },
      { title: { nested: true } },
      { title: ['an', 'array'] },
      { title: 'x'.repeat(50_000) },
      { title: 'a\u0000b' },
      { title: 'bill \ud800 end' },
      { amount: -1, currency: 'INR', title: 'x' },
      { amount: '1e309', currency: 'INR', title: 'x' },
      { occurredAt: 'not a date', title: 'x' },
      { __proto__: { polluted: true }, title: 'x' },
    ];

    const writes: Array<[string, string]> = [
      ['POST', '/daybook/records'],
      ['PATCH', `/daybook/records/${recordId}`],
      ['POST', `/daybook/records/${recordId}/answer`],
      ['POST', '/cases'],
      ['PATCH', `/cases/${caseId}`],
      ['POST', `/cases/${caseId}/items`],
      ['POST', '/tasks'],
      ['PUT', '/insights/budget'],
      ['POST', '/daybook/ask'],
      ['POST', '/insights/advice'],
      ['PATCH', '/me/account'],
      ['DELETE', '/me/account'],
    ];

    const broke: string[] = [];
    const leaked: string[] = [];

    for (const [method, path] of writes) {
      for (const body of bodies) {
        lastInternalError = null;
        const answer = await request(path, method, body, OWNER_A);
        if (answer.status >= 500) {
          const cause = lastInternalError instanceof Error ? lastInternalError.message : answer.text.slice(0, 160);
          broke.push(`${method} ${path} with ${JSON.stringify(body)?.slice(0, 60)} → ${answer.status}: ${cause}`);
        }
        const tokens = machineTokensIn(answer.text);
        if (tokens.length > 0) {
          leaked.push(`${method} ${path} leaked ${tokens.join(', ')}: ${answer.text.slice(0, 160)}`);
        }
      }
    }

    assert.deepEqual(broke, [], 'a malformed body produced a server error');
    assert.deepEqual(leaked, [], 'a refusal carried something only the machine should see');
  });

  test('advice refuses an unusable model answer in a sentence', async () => {
    responder = () => ({ nothing: 'usable' });
    const answer = await request('/insights/advice', 'POST', {}, OWNER_A);
    assert.ok(answer.status >= 400, `advice answered ${answer.status} to an unusable model reply`);
    assert.deepEqual(machineTokensIn(answer.text), [], `advice leaked: ${answer.text.slice(0, 200)}`);
  });

  test('a filename cannot climb out of the data directory', async () => {
    for (const name of [
      '../../../../etc/passwd',
      '..\\..\\..\\windows\\win.ini',
      '/etc/shadow',
      'C:\\Windows\\System32\\config\\SAM',
      'a\u0000b.png',
      'bill\n.png',
      '.'.repeat(300) + '.png',
    ]) {
      const stored = storeUpload(OWNER_A, png(), 'image/png', name);

      assert.match(
        stored.stored_path.replace(/\\/g, '/'),
        /\/files\/[0-9a-f]{64}\/[0-9a-f]{64}\.png$/,
        `a filename reached the path: ${stored.stored_path}`,
      );
      assert.doesNotMatch(stored.original_name, /[\\/]/, 'a path separator survived in the stored name');
      assert.doesNotMatch(stored.original_name, /[\u0000-\u001f]/, 'a control character survived in the stored name');
      assert.ok(stored.original_name.length <= 240, 'the stored name was not bounded');
      db.prepare('DELETE FROM files WHERE id = ?').run(stored.id);
    }
  });
});

describe('no response carries anything only the machine should see', () => {
  test('a full account export and every route\'s ordinary answer are clean', async () => {
    armWithAnything();
    const recordId = await aRecord();
    const caseId = await aCase();
    await aCaseItem(caseId);
    await aTask(recordId);
    await aFileId();
    aMeetingFromDb();
    await aSignal();

    const now = Date.now();
    db.prepare(
      `INSERT INTO analyses (id, case_id, user_id, result, provider, model, input_digest, created_at)
       VALUES ('an_a', ?, ?, ?, 'groq', 'openai/gpt-oss-120b', ?, ?)`,
    ).run(
      caseId,
      OWNER_A,
      JSON.stringify({ verdict: { headline: 'The charge was taken twice.' }, signals: [], sources: [] }),
      'a'.repeat(64),
      now,
    );

    const paths: Array<[string, string]> = [
      ['GET', '/me/account'],
      ['GET', '/me/account/export'],
      ['GET', '/daybook/records'],
      ['GET', `/daybook/records/${recordId}`],
      ['GET', '/daybook/upcoming'],
      ['GET', '/daybook/recap'],
      ['GET', '/meetings'],
      ['GET', '/meetings/mtg_a'],
      ['GET', '/tasks'],
      ['GET', '/tasks?state=all'],
      ['GET', '/cases'],
      ['GET', `/cases/${caseId}`],
      ['GET', `/cases/${caseId}/report`],
      ['GET', '/insights'],
      ['GET', '/insights/budget'],
      ['GET', '/insights/digest'],
      ['GET', '/attention'],
      ['GET', '/attention/sig_a'],
      ['GET', '/search?q=Sharma'],
    ];

    const leaked: string[] = [];
    for (const [method, path] of paths) {
      const answer = await request(path, method, undefined, OWNER_A);
      assert.ok(answer.status < 500, `${method} ${path} → ${answer.status}: ${answer.text.slice(0, 200)}`);
      const tokens = machineTokensIn(answer.text);
      if (tokens.length > 0) {
        leaked.push(`${method} ${path} leaked ${tokens.join(', ')}`);
      }
    }

    assert.deepEqual(leaked, [], 'a response carried something only the machine should see');
  });

  test('model-written advice does not name the model that wrote it', async () => {
    armWithAnything();
    const answer = await request('/insights/advice', 'POST', {}, OWNER_A);
    assert.equal(answer.status, 200, `advice answered ${answer.status}: ${answer.text.slice(0, 200)}`);
    assert.deepEqual(
      machineTokensIn(answer.text),
      [],
      `advice leaked: ${answer.text.slice(0, 300)}`,
    );
  });

  test('an error body names no vendor, no path and no code', async () => {
    const answers = [
      await request('/daybook/records/does-not-exist', 'GET', undefined, OWNER_A),
      await request('/cases/does-not-exist', 'GET', undefined, OWNER_A),
      await request('/cases', 'POST', { title: '' }, OWNER_A),
      await request('/insights/budget', 'PUT', { amount: '-1', currency: 'INR' }, OWNER_A),
      await request('/me/account', 'DELETE', { confirm: 'nope' }, OWNER_A),
      await request('/tasks/does-not-exist', 'DELETE', undefined, OWNER_A),
    ];

    for (const answer of answers) {
      assert.ok(answer.status >= 400 && answer.status < 500, `unexpected status ${answer.status}`);
      assert.deepEqual(machineTokensIn(answer.text), [], `a refusal leaked: ${answer.text.slice(0, 200)}`);
      const message = String(answer.body.error ?? '');
      assert.ok(message.length > 0, 'a refusal had no sentence in it');

      assert.doesNotMatch(message, /^\s*\[|"code"|expected|received/i, `not a person's sentence: ${message}`);
    }
  });

  test('the account-deletion phrase is accepted only in the body', async () => {
    const { DELETE_CONFIRMATION } = await import('./routes/account.ts');

    const viaQuery = await request(
      `/me/account?confirm=${encodeURIComponent(DELETE_CONFIRMATION)}`,
      'DELETE',
      undefined,
      OWNER_B,
    );
    assert.equal(viaQuery.status, 400, 'the deletion phrase worked from the query string');
    assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(OWNER_B), 'the account was deleted from a query string');
  });
});
