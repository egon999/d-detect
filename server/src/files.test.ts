import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'detact-files-'));
process.env.DATA_DIR = directory;
const { db, ensureUser } = await import('./db.ts');
const { collectAllOrphanFiles, collectOrphanFiles, fileById, fileBytes, storeUpload } = await import('./files.ts');

const MINE = 'owner-a';
const THEIRS = 'owner-b';

beforeEach(() => {
  db.exec('DELETE FROM jobs; DELETE FROM signals; DELETE FROM signal_scans; DELETE FROM cases; DELETE FROM meetings; DELETE FROM records; DELETE FROM tasks; DELETE FROM budgets; DELETE FROM files; DELETE FROM users;');
  ensureUser(MINE, null, null);
  ensureUser(THEIRS, null, null);
});

after(() => {
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-files-'));
  rmSync(target, { recursive: true, force: true });
});

function png(fill: number): Uint8Array {
  const bytes = new Uint8Array(72).fill(fill);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  return bytes;
}

function age(fileId: string): void {
  db.prepare('UPDATE files SET created_at = ? WHERE id = ?').run(Date.now() - 120_000, fileId);
}

function fileRow(fileId: string) {
  return db.prepare('SELECT id, stored_path FROM files WHERE id = ?').get(fileId) as { stored_path: string } | undefined;
}

function addRecord(id: string, owner: string, fileId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, file_id, created_at, updated_at)
     VALUES (?, ?, 'other', 'A receipt', ?, ?, ?)`,
  ).run(id, owner, fileId, now, now);
}

function warningsDuring(sweep: () => number): { removed: number; warnings: string[] } {
  const warnings: string[] = [];
  const real = console.warn;
  console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(' ')); };
  try {
    return { removed: sweep(), warnings };
  } finally {
    console.warn = real;
  }
}

test('the same screenshot in two records is one row, and the first delete leaves it readable', () => {
  const first = storeUpload(MINE, png(11), 'image/png', 'receipt.png');
  const again = storeUpload(MINE, png(11), 'image/png', 'receipt-forwarded.png');
  assert.equal(again.id, first.id, 'Identical bytes were stored as two rows.');

  addRecord('rec_one', MINE, first.id);
  addRecord('rec_two', MINE, first.id);
  age(first.id);

  db.prepare('DELETE FROM records WHERE id = ?').run('rec_one');
  const swept = warningsDuring(() => collectOrphanFiles(MINE));
  assert.equal(swept.removed, 0);
  assert.deepEqual(swept.warnings, [], 'The sweep tried to delete a file the other record still points at.');

  const still = fileById(first.id, MINE);
  assert.ok(still, 'A file the other record still points at was collected.');
  assert.ok(existsSync(first.stored_path));
  assert.deepEqual(fileBytes(still, MINE), png(11), 'The record left standing can no longer read its own file.');
});

test('the last referrer takes the bytes with it', () => {
  const file = storeUpload(MINE, png(12), 'image/png', 'only.png');
  addRecord('rec_only', MINE, file.id);
  age(file.id);

  db.prepare('DELETE FROM records WHERE id = ?').run('rec_only');
  assert.equal(collectOrphanFiles(MINE), 1);
  assert.equal(fileRow(file.id), undefined);
  assert.equal(existsSync(file.stored_path), false, 'The row is gone but the bytes are still on disk.');

  assert.equal(collectOrphanFiles(MINE), 0);
});

test('a meeting and a case item hold a file as firmly as a record does', () => {
  const file = storeUpload(MINE, png(13), 'image/png', 'shared.png');
  age(file.id);
  const now = Date.now();
  db.prepare(
    `INSERT INTO meetings (id, user_id, title, file_id, started_at, created_at, updated_at)
     VALUES ('mtg_one', ?, 'A call about it', ?, ?, ?, ?)`,
  ).run(MINE, file.id, now, now, now);
  db.prepare(
    `INSERT INTO cases (id, user_id, title, created_at, updated_at) VALUES ('case_one', ?, 'A dispute', ?, ?)`,
  ).run(MINE, now, now);
  db.prepare(
    `INSERT INTO case_items (id, case_id, user_id, label, file_id, created_at)
     VALUES ('item_one', 'case_one', ?, 'Their invoice', ?, ?)`,
  ).run(MINE, file.id, now);

  db.prepare(`DELETE FROM meetings WHERE id = 'mtg_one'`).run();
  const swept = warningsDuring(() => collectOrphanFiles(MINE));
  assert.equal(swept.removed, 0, 'A file a case item still points at was collected.');
  assert.deepEqual(swept.warnings, [], 'The sweep tried to delete a file a case item still points at.');
  assert.ok(existsSync(file.stored_path));

  db.prepare(`DELETE FROM cases WHERE id = 'case_one'`).run();
  assert.equal(collectOrphanFiles(MINE), 1);
  assert.equal(existsSync(file.stored_path), false);
});

test('a file young enough to still be uploading survives collection until it is not', () => {
  const file = storeUpload(MINE, png(14), 'image/png', 'inflight.png');

  assert.equal(collectOrphanFiles(MINE), 0, 'A file that could still be in flight was collected.');
  assert.ok(existsSync(file.stored_path));

  age(file.id);
  assert.equal(collectOrphanFiles(MINE), 1);
  assert.equal(existsSync(file.stored_path), false);
});

test('one account deleting something never collects another account\'s file', () => {
  const mine = storeUpload(MINE, png(15), 'image/png', 'mine.png');
  const theirs = storeUpload(THEIRS, png(15), 'image/png', 'theirs.png');
  assert.notEqual(theirs.id, mine.id, 'Two accounts were handed one row for the same bytes.');
  assert.notEqual(theirs.stored_path, mine.stored_path, 'Two accounts were handed one path for the same bytes.');
  age(mine.id);
  age(theirs.id);

  assert.equal(collectOrphanFiles(THEIRS), 1);
  assert.ok(fileRow(mine.id), "One account's delete collected another account's file.");
  assert.ok(existsSync(mine.stored_path));
  assert.equal(existsSync(theirs.stored_path), false);
});

test('a stored path outside the data directory is refused rather than unlinked', () => {

  const outside = resolve(directory, 'not-ours.png');
  writeFileSync(outside, png(16));

  const file = storeUpload(MINE, png(17), 'image/png', 'doctored.png');
  db.prepare('UPDATE files SET stored_path = ? WHERE id = ?').run(outside, file.id);
  age(file.id);

  const refused = warningsDuring(() => collectOrphanFiles(MINE));
  assert.equal(refused.removed, 0);
  assert.match(refused.warnings.join('\n'), /refusing to delete a stored file outside/, 'The refusal was silent.');
  assert.ok(existsSync(outside), 'Collection followed a stored path out of the data directory.');
  assert.ok(fileRow(file.id), 'The row was dropped even though its bytes were refused.');
});

test('a row whose bytes are already gone is still cleared, and not an error', () => {
  const file = storeUpload(MINE, png(18), 'image/png', 'vanished.png');
  rmSync(file.stored_path);
  age(file.id);

  assert.equal(collectOrphanFiles(MINE), 1, 'A row left behind by bytes that vanished under it.');
  assert.equal(fileRow(file.id), undefined);
  assert.equal(collectOrphanFiles(MINE), 0);
});

test('the sweep at startup takes every account\'s stranded files, with no grace period', () => {
  const mine = storeUpload(MINE, png(19), 'image/png', 'stranded.png');
  const theirs = storeUpload(THEIRS, png(20), 'image/png', 'stranded-too.png');

  assert.equal(collectAllOrphanFiles(), 2);
  assert.equal(existsSync(mine.stored_path), false);
  assert.equal(existsSync(theirs.stored_path), false);
});

const SWEPT = ['case_items.file_id', 'meetings.file_id', 'records.file_id'];

test('every column in the schema that can hold a file id is one the sweep checks', () => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
  const holders = new Set<string>();
  for (const { name } of tables) {
    if (name === 'files') continue;

    const keys = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as Array<{ table: string; from: string }>;
    for (const key of keys) {
      if (key.table === 'files') holders.add(`${name}.${key.from}`);
    }
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
    for (const column of columns) {
      if (/(^|_)file_?ids?$/i.test(column.name)) holders.add(`${name}.${column.name}`);
    }
  }

  assert.deepEqual(
    [...holders].sort(),
    SWEPT,
    'A table gained a file reference. Add it to ORPHANS in files.ts, or its files will be collected while it still points at them.',
  );
});

test('an id is readable only by the account it belongs to, whoever asks', () => {
  const mine = storeUpload(MINE, png(21), 'image/png', 'mine.png');

  assert.equal(fileById(mine.id, THEIRS), null, 'Another account was handed a file row.');
  assert.ok(fileById(mine.id, MINE));

  assert.throws(() => fileBytes(mine, THEIRS), /does not exist/);
  assert.throws(() => fileBytes(mine, undefined), /does not exist/);
  assert.deepEqual(fileBytes(mine, MINE), png(21));

  const theirs = storeUpload(THEIRS, png(22), 'image/png', 'theirs.png');
  assert.throws(() => fileBytes(theirs, MINE), /does not exist/);
});

test('the startup sweep leaves a file a record still points at', () => {
  const file = storeUpload(MINE, png(23), 'image/png', 'held.png');
  addRecord('rec-held', MINE, file.id);

  assert.equal(collectAllOrphanFiles(), 0, 'The startup sweep collected a file a record holds.');
  assert.ok(fileRow(file.id));
  assert.ok(existsSync(file.stored_path));
  assert.deepEqual(fileBytes(fileById(file.id, MINE)!, MINE), png(23));

  db.prepare('DELETE FROM records WHERE id = ?').run('rec-held');
  assert.equal(collectAllOrphanFiles(), 1);
  assert.equal(fileRow(file.id), undefined);
});
