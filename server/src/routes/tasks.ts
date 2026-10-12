import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { accountOf } from '../auth.ts';
import { db } from '../db.ts';
import { newId } from '../files.ts';
import { toEpoch } from '../money.ts';
import type { Account } from '../auth.ts';

type Variables = { account: Account };

type TaskRow = {
  id: string;
  user_id: string;
  text: string;
  owner_name: string | null;
  due_at: number | null;
  done_at: number | null;
  meeting_id: string | null;
  record_id: string | null;
  priority: string;
  created_at: number;
  meeting_title: string | null;
  record_title: string | null;
};

const SELECT_TASK = `SELECT t.id, t.user_id, t.text, t.owner_name, t.due_at, t.done_at, t.meeting_id,
         t.record_id, t.priority, t.created_at,
         m.title AS meeting_title, r.title AS record_title
  FROM tasks t
  LEFT JOIN meetings m ON m.id = t.meeting_id AND m.user_id = t.user_id
  LEFT JOIN records  r ON r.id = t.record_id  AND r.user_id = t.user_id`;

const OPEN_ORDER = 'ORDER BY (t.due_at IS NULL), t.due_at ASC, t.created_at DESC';

const DONE_ORDER = 'ORDER BY t.done_at DESC';

const ALL_ORDER =
  'ORDER BY (t.done_at IS NOT NULL), (t.due_at IS NULL), t.due_at ASC, t.done_at DESC, t.created_at DESC';

function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function present(row: TaskRow, now: number): Record<string, unknown> {
  return {
    id: row.id,
    text: row.text,
    owner: row.owner_name,
    priority: row.priority,
    dueAt: row.due_at,
    doneAt: row.done_at,

    overdue: row.done_at === null && row.due_at !== null && row.due_at < startOfDay(now),
    meetingId: row.meeting_id,
    recordId: row.record_id,
    meetingTitle: row.meeting_title,
    recordTitle: row.record_title,
    createdAt: row.created_at,
  };
}

function taskById(id: string, userId: string): TaskRow | undefined {
  return db.prepare(`${SELECT_TASK} WHERE t.id = ? AND t.user_id = ?`).get(id, userId) as TaskRow | undefined;
}

function ownsRecord(recordId: string, userId: string): boolean {
  return (
    db.prepare('SELECT id FROM records WHERE id = ? AND user_id = ?').get(recordId, userId) !== undefined
  );
}

function dueDay(raw: string): number {
  const parsed = toEpoch(raw, 'day');
  if (parsed.at === null || !['day', 'minute'].includes(parsed.precision ?? '')) {
    throw new HTTPException(400, { message: 'Choose a full due date, including the day.' });
  }
  return parsed.at;
}

function ownerName(raw: string | null | undefined): string | null {
  return (raw ?? '').trim() || null;
}

export const tasks = new Hono<{ Variables: Variables }>();

tasks.get('/', (context) => {
  const account = accountOf(context);
  const state = context.req.query('state');
  const recordId = context.req.query('recordId');

  const conditions = ['t.user_id = ?'];
  const values: unknown[] = [account.id];

  if (recordId !== undefined) {
    if (!ownsRecord(recordId, account.id)) {
      throw new HTTPException(404, { message: 'That record does not exist.' });
    }
    conditions.push('t.record_id = ?');
    values.push(recordId);
  }

  let order = OPEN_ORDER;
  if (state === 'done') {
    conditions.push('t.done_at IS NOT NULL');
    order = DONE_ORDER;
  } else if (state === 'all') {
    order = ALL_ORDER;
  } else {
    conditions.push('t.done_at IS NULL');
  }

  const rows = db
    .prepare(`${SELECT_TASK} WHERE ${conditions.join(' AND ')} ${order}`)
    .all(...values) as TaskRow[];

  const now = Date.now();
  return context.json({ tasks: rows.map((row) => present(row, now)) });
});

const NewTask = z.object({
  text: z.string().trim().min(1).max(500),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  owner: z.string().max(120).nullable().optional(),
  due: z.string().nullable().optional(),

  recordId: z.string().trim().min(1).max(64).optional(),
});

tasks.post('/', async (context) => {
  const account = accountOf(context);
  const parsed = NewTask.safeParse(await context.req.json().catch(() => ({})));
  if (!parsed.success) throw new HTTPException(400, { message: 'Write what the task is.' });
  const input = parsed.data;

  if (input.recordId !== undefined && !ownsRecord(input.recordId, account.id)) {
    throw new HTTPException(404, { message: 'That record does not exist.' });
  }

  const id = newId('task');
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, owner_name, due_at, record_id, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    account.id,
    input.text,
    ownerName(input.owner),
    input.due ? dueDay(input.due) : null,
    input.recordId ?? null,
    input.priority ?? 'normal',
    Date.now(),
  );

  const row = taskById(id, account.id);
  if (!row) throw new HTTPException(404, { message: 'That task does not exist.' });
  return context.json({ task: present(row, Date.now()) }, 201);
});

tasks.get('/:id', (context) => {
  const account = accountOf(context);
  const row = taskById(context.req.param('id'), account.id);
  if (!row) throw new HTTPException(404, { message: 'That task does not exist.' });
  return context.json({ task: present(row, Date.now()) });
});

const TaskPatch = z.object({

  done: z.boolean().optional(),
  text: z.string().trim().min(1).max(500).optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  owner: z.string().max(120).nullable().optional(),
  due: z.string().nullable().optional(),
});

tasks.patch('/:id', async (context) => {
  const account = accountOf(context);
  const taskId = context.req.param('id');
  if (!taskById(taskId, account.id)) throw new HTTPException(404, { message: 'That task does not exist.' });

  const parsed = TaskPatch.safeParse(await context.req.json().catch(() => ({})));
  if (!parsed.success) throw new HTTPException(400, { message: 'That change could not be applied.' });
  const patch = parsed.data;

  const dueTouched = patch.due !== undefined;
  const dueAt = typeof patch.due === 'string' ? dueDay(patch.due) : null;
  const ownerTouched = patch.owner !== undefined;

  db.prepare(
    `UPDATE tasks SET
       text = COALESCE(?, text),
       priority = COALESCE(?, priority),
       owner_name = CASE WHEN ? THEN ? ELSE owner_name END,
       due_at = CASE WHEN ? THEN ? ELSE due_at END,
       done_at = CASE WHEN ? THEN ? ELSE done_at END
     WHERE id = ? AND user_id = ?`,
  ).run(
    patch.text ?? null,
    patch.priority ?? null,
    ownerTouched ? 1 : 0,
    ownerName(patch.owner),
    dueTouched ? 1 : 0,
    dueAt,
    patch.done !== undefined ? 1 : 0,
    patch.done === true ? Date.now() : null,
    taskId,
    account.id,
  );

  const row = taskById(taskId, account.id);
  if (!row) throw new HTTPException(404, { message: 'That task does not exist.' });
  return context.json({ task: present(row, Date.now()) });
});

tasks.delete('/:id', (context) => {
  const account = accountOf(context);
  const result = db
    .prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')
    .run(context.req.param('id'), account.id);
  if (result.changes === 0) throw new HTTPException(404, { message: 'That task does not exist.' });
  return context.json({ deleted: true });
});
