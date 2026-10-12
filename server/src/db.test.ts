import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';

const directory = mkdtempSync(join(tmpdir(), 'detact-db-'));

const legacy = new BetterSqlite3(resolve(directory, 'detact.db'));
legacy.pragma('journal_mode = WAL');
legacy.pragma('foreign_keys = ON');
legacy.exec(`
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT,
  name        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE TABLE files (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  sha256        TEXT NOT NULL,
  mime          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  stored_path   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Declared in full, because this is the table the timelines read and the fixture has to be
-- able to answer the same query plans a live database would. The retired two-column status
-- index is here too: it is what an existing file actually carries, and dropping it is part
-- of the change under test.
CREATE TABLE records (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  kind               TEXT NOT NULL,
  title              TEXT NOT NULL,
  occurred_at        INTEGER,
  occurred_precision TEXT,
  amount_minor       INTEGER,
  currency           TEXT,
  direction          TEXT,
  counterparty       TEXT,
  category           TEXT,
  note               TEXT,
  file_id            TEXT REFERENCES files(id),
  extraction         TEXT NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'needs_context',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX records_owner_time ON records(user_id, occurred_at DESC);
CREATE INDEX records_owner_status ON records(user_id, status);
CREATE TABLE meetings (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  file_id     TEXT REFERENCES files(id),
  language    TEXT,
  duration_ms INTEGER,
  transcript  TEXT,
  summary     TEXT,
  status      TEXT NOT NULL DEFAULT 'recorded',
  error       TEXT,
  started_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX meetings_owner_time ON meetings(user_id, started_at DESC);
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  text        TEXT NOT NULL,
  owner_name  TEXT,
  due_at      INTEGER,
  done_at     INTEGER,
  meeting_id  TEXT REFERENCES meetings(id) ON DELETE CASCADE,
  record_id   TEXT REFERENCES records(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
`);
legacy.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, NULL, NULL, 1)').run('owner-a');
legacy
  .prepare(
    `INSERT INTO meetings (id, user_id, title, transcript, status, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'complete', 1, 1, 1)`,
  )
  .run('mtg_old', 'owner-a', 'Call with the landlord', 'He said he would return the deposit.');
legacy
  .prepare(
    `INSERT INTO tasks (id, user_id, text, meeting_id, created_at) VALUES (?, ?, ?, ?, 1)`,
  )
  .run('task_old', 'owner-a', 'Ask for the deposit back', 'mtg_old');
legacy.close();

process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';
const { db, alignMeetingStatusDefault } = await import('./db.ts');

after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function declarationOf(name: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name) as { sql: string } | undefined;
  assert.ok(row, `${name} is not in the schema`);
  return row.sql;
}

test('a live database carrying the retired meeting default is rebuilt onto the first real stage', () => {
  const declaration = declarationOf('meetings');
  assert.ok(
    !declaration.includes(`DEFAULT 'recorded'`),
    'the retired default must be gone from the live schema, not only from the statement in db.ts',
  );
  assert.ok(declaration.includes(`DEFAULT 'transcribing'`), 'the default must be the first stage the pipeline writes');

  db.prepare(
    `INSERT INTO meetings (id, user_id, title, started_at, created_at, updated_at)
     VALUES ('mtg_defaulted', 'owner-a', 'Untouched', 2, 2, 2)`,
  ).run();
  const defaulted = db.prepare(`SELECT status FROM meetings WHERE id = 'mtg_defaulted'`).get() as { status: string };
  assert.equal(defaulted.status, 'transcribing');

  db.prepare(`DELETE FROM meetings WHERE id = 'mtg_defaulted'`).run();
});

test('the rebuild keeps the meeting, and keeps the task that would have cascaded away with it', () => {
  const meeting = db.prepare(`SELECT * FROM meetings WHERE id = 'mtg_old'`).get() as {
    title: string;
    transcript: string | null;
    status: string;
    note: string;
    started_at_estimated: number;
    intelligence: string;
  };
  assert.equal(meeting.title, 'Call with the landlord');
  assert.equal(meeting.transcript, 'He said he would return the deposit.');

  assert.equal(meeting.status, 'complete');

  assert.equal(meeting.note, '');
  assert.equal(meeting.started_at_estimated, 0);
  assert.equal(meeting.intelligence, '{}');

  const task = db.prepare(`SELECT text, meeting_id FROM tasks WHERE id = 'task_old'`).get() as
    | { text: string; meeting_id: string | null }
    | undefined;
  assert.ok(task, 'the task hanging off the rebuilt meeting must still be there');
  assert.equal(task.text, 'Ask for the deposit back');
  assert.equal(task.meeting_id, 'mtg_old', 'and must still point at its meeting');

  assert.deepEqual(db.pragma('foreign_key_check'), [], 'the rebuild must leave no reference dangling');
});

test('the index the rebuild dropped with the old table is back', () => {

  assert.ok(declarationOf('meetings_owner_time').includes('meetings'));

  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT id FROM meetings WHERE user_id = ? ORDER BY started_at DESC`)
    .all('owner-a') as Array<{ detail: string }>;
  assert.ok(
    plan.some((step) => step.detail.includes('meetings_owner_time')),
    `the owner-and-time index must still serve the meeting list: ${JSON.stringify(plan)}`,
  );
});

test('a database whose default is already right is left alone', () => {

  assert.equal(alignMeetingStatusDefault(db), false);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM meetings`).get() as { n: number }).n, 1);
});

test('the timeline query reads an index rather than every record the account owns', () => {

  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM records
        WHERE user_id = ? AND COALESCE(occurred_at, created_at) >= ? AND COALESCE(occurred_at, created_at) <= ?`,
    )
    .all('owner-a', 0, 1) as Array<{ detail: string }>;
  assert.ok(
    plan.every((step) => !step.detail.includes('SCAN records')),
    `the month window must not scan the table: ${JSON.stringify(plan)}`,
  );

  const recurring = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM records
        WHERE user_id = ? AND status = 'complete' AND occurred_at IS NOT NULL AND occurred_at >= ?
        ORDER BY occurred_at DESC`,
    )
    .all('owner-a', 0) as Array<{ detail: string }>;
  assert.ok(
    recurring.every((step) => !step.detail.includes('TEMP B-TREE')),
    `the recurring pass must read its order from an index rather than sorting: ${JSON.stringify(recurring)}`,
  );
});
