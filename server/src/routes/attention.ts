import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { accountOf } from '../auth.ts';
import { db } from '../db.ts';
import { lookView, startLook } from '../signals/index.ts';
import { present, resolveSignal, signalById, signalsInState } from '../signals/store.ts';
import type { Account } from '../auth.ts';
import type { SignalState } from '../signals/store.ts';
import type { Signal } from '../signals/types.ts';

type Variables = { account: Account };

const attention = new Hono<{ Variables: Variables }>();

type SourceView = { kind: 'record' | 'meeting'; id: string; title: string };

function sourceViews(signals: Signal[], userId: string): Map<string, SourceView> {
  const recordIds = new Set<string>();
  const meetingIds = new Set<string>();
  for (const signal of signals) {
    for (const source of signal.sources) {
      (source.kind === 'record' ? recordIds : meetingIds).add(source.id);
    }
  }

  const views = new Map<string, SourceView>();

  for (const [kind, table, ids] of [
    ['record', 'records', [...recordIds]],
    ['meeting', 'meetings', [...meetingIds]],
  ] as const) {
    if (ids.length === 0) continue;
    const rows = db
      .prepare(`SELECT id, title FROM ${table} WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .all(userId, ...ids) as Array<{ id: string; title: string }>;
    for (const row of rows) views.set(`${kind}:${row.id}`, { kind, id: row.id, title: row.title });
  }
  return views;
}

function withSources(signals: Signal[], userId: string): Array<Record<string, unknown>> {
  const views = sourceViews(signals, userId);
  return signals.map((signal) => ({
    ...signal,
    sources: signal.sources
      .map((source) => views.get(`${source.kind}:${source.id}`))
      .filter((view): view is SourceView => view !== undefined),
  }));
}

const STATES: Record<string, SignalState> = {
  open: 'open',
  handled: 'handled',
  done: 'handled',
  dismissed: 'dismissed',
};

function stateOf(raw: string | undefined): SignalState {
  return STATES[(raw ?? '').trim().toLowerCase()] ?? 'open';
}

attention.get('/', (context) => {
  const account = accountOf(context);
  const state = stateOf(context.req.query('state'));

  if (context.req.query('refresh') === '1') startLook(account.id);

  const signals = signalsInState(account.id, state);
  const counts: Record<Signal['kind'], number> = { commitment: 0, renewal: 0, anomaly: 0 };
  for (const signal of signals) counts[signal.kind] += 1;

  return context.json({
    signals: withSources(signals, account.id),
    counts,
    total: signals.length,
    state,
    ...lookView(account.id),
  });
});

attention.post('/refresh', (context) => {
  const account = accountOf(context);
  const started = startLook(account.id);
  return context.json({ started, ...lookView(account.id) }, 202);
});

const Verdict = z.object({
  status: z
    .enum(['handled', 'done', 'dismissed', 'open'])
    .transform((value) => (value === 'handled' ? ('done' as const) : value)),
});

attention.post('/:id/resolve', async (context) => {
  const account = accountOf(context);
  const id = context.req.param('id');
  if (!signalById(id, account.id)) {
    throw new HTTPException(404, { message: 'That item is no longer here.' });
  }

  const parsed = Verdict.safeParse(await context.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'Say whether you have handled this, it was not worth raising, or it belongs back on your list.',
    });
  }

  const signal = resolveSignal(id, account.id, parsed.data.status);
  if (!signal) throw new HTTPException(404, { message: 'That item is no longer here.' });

  return context.json({ signal: withSources([signal], account.id)[0] });
});

attention.get('/:id', (context) => {
  const account = accountOf(context);
  const row = signalById(context.req.param('id'), account.id);
  if (!row) throw new HTTPException(404, { message: 'That item is no longer here.' });

  const signal = present(row);
  return context.json({ signal: withSources([signal], account.id)[0] });
});

export { attention };
