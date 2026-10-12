import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Account } from '../auth.ts';

const directory = mkdtempSync(join(tmpdir(), 'detact-attention-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';
const { db, ensureUser } = await import('../db.ts');
const { attention } = await import('./attention.ts');
const { MIN_SERIES_OCCURRENCES } = await import('../recurring.ts');

const app = new Hono<{ Variables: { account: Account } }>();
app.use('*', async (context, next) => {
  const id = context.req.header('x-test-owner') ?? 'owner-a';
  ensureUser(id, null, null);
  context.set('account', { id, email: null, name: null });
  await next();
});
app.route('/attention', attention);
app.onError((error, context) =>
  context.json({ error: error.message }, error instanceof HTTPException ? error.status : 500),
);

type ProviderBody = { messages?: Array<{ role: string; content: string }> };
let responder: (url: string, body: ProviderBody) => Promise<unknown> | unknown;

let unauthorized: string[] = [];
let calls = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  calls += 1;
  assert.ok(url.includes('/chat/completions'), `Unexpected network call: ${url}`);
  const parsed = typeof init?.body === 'string' ? (JSON.parse(init.body) as ProviderBody) : {};
  const result = await responder(url, parsed);
  return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
};

beforeEach(() => {
  db.exec(
    'DELETE FROM jobs; DELETE FROM signals; DELETE FROM signal_scans; DELETE FROM cases; DELETE FROM questions; DELETE FROM meetings; DELETE FROM records; DELETE FROM tasks; DELETE FROM budgets; DELETE FROM files; DELETE FROM users;',
  );
  ensureUser('owner-a', null, null);
  unauthorized = [];
  calls = 0;
  responder = (url) => {
    unauthorized.push(url);
    throw new Error('This test did not authorize a model call.');
  };
});

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-attention-'));
  rmSync(target, { recursive: true, force: true });
});

const DAY = 86_400_000;

type SignalView = {
  id: string;
  kind: 'commitment' | 'renewal' | 'anomaly';
  title: string;
  detail: string;
  dueAt: number | null;
  amountMinor: number | null;
  amountLabel: string | null;
  sources: Array<{ kind: string; id: string; title: string }>;
  status: string;
  resolvedAt: number | null;
};

type ListBody = {
  signals: SignalView[];
  counts: { commitment: number; renewal: number; anomaly: number };
  total: number;
  state: string;
  looking: boolean;
  startedAt: number | null;
  lastLook: {
    at: number;
    found: number;
    read: number;
    unfinished: number;
    completed: boolean;
    notice: string | null;
  } | null;
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

async function list(query = '', owner = 'owner-a'): Promise<ListBody> {
  const { status, json } = await call('GET', `/attention${query}`, undefined, owner);
  assert.equal(status, 200, `Listing failed: ${JSON.stringify(json)}`);
  return json as unknown as ListBody;
}

function seedRecord(id: string, fields: Partial<{
  title: string;
  owner: string;
  occurredAt: number;
  createdAt: number;
  amountMinor: number | null;
  direction: string | null;
  counterparty: string | null;
  sourceText: string;
}> = {}): string {
  const owner = fields.owner ?? 'owner-a';
  ensureUser(owner, null, null);
  const now = Date.now();

  const createdAt = fields.createdAt ?? now;
  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction,
                          counterparty, extraction, status, created_at, updated_at)
     VALUES (?, ?, 'payment', ?, ?, ?, 'INR', ?, ?, ?, 'complete', ?, ?)`,
  ).run(
    id,
    owner,
    fields.title ?? id,
    fields.occurredAt ?? now,
    fields.amountMinor ?? null,
    fields.direction ?? null,
    fields.counterparty ?? null,
    fields.sourceText === undefined ? '{}' : JSON.stringify({ sourceText: fields.sourceText }),
    createdAt,
    createdAt,
  );
  return id;
}

function seedSignal(fields: {
  id: string;
  title: string;
  kind?: 'commitment' | 'renewal' | 'anomaly';
  status?: 'open' | 'done' | 'dismissed';
  sourceId: string;
  dueAt?: number | null;
  owner?: string;
}): string {
  const owner = fields.owner ?? 'owner-a';
  const now = Date.now();
  db.prepare(
    `INSERT INTO signals (id, user_id, kind, rule, title, detail, quote, due_at, amount_minor,
                          currency, sources, status, fingerprint, created_at, updated_at, resolved_at)
     VALUES (?, ?, ?, 'promised_to_you', ?, '', NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.id,
    owner,
    fields.kind ?? 'commitment',
    fields.title,
    fields.dueAt ?? null,
    JSON.stringify([{ kind: 'record', id: fields.sourceId }]),
    fields.status ?? 'open',
    `fp:${fields.id}`,
    now,
    now,
    (fields.status ?? 'open') === 'open' ? null : now,
  );
  return fields.id;
}

async function settled(owner = 'owner-a', query = ''): Promise<ListBody> {
  for (let attempt = 0; attempt < 4_000; attempt += 1) {
    const body = await list(query, owner);
    if (!body.looking) return body;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail('A pass was still reported as running after twenty seconds.');
}

function storedStatus(id: string): { status: string; resolvedAt: number | null } | undefined {
  const row = db.prepare('SELECT status, resolved_at FROM signals WHERE id = ?').get(id) as
    | { status: string; resolved_at: number | null }
    | undefined;
  return row === undefined ? undefined : { status: row.status, resolvedAt: row.resolved_at };
}

test('the three lists are separate, and each tally describes the list it came with', async () => {
  const record = seedRecord('rec_1', { title: 'Courier receipt' });
  seedSignal({ id: 'sig_open', title: 'Ravi said he would refund the courier', sourceId: record });
  seedSignal({ id: 'sig_handled', title: 'Policy expires', kind: 'renewal', status: 'done', sourceId: record });
  seedSignal({ id: 'sig_binned', title: 'Paid the shop twice', kind: 'anomaly', status: 'dismissed', sourceId: record });

  const open = await list();
  assert.equal(open.state, 'open');
  assert.equal(open.total, 1);
  assert.deepEqual(open.counts, { commitment: 1, renewal: 0, anomaly: 0 });
  assert.equal(open.signals[0]?.id, 'sig_open');

  assert.deepEqual(open.signals[0]?.sources, [{ kind: 'record', id: 'rec_1', title: 'Courier receipt' }]);

  const handled = await list('?state=handled');
  assert.equal(handled.state, 'handled');
  assert.equal(handled.total, 1);
  assert.deepEqual(handled.counts, { commitment: 0, renewal: 1, anomaly: 0 });
  assert.equal(handled.signals[0]?.id, 'sig_handled');

  assert.equal((await list('?state=done')).signals[0]?.id, 'sig_handled');

  const dismissed = await list('?state=dismissed');
  assert.equal(dismissed.total, 1);
  assert.deepEqual(dismissed.counts, { commitment: 0, renewal: 0, anomaly: 1 });
  assert.equal(dismissed.signals[0]?.id, 'sig_binned');

  for (const query of ['?state=', '?state=everything', '']) {
    assert.equal((await list(query)).state, 'open');
  }
  assert.deepEqual(unauthorized, []);
});

test('something handled by mistake can be found and put back', async () => {
  const record = seedRecord('rec_1', { title: 'Repair bill' });
  seedSignal({ id: 'sig_1', title: 'Shop said they would send the warranty card', status: 'done', sourceId: record });

  assert.equal((await list()).total, 0);

  assert.equal((await list('?state=handled')).signals[0]?.id, 'sig_1');

  const back = await call('POST', '/attention/sig_1/resolve', { status: 'open' });
  assert.equal(back.status, 200);
  const signal = back.json['signal'] as SignalView;
  assert.equal(signal.status, 'open');
  assert.equal(signal.resolvedAt, null);

  assert.deepEqual(signal.sources, [{ kind: 'record', id: 'rec_1', title: 'Repair bill' }]);

  assert.equal((await list()).signals[0]?.id, 'sig_1');
  assert.equal((await list('?state=handled')).total, 0);

  const handledAgain = await call('POST', '/attention/sig_1/resolve', { status: 'handled' });
  assert.equal((handledAgain.json['signal'] as SignalView).status, 'done');
  assert.equal((await list('?state=handled')).total, 1);

  const nonsense = await call('POST', '/attention/sig_1/resolve', { status: 'maybe' });
  assert.equal(nonsense.status, 400);
  assert.equal(
    nonsense.json['error'],
    'Say whether you have handled this, it was not worth raising, or it belongs back on your list.',
  );

  const gone = await call('POST', '/attention/sig_nothing/resolve', { status: 'dismissed' });
  assert.equal(gone.status, 404);
  assert.deepEqual(unauthorized, []);
});

test('looking again answers at once, says it is looking, and a second ask starts nothing', async () => {
  seedRecord('rec_long', {
    title: 'Insurance letter',
    sourceText: 'Your policy number QQ-4471 is valid and the cover continues under the same terms.',
  });

  let open: (() => void) | undefined;
  const held = new Promise<void>((unblock) => {
    open = unblock;
  });
  responder = async () => {
    await held;
    return { commitments: [], renewals: [] };
  };

  const started = await call('POST', '/attention/refresh');
  assert.equal(started.status, 202);
  assert.equal(started.json['started'], true);
  assert.equal(started.json['looking'], true);

  const during = await list();
  assert.equal(during.looking, true);
  assert.ok(typeof during.startedAt === 'number');
  assert.equal(during.total, 0);

  const again = await call('POST', '/attention/refresh');
  assert.equal(again.status, 202);
  assert.equal(again.json['started'], false, 'A second ask during a pass must not start a second one');
  assert.equal(again.json['looking'], true, 'and must still tell the person something is happening');

  const legacy = await list('?refresh=1');
  assert.equal(legacy.looking, true);

  open?.();
  const finished = await settled();
  assert.equal(finished.looking, false);
  assert.equal(finished.startedAt, null);
  assert.equal(finished.lastLook?.completed, true);
  assert.equal(finished.lastLook?.read, 1);
  assert.equal(finished.lastLook?.found, 0);

  assert.equal(calls, 1);
  assert.deepEqual(unauthorized, []);
});

test('a pass that finds nothing because it could not look still leaves the list standing', async () => {
  const record = seedRecord('rec_long', {
    title: 'Insurance letter',
    sourceText: 'Your policy number QQ-4471 is valid and the cover continues under the same terms.',
  });
  seedSignal({ id: 'sig_1', title: 'Ravi said he would send the receipt', sourceId: record });

  responder = () => {
    throw new Error('the model is unreachable');
  };

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const finished = await settled();

  assert.equal(finished.total, 1);
  assert.equal(finished.signals[0]?.id, 'sig_1');

  assert.equal(finished.looking, false);
  assert.equal(finished.startedAt, null);
  assert.ok(finished.lastLook !== null, 'The person must be able to tell a finished pass from a running one');
  assert.equal(finished.lastLook?.found, 0);

  assert.equal(finished.counts.commitment, 1);

  assert.equal(finished.lastLook?.read, 0, 'nothing was read, so nothing may be reported as read');
  assert.equal(finished.lastLook?.unfinished, 1);
  assert.ok(finished.lastLook?.notice, 'a list that is not the whole answer has to say so');
  const notice = finished.lastLook?.notice ?? '';
  assert.match(notice, /again/i, 'and has to say the reading can be tried again');
  assert.ok(!/empty|nothing/i.test(notice), `the person was told their document was empty: ${notice}`);
  for (const forbidden of ['groq', 'model', 'provider', 'unreachable', '502', 'gsk_', 'xai-']) {
    assert.ok(!notice.toLowerCase().includes(forbidden), `the notice shown to the person said "${forbidden}"`);
  }

  const marked = db
    .prepare('SELECT subject_id FROM signal_scans WHERE user_id = ?')
    .all('owner-a') as Array<{ subject_id: string }>;
  assert.deepEqual(marked, [], 'material nobody managed to read must not be recorded as read');
});

test('one account never sees the noticed things of another', async () => {
  const mine = seedRecord('rec_mine', { title: 'My receipt' });
  const theirs = seedRecord('rec_theirs', { title: 'Their receipt', owner: 'owner-b' });
  seedSignal({ id: 'sig_mine', title: 'My refund was promised', sourceId: mine });
  seedSignal({ id: 'sig_theirs', title: 'Their refund was promised', sourceId: theirs, owner: 'owner-b' });

  assert.deepEqual(
    (await list('', 'owner-a')).signals.map((signal) => signal.id),
    ['sig_mine'],
  );
  assert.deepEqual(
    (await list('', 'owner-b')).signals.map((signal) => signal.id),
    ['sig_theirs'],
  );

  assert.equal((await call('GET', '/attention/sig_mine', undefined, 'owner-b')).status, 404);
  const hijack = await call('POST', '/attention/sig_mine/resolve', { status: 'dismissed' }, 'owner-b');
  assert.equal(hijack.status, 404);

  assert.equal((await list('', 'owner-a')).signals[0]?.status, 'open');
  assert.deepEqual(unauthorized, []);
});

test('a history too short to be a pattern is not called a missed payment either', async () => {
  const now = Date.now();

  seedRecord('rec_a', {
    title: 'Shakti Electric, July',
    occurredAt: now - 70 * DAY,
    amountMinor: 120_000,
    direction: 'out',
    counterparty: 'Shakti Electric',
  });
  seedRecord('rec_b', {
    title: 'Shakti Electric, August',
    occurredAt: now - 40 * DAY,
    amountMinor: 120_000,
    direction: 'out',
    counterparty: 'Shakti Electric',
  });

  assert.equal(MIN_SERIES_OCCURRENCES, 3, 'Both sides of the app read this one number');

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const two = await settled();
  assert.equal(two.total, 0, 'Two payments are one gap, and one gap is not a cadence');
  assert.equal(two.lastLook?.completed, true);

  seedRecord('rec_c', {
    title: 'Shakti Electric, June',
    occurredAt: now - 100 * DAY,
    amountMinor: 120_000,
    direction: 'out',
    counterparty: 'Shakti Electric',
  });

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const three = await settled();
  assert.equal(three.total, 1);
  const noticed = three.signals[0];
  assert.equal(noticed?.kind, 'anomaly');
  assert.equal(noticed?.title, 'Nothing saved for Shakti Electric this time');

  assert.equal(noticed?.sources.length, 3);
  assert.deepEqual(
    noticed?.sources.map((source) => source.kind),
    ['record', 'record', 'record'],
  );
  assert.equal(three.lastLook?.found, 1);

  assert.equal(calls, 0);
  assert.deepEqual(unauthorized, []);
});

function seedMonthly(counterparty: string, lastDaysAgo: number, count = 3, gapDays = 30): void {
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    const daysAgo = lastDaysAgo + (count - 1 - index) * gapDays;
    seedRecord(`rec_${counterparty.replace(/\W/g, '')}_${index}`, {
      title: `${counterparty}, statement ${index + 1}`,
      occurredAt: now - daysAgo * DAY,
      amountMinor: 120_000,
      direction: 'out',
      counterparty,
    });
  }
}

test('a late payment arriving clears the finding about it, without anybody dismissing it', async () => {
  seedMonthly('Shakti Electric', 40);
  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const raised = await settled();
  assert.equal(raised.total, 1);
  assert.match(raised.signals[0]?.title ?? '', /Nothing saved for Shakti Electric/);

  seedRecord('rec_catchup', {
    title: 'Shakti Electric, catch-up',
    occurredAt: Date.now() - 2 * DAY,
    amountMinor: 120_000,
    direction: 'out',
    counterparty: 'Shakti Electric',
  });

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const after = await settled();

  assert.equal(after.total, 0);
  assert.equal(after.counts.anomaly, 0);
  assert.equal(
    (await list('?state=dismissed')).signals.some((signal) => /Nothing saved for Shakti/.test(signal.title)),
    true,
    'Retired, not deleted: the observation is still on record',
  );
});

test('the same condition seen twice does not produce a second card', async () => {
  seedMonthly('Shakti Electric', 40);

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const first = await settled();
  assert.equal(first.total, 1);
  const id = first.signals[0]?.id;

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  await settled();
  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const third = await settled();

  assert.equal(third.total, 1);
  assert.equal(third.signals[0]?.id, id, 'A re-run refreshes the card rather than raising a new one');
  assert.equal((await list('?state=dismissed')).total, 0, 'and leaves nothing behind it');
  assert.equal(calls, 0);
});

test('a signal whose own record is deleted is retired rather than shown pointing nowhere', async () => {
  seedMonthly('Shakti Electric', 40);
  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const raised = await settled();
  assert.equal(raised.total, 1);
  assert.equal(raised.signals[0]?.sources.length, 3);
  const id = raised.signals[0]?.id ?? '';

  db.prepare('DELETE FROM records WHERE id = ?').run('rec_ShaktiElectric_0');

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  await settled('owner-a', '?state=dismissed');
  const stored = storedStatus(id);
  assert.equal(stored?.status, 'dismissed', 'Deleting the material must retire the finding, not hide it');
  assert.ok((stored?.resolvedAt ?? 0) > 0);

  assert.equal((await list()).total, 0, 'A source the person cannot open means a card they cannot check');
  assert.equal(
    (await list('?state=dismissed')).signals.some((signal) => signal.id === id),
    false,
  );
});

test('a card about two payments stops being shown when one of the two is gone', async () => {
  const now = Date.now();
  seedRecord('rec_dup_a', {
    title: 'Sharma Electricals, first',
    occurredAt: now - DAY,
    amountMinor: 249_900,
    direction: 'out',
    counterparty: 'Sharma Electricals',
  });
  seedRecord('rec_dup_b', {
    title: 'Sharma Electricals, again',
    occurredAt: now - DAY + 3_600_000,
    amountMinor: 249_900,
    direction: 'out',
    counterparty: 'Sharma Electricals',
  });

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const raised = await settled();
  assert.equal(raised.total, 1);
  assert.match(raised.signals[0]?.title ?? '', /look the same/);
  assert.equal(raised.signals[0]?.sources.length, 2);

  db.prepare('DELETE FROM records WHERE id = ?').run('rec_dup_b');
  const after = await list();
  assert.equal(after.total, 0);
});

test('a question answered is a card that clears itself', async () => {
  const now = Date.now();
  seedRecord('rec_waiting', { title: 'Repair bill', occurredAt: now - 10 * DAY, createdAt: now - 10 * DAY });
  db.prepare(`UPDATE records SET status = 'needs_context' WHERE id = 'rec_waiting'`).run();
  db.prepare(
    `INSERT INTO questions (id, record_id, field, prompt, options, answer, answered_at, created_at)
     VALUES ('q_1', 'rec_waiting', 'amount', 'How much did this cost?', '[]', NULL, NULL, ?)`,
  ).run(now - 10 * DAY);

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const raised = await settled();
  assert.equal(raised.total, 1);
  assert.match(raised.signals[0]?.title ?? '', /Repair bill is not finished/);
  assert.match(raised.signals[0]?.detail ?? '', /How much did this cost\?/);

  db.prepare(`UPDATE questions SET answer = '₹450', answered_at = ? WHERE id = 'q_1'`).run(Date.now());
  db.prepare(`UPDATE records SET status = 'complete' WHERE id = 'rec_waiting'`).run();

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const after = await settled();
  assert.equal(after.total, 0);
});

test('a question nobody can answer is also a card that goes', async () => {
  const now = Date.now();
  seedRecord('rec_forgotten', {
    title: 'Auto fare slip',
    occurredAt: now - 40 * DAY,
    createdAt: now - 12 * DAY,
  });
  db.prepare(`UPDATE records SET status = 'needs_context' WHERE id = 'rec_forgotten'`).run();
  db.prepare(
    `INSERT INTO questions (id, record_id, field, prompt, options, answer, answered_at, created_at)
     VALUES ('q_skip', 'rec_forgotten', 'category', 'What was this for?', '[]', NULL, NULL, ?)`,
  ).run(now - 12 * DAY);

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  assert.equal((await settled()).total, 1);

  db.prepare(`UPDATE questions SET answer = NULL, answered_at = ? WHERE id = 'q_skip'`).run(Date.now());
  db.prepare(`UPDATE records SET status = 'complete' WHERE id = 'rec_forgotten'`).run();

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  assert.equal((await settled()).total, 0);
});

test('nothing older than its welcome is left greeting the person', async () => {
  const record = seedRecord('rec_old', { title: 'Courier receipt' });
  const now = Date.now();
  seedSignal({ id: 'sig_ancient', title: 'Ravi said he would refund the courier', sourceId: record });
  db.prepare('UPDATE signals SET created_at = ?, updated_at = ? WHERE id = ?').run(
    now - 200 * DAY,
    now - 200 * DAY,
    'sig_ancient',
  );

  assert.equal((await list()).total, 1);

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const after = await settled();
  assert.equal(after.total, 0);
  assert.equal(
    (await list('?state=dismissed')).signals.some((signal) => signal.id === 'sig_ancient'),
    true,
  );
});

test('a dated item is not aged out before its own date arrives', async () => {
  const record = seedRecord('rec_policy', { title: 'Insurance policy' });
  const now = Date.now();
  seedSignal({
    id: 'sig_renewal',
    title: 'Your two-wheeler policy is up for renewal',
    kind: 'renewal',
    sourceId: record,
    dueAt: now + 20 * DAY,
  });
  db.prepare('UPDATE signals SET created_at = ?, updated_at = ? WHERE id = ?').run(
    now - 200 * DAY,
    now - 200 * DAY,
    'sig_renewal',
  );

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const after = await settled();

  assert.equal(after.total, 1);
  assert.equal(after.signals[0]?.id, 'sig_renewal');
});

test('what the person decided is not undone by the next pass', async () => {
  seedMonthly('Shakti Electric', 40);
  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const raised = await settled();
  const id = raised.signals[0]!.id;

  const dismissed = await call('POST', `/attention/${id}/resolve`, { status: 'dismissed' });
  assert.equal(dismissed.status, 200);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await call('POST', '/attention/refresh')).status, 202);
    await settled();
  }
  assert.equal((await list()).total, 0);
  assert.equal((await list('?state=dismissed')).signals[0]?.id, id);
});

test('no finding can be built out of another account\'s records', async () => {
  const now = Date.now();

  for (let index = 0; index < 3; index += 1) {
    seedRecord(`rec_b_${index}`, {
      title: `Shakti Electric ${index}`,
      owner: 'owner-b',
      occurredAt: now - (40 + index * 30) * DAY,
      amountMinor: 120_000,
      direction: 'out',
      counterparty: 'Shakti Electric',
    });
  }

  assert.equal((await call('POST', '/attention/refresh', undefined, 'owner-a')).status, 202);
  const mine = await settled('owner-a');
  assert.equal(mine.total, 0, 'One account\'s records cannot raise a signal for another');

  assert.equal((await call('POST', '/attention/refresh', undefined, 'owner-b')).status, 202);
  const theirs = await settled('owner-b');
  assert.equal(theirs.total, 1);

  const cited = theirs.signals[0]!.sources.map((source) => source.id);
  assert.equal(cited.length, 3);
  const owners = db
    .prepare(`SELECT DISTINCT user_id AS owner FROM records WHERE id IN (${cited.map(() => '?').join(',')})`)
    .all(...cited) as Array<{ owner: string }>;
  assert.deepEqual(owners, [{ owner: 'owner-b' }]);
});

test('a meeting with action items cannot be raised against the wrong account', async () => {
  const now = Date.now();
  const startedAt = now - 20 * DAY;
  ensureUser('owner-a', null, null);
  ensureUser('owner-b', null, null);

  const meeting = db.prepare(
    `INSERT INTO meetings (id, user_id, title, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const task = db.prepare(
    `INSERT INTO tasks (id, user_id, text, meeting_id, created_at) VALUES (?, ?, ?, ?, ?)`,
  );

  meeting.run('mtg_a', 'owner-a', 'Rent talk with landlord', startedAt, startedAt, startedAt);
  task.run('task_a_0', 'owner-a', 'Ask about the deposit', 'mtg_a', startedAt);
  task.run('task_a_1', 'owner-a', 'Get the agreement copied', 'mtg_a', startedAt);
  for (let index = 0; index < 3; index += 1) {
    task.run(`task_borrowed_${index}`, 'owner-b', `Counter note ${index}`, 'mtg_a', startedAt);
  }

  meeting.run('mtg_b', 'owner-b', 'Builder call', startedAt, startedAt, startedAt);
  for (let index = 0; index < 4; index += 1) {
    task.run(`task_b_${index}`, 'owner-b', `Follow up ${index}`, 'mtg_b', startedAt);
  }

  assert.equal((await call('POST', '/attention/refresh', undefined, 'owner-a')).status, 202);
  const mine = await settled('owner-a');
  assert.equal(
    mine.total,
    0,
    'Two of their own action items is not enough to raise anything, whoever else wrote on the phone',
  );

  assert.equal((await call('POST', '/attention/refresh', undefined, 'owner-b')).status, 202);
  const theirs = await settled('owner-b');
  assert.equal(theirs.total, 1);
  assert.equal(theirs.signals[0]?.sources.length, 1);
  assert.equal(theirs.signals[0]?.sources[0]?.kind, 'meeting');
  assert.equal(theirs.signals[0]?.sources[0]?.id, 'mtg_b');
  assert.equal(theirs.signals[0]?.sources[0]?.title, 'Builder call');
  assert.ok(
    !JSON.stringify(theirs.signals[0]).includes('Rent talk'),
    'Not one word of the other account\'s meeting may appear on this card',
  );
});

test('two thousand records are a pass that finishes, and finishes without a model call', async () => {
  const now = Date.now();
  const payees = ['Sharma Electricals', 'Ganesh Kirana', 'Sai Tea Stall', 'Metro Card', 'Bharat Traders'];
  const insert = db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction,
                          counterparty, extraction, status, created_at, updated_at)
     VALUES (?, 'owner-a', ?, ?, ?, ?, 'INR', 'out', ?, '{}', 'complete', ?, ?)`,
  );
  db.transaction(() => {
    for (let index = 0; index < 2_000; index += 1) {
      const at = now - index * 8 * 3_600_000;
      insert.run(
        `rec_bulk_${index}`,
        index % 5 === 0 ? 'bill' : 'payment',
        `Bulk ${index}`,
        at,
        20_000 + (index % 37) * 1_000,
        payees[index % payees.length]!,
        at,
        at,
      );
    }
  })();

  const started = Date.now();
  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const after = await settled();
  const elapsed = Date.now() - started;

  assert.equal(after.looking, false);
  assert.equal(after.lastLook?.completed, true);
  assert.equal(calls, 0, 'Not one of these questions needs a model');
  assert.deepEqual(unauthorized, []);

  assert.ok(elapsed < 10_000, `A pass over 2000 records took ${elapsed}ms`);
});

test('a run of identical small payments raises nothing, however many there are', async () => {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction,
                          counterparty, extraction, status, created_at, updated_at)
     VALUES (?, 'owner-a', 'payment', ?, ?, ?, 'INR', 'out', ?, '{}', 'complete', ?, ?)`,
  );

  db.transaction(() => {
    for (let index = 0; index < 250; index += 1) {
      const at = now - index * DAY;
      insert.run(`rec_tea_${index}`, `Tea ${index}`, at, 3_000, 'Sai Tea Stall', at, at);
    }
  })();

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const after = await settled();
  assert.equal(after.total, 0, 'A habit is not 250 double charges');
  assert.equal(calls, 0);
});

test('an account with nothing in it gets an empty list, not an error and not a guess', async () => {
  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const empty = await settled();
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.counts, { commitment: 0, renewal: 0, anomaly: 0 });
  assert.deepEqual(empty.signals, []);
  assert.equal(empty.lastLook?.completed, true);
  assert.equal(empty.lastLook?.found, 0);
  assert.equal(calls, 0);
});

test('a capture from this morning is not in the list of things left undone', async () => {
  const now = Date.now();
  seedRecord('rec_fresh', { title: 'Petrol slip', occurredAt: now });
  db.prepare(`UPDATE records SET status = 'needs_context', created_at = ? WHERE id = 'rec_fresh'`).run(now);
  db.prepare(
    `INSERT INTO questions (id, record_id, field, prompt, options, answer, answered_at, created_at)
     VALUES ('q_fresh', 'rec_fresh', 'amount', 'How much did this cost?', '[]', NULL, NULL, ?)`,
  ).run(now);

  assert.equal((await call('POST', '/attention/refresh')).status, 202);
  const after = await settled();
  assert.equal(after.total, 0, 'Still in the person\'s hand, not neglected');
  assert.equal(calls, 0);
});
