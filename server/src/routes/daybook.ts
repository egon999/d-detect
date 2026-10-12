import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { accountOf } from '../auth.ts';
import { db } from '../db.ts';
import { askJson, RATE_LIMIT_WAIT_BUDGET_MS } from '../ai/index.ts';
import { config } from '../env.ts';
import { readSource, understand } from '../extract.ts';
import { extractFacts } from '../facts.ts';
import { fileById, isAudio, newId, storeUpload, UploadRefused } from '../files.ts';
import { exponentFor, formatMinorUnits, normalizeCurrency, toEpoch, toMinorUnits } from '../money.ts';
import { scheduleSignals } from '../signals/index.ts';
import type { Account } from '../auth.ts';

type Variables = { account: Account };

export type RecordRow = {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  occurred_at: number | null;
  occurred_precision: string | null;
  amount_minor: number | null;
  currency: string | null;
  direction: string | null;
  counterparty: string | null;
  category: string | null;
  note: string | null;
  file_id: string | null;
  extraction: string;
  status: string;
  created_at: number;
  updated_at: number;
};

type QuestionRow = {
  id: string;
  record_id: string;
  field: string;
  prompt: string;
  options: string;
  answer: string | null;
  answered_at: number | null;
  created_at: number;
};

function sortKeyOf(row: RecordRow): number {
  return row.occurred_at ?? row.created_at;
}

function openQuestions(recordIds: string[]): Map<string, QuestionRow> {
  const found = new Map<string, QuestionRow>();
  if (recordIds.length === 0) return found;
  const rows = db
    .prepare(
      `SELECT * FROM questions WHERE answered_at IS NULL AND record_id IN (${recordIds.map(() => '?').join(', ')})
       ORDER BY created_at`,
    )
    .all(...recordIds) as QuestionRow[];
  for (const row of rows) if (!found.has(row.record_id)) found.set(row.record_id, row);
  return found;
}

type JobProgressRow = { subject_id: string; status: string; attempts: number };

const READING = 'Reading the file.';

function progressSentence(job: JobProgressRow | undefined): string {
  const again = (job?.attempts ?? 1) > 1;
  switch (job?.status) {
    case 'queued':
      return again ? 'Waiting its turn to be read again.' : 'Waiting its turn to be read.';
    case 'reading':
      return again ? 'Reading the file again.' : READING;
    case 'understanding':
      return 'Working out what it says.';
    default:

      return READING;
  }
}

function readProgress(recordIds: string[]): Map<string, string> {
  const found = new Map<string, string>();
  if (recordIds.length === 0) return found;
  const rows = db
    .prepare(
      `SELECT subject_id, status, attempts FROM jobs
        WHERE kind = 'capture' AND subject_id IN (${recordIds.map(() => '?').join(', ')})
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(...recordIds) as JobProgressRow[];
  for (const row of rows) if (!found.has(row.subject_id)) found.set(row.subject_id, progressSentence(row));
  return found;
}

function present(row: RecordRow, open?: Map<string, QuestionRow>, progress?: Map<string, string>): Record<string, unknown> {
  const question = (open ?? openQuestions([row.id])).get(row.id);

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    occurredAt: row.occurred_at,
    occurredPrecision: row.occurred_precision,
    amountMinor: row.amount_minor,
    currency: row.currency,
    amountLabel:
      row.amount_minor !== null && row.currency ? formatMinorUnits(row.amount_minor, row.currency) : null,
    direction: row.direction,
    counterparty: row.counterparty,
    category: row.category,
    note: row.note,
    fileId: row.file_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    extraction: showableExtraction(row.extraction),

    progress: row.status === 'processing' ? (progress ?? readProgress([row.id])).get(row.id) ?? READING : null,
    question: question
      ? {
          id: question.id,
          field: question.field,
          prompt: question.prompt,
          options: parseOptions(question.options),
        }
      : null,
  };
}

function parseExtraction(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

const SHOWABLE_EXTRACTION_KEYS = ['readBy', 'readNote', 'reference', 'status', 'summary', 'sourceText', 'unread'] as const;

function showableExtraction(raw: string): Record<string, unknown> {
  const stored = parseExtraction(raw);
  const shown: Record<string, unknown> = {};
  for (const key of SHOWABLE_EXTRACTION_KEYS) {
    if (stored[key] !== undefined) shown[key] = stored[key];
  }
  return shown;
}

function parseOptions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

async function labelCategory(recordId: string, answer: string, counterparty: string | null): Promise<void> {
  try {
    const { value } = await askJson(z.object({ category: z.string().min(1).max(40) }), {
      messages: [
        {
          role: 'system',
          content:
            'You label a personal spending record with one short category, in JSON as {"category":"..."}. ' +
            'Use two words at most, title case, the kind of label a budgeting app groups by — ' +
            'for example Groceries, Electronics, Rent, Travel, Eating Out, Medical. ' +
            'Use the same language as the input. Return nothing else.',
        },
        {
          role: 'user',
          content: counterparty ? `Paid to: ${counterparty}\nPurpose: ${answer}` : `Purpose: ${answer}`,
        },
      ],
      temperature: 0,
      maxTokens: 64,
    });
    const category = value.category.trim();
    if (category) {
      db.prepare('UPDATE records SET category = ?, updated_at = ? WHERE id = ? AND category IS NULL').run(
        category,
        Date.now(),
        recordId,
      );
    }
  } catch {

  }
}

function setStatus(recordId: string, status: string, note?: string | null): void {
  db.prepare('UPDATE records SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?').run(
    status,
    note ?? null,
    Date.now(),
    recordId,
  );
}

function setJob(jobId: string, status: string, detail: string | null): void {
  db.prepare('UPDATE jobs SET status = ?, detail = ?, updated_at = ? WHERE id = ?').run(
    status,
    detail,
    Date.now(),
    jobId,
  );
}

const RECORD_GONE = 'The record was deleted while it was being read.';

class CaptureProblem extends Error {}

type Ask = { field: string; question: string; options: string[] };

const UNREADABLE_QUESTION = 'Nothing could be read from this. What is it? A few words is enough.';

const MONEY_KINDS = new Set(['payment', 'purchase', 'bill', 'receipt']);

function ownsRecord(recordId: string, userId: string): boolean {
  return db.prepare('SELECT id FROM records WHERE id = ? AND user_id = ?').get(recordId, userId) !== undefined;
}

async function jsonObject(context: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const parsed = await context.req.json().catch(() => null);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function replaceQuestion(recordId: string, ask: Ask | null): void {
  db.prepare('DELETE FROM questions WHERE record_id = ? AND answered_at IS NULL').run(recordId);
  if (!ask) return;
  db.prepare(
    `INSERT INTO questions (id, record_id, field, prompt, options, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newId('q'), recordId, ask.field, ask.question, JSON.stringify(ask.options), Date.now());
}

function openQuestionOf(recordId: string): QuestionRow | undefined {
  return db
    .prepare('SELECT * FROM questions WHERE record_id = ? AND answered_at IS NULL ORDER BY created_at LIMIT 1')
    .get(recordId) as QuestionRow | undefined;
}

function otherOpenQuestions(recordId: string, settlingId: string | null): boolean {
  return (
    db
      .prepare('SELECT id FROM questions WHERE record_id = ? AND answered_at IS NULL AND id <> ? LIMIT 1')
      .get(recordId, settlingId ?? '') !== undefined
  );
}

function closeQuestion(questionId: string, answer: string | null, when: number): void {
  db.prepare('UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?').run(answer, when, questionId);
}

function currencyWritten(raw: string): string | null {
  const match = /^([^\d+-]*)[+-]?\d[\d.,]*([^\d]*)$/.exec(raw.trim());
  if (!match) return null;
  for (const label of [match[1], match[2]]) {
    const code = label?.trim() ? normalizeCurrency(label.trim()) : null;
    if (code) return code;
  }
  return null;
}

function statedAlready(
  field: string,
  saving: { amountMinor: number | null; occurredAt: number | null; counterparty: string | null },
): boolean {
  switch (field.toLowerCase()) {
    case 'amount':
      return saving.amountMinor !== null;
    case 'date':
      return saving.occurredAt !== null;
    case 'counterparty':
      return Boolean(saving.counterparty?.trim());
    default:
      return false;
  }
}

function failCapture(recordId: string, jobId: string, cause: unknown): void {
  const detail = cause instanceof Error ? cause.message : String(cause);
  try {
    setStatus(
      recordId,
      'failed',
      cause instanceof CaptureProblem ? detail : 'This could not be read. Try again, or type in the details yourself.',
    );
  } catch {  }
  try {
    setJob(jobId, 'failed', detail.slice(0, 2_000));
  } catch {  }
}

async function processCapture(userId: string, recordId: string, jobId: string): Promise<void> {
  try {
    const row = db.prepare('SELECT * FROM records WHERE id = ? AND user_id = ?').get(recordId, userId) as
      | RecordRow
      | undefined;
    if (!row) {
      setJob(jobId, 'cancelled', RECORD_GONE);
      return;
    }
    if (!row.file_id) throw new CaptureProblem('That record has no file.');

    const file = fileById(row.file_id, userId);
    if (!file) throw new CaptureProblem('That file is no longer stored.');

    setJob(jobId, 'reading', null);
    const source = await readSource(file, userId);

    if (!source.text.trim()) {
      const note = source.note ?? 'Nothing could be read from this file.';
      db.transaction(() => {
        if (!ownsRecord(recordId, userId)) return;
        db.prepare(
          `UPDATE records SET note = ?, extraction = ?, status = 'needs_context', updated_at = ? WHERE id = ?`,
        ).run(note, JSON.stringify({ readBy: source.method, readNote: note, unread: true }), Date.now(), recordId);
        replaceQuestion(recordId, { field: 'other', question: UNREADABLE_QUESTION, options: [] });
      })();
      setJob(jobId, 'done', 'Nothing readable in the file; asked the person instead.');
      return;
    }

    setJob(jobId, 'understanding', null);
    const { record, provider, model } = await understand(source, file.original_name);

    const described = source.method === 'scene';
    const currency = described ? null : normalizeCurrency(record.currency);
    const proposedAmount = toMinorUnits(record.amount, currency);
    const facts = extractFacts(source.text);
    const amountSupported = facts.amounts.some((amount) => amount.minor === proposedAmount && amount.currency === currency) ||
      [...source.text.matchAll(/\d[\d,.]*/g)].some((match) => toMinorUnits(match[0], currency) === proposedAmount);
    const amountMinor = proposedAmount !== null && proposedAmount >= 0 && amountSupported ? proposedAmount : null;
    const when = toEpoch(described ? null : record.occurredAt, record.occurredPrecision);

    const unplacedAmount = !described && amountMinor === null && record.amount !== null;
    const proposedContext: Ask | null = unplacedAmount
      ? {
          field: 'amount',
          question: currency === null ? 'What was the amount? Include the currency.' : 'What was the amount?',
          options: [],
        }
      : record.missingContext ??
        (described ? { field: 'other', question: 'What is this picture about?', options: [] } : null);

    const counterparty = described ? null : record.counterparty;
    const missingContext =
      proposedContext && statedAlready(proposedContext.field, { amountMinor, occurredAt: when.at, counterparty })
        ? null
        : proposedContext;

    const extraction = {
      readBy: source.method,
      readNote: source.note,
      provider,
      model,
      reference: described ? null : record.reference,
      status: described ? null : record.status,
      summary: record.summary,
      sourceText: source.text.slice(0, 8_000),
    };

    db.transaction(() => {
      if (!ownsRecord(recordId, userId)) return;
      db.prepare(
        `UPDATE records SET
           kind = ?, title = ?, occurred_at = ?, occurred_precision = ?,
           amount_minor = ?, currency = ?, direction = ?, counterparty = ?, category = ?,
           extraction = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        described && MONEY_KINDS.has(record.kind) ? 'other' : record.kind,
        record.title,
        when.at,
        when.precision,
        amountMinor,
        currency,
        described ? null : record.direction,
        counterparty,
        record.category,
        JSON.stringify(extraction),
        missingContext ? 'needs_context' : 'complete',
        Date.now(),
        recordId,
      );

      replaceQuestion(recordId, missingContext);
    })();

    setJob(jobId, 'done', null);
  } catch (cause) {
    failCapture(recordId, jobId, cause);
  }
}

const CAPTURE_LIMIT = 3;
const waiting: Array<() => Promise<void>> = [];
let running = 0;

const inFlight = new Set<string>();

function pump(): void {
  while (running < CAPTURE_LIMIT) {
    const next = waiting.shift();
    if (!next) return;
    running += 1;
    void next()
      .catch(() => {})
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

function queueCapture(userId: string, recordId: string, jobId: string): void {
  inFlight.add(recordId);
  waiting.push(async () => {
    try {
      await processCapture(userId, recordId, jobId);
    } finally {

      inFlight.delete(recordId);
    }

    scheduleSignals(userId);
  });
  pump();
}

function attemptNumber(recordId: string): number {
  const prior = db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'capture' AND subject_id = ?`)
    .get(recordId) as { n: number };
  return prior.n + 1;
}

function startCaptureJob(userId: string, recordId: string, now: number): string {
  const jobId = newId('job');
  db.prepare(
    `INSERT INTO jobs (id, user_id, kind, subject_id, status, attempts, created_at, updated_at)
     VALUES (?, ?, 'capture', ?, 'queued', ?, ?, ?)`,
  ).run(jobId, userId, recordId, attemptNumber(recordId), now, now);
  return jobId;
}

function restartCapture(userId: string, recordId: string): RecordRow {
  const now = Date.now();
  db.prepare(`UPDATE records SET status = 'processing', note = NULL, updated_at = ? WHERE id = ?`).run(now, recordId);

  queueCapture(userId, recordId, startCaptureJob(userId, recordId, now));
  return db.prepare('SELECT * FROM records WHERE id = ?').get(recordId) as RecordRow;
}

const BOOT_AT = Date.now();

const RESUME_ATTEMPT_LIMIT = 1;

const RESUME_CEILING = 12;

export function resumeInterruptedReads(settledAfter = BOOT_AT): number {
  const stranded = db
    .prepare(
      `SELECT id, user_id FROM records
        WHERE status = 'failed' AND file_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM jobs
             WHERE jobs.kind = 'capture' AND jobs.subject_id = records.id
               AND jobs.status = 'failed' AND jobs.attempts <= ? AND jobs.updated_at >= ?
          )
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(RESUME_ATTEMPT_LIMIT, settledAfter, RESUME_CEILING) as Array<{ id: string; user_id: string }>;

  for (const record of stranded) restartCapture(record.user_id, record.id);
  return stranded.length;
}

const MODEL_CALLS_PER_READ = 4;
export const STALE_READ_AFTER_MS =
  (MODEL_CALLS_PER_READ + 1) * (config.ai.timeoutMs + RATE_LIMIT_WAIT_BUDGET_MS);

const ABANDONED = 'Reading this stopped before it finished. Try again, or type in the details yourself.';

function isStale(row: RecordRow, now = Date.now()): boolean {
  return row.status === 'processing' && !inFlight.has(row.id) && now - row.updated_at > STALE_READ_AFTER_MS;
}

export function settleAbandonedReads(now = Date.now()): number {
  const cutoff = now - STALE_READ_AFTER_MS;
  const stale = db
    .prepare(`SELECT id FROM records WHERE status = 'processing' AND updated_at < ?`)
    .all(cutoff) as Array<{ id: string }>;

  const settleRecord = db.prepare(
    `UPDATE records SET status = 'failed', note = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND updated_at < ?`,
  );
  const settleJobs = db.prepare(
    `UPDATE jobs SET status = 'failed', detail = ?, updated_at = ?
      WHERE kind = 'capture' AND subject_id = ? AND status NOT IN ('done', 'failed', 'cancelled')`,
  );

  let settled = 0;
  for (const row of stale) {
    if (inFlight.has(row.id)) continue;
    if (settleRecord.run(ABANDONED, now, row.id, cutoff).changes === 0) continue;
    settleJobs.run('Nothing wrote a result before the read was abandoned.', now, row.id);
    settled += 1;
  }
  return settled;
}

export const staleReadSweep: NodeJS.Timeout = setInterval(() => {
  try {
    settleAbandonedReads();
  } catch {

  }
}, 60_000).unref();

function isStuck(status: string): boolean {
  return status === 'failed' || status === 'unreadable';
}

function uploadRefusal(cause: unknown): string {
  const couldNotStore = 'That file could not be saved just now. Try sending it again.';
  if (cause instanceof UploadRefused) return cause.message;
  console.error('[detact] could not store an upload:', cause);
  return couldNotStore;
}

export const daybook = new Hono<{ Variables: Variables }>();

daybook.post('/capture', async (context) => {
  const account = accountOf(context);
  const body = await context.req.parseBody();
  const upload = body['file'];

  if (!(upload instanceof File)) {
    throw new HTTPException(400, { message: 'Attach a file.' });
  }
  if (isAudio(upload.type)) {
    throw new HTTPException(400, { message: 'Audio belongs in a meeting, not a record.' });
  }

  const bytes = new Uint8Array(await upload.arrayBuffer());

  let file;
  try {
    file = storeUpload(account.id, bytes, upload.type || 'application/octet-stream', upload.name || 'upload');
  } catch (cause) {
    throw new HTTPException(400, { message: uploadRefusal(cause) });
  }

  const now = Date.now();
  const duplicate = db.prepare('SELECT * FROM records WHERE user_id = ? AND file_id = ? ORDER BY created_at LIMIT 1')
    .get(account.id, file.id) as RecordRow | undefined;
  if (duplicate) {

    if (isStuck(duplicate.status) || isStale(duplicate)) {
      return context.json({ record: present(restartCapture(account.id, duplicate.id)), duplicate: true, retrying: true }, 202);
    }
    return context.json({ record: present(duplicate), duplicate: true });
  }
  const recordId = newId('rec');
  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, file_id, extraction, status, created_at, updated_at)
     VALUES (?, ?, 'other', ?, ?, '{}', 'processing', ?, ?)`,
  ).run(recordId, account.id, file.original_name, file.id, now, now);

  queueCapture(account.id, recordId, startCaptureJob(account.id, recordId, now));

  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId) as RecordRow;
  return context.json({ record: present(row) }, 202);
});

const ManualRecord = z.object({
  title: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(32).default('note'),
  note: z.string().max(4_000).optional(),
  amount: z.string().optional(),
  currency: z.string().optional(),
  direction: z.enum(['out', 'in']).optional(),
  counterparty: z.string().max(120).optional(),
  category: z.string().max(60).optional(),
  occurredAt: z.string().optional(),
});

daybook.post('/records', async (context) => {
  const account = accountOf(context);
  const parsed = ManualRecord.safeParse(await jsonObject(context));
  if (!parsed.success) throw new HTTPException(400, { message: 'Give the record a title.' });

  const input = parsed.data;
  const currency = normalizeCurrency(input.currency ?? (input.amount ? 'INR' : null));
  const when = toEpoch(input.occurredAt ?? null, null);
  const amountMinor = toMinorUnits(input.amount ?? null, currency);
  if (input.currency && !currency) throw new HTTPException(400, { message: 'Choose a supported currency.' });
  if (input.amount && (amountMinor === null || amountMinor < 0)) throw new HTTPException(400, { message: 'Enter a valid positive amount and choose whether it was paid or received.' });
  if (input.occurredAt && when.at === null) throw new HTTPException(400, { message: 'Enter a valid date.' });
  const now = Date.now();
  const id = newId('rec');

  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, occurred_precision, amount_minor,
       currency, direction, counterparty, category, note, extraction, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)`,
  ).run(
    id,
    account.id,
    input.kind,
    input.title,
    when.at ?? now,
    when.precision ?? 'minute',
    amountMinor,
    currency,
    input.direction ?? null,
    input.counterparty ?? null,
    input.category ?? null,
    input.note ?? null,
    JSON.stringify({ readBy: 'manual' }),
    now,
    now,
  );

  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow;

  if (amountMinor !== null && !input.category) {
    const purpose = [input.title, input.note].filter(Boolean).join(' — ');
    void labelCategory(id, purpose, input.counterparty ?? null);
  }

  return context.json({ record: present(row) }, 201);
});

function queryFilter(context: { req: { query: (key: string) => string | undefined } }, name: string): string | null {
  const raw = context.req.query(name);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

daybook.get('/records', (context) => {
  const account = accountOf(context);
  const limit = Math.max(1, Math.min(Number.parseInt(context.req.query('limit') ?? '100', 10) || 100, 500));
  const rawCursor = context.req.query('before');

  const cursor = rawCursor === undefined ? null : /^\d+$/.test(rawCursor) ? Number(rawCursor) : Number.NaN;
  if (cursor !== null && !Number.isSafeInteger(cursor)) {
    throw new HTTPException(400, { message: 'That page could not be loaded. Open the timeline again.' });
  }

  const counterparty = queryFilter(context, 'counterparty');
  if (counterparty !== null && counterparty.length > 120) {
    throw new HTTPException(400, { message: 'That name is too long to filter by.' });
  }
  const category = queryFilter(context, 'category');
  if (category !== null && category.length > 60) {
    throw new HTTPException(400, { message: 'That label is too long to filter by.' });
  }

  const filters: string[] = [];
  const filterValues: unknown[] = [];
  if (counterparty !== null) {
    filters.push(`AND lower(trim(COALESCE(counterparty, ''))) = lower(?)`);
    filterValues.push(counterparty);
  }
  if (category !== null) {
    filters.push(`AND lower(trim(COALESCE(category, ''))) = lower(?)`);
    filterValues.push(category);
  }
  const where = filters.join('\n         ');

  const ordered = `ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC`;
  const page = db
    .prepare(
      `SELECT * FROM records WHERE user_id = ?
         AND (? IS NULL OR COALESCE(occurred_at, created_at) < ?)
         ${where}
       ${ordered} LIMIT ?`,
    )
    .all(account.id, cursor, cursor, ...filterValues, limit + 1) as RecordRow[];

  const beyond = page[limit];
  const rows = page.slice(0, limit);
  const edge = rows.at(-1);
  let more = beyond !== undefined;
  if (beyond && edge && sortKeyOf(edge) === sortKeyOf(beyond)) {
    rows.push(
      ...(db
        .prepare(
          `SELECT * FROM records WHERE user_id = ? AND COALESCE(occurred_at, created_at) = ? AND id < ?
             ${where}
           ${ordered}`,
        )
        .all(account.id, sortKeyOf(edge), edge.id, ...filterValues) as RecordRow[]),
    );

    more =
      db
        .prepare(
          `SELECT 1 FROM records WHERE user_id = ? AND COALESCE(occurred_at, created_at) < ?
             ${where}
           LIMIT 1`,
        )
        .get(account.id, sortKeyOf(edge), ...filterValues) !== undefined;
  }

  const open = openQuestions(rows.map((row) => row.id));
  const progress = readProgress(rows.filter((row) => row.status === 'processing').map((row) => row.id));
  const youngest = rows.at(-1);
  return context.json({
    records: rows.map((row) => present(row, open, progress)),
    nextCursor: more && youngest ? sortKeyOf(youngest) : null,
  });
});

daybook.get('/records/:id', (context) => {
  const account = accountOf(context);
  const row = db
    .prepare('SELECT * FROM records WHERE id = ? AND user_id = ?')
    .get(context.req.param('id'), account.id) as RecordRow | undefined;
  if (!row) throw new HTTPException(404, { message: 'That record does not exist.' });
  return context.json({ record: present(row) });
});

daybook.post('/records/:id/answer', async (context) => {
  const account = accountOf(context);
  const recordId = context.req.param('id');

  const mine = () => db.prepare('SELECT * FROM records WHERE id = ? AND user_id = ?').get(recordId, account.id) as
    | RecordRow
    | undefined;

  let row = mine();
  if (!row) throw new HTTPException(404, { message: 'That record does not exist.' });

  const body = (await jsonObject(context)) as { answer?: unknown };
  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (!answer || answer.length > 4_000) throw new HTTPException(400, { message: 'Write an answer of up to 4,000 characters.' });

  row = mine();
  if (!row) throw new HTTPException(404, { message: 'That record does not exist.' });

  const question = openQuestionOf(recordId);

  if (!question || row.status !== 'needs_context') {
    throw new HTTPException(409, { message: 'This record is not waiting on anything.' });
  }

  const now = Date.now();

  const field = (question?.field ?? 'other').toLowerCase();

  const alreadyStated = field === 'amount'
    ? row.amount_minor !== null
    : field === 'date'
    ? row.occurred_at !== null
    : field === 'counterparty' && Boolean(row.counterparty?.trim());
  if (alreadyStated) {
    db.transaction(() => {
      closeQuestion(question.id, null, now);
      if (!otherOpenQuestions(recordId, question.id)) {
        db.prepare(`UPDATE records SET status = 'complete', updated_at = ? WHERE id = ? AND user_id = ?`).run(
          now, recordId, account.id,
        );
      }
    })();
    const settled = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId) as RecordRow;
    return context.json({ record: present(settled), answerApplied: false });
  }

  const patch: string[] = [];
  const values: unknown[] = [];
  let handled = false;

  if (field === 'amount') {

    const currency = currencyWritten(answer) ?? row.currency;
    if (!currency) {
      throw new HTTPException(400, { message: 'Write the amount with its currency, for example ₹1,250.50 or 20 USD.' });
    }
    const minor = toMinorUnits(answer, currency);
    if (minor === null || minor < 0) throw new HTTPException(400, { message: 'Enter one valid amount, for example 1,250.50.' });
    patch.push('amount_minor = ?', 'currency = ?');
    values.push(minor, currency);
    handled = true;
  } else if (field === 'date') {
    const when = toEpoch(answer, null);
    if (when.at === null) throw new HTTPException(400, { message: 'Enter a valid date, for example 26/09/2026.' });
    if (when.at !== null) {
      patch.push('occurred_at = ?', 'occurred_precision = ?');
      values.push(when.at, when.precision ?? 'day');
      handled = true;
    }
  } else if (field === 'counterparty') {
    patch.push('counterparty = ?');
    values.push(answer.slice(0, 120));
    handled = true;
  } else if (field === 'purpose' || field === 'category') {

    const options = parseOptions(question?.options ?? null);
    const picked = options.find((option) => option.toLowerCase() === answer.toLowerCase());
    if (picked || answer.length <= 40) {
      patch.push('category = ?');
      values.push(picked ?? answer);
    } else {
      patch.push('note = ?');
      values.push(answer);
    }
    handled = true;
  }

  if (!handled) {
    patch.push('note = ?');
    values.push(answer);

    if (parseExtraction(row.extraction).unread === true && answer.length <= 120) {
      patch.push('title = ?');
      values.push(answer);
    }
  }

  db.transaction(() => {
    closeQuestion(question.id, answer, now);
    const remaining = otherOpenQuestions(recordId, question.id);
    db.prepare(`UPDATE records SET ${patch.join(', ')}, status = ?, updated_at = ? WHERE id = ? AND user_id = ?`).run(
      ...values, remaining ? 'needs_context' : 'complete', now, recordId, account.id,
    );
  })();

  if ((field === 'purpose' || field === 'category') && answer.length > 40) {
    void labelCategory(recordId, answer, row.counterparty);
  }

  scheduleSignals(account.id);

  const updated = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId) as RecordRow;
  return context.json({ record: present(updated), answerApplied: true });
});

daybook.post('/records/:id/question/skip', (context) => {
  const account = accountOf(context);
  const recordId = context.req.param('id');

  const row = db.prepare('SELECT * FROM records WHERE id = ? AND user_id = ?').get(recordId, account.id) as
    | RecordRow
    | undefined;
  if (!row) throw new HTTPException(404, { message: 'That record does not exist.' });

  const question = openQuestionOf(recordId);
  if (!question) throw new HTTPException(409, { message: 'This record is not waiting on anything.' });

  const now = Date.now();
  db.transaction(() => {
    closeQuestion(question.id, null, now);

    if (row.status === 'needs_context' && !otherOpenQuestions(recordId, question.id)) {
      db.prepare(`UPDATE records SET status = 'complete', updated_at = ? WHERE id = ? AND user_id = ?`).run(
        now,
        recordId,
        account.id,
      );
    }
  })();

  scheduleSignals(account.id);

  const updated = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId) as RecordRow;
  return context.json({ record: present(updated) });
});

const RecordPatch = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  kind: z.string().trim().min(1).max(32).optional(),
  note: z.string().max(4_000).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  counterparty: z.string().max(120).nullable().optional(),
  amount: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),

  direction: z.enum(['out', 'in']).nullable().optional(),
  occurredAt: z.string().nullable().optional(),
});

type RecordEdit = z.infer<typeof RecordPatch>;

function answerFromEdit(field: string, edit: RecordEdit): string | null {
  const written = (value: string | null | undefined): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

  switch (field.toLowerCase()) {
    case 'amount':

      return written(edit.amount);
    case 'date':
      return written(edit.occurredAt);
    case 'counterparty':
      return written(edit.counterparty);
    case 'purpose':
    case 'category':
      return written(edit.category) ?? written(edit.note);
    default:

      return written(edit.note) ?? written(edit.title);
  }
}

function statusAfterEdit(row: RecordRow, settled: boolean, asking: boolean, gave: boolean): string {
  if (row.status === 'needs_context') return !asking && (settled || gave) ? 'complete' : 'needs_context';

  if (isStuck(row.status) && gave) return 'complete';
  return row.status;
}

daybook.patch('/records/:id', async (context) => {
  const account = accountOf(context);
  const recordId = context.req.param('id');
  const row = db.prepare('SELECT * FROM records WHERE id = ? AND user_id = ?').get(recordId, account.id) as
    | RecordRow
    | undefined;
  if (!row) throw new HTTPException(404, { message: 'That record does not exist.' });

  const parsed = RecordPatch.safeParse(await jsonObject(context));
  if (!parsed.success) throw new HTTPException(400, { message: 'That change could not be applied.' });
  const patch = parsed.data;

  const currency = patch.currency !== undefined ? normalizeCurrency(patch.currency) : row.currency;
  let amountMinor = patch.amount !== undefined ? toMinorUnits(patch.amount, currency) : row.amount_minor;
  const when = patch.occurredAt !== undefined ? toEpoch(patch.occurredAt, null) : null;
  if (patch.currency !== undefined && patch.currency !== null && !currency) {
    throw new HTTPException(400, { message: 'Choose a supported currency.' });
  }
  if (patch.amount !== undefined && patch.amount !== null && (amountMinor === null || amountMinor < 0)) {
    throw new HTTPException(400, { message: 'Enter one valid positive amount.' });
  }
  if (patch.occurredAt !== undefined && patch.occurredAt !== null && when?.at === null) {
    throw new HTTPException(400, { message: 'Enter a valid date.' });
  }
  if (patch.amount === undefined && amountMinor !== null && currency !== row.currency) {
    if (!currency || !row.currency) throw new HTTPException(400, { message: 'Enter the amount when changing its currency.' });
    amountMinor = amountMinor * 10 ** (exponentFor(currency) - exponentFor(row.currency));
    if (!Number.isSafeInteger(amountMinor)) throw new HTTPException(400, { message: 'Enter an amount that is valid in the new currency.' });
  }

  const pending = openQuestionOf(recordId);
  const answer = pending ? answerFromEdit(pending.field, patch) : null;
  const settling = answer === null ? null : pending ?? null;

  const gave = [patch.amount, patch.currency, patch.direction, patch.occurredAt, patch.counterparty, patch.category, patch.note]
    .some((value) => value !== undefined && value !== null);
  const now = Date.now();

  db.transaction(() => {
    if (settling && answer !== null) closeQuestion(settling.id, answer, now);
    const asking = otherOpenQuestions(recordId, settling?.id ?? null);
    const status = statusAfterEdit(row, settling !== null, asking, gave);

    const dropFailureNote = patch.note === undefined && isStuck(row.status) && status === 'complete';

    db.prepare(
      `UPDATE records SET
         title = COALESCE(?, title), kind = COALESCE(?, kind),
         note = CASE WHEN ? THEN ? ELSE note END,
         category = CASE WHEN ? THEN ? ELSE category END,
         counterparty = CASE WHEN ? THEN ? ELSE counterparty END,
         direction = CASE WHEN ? THEN ? ELSE direction END,
         amount_minor = ?, currency = ?,
         occurred_at = CASE WHEN ? THEN ? ELSE occurred_at END,
         occurred_precision = CASE WHEN ? THEN ? ELSE occurred_precision END,
         status = ?,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.title ?? null,
      patch.kind ?? null,
      patch.note !== undefined || dropFailureNote ? 1 : 0,
      patch.note ?? null,
      patch.category !== undefined ? 1 : 0,
      patch.category ?? null,
      patch.counterparty !== undefined ? 1 : 0,
      patch.counterparty ?? null,
      patch.direction !== undefined ? 1 : 0,
      patch.direction ?? null,
      amountMinor,
      currency,
      patch.occurredAt !== undefined ? 1 : 0,
      when?.at ?? null,
      patch.occurredAt !== undefined ? 1 : 0,
      when?.precision ?? null,
      status,
      now,
      recordId,
    );
  })();

  const updated = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId) as RecordRow;
  return context.json({ record: present(updated) });
});

daybook.delete('/records/:id', (context) => {
  const account = accountOf(context);
  const result = db
    .prepare('DELETE FROM records WHERE id = ? AND user_id = ?')
    .run(context.req.param('id'), account.id);
  if (result.changes === 0) throw new HTTPException(404, { message: 'That record does not exist.' });

  scheduleSignals(account.id);

  return context.json({ deleted: true });
});

daybook.post('/records/:id/retry', (context) => {
  const account = accountOf(context);
  const recordId = context.req.param('id');
  const row = db.prepare('SELECT * FROM records WHERE id = ? AND user_id = ?').get(recordId, account.id) as
    | RecordRow
    | undefined;
  if (!row) throw new HTTPException(404, { message: 'That record does not exist.' });

  if (!isStuck(row.status) && !isStale(row)) {
    throw new HTTPException(400, {
      message:
        row.status === 'processing'
          ? 'This is still being read. Wait for it to finish.'
          : 'This one has already been read.',
    });
  }

  if (row.status === 'processing') settleAbandonedReads();

  if (!row.file_id) {
    throw new HTTPException(400, { message: 'This record has no file to read. Edit it instead.' });
  }

  return context.json({ record: present(restartCapture(account.id, recordId)) }, 202);
});
