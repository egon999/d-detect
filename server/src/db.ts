import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from './env.ts';

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(resolve(config.dataDir, 'files'), { recursive: true });

export const db: BetterSqlite3.Database = new BetterSqlite3(resolve(config.dataDir, 'detact.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT,
  name        TEXT,
  created_at  INTEGER NOT NULL
);

-- Stored originals. One row per distinct set of bytes per owner: the (owner, sha256)
-- index means uploading the same screenshot twice reuses the first row rather than
-- silently storing it again.
CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  sha256        TEXT NOT NULL,
  mime          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  stored_path   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS files_owner_sha ON files(user_id, sha256);

-- A Daybook record: one thing that happened. A payment, a purchase, a bill, a ticket,
-- a visit, a note. 'kind' is what the server decided the source was; 'status' is
-- 'needs_context' until the one missing question is answered.
CREATE TABLE IF NOT EXISTS records (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  occurred_at   INTEGER,
  occurred_precision TEXT,
  amount_minor  INTEGER,
  currency      TEXT,
  direction     TEXT,
  counterparty  TEXT,
  category      TEXT,
  note          TEXT,
  file_id       TEXT REFERENCES files(id),
  extraction    TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'needs_context',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS records_owner_time ON records(user_id, occurred_at DESC);

-- The single contextual question the server could not answer from the file itself.
-- Deliberately one row at a time per record: an interrogation is not a product.
CREATE TABLE IF NOT EXISTS questions (
  id          TEXT PRIMARY KEY,
  record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  options     TEXT NOT NULL DEFAULT '[]',
  answer      TEXT,
  answered_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS questions_record ON questions(record_id);

-- A meeting. 'status' is the stage its recording has reached, and the ladder that owns the
-- four real values is STATUS_RANK in routes/meetings.ts.
--
-- The default is the first of those four and not the stage before it. It used to be
-- 'recorded', which describes a state no meeting is ever in: nothing writes it, the rank
-- table has no entry for it, and the client's status union does not contain it — so a row
-- that landed on the default was a meeting the app had nothing to render for. Defaulting to
-- the first real stage means an insert that forgets the column produces a row the pipeline
-- and the screen both understand.
CREATE TABLE IF NOT EXISTS meetings (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  file_id     TEXT REFERENCES files(id),
  language    TEXT,
  duration_ms INTEGER,
  transcript  TEXT,
  summary     TEXT,
  status      TEXT NOT NULL DEFAULT 'transcribing',
  error       TEXT,
  started_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS meetings_owner_time ON meetings(user_id, started_at DESC);

-- Action items. They come from a meeting or from a record, and they are the same list
-- either way, because a person has one list of things to do.
CREATE TABLE IF NOT EXISTS tasks (
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
CREATE INDEX IF NOT EXISTS tasks_owner_open ON tasks(user_id, done_at);

CREATE TABLE IF NOT EXISTS budgets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  period        TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS budgets_owner_period ON budgets(user_id, period);

-- Evidence cases. The secondary experience, on the same files and the same timeline.
CREATE TABLE IF NOT EXISTS cases (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  question    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_owner_time ON cases(user_id, updated_at DESC);

-- One piece of material in a case. 'side' records whose account it is, which is the
-- whole point: the product compares what you submitted against what they claim.
CREATE TABLE IF NOT EXISTS case_items (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  side        TEXT NOT NULL DEFAULT 'mine',
  label       TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  file_id     TEXT REFERENCES files(id),
  extraction  TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS case_items_case ON case_items(case_id, created_at);

CREATE TABLE IF NOT EXISTS analyses (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  result      TEXT NOT NULL,
  provider    TEXT,
  model       TEXT,
  input_digest TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS analyses_case_time ON analyses(case_id, created_at DESC);

-- Background work. Extraction and transcription do not finish inside a request, and a
-- spinner that outlives its request is how the old build lied about progress. A job
-- row is the truth the client polls.
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  detail      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_owner_status ON jobs(user_id, status);
CREATE INDEX IF NOT EXISTS jobs_subject ON jobs(subject_id);

-- Things the timeline noticed on its own.
--
-- A commitment someone made, a document about to expire, a charge that looks wrong: these
-- are three features only if you build them three times. They are one thing -- an observation
-- derived from records the person already captured, which they have not dealt with yet -- so
-- they are one table, one detector pass and one list in the app.
--
-- The sources column is the point of the table. Every signal names the record or meeting
-- rows it was derived from, and the app shows them, because a claim the person cannot trace
-- back to their own material is indistinguishable from an invented one. A detector that
-- cannot cite its sources must not write a row.
CREATE TABLE IF NOT EXISTS signals (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  -- 'commitment' | 'renewal' | 'anomaly'
  kind         TEXT NOT NULL,
  -- The detector that produced it, e.g. 'duplicate_charge'. Stable id, never shown raw.
  rule         TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  -- Verbatim from the person's own material, when the detector had a quote to stand on.
  quote        TEXT,
  due_at       INTEGER,
  amount_minor INTEGER,
  currency     TEXT,
  -- JSON: [{ kind: 'record'|'meeting', id }]. Never empty.
  sources      TEXT NOT NULL DEFAULT '[]',
  -- 'open' | 'done' | 'dismissed'. The person's verdict, never the detector's.
  status       TEXT NOT NULL DEFAULT 'open',
  -- Lets a re-run recognise a signal it already raised instead of duplicating it.
  fingerprint  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  resolved_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS signals_owner_fingerprint ON signals(user_id, fingerprint);
CREATE INDEX IF NOT EXISTS signals_owner_open ON signals(user_id, status, due_at);

-- Material the detectors have already read.
--
-- Reading a transcript or a document for commitments and expiry dates costs a model call;
-- finding nothing in it is a result worth keeping, because otherwise every pass pays again
-- to rediscover that a receipt contains no promises. One row per piece of material read.
--
-- Deliberately its own table rather than a row in the jobs table. A job is work the client
-- polls for, keyed by subject; adding a second kind of row under the same subject id made
-- "the job for this record" ambiguous for every existing query.
CREATE TABLE IF NOT EXISTS signal_scans (
  user_id     TEXT NOT NULL REFERENCES users(id),
  -- A records.id or a meetings.id. Not a foreign key: the marker outliving the material
  -- is correct, and cascade-deleting it would make a re-upload pay to read it again.
  subject_id  TEXT NOT NULL,
  scanned_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, subject_id)
);
`);

function addColumn(table: string, column: string, declaration: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

addColumn('meetings', 'intelligence', `TEXT NOT NULL DEFAULT '{}'`);
addColumn('meetings', 'ended_at', 'INTEGER');
addColumn('tasks', 'priority', `TEXT NOT NULL DEFAULT 'normal'`);
addColumn('cases', 'my_claim', `TEXT NOT NULL DEFAULT ''`);
addColumn('cases', 'their_claim', `TEXT NOT NULL DEFAULT ''`);
addColumn('cases', 'source_record_id', 'TEXT');
addColumn('case_items', 'status', `TEXT NOT NULL DEFAULT 'pending'`);
addColumn('case_items', 'kind', `TEXT NOT NULL DEFAULT 'document'`);

addColumn('tasks', 'fingerprint', 'TEXT');

addColumn('meetings', 'started_at_estimated', 'INTEGER NOT NULL DEFAULT 0');

addColumn('meetings', 'note', `TEXT NOT NULL DEFAULT ''`);

addColumn('users', 'display_name', 'TEXT');
addColumn('users', 'currency', 'TEXT');
addColumn('users', 'locale', 'TEXT');

export function alignMeetingStatusDefault(database: BetterSqlite3.Database): boolean {
  const dead = `DEFAULT 'recorded'`;
  const table = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'meetings'`)
    .get() as { sql: string } | undefined;
  if (!table?.sql.includes(dead)) return false;

  const indexes = (
    database
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'meetings' AND sql IS NOT NULL`)
      .all() as Array<{ sql: string }>
  ).map((row) => row.sql);

  const rebuilt = table.sql
    .replace(/CREATE\s+TABLE\s+("meetings"|'meetings'|\[meetings\]|meetings)/i, 'CREATE TABLE meetings_rebuilt')
    .replace(dead, `DEFAULT 'transcribing'`);
  if (!rebuilt.startsWith('CREATE TABLE meetings_rebuilt')) {
    throw new Error('meetings could not be rebuilt: its declaration was not in the expected form');
  }

  database.pragma('foreign_keys = OFF');

  database.pragma('legacy_alter_table = ON');
  try {
    database.transaction(() => {
      database.exec(rebuilt);
      database.exec('INSERT INTO meetings_rebuilt SELECT * FROM meetings');
      database.exec('DROP TABLE meetings');
      database.exec('ALTER TABLE meetings_rebuilt RENAME TO meetings');
      for (const sql of indexes) database.exec(sql);

      const dangling = database.pragma('foreign_key_check') as unknown[];
      if (dangling.length > 0) {
        throw new Error(`meetings could not be rebuilt: ${dangling.length} references would be left dangling`);
      }
    })();
  } finally {
    database.pragma('legacy_alter_table = OFF');
    database.pragma('foreign_keys = ON');
  }

  return true;
}

alignMeetingStatusDefault(db);

db.exec(`
CREATE INDEX IF NOT EXISTS tasks_owner_fingerprint ON tasks(user_id, fingerprint);
CREATE INDEX IF NOT EXISTS tasks_meeting ON tasks(meeting_id);
CREATE INDEX IF NOT EXISTS tasks_record ON tasks(record_id);

-- One case per record it was raised from. Two taps on "use this as evidence" used to
-- make two cases for the same payment, and the second one is never the one the person
-- goes back to. Partial, because a case created from nothing has no record to be unique on.
CREATE UNIQUE INDEX IF NOT EXISTS cases_owner_source_record
  ON cases(user_id, source_record_id) WHERE source_record_id IS NOT NULL;

-- Finding a record by what it is about, not only by when it happened. Covers the stale
-- 'processing' sweep as well, which reads by status and age.
CREATE INDEX IF NOT EXISTS records_owner_updated ON records(user_id, status, updated_at);

-- The timeline, dated the way every screen that reports a total actually dates it.
--
-- records_owner_time indexes occurred_at alone, and no query uses that column alone: a
-- record whose date could not be read is dated by when it was saved, so the money screen,
-- the home digest and the recap all read and order by COALESCE(occurred_at, created_at).
-- An index on a bare column cannot serve an expression, so each of those was reading every
-- row this account owns and sorting the lot — once per screen, growing with the account.
-- Expression index, so the month window becomes a range scan over just the months asked for.
CREATE INDEX IF NOT EXISTS records_owner_at ON records(user_id, COALESCE(occurred_at, created_at));

-- Settled records in date order, for the recurring-payment pass that runs on every money
-- screen. A strict superset of the old records_owner_status, which is dropped below: the
-- leftmost two columns are the same, so nothing that used it loses an index, and the third
-- turns that pass's ORDER BY from a sort of every completed record into a scan.
CREATE INDEX IF NOT EXISTS records_owner_status_occurred ON records(user_id, status, occurred_at);
DROP INDEX IF EXISTS records_owner_status;
`);

export function ensureUser(id: string, email: string | null, name: string | null): void {
  db.prepare(
    `INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = COALESCE(excluded.email, users.email),
       name  = COALESCE(excluded.name,  users.name)`,
  ).run(id, email, name, Date.now());
}
