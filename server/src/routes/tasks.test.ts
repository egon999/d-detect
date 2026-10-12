import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Account } from '../auth.ts';

const directory = mkdtempSync(join(tmpdir(), 'detact-tasks-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';
const { db, ensureUser } = await import('../db.ts');
const { tasks } = await import('./tasks.ts');

const app = new Hono<{ Variables: { account: Account } }>();
app.use('*', async (context, next) => {
  const id = context.req.header('x-test-owner') ?? 'owner-a';
  ensureUser(id, null, null);
  context.set('account', { id, email: null, name: null });
  await next();
});
app.route('/tasks', tasks);
app.onError((error, context) =>
  context.json({ error: error.message }, error instanceof HTTPException ? error.status : 500),
);

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  assert.fail(`The task list made a network call it does not need: ${String(input)}`);
};

beforeEach(() => {
  db.exec(
    'DELETE FROM jobs; DELETE FROM signals; DELETE FROM signal_scans; DELETE FROM cases; DELETE FROM meetings; DELETE FROM records; DELETE FROM tasks; DELETE FROM budgets; DELETE FROM files; DELETE FROM users;',
  );
  ensureUser('owner-a', null, null);
});

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-tasks-'));
  rmSync(target, { recursive: true, force: true });
});

const DAY = 86_400_000;

type TaskView = {
  id: string;
  text: string;
  owner: string | null;
  priority: string;
  dueAt: number | null;
  doneAt: number | null;
  overdue: boolean;
  meetingId: string | null;
  recordId: string | null;
  meetingTitle: string | null;
  recordTitle: string | null;
  createdAt: number;
};

async function call(
  method: string,
  path: string,
  body?: unknown,
  owner = 'owner-a',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await app.request(path, {
    method,
    headers: { 'x-test-owner': owner, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function add(body: unknown, owner = 'owner-a'): Promise<TaskView> {
  const { status, json } = await call('POST', '/tasks', body, owner);
  assert.equal(status, 201, `Creating a task failed: ${JSON.stringify(json)}`);
  return json['task'] as TaskView;
}

async function list(query = '', owner = 'owner-a'): Promise<TaskView[]> {
  const { status, json } = await call('GET', `/tasks${query}`, undefined, owner);
  assert.equal(status, 200, `Listing tasks failed: ${JSON.stringify(json)}`);
  return json['tasks'] as TaskView[];
}

function seedRecord(id: string, title: string, owner = 'owner-a'): string {
  ensureUser(owner, null, null);
  const now = Date.now();
  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, status, created_at, updated_at)
     VALUES (?, ?, 'payment', ?, ?, 'complete', ?, ?)`,
  ).run(id, owner, title, now, now, now);
  return id;
}

function seedTask(fields: { text: string; dueAt?: number | null; doneAt?: number | null; createdAt: number }): void {
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, due_at, done_at, priority, created_at)
     VALUES (?, 'owner-a', ?, ?, ?, 'normal', ?)`,
  ).run(`task_${fields.text.replace(/\W/g, '_')}`, fields.text, fields.dueAt ?? null, fields.doneAt ?? null, fields.createdAt);
}

test('a task can be opened on its own, and someone else cannot open it', async () => {
  const created = await add({ text: 'Send the signed copy', priority: 'high', owner: 'Priya' });

  const mine = await call('GET', `/tasks/${created.id}`);
  assert.equal(mine.status, 200);
  const task = mine.json['task'] as TaskView;
  assert.equal(task.id, created.id);
  assert.equal(task.text, 'Send the signed copy');
  assert.equal(task.priority, 'high');
  assert.equal(task.owner, 'Priya');

  const theirs = await call('GET', `/tasks/${created.id}`, undefined, 'owner-b');
  assert.equal(theirs.status, 404);
  assert.equal(theirs.json['error'], 'That task does not exist.');

  const missing = await call('GET', '/tasks/task_never_existed');
  assert.equal(missing.status, 404);
});

test('who is doing it can be set, corrected and cleared', async () => {

  const created = await add({ text: 'Collect the receipt', owner: '  Priya  ' });
  assert.equal(created.owner, 'Priya');

  const corrected = await call('PATCH', `/tasks/${created.id}`, { owner: 'Ravi' });
  assert.equal(corrected.status, 200);
  assert.equal((corrected.json['task'] as TaskView).owner, 'Ravi');

  const renamed = await call('PATCH', `/tasks/${created.id}`, { text: 'Collect the stamped receipt' });
  assert.equal((renamed.json['task'] as TaskView).owner, 'Ravi');
  assert.equal((renamed.json['task'] as TaskView).text, 'Collect the stamped receipt');

  const cleared = await call('PATCH', `/tasks/${created.id}`, { owner: null });
  assert.equal((cleared.json['task'] as TaskView).owner, null);

  const blanked = await add({ text: 'Nobody in particular', owner: '   ' });
  assert.equal(blanked.owner, null);
});

test('a task about a record names the record, and the record can be asked for its own', async () => {
  const recordId = seedRecord('rec_bill', 'Electricity bill, March');
  seedRecord('rec_other', 'Water bill, March');

  const attached = await add({ text: 'Ask for the meter reading', recordId });
  assert.equal(attached.recordId, recordId);
  assert.equal(attached.recordTitle, 'Electricity bill, March');
  assert.equal(attached.meetingId, null);
  assert.equal(attached.meetingTitle, null);

  await add({ text: 'Unrelated errand' });
  await add({ text: 'Check the water meter', recordId: 'rec_other' });

  const aboutBill = await list(`?recordId=${recordId}`);
  assert.deepEqual(
    aboutBill.map((task) => task.text),
    ['Ask for the meter reading'],
  );

  assert.equal((await list()).length, 3);
});

test('a record somebody else owns is not a record', async () => {
  seedRecord('rec_theirs', 'Their rent receipt', 'owner-b');

  const created = await call('POST', '/tasks', { text: 'Pry', recordId: 'rec_theirs' }, 'owner-a');
  assert.equal(created.status, 404);
  assert.equal(created.json['error'], 'That record does not exist.');

  const listed = await call('GET', '/tasks?recordId=rec_theirs', undefined, 'owner-a');
  assert.equal(listed.status, 404);
  assert.equal(listed.json['error'], 'That record does not exist.');

  assert.equal((await list()).length, 0);
});

test('overdue leads, then due soonest, then undated newest first', async () => {
  const now = Date.now();
  seedTask({ text: 'rent two days late', dueAt: now - 2 * DAY, createdAt: now - 9 * DAY });
  seedTask({ text: 'bill one day late', dueAt: now - 1 * DAY, createdAt: now - 8 * DAY });
  seedTask({ text: 'call tomorrow', dueAt: now + 1 * DAY, createdAt: now - 7 * DAY });
  seedTask({ text: 'form next week', dueAt: now + 7 * DAY, createdAt: now - 6 * DAY });
  seedTask({ text: 'undated written later', dueAt: null, createdAt: now - 2 * DAY });
  seedTask({ text: 'undated written first', dueAt: null, createdAt: now - 5 * DAY });

  const open = await list();
  assert.deepEqual(
    open.map((task) => task.text),
    [
      'rent two days late',
      'bill one day late',
      'call tomorrow',
      'form next week',
      'undated written later',
      'undated written first',
    ],
  );

  assert.deepEqual(
    open.map((task) => task.overdue),
    [true, true, false, false, false, false],
  );
});

test('a tick can be taken back', async () => {
  const created = await add({ text: 'Pay the maintenance', due: '2026-03-14' });
  assert.equal(created.doneAt, null);

  const ticked = await call('PATCH', `/tasks/${created.id}`, { done: true });
  const done = ticked.json['task'] as TaskView;
  assert.ok(done.doneAt !== null);

  assert.equal(done.overdue, false);

  assert.deepEqual(await list(), []);
  assert.deepEqual(
    (await list('?state=done')).map((task) => task.text),
    ['Pay the maintenance'],
  );
  assert.deepEqual(
    (await list('?state=all')).map((task) => task.text),
    ['Pay the maintenance'],
  );

  const undone = await call('PATCH', `/tasks/${created.id}`, { done: false });
  assert.equal((undone.json['task'] as TaskView).doneAt, null);
  assert.deepEqual(
    (await list()).map((task) => task.text),
    ['Pay the maintenance'],
  );
  assert.deepEqual(await list('?state=done'), []);
});

test('a due date names a day or it is refused', async () => {
  const march = new Date(2026, 2, 14).getTime();
  for (const written of ['2026-03-14', '14/03/2026', '14 March 2026']) {
    const created = await add({ text: `Due ${written}`, due: written });
    assert.equal(created.dueAt, march, `${written} should be the same day as every other spelling of it`);
  }

  for (const vague of ['2026-03', '2026', 'next month', '32/01/2026']) {
    const refused = await call('POST', '/tasks', { text: 'Vague', due: vague });
    assert.equal(refused.status, 400, `${vague} should not be accepted as a due date`);
    assert.equal(refused.json['error'], 'Choose a full due date, including the day.');
  }

  assert.equal((await add({ text: 'No date at all', due: '' })).dueAt, null);

  const created = await add({ text: 'Has a date', due: '2026-03-14' });
  const refusedEdit = await call('PATCH', `/tasks/${created.id}`, { due: 'sometime' });
  assert.equal(refusedEdit.status, 400);

  assert.equal(((await call('GET', `/tasks/${created.id}`)).json['task'] as TaskView).dueAt, march);

  const untouched = await call('PATCH', `/tasks/${created.id}`, { priority: 'low' });
  assert.equal((untouched.json['task'] as TaskView).dueAt, march);

  const cleared = await call('PATCH', `/tasks/${created.id}`, { due: null });
  assert.equal((cleared.json['task'] as TaskView).dueAt, null);
});

test('one account never sees, edits or deletes the tasks of another', async () => {
  const mine = await add({ text: 'My errand' }, 'owner-a');
  const theirs = await add({ text: 'Their errand' }, 'owner-b');

  assert.deepEqual(
    (await list('', 'owner-a')).map((task) => task.text),
    ['My errand'],
  );
  assert.deepEqual(
    (await list('', 'owner-b')).map((task) => task.text),
    ['Their errand'],
  );

  const edit = await call('PATCH', `/tasks/${mine.id}`, { text: 'Hijacked' }, 'owner-b');
  assert.equal(edit.status, 404);
  const removal = await call('DELETE', `/tasks/${mine.id}`, undefined, 'owner-b');
  assert.equal(removal.status, 404);

  assert.equal(((await call('GET', `/tasks/${mine.id}`)).json['task'] as TaskView).text, 'My errand');

  const own = await call('DELETE', `/tasks/${theirs.id}`, undefined, 'owner-b');
  assert.equal(own.status, 200);
  assert.deepEqual(await list('', 'owner-b'), []);
});
