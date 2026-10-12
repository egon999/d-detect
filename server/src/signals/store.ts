import { db } from '../db.ts';
import { newId } from '../files.ts';
import { formatMinorUnits } from '../money.ts';
import type { Draft, Signal, SignalSource } from './types.ts';

type SignalRow = {
  id: string;
  kind: string;
  rule: string;
  title: string;
  detail: string;
  quote: string | null;
  due_at: number | null;
  amount_minor: number | null;
  currency: string | null;
  sources: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
};

function parseSources(raw: string): SignalSource[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SignalSource =>
        typeof entry === 'object' &&
        entry !== null &&
        'id' in entry &&
        typeof (entry as SignalSource).id === 'string' &&
        ((entry as SignalSource).kind === 'record' || (entry as SignalSource).kind === 'meeting'),
    );
  } catch {
    return [];
  }
}

export function present(row: SignalRow): Signal {
  return {
    id: row.id,
    kind: row.kind as Signal['kind'],
    rule: row.rule,
    title: row.title,
    detail: row.detail,
    quote: row.quote,
    dueAt: row.due_at,
    amountMinor: row.amount_minor,
    currency: row.currency,

    amountLabel:
      row.amount_minor !== null && row.currency
        ? formatMinorUnits(Math.abs(row.amount_minor), row.currency)
        : null,
    sources: parseSources(row.sources),
    status: row.status as Signal['status'],
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function liveSources(sources: SignalSource[], userId: string): SignalSource[] {
  const recordIds = sources.filter((source) => source.kind === 'record').map((source) => source.id);
  const meetingIds = sources.filter((source) => source.kind === 'meeting').map((source) => source.id);

  const alive = new Set<string>();
  for (const [table, ids] of [
    ['records', recordIds],
    ['meetings', meetingIds],
  ] as const) {
    if (ids.length === 0) continue;
    const rows = db
      .prepare(`SELECT id FROM ${table} WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .all(userId, ...ids) as Array<{ id: string }>;
    for (const row of rows) alive.add(`${table === 'records' ? 'record' : 'meeting'}:${row.id}`);
  }

  return sources.filter((source) => alive.has(`${source.kind}:${source.id}`));
}

export function saveDrafts(userId: string, drafts: Draft[]): number {
  if (drafts.length === 0) return 0;
  const now = Date.now();

  const insert = db.prepare(
    `INSERT INTO signals (id, user_id, kind, rule, title, detail, quote, due_at, amount_minor,
                          currency, sources, status, fingerprint, created_at, updated_at)
     VALUES (@id, @userId, @kind, @rule, @title, @detail, @quote, @dueAt, @amountMinor,
             @currency, @sources, 'open', @fingerprint, @now, @now)
     ON CONFLICT(user_id, fingerprint) DO UPDATE SET
       title        = excluded.title,
       detail       = excluded.detail,
       quote        = excluded.quote,
       due_at       = excluded.due_at,
       amount_minor = excluded.amount_minor,
       currency     = excluded.currency,
       sources      = excluded.sources,
       updated_at   = excluded.updated_at`,
  );

  const write = db.transaction((batch: Draft[]) => {
    let created = 0;
    for (const draft of batch) {
      const sources = liveSources(draft.sources, userId);
      if (sources.length === 0) continue;

      const result = insert.run({
        id: newId('sig'),
        userId,
        kind: draft.kind,
        rule: draft.rule,
        title: draft.title,
        detail: draft.detail,
        quote: draft.quote ?? null,
        dueAt: draft.dueAt ?? null,
        amountMinor: draft.amountMinor ?? null,
        currency: draft.currency ?? null,
        sources: JSON.stringify(sources),
        fingerprint: draft.fingerprint,
        now,
      });

      if (result.lastInsertRowid !== 0 && result.changes === 1) created += 1;
    }
    return created;
  });

  return write(drafts);
}

export type SignalState = 'open' | 'handled' | 'dismissed';

const STORED_STATUS: Record<SignalState, 'open' | 'done' | 'dismissed'> = {
  open: 'open',
  handled: 'done',
  dismissed: 'dismissed',
};

export function signalsInState(userId: string, state: SignalState = 'open', limit = 50): Signal[] {
  const order =
    state === 'open'
      ? '(due_at IS NULL), due_at ASC, created_at DESC'
      : 'resolved_at DESC, created_at DESC';

  const rows = db
    .prepare(
      `SELECT id, kind, rule, title, detail, quote, due_at, amount_minor, currency, sources,
              status, created_at, resolved_at
         FROM signals
        WHERE user_id = ? AND status = ?
        ORDER BY ${order}
        LIMIT ?`,
    )
    .all(userId, STORED_STATUS[state], limit) as SignalRow[];

  const live: Signal[] = [];
  for (const row of rows) {
    const signal = present(row);
    const sources = liveSources(signal.sources, userId);
    const cited = new Set(signal.sources.map((source) => `${source.kind}:${source.id}`)).size;
    const gone = new Set(sources.map((source) => `${source.kind}:${source.id}`)).size < cited;

    if (sources.length === 0 || gone) {
      if (row.status === 'open') {
        const now = Date.now();
        db.prepare(
          `UPDATE signals SET status = 'dismissed', resolved_at = ?, updated_at = ?
            WHERE id = ? AND user_id = ?`,
        ).run(now, now, row.id, userId);
      }
      continue;
    }
    live.push({ ...signal, sources });
  }
  return live;
}

export function signalById(id: string, userId: string): SignalRow | undefined {
  return db
    .prepare(
      `SELECT id, kind, rule, title, detail, quote, due_at, amount_minor, currency, sources,
              status, created_at, resolved_at
         FROM signals WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId) as SignalRow | undefined;
}

export function resolveSignal(id: string, userId: string, status: 'done' | 'dismissed' | 'open'): Signal | null {
  const now = Date.now();
  db.prepare('UPDATE signals SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
    status,
    status === 'open' ? null : now,
    now,
    id,
    userId,
  );
  const row = signalById(id, userId);
  return row ? present(row) : null;
}

export function retireResolved(
  userId: string,
  evaluated: Map<string, Set<string>>,
  now = Date.now(),
): number {
  if (evaluated.size === 0) return 0;

  let retired = 0;
  const read = db.prepare('SELECT id, rule, fingerprint FROM signals WHERE user_id = ? AND status = ?');
  const retire = db.prepare(
    `UPDATE signals SET status = 'dismissed', resolved_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`,
  );

  db.transaction(() => {
    for (const row of read.all(userId, STORED_STATUS.open) as Array<{
      id: string;
      rule: string;
      fingerprint: string;
    }>) {
      const live = evaluated.get(row.rule);
      if (live === undefined || live.has(row.fingerprint)) continue;
      retire.run(now, now, row.id, userId);
      retired += 1;
    }
  })();

  return retired;
}

export function retireOrphaned(userId: string, now = Date.now()): number {
  const rows = db
    .prepare('SELECT id, sources FROM signals WHERE user_id = ? AND status = ? LIMIT 500')
    .all(userId, STORED_STATUS.open) as Array<{ id: string; sources: string }>;
  if (rows.length === 0) return 0;

  const cited = rows.map((row) => ({ id: row.id, sources: parseSources(row.sources) }));
  const wanted = { record: new Set<string>(), meeting: new Set<string>() };
  for (const entry of cited) for (const source of entry.sources) wanted[source.kind].add(source.id);

  const alive = new Set<string>();
  for (const [kind, table] of [
    ['record', 'records'],
    ['meeting', 'meetings'],
  ] as const) {
    const ids = [...wanted[kind]];

    for (let start = 0; start < ids.length; start += 400) {
      const slice = ids.slice(start, start + 400);
      const found = db
        .prepare(`SELECT id FROM ${table} WHERE user_id = ? AND id IN (${slice.map(() => '?').join(',')})`)
        .all(userId, ...slice) as Array<{ id: string }>;
      for (const row of found) alive.add(`${kind}:${row.id}`);
    }
  }

  const retire = db.prepare(
    `UPDATE signals SET status = 'dismissed', resolved_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = ?`,
  );

  let retired = 0;
  db.transaction(() => {
    for (const entry of cited) {
      const lost =
        entry.sources.length === 0 ||
        entry.sources.some((source) => !alive.has(`${source.kind}:${source.id}`));
      if (!lost) continue;
      retire.run(now, now, entry.id, userId, STORED_STATUS.open);
      retired += 1;
    }
  })();

  return retired;
}

const OPEN_TTL_MS = 180 * 86_400_000;

export function expireStale(userId: string, now = Date.now()): number {
  const result = db
    .prepare(
      `UPDATE signals SET status = 'dismissed', resolved_at = ?, updated_at = ?
        WHERE user_id = ? AND status = ? AND created_at < ? AND (due_at IS NULL OR due_at < ?)`,
    )
    .run(now, now, userId, STORED_STATUS.open, now - OPEN_TTL_MS, now);
  return result.changes;
}
