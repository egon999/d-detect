import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { accountOf } from '../auth.ts';
import { db } from '../db.ts';
import { formatMinorUnits } from '../money.ts';

import { search as retrieve } from '../search.ts';
import type { Account } from '../auth.ts';
import type { SearchSource } from '../search.ts';

type Variables = { account: Account };

export type SearchResult = {
  type: SearchSource;
  id: string;
  title: string;
  subtitle: string | null;
  occurredAt: number | null;
  amountLabel: string | null;
};

type Ranked = {
  result: SearchResult;

  position: number;

  at: number;
};

const MAX_QUERY = 200;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const SUBTITLE_MAX = 120;

function line(text: string | null, max = SUBTITLE_MAX): string | null {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

function positionsOf(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, position) => [id, position] as const));
}

type RecordRow = {
  id: string;
  title: string;
  occurred_at: number | null;
  created_at: number;
  amount_minor: number | null;
  currency: string | null;
  direction: string | null;
  counterparty: string | null;
  category: string | null;
  note: string | null;
};

function aboutRecord(row: RecordRow): string | null {
  const counterparty = line(row.counterparty);
  if (counterparty) {
    if (row.direction === 'out') return line(`Paid to ${counterparty}`);
    if (row.direction === 'in') return line(`Received from ${counterparty}`);
    return counterparty;
  }
  return line(row.category) ?? line(row.note);
}

function foundRecords(userId: string, ids: string[]): Ranked[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, title, occurred_at, created_at, amount_minor, currency, direction, counterparty, category, note
         FROM records WHERE user_id = ? AND id IN (${placeholders(ids.length)})`,
    )
    .all(userId, ...ids) as RecordRow[];

  const positions = positionsOf(ids);
  return rows.map((row) => ({
    position: positions.get(row.id) ?? ids.length,

    at: row.occurred_at ?? row.created_at,
    result: {
      type: 'record' as const,
      id: row.id,
      title: line(row.title) ?? '',
      subtitle: aboutRecord(row),
      occurredAt: row.occurred_at,
      amountLabel:
        row.amount_minor !== null && row.currency ? formatMinorUnits(row.amount_minor, row.currency) : null,
    },
  }));
}

type MeetingRow = {
  id: string;
  title: string;
  note: string;
  summary: string | null;
  started_at: number;
};

function foundMeetings(userId: string, ids: string[]): Ranked[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, title, note, summary, started_at
         FROM meetings WHERE user_id = ? AND id IN (${placeholders(ids.length)})`,
    )
    .all(userId, ...ids) as MeetingRow[];

  const positions = positionsOf(ids);
  return rows.map((row) => ({
    position: positions.get(row.id) ?? ids.length,
    at: row.started_at,
    result: {
      type: 'meeting' as const,
      id: row.id,
      title: line(row.title) ?? '',

      subtitle: line(row.note) ?? line(row.summary),
      occurredAt: row.started_at,

      amountLabel: null,
    },
  }));
}

type TaskRow = {
  id: string;
  text: string;
  owner_name: string | null;
  due_at: number | null;
  created_at: number;
};

function foundTasks(userId: string, ids: string[]): Ranked[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, text, owner_name, due_at, created_at
         FROM tasks WHERE user_id = ? AND id IN (${placeholders(ids.length)})`,
    )
    .all(userId, ...ids) as TaskRow[];

  const positions = positionsOf(ids);
  return rows.map((row) => ({
    position: positions.get(row.id) ?? ids.length,
    at: row.due_at ?? row.created_at,
    result: {
      type: 'task' as const,
      id: row.id,

      title: line(row.text) ?? '',
      subtitle: row.owner_name ? line(`For ${row.owner_name.trim()}`) : null,
      occurredAt: row.due_at,
      amountLabel: null,
    },
  }));
}

type CaseRow = {
  id: string;
  title: string;
  question: string;
  my_claim: string;
  their_claim: string;
  created_at: number;
};

function foundCases(userId: string, ids: string[]): Ranked[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, title, question, my_claim, their_claim, created_at
         FROM cases WHERE user_id = ? AND id IN (${placeholders(ids.length)})`,
    )
    .all(userId, ...ids) as CaseRow[];

  const positions = positionsOf(ids);
  return rows.map((row) => ({
    position: positions.get(row.id) ?? ids.length,
    at: row.created_at,
    result: {
      type: 'case' as const,
      id: row.id,
      title: line(row.title) ?? '',

      subtitle: line(row.question) ?? line(row.my_claim) ?? line(row.their_claim),
      occurredAt: row.created_at,

      amountLabel: null,
    },
  }));
}

const KINDS: readonly SearchSource[] = ['record', 'meeting', 'task', 'case'];

function narrowedTo(raw: string | undefined): SearchSource | null {
  const wanted = (raw ?? '').trim();
  if (!wanted) return null;
  if (!KINDS.includes(wanted as SearchSource)) {
    throw new HTTPException(400, {
      message: 'You can narrow a search to records, meetings, tasks or cases.',
    });
  }
  return wanted as SearchSource;
}

function limitFrom(raw: string | undefined): number {
  const asked = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(asked)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(asked, MAX_LIMIT));
}

export const search = new Hono<{ Variables: Variables }>();

search.get('/', (context) => {
  const account = accountOf(context);
  const query = (context.req.query('q') ?? '').slice(0, MAX_QUERY);
  const limit = limitFrom(context.req.query('limit'));
  const only = narrowedTo(context.req.query('kind'));

  let hits;
  try {
    hits = retrieve(account.id, query, { limit, amounts: true, strict: true, ...(only ? { only } : {}) });
  } catch (cause) {

    console.error('[search] a search could not be run', { cause });
    throw new HTTPException(503, {
      message: 'Search could not run just now. Please try again in a moment.',
    });
  }

  const found = [
    ...foundRecords(account.id, hits.record),
    ...foundMeetings(account.id, hits.meeting),
    ...foundTasks(account.id, hits.task),
    ...foundCases(account.id, hits.case),
  ];

  found.sort((left, right) => left.position - right.position || right.at - left.at);

  return context.json({ results: found.slice(0, limit).map((entry) => entry.result) });
});
