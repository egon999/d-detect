import { db } from '../db.ts';
import { newId } from '../files.ts';
import { detectAnomalies, detectPending, detectUntouchedMeetings } from './anomalies.ts';
import type { AnomalyRecord, MeetingProgress, PendingRecord } from './anomalies.ts';
import { readMaterial, ReadingUnfinished, type Material } from './extract.ts';
import { saveDrafts, retireResolved, retireOrphaned, expireStale } from './store.ts';
import { RULES_BY_DETECTOR, type DetectorGroup } from './types.ts';

const READ_BUDGET = 6;

const LOOK_BACK = 1000;

type RecordRow = {
  id: string;
  kind: string;
  title: string;
  occurred_at: number | null;
  amount_minor: number | null;
  currency: string | null;
  direction: string | null;
  counterparty: string | null;
  status: string;
  extraction: string;
  note: string | null;
  created_at: number;
};

const RECORD_COLUMNS = `id, kind, title, occurred_at, amount_minor, currency, direction,
                        counterparty, status, extraction, note, created_at`;

function textOf(row: RecordRow): string {
  let sourceText = '';
  try {
    const extraction: unknown = JSON.parse(row.extraction);
    if (extraction && typeof extraction === 'object' && 'sourceText' in extraction) {
      const value = (extraction as { sourceText?: unknown }).sourceText;
      if (typeof value === 'string') sourceText = value;
    }
  } catch {

  }
  return [sourceText, row.note ?? ''].filter(Boolean).join('\n\n').trim();
}

function isUnread(row: RecordRow): boolean {
  if (row.status === 'failed') return true;
  try {
    const extraction: unknown = JSON.parse(row.extraction);
    return Boolean(extraction && typeof extraction === 'object' && (extraction as { unread?: unknown }).unread === true);
  } catch {
    return true;
  }
}

function openQuestions(userId: string): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT q.record_id AS record_id, q.prompt AS prompt
         FROM questions q
         JOIN records r ON r.id = q.record_id
        WHERE r.user_id = ? AND q.answered_at IS NULL
        ORDER BY q.created_at ASC`,
    )
    .all(userId) as Array<{ record_id: string; prompt: string }>;

  const first = new Map<string, string>();

  for (const row of rows) if (!first.has(row.record_id)) first.set(row.record_id, row.prompt);
  return first;
}

function pendingRecords(userId: string): PendingRecord[] {
  const rows = db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM records
        WHERE user_id = ? AND status IN ('needs_context', 'failed')
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, LOOK_BACK) as RecordRow[];

  const prompts = openQuestions(userId);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    question: prompts.get(row.id) ?? null,
    unread: isUnread(row),
  }));
}

function meetingProgress(userId: string): MeetingProgress[] {
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.title AS title, m.started_at AS started_at,
              COUNT(t.id) AS items, SUM(CASE WHEN t.done_at IS NOT NULL THEN 1 ELSE 0 END) AS done
         FROM meetings m
         JOIN tasks t ON t.meeting_id = m.id AND t.user_id = m.user_id
        WHERE m.user_id = ?
        GROUP BY m.id, m.title, m.started_at
        ORDER BY m.started_at DESC
        LIMIT 200`,
    )
    .all(userId) as Array<{ id: string; title: string; started_at: number; items: number; done: number }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    items: row.items,
    done: row.done,
  }));
}

function markScanned(userId: string, subjectIds: string[]): void {
  if (subjectIds.length === 0) return;
  const now = Date.now();
  const insert = db.prepare(
    'INSERT OR REPLACE INTO signal_scans (user_id, subject_id, scanned_at) VALUES (?, ?, ?)',
  );
  db.transaction((ids: string[]) => {
    for (const id of ids) insert.run(userId, id, now);
  })(subjectIds);
}

function scannedIds(userId: string): Set<string> {
  const rows = db.prepare('SELECT subject_id FROM signal_scans WHERE user_id = ?').all(userId) as Array<{
    subject_id: string;
  }>;
  return new Set(rows.map((row) => row.subject_id));
}

export interface PassResult {

  created: number;

  read: number;

  unfinished: number;

  retired: number;
}

export async function runSignals(userId: string, now: number = Date.now()): Promise<PassResult> {
  let created = 0;
  let retired = 0;

  const records = db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM records
        WHERE user_id = ?
        ORDER BY occurred_at DESC
        LIMIT ?`,
    )
    .all(userId, LOOK_BACK) as RecordRow[];

  const evaluated = new Map<string, Set<string>>();
  const note = (group: DetectorGroup, drafts: { rule: string; fingerprint: string }[]): void => {
    const found = new Map<string, Set<string>>();
    for (const draft of drafts) {
      const set = found.get(draft.rule) ?? new Set<string>();
      set.add(draft.fingerprint);
      found.set(draft.rule, set);
    }
    for (const rule of RULES_BY_DETECTOR[group]) evaluated.set(rule, found.get(rule) ?? new Set<string>());
  };

  const forAnomalies: AnomalyRecord[] = records.map((row) => ({
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurred_at,
    amountMinor: row.amount_minor,
    currency: row.currency,
    direction: row.direction,
    counterparty: row.counterparty,
    status: row.status,
    extraction: row.extraction,
  }));

  try {
    const drafts = detectAnomalies(forAnomalies, now);
    note('money', drafts);
    created += saveDrafts(userId, drafts);
  } catch (cause) {
    console.error('[signals] money detectors failed', cause);
  }

  try {
    const drafts = detectPending(pendingRecords(userId), now);
    note('pending', drafts);
    created += saveDrafts(userId, drafts);
  } catch (cause) {
    console.error('[signals] unfinished-capture detectors failed', cause);
  }

  try {
    const drafts = detectUntouchedMeetings(meetingProgress(userId), now);
    note('meetings', drafts);
    created += saveDrafts(userId, drafts);
  } catch (cause) {
    console.error('[signals] meeting detector failed', cause);
  }

  try {

    retired += retireOrphaned(userId, now);
    retired += retireResolved(userId, evaluated, now);
    retired += expireStale(userId, now);
  } catch (cause) {
    console.error('[signals] retiring stale findings failed', cause);
  }

  const done = scannedIds(userId);
  const pending: Material[] = [];

  for (const row of records) {
    if (done.has(row.id) || pending.length >= READ_BUDGET) continue;
    const text = textOf(row);
    if (text.length < 40) continue;
    pending.push({ kind: 'record', id: row.id, title: row.title, text, occurredAt: row.occurred_at });
  }

  const meetings = db
    .prepare(
      `SELECT id, title, transcript, started_at FROM meetings
        WHERE user_id = ? AND transcript IS NOT NULL AND length(transcript) > 40
        ORDER BY started_at DESC LIMIT 200`,
    )
    .all(userId) as Array<{ id: string; title: string; transcript: string; started_at: number }>;

  for (const row of meetings) {
    if (done.has(row.id) || pending.length >= READ_BUDGET) continue;
    pending.push({
      kind: 'meeting',
      id: row.id,
      title: row.title,
      text: row.transcript,
      occurredAt: row.started_at,
    });
  }

  const scanned: string[] = [];
  let read = 0;
  let unfinished = 0;
  for (const material of pending) {
    try {
      created += saveDrafts(userId, await readMaterial(material));
      scanned.push(material.id);
      read += 1;
    } catch (cause) {
      unfinished += 1;
      if (cause instanceof ReadingUnfinished && !cause.retryable) scanned.push(material.id);
      console.error('[signals] could not read material', material.id, cause);
    }
  }
  markScanned(userId, scanned);

  return { created, read, unfinished, retired };
}

const inFlight = new Map<string, Promise<unknown>>();
const again = new Set<string>();

function track(userId: string, pass: Promise<unknown>): void {
  inFlight.set(
    userId,
    pass.finally(() => {
      inFlight.delete(userId);
      if (again.delete(userId)) scheduleSignals(userId);
    }),
  );
}

export function scheduleSignals(userId: string): void {
  if (inFlight.has(userId)) {
    again.add(userId);
    return;
  }

  track(
    userId,
    runSignals(userId).catch((cause: unknown) => {
      console.error('[signals] pass failed', cause);
    }),
  );
}

export { retireOrphaned } from './store.ts';

const PASS_KIND = 'attention';

const PASS_CEILING_MS = 12 * 60_000;

type PassJobRow = { id: string; status: string; detail: string | null; created_at: number; updated_at: number };

export interface LastLook {

  at: number;

  found: number;

  read: number;

  unfinished: number;

  completed: boolean;

  notice: string | null;
}

export interface LookView {

  looking: boolean;

  startedAt: number | null;

  lastLook: LastLook | null;
}

function passJob(userId: string, unfinished: boolean): PassJobRow | undefined {
  return db
    .prepare(
      `SELECT id, status, detail, created_at, updated_at FROM jobs
        WHERE user_id = ? AND kind = ? AND status ${unfinished ? 'NOT IN' : 'IN'} ('done', 'failed')
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(userId, PASS_KIND) as PassJobRow | undefined;
}

function lastLookOf(row: PassJobRow | undefined): LastLook | null {
  if (!row) return null;

  let found = 0;
  let read = 0;
  let unfinished = 0;
  try {

    const parsed: unknown = row.detail === null ? null : JSON.parse(row.detail);
    if (parsed !== null && typeof parsed === 'object') {
      const counts = parsed as { found?: unknown; read?: unknown; unfinished?: unknown };
      if (typeof counts.found === 'number') found = counts.found;
      if (typeof counts.read === 'number') read = counts.read;
      if (typeof counts.unfinished === 'number') unfinished = counts.unfinished;
    }
  } catch {

  }

  const completed = row.status === 'done';

  const notice = completed
    ? unfinished > 0
      ? `${unfinished === 1 ? 'One of your entries' : `${unfinished} of your entries`} could not be read this time, so anything in ${unfinished === 1 ? 'it' : 'them'} is not on this list yet. Try looking again.`
      : null
    : 'The last look did not finish, so this list may be missing something. Try looking again.';

  return { at: row.updated_at, found, read, unfinished, completed, notice };
}

export function lookView(userId: string, now: number = Date.now()): LookView {
  const unfinished = passJob(userId, true);
  const running = unfinished !== undefined && now - unfinished.updated_at < PASS_CEILING_MS ? unfinished : null;

  return {
    looking: inFlight.has(userId) || running !== null,
    startedAt: running?.created_at ?? null,
    lastLook: lastLookOf(passJob(userId, false)),
  };
}

function endPass(
  jobId: string,
  status: 'done' | 'failed',
  counts: { found: number; read: number; unfinished: number },
): void {
  db.prepare('UPDATE jobs SET status = ?, detail = ?, updated_at = ? WHERE id = ?').run(
    status,
    JSON.stringify(counts),
    Date.now(),
    jobId,
  );
}

async function withJobRow(userId: string, jobId: string): Promise<void> {
  try {
    const result = await runSignals(userId);
    endPass(jobId, 'done', { found: result.created, read: result.read, unfinished: result.unfinished });
  } catch (cause) {

    console.error('[signals] pass failed', cause);
    endPass(jobId, 'failed', { found: 0, read: 0, unfinished: 0 });
  }
}

export function startLook(userId: string): boolean {
  if (inFlight.has(userId)) return false;

  const now = Date.now();
  const jobId = newId('job');

  db.transaction(() => {

    db.prepare(
      `UPDATE jobs SET status = 'failed', updated_at = ?
        WHERE user_id = ? AND kind = ? AND status NOT IN ('done', 'failed')`,
    ).run(now, userId, PASS_KIND);

    db.prepare(
      `INSERT INTO jobs (id, user_id, kind, subject_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'looking', ?, ?)`,
    ).run(jobId, userId, PASS_KIND, userId, now, now);
  })();

  track(userId, withJobRow(userId, jobId));
  return true;
}
