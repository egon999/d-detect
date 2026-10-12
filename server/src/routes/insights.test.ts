import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Account } from '../auth.ts';

const directory = mkdtempSync(join(tmpdir(), 'detact-insights-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';
const { db, ensureUser } = await import('../db.ts');
const { insights, DRILL_DOWN_LIMIT, MIN_RECORDS_FOR_PACE } = await import('./insights.ts');
const { formatMinorUnits } = await import('../money.ts');
const { MIN_DAYS_FOR_PACE } = await import('../budget.ts');

const app = new Hono<{ Variables: { account: Account } }>();
app.use('*', async (context, next) => {
  const id = context.req.header('x-test-owner') ?? 'owner-a';
  ensureUser(id, null, null);
  context.set('account', { id, email: null, name: null });
  await next();
});
app.route('/api/insights', insights);
app.onError((error, context) =>
  context.json({ error: error.message }, error instanceof HTTPException ? error.status : 500),
);

type ProviderBody = { messages?: Array<{ role: string; content: string }> };

let prompts: ProviderBody[] = [];

let calls = 0;
let responder: (url: string, body: ProviderBody) => Promise<unknown> | unknown;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  assert.ok(url.includes('/chat/completions'), `Unexpected network call: ${url}`);
  calls += 1;
  const parsed = typeof init?.body === 'string' ? (JSON.parse(init.body) as ProviderBody) : {};
  prompts.push(parsed);
  const result = await responder(url, parsed);

  if (result instanceof Response) return result;
  return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
};

beforeEach(() => {
  db.exec(
    `DELETE FROM jobs; DELETE FROM signals; DELETE FROM signal_scans; DELETE FROM analyses;
     DELETE FROM case_items; DELETE FROM cases; DELETE FROM questions; DELETE FROM tasks;
     DELETE FROM meetings; DELETE FROM records; DELETE FROM budgets; DELETE FROM files;
     DELETE FROM users;`,
  );
  ensureUser('owner-a', null, null);
  ensureUser('owner-b', null, null);
  prompts = [];
  calls = 0;
  responder = () => {
    throw new Error('This test did not authorize a model call.');
  };
});

after(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-insights-'));
  rmSync(target, { recursive: true, force: true });
});

type Money = { amountMinor: number; amountLabel: string | null };

type DrillDown = { recordIds: string[]; count: number; moreCount: number };

type Screen = {
  period: {
    key: string;
    label: string;
    startedAt: number;
    endedAt: number;
    isCurrent: boolean;
    hasData: boolean;
    dayOfPeriod: number;
    daysInPeriod: number;
    daysLeft: number;
    month: string;
    startsAt: number;
    endsAt: number;
  };
  availablePeriods: Array<{ key: string; label: string; hasData: boolean }>;
  currency: string | null;
  spent: Money;
  received: Money;
  pace: {
    perDaySoFarMinor: number;
    perDaySoFarLabel: string | null;
    projectedMinor: number | null;
    projectedLabel: string | null;
    basedOnRecordCount: number;
    notEnoughYet: string | null;
  };
  categories: Array<
    { name: string; amountMinor: number; amountLabel: string; sharePercent: number } & DrillDown
  >;
  counterparties: Array<{ name: string; amountMinor: number; amountLabel: string } & DrillDown>;
  days: Array<{ date: string; amountMinor: number } & DrillDown>;
  comparison: { previousMonthMinor: number; previousMonthLabel: string | null; changePercent: number | null };
  recordCount: number;
  needsContextCount: number;
  excludedRecordCount: number;
  excluded: { missingCurrency: DrillDown; otherCurrency: DrillDown; unreadable: DrillDown };
  previousMonths: Array<{ month: string; label: string; amountMinor: number; amountLabel: string }>;
  guidance: Array<{ kind: string; tone: string; text: string }>;
};

type BudgetView = {
  amountMinor: number;
  amountLabel: string;
  remainingMinor: number;
  remainingLabel: string;
  usedPercent: number;
  perDayLeftMinor: number;
  perDayLeftLabel: string;
  overspent: boolean;
  period: string;
};

type TestResponse = Screen & {
  budget: BudgetView | null;
  advice: { headline: string; verdict: string; reasons: string[] };
  alerts: Array<{ kind: string; text: string; recordIds: string[]; at: number }>;
  error: string;
};

async function request(path: string, method = 'GET', body?: unknown, owner = 'owner-a') {
  const response = await app.request(path, {
    method,
    headers: { 'x-test-owner': owner, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as TestResponse };
}

type MonthRef = { year: number; monthIndex: number };

function monthsAgo(back: number): MonthRef {
  const now = new Date();
  const moved = new Date(now.getFullYear(), now.getMonth() - back, 1);
  return { year: moved.getFullYear(), monthIndex: moved.getMonth() };
}

function keyOf(month: MonthRef): string {
  return `${month.year}-${String(month.monthIndex + 1).padStart(2, '0')}`;
}

function labelOf(month: MonthRef): string {
  const name = new Intl.DateTimeFormat('en-IN', { month: 'long' }).format(new Date(month.year, month.monthIndex, 1));
  return month.year === new Date().getFullYear() ? name : `${name} ${month.year}`;
}

function dayIn(month: MonthRef, day: number): number {
  return new Date(month.year, month.monthIndex, day, 12, 0, 0, 0).getTime();
}

async function withToday<T>(when: Date, run: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ['Date'], now: when });
  try {
    return await run();
  } finally {
    mock.timers.reset();
  }
}

function mintId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function addRecord(
  seed: {
    owner?: string;
    kind?: string;
    title?: string;
    at?: number;
    amountMinor?: number | null;
    currency?: string | null;
    direction?: string | null;
    counterparty?: string | null;
    category?: string | null;
    extraction?: string;
    status?: string;
  } = {},
): string {
  const id = mintId('rec');
  const at = seed.at ?? Date.now();
  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction,
                          counterparty, category, note, extraction, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    id,
    seed.owner ?? 'owner-a',
    seed.kind ?? 'payment',
    seed.title ?? 'Payment',
    at,
    seed.amountMinor === undefined ? 1_000_00 : seed.amountMinor,
    seed.currency === undefined ? 'INR' : seed.currency,
    seed.direction ?? null,
    seed.counterparty ?? null,
    seed.category ?? null,
    seed.extraction ?? '{}',
    seed.status ?? 'complete',
    at,
    at,
  );
  return id;
}

test('the screen opens on the last month the person has money in, not on an empty calendar month', async () => {
  const previous = monthsAgo(1);

  addRecord({ at: dayIn(previous, 28), amountMinor: 2_450_00, counterparty: 'Sharma Kirana Store' });
  addRecord({ at: dayIn(previous, 29), amountMinor: 1_050_00, counterparty: 'Auto' });

  addRecord({ at: dayIn(monthsAgo(0), 1), kind: 'note', amountMinor: null, currency: null });

  addRecord({ at: dayIn(monthsAgo(0), 1), owner: 'owner-b', amountMinor: 99_000_00 });

  const opened = await request('/api/insights');
  assert.equal(opened.status, 200);
  assert.equal(opened.body.period.key, keyOf(previous));
  assert.equal(opened.body.period.label, labelOf(previous));
  assert.equal(opened.body.period.isCurrent, false);
  assert.equal(opened.body.period.hasData, true);
  assert.equal(opened.body.spent.amountMinor, 3_500_00);
  assert.equal(opened.body.spent.amountLabel, formatMinorUnits(3_500_00, 'INR'));

  assert.equal(opened.body.period.month, opened.body.period.key);
  assert.equal(opened.body.period.startsAt, opened.body.period.startedAt);
  assert.equal(opened.body.period.endsAt, opened.body.period.endedAt);

  const current = monthsAgo(0);
  const asked = await request(`/api/insights?period=${keyOf(current)}`);
  assert.equal(asked.body.period.key, keyOf(current));
  assert.equal(asked.body.period.isCurrent, true);
  assert.equal(asked.body.period.hasData, false);
  assert.equal(asked.body.spent.amountMinor, 0);

  const legacy = await request(`/api/insights?month=${keyOf(current)}`);
  assert.equal(legacy.body.period.key, keyOf(current));

  assert.equal(calls, 0, 'the money screen costs nothing to open');
});

test('the month switcher offers only months that have something in them, newest first', async () => {
  const current = monthsAgo(0);
  const twoBack = monthsAgo(2);
  const fiveBack = monthsAgo(5);
  addRecord({ at: dayIn(current, 1), amountMinor: 500_00 });
  addRecord({ at: dayIn(twoBack, 15), amountMinor: 700_00 });
  addRecord({ at: dayIn(fiveBack, 9), amountMinor: 900_00 });

  addRecord({ at: dayIn(monthsAgo(1), 10), kind: 'message', amountMinor: null, currency: null });
  addRecord({ at: dayIn(monthsAgo(3), 10), owner: 'owner-b', amountMinor: 400_00 });

  const screen = await request('/api/insights');
  assert.deepEqual(
    screen.body.availablePeriods.map((month) => month.key),
    [keyOf(current), keyOf(twoBack), keyOf(fiveBack)],
  );
  for (const month of screen.body.availablePeriods) {
    assert.equal(month.hasData, true);
    assert.equal(month.label, labelOf({ year: Number(month.key.slice(0, 4)), monthIndex: Number(month.key.slice(5)) - 1 }));

    assert.doesNotMatch(month.label, /\d{4}-\d{2}/);
  }

  for (const month of screen.body.availablePeriods) {
    const opened = await request(`/api/insights?period=${month.key}`);
    assert.equal(opened.body.period.hasData, true, month.key);
  }
});

test('a month with nothing in it reports zeros and says it is empty', async () => {

  addRecord({ at: dayIn(monthsAgo(4), 12), amountMinor: 6_000_00 });
  addRecord({ at: dayIn(monthsAgo(0), 1), amountMinor: 6_000_00 });
  const empty = monthsAgo(3);

  const screen = await request(`/api/insights?period=${keyOf(empty)}`);
  assert.equal(screen.body.period.hasData, false);
  assert.equal(screen.body.recordCount, 0);
  assert.equal(screen.body.spent.amountMinor, 0);
  assert.equal(screen.body.received.amountMinor, 0);

  assert.equal(screen.body.currency, 'INR');
  assert.equal(screen.body.spent.amountLabel, formatMinorUnits(0, 'INR'));
  assert.deepEqual(screen.body.categories, []);
  assert.deepEqual(screen.body.counterparties, []);
  assert.equal(screen.body.excludedRecordCount, 0);
  assert.equal(screen.body.needsContextCount, 0);
  assert.equal(screen.body.pace.projectedMinor, null);
  assert.equal(screen.body.days.length, screen.body.period.daysInPeriod);
  assert.equal(
    screen.body.days.reduce((total, day) => total + day.amountMinor, 0),
    0,
  );

  assert.equal(
    screen.body.guidance.find((line) => line.kind === 'pace'),
    undefined,
  );
  for (const line of screen.body.guidance) assert.doesNotMatch(line.text, /heading for|lands near|a day/);
});

test('a month is not projected from its first days, and is once enough of it has run', async () => {
  const current = monthsAgo(0);
  addRecord({ at: dayIn(current, 1), amountMinor: 40_000_00, counterparty: 'Landlord', category: 'Rent' });

  await withToday(new Date(current.year, current.monthIndex, MIN_DAYS_FOR_PACE - 2, 12), async () => {
    const early = await request('/api/insights');
    assert.equal(early.body.period.dayOfPeriod, MIN_DAYS_FOR_PACE - 2);
    assert.equal(early.body.spent.amountMinor, 40_000_00);

    assert.equal(early.body.pace.projectedMinor, null);
    assert.equal(early.body.pace.projectedLabel, null);

    assert.equal(early.body.pace.perDaySoFarMinor, Math.round(40_000_00 / (MIN_DAYS_FOR_PACE - 2)));

    assert.equal(
      early.body.guidance.find((line) => line.kind === 'pace'),
      undefined,
    );

    assert.equal(early.body.pace.notEnoughYet, null);
  });

  await withToday(new Date(current.year, current.monthIndex, 21, 12), async () => {
    const thin = await request('/api/insights');
    assert.equal(thin.body.period.dayOfPeriod, 21);
    assert.equal(thin.body.pace.projectedMinor, null);
    assert.equal(thin.body.pace.projectedLabel, null);
    assert.equal(thin.body.pace.basedOnRecordCount, 1);
    assert.match(thin.body.pace.notEnoughYet ?? '', /not enough/i);
    assert.match(thin.body.pace.notEnoughYet ?? '', /1 entry/);

    const pace = thin.body.guidance.find((line) => line.kind === 'pace');
    assert.equal(pace?.text, thin.body.pace.notEnoughYet);
    for (const line of thin.body.guidance) assert.doesNotMatch(line.text, /heading for|lands near/);
  });

  const extras = MIN_RECORDS_FOR_PACE - 1;
  for (let index = 0; index < extras; index += 1) {
    addRecord({ at: dayIn(current, 2 + index), amountMinor: 1_000_00, counterparty: 'Kirana' });
  }

  await withToday(new Date(current.year, current.monthIndex, 10, 12), async () => {
    const later = await request('/api/insights');
    const days = later.body.period.daysInPeriod;
    const spent = 40_000_00 + extras * 1_000_00;
    assert.equal(later.body.period.dayOfPeriod, 10);
    assert.equal(later.body.spent.amountMinor, spent);
    assert.equal(later.body.pace.basedOnRecordCount, MIN_RECORDS_FOR_PACE);
    assert.equal(later.body.pace.notEnoughYet, null);
    assert.equal(later.body.pace.projectedMinor, Math.round((spent * days) / 10));
    assert.equal(later.body.pace.projectedLabel, formatMinorUnits(Math.round((spent * days) / 10), 'INR'));
  });

  const previous = monthsAgo(1);
  addRecord({ at: dayIn(previous, 10), amountMinor: 8_000_00 });
  const closed = await request(`/api/insights?period=${keyOf(previous)}`);
  assert.equal(closed.body.period.isCurrent, false);
  assert.equal(closed.body.pace.projectedMinor, null);

  assert.equal(closed.body.pace.notEnoughYet, null);
});

test('rows that assert no transaction do not help a month clear the projection floor', async () => {

  const current = monthsAgo(0);
  addRecord({ at: dayIn(current, 1), amountMinor: 40_000_00, counterparty: 'Landlord', category: 'Rent' });
  for (let index = 0; index < MIN_RECORDS_FOR_PACE; index += 1) {
    addRecord({ at: dayIn(current, 2 + index), kind: 'ticket', amountMinor: 7_000_00 });
  }

  await withToday(new Date(current.year, current.monthIndex, 21, 12), async () => {
    const screen = await request('/api/insights');
    assert.equal(screen.body.recordCount, MIN_RECORDS_FOR_PACE + 1, 'every row is in the month');
    assert.equal(screen.body.spent.amountMinor, 40_000_00, 'and only one of them is in the total');
    assert.equal(screen.body.pace.basedOnRecordCount, 1);
    assert.equal(screen.body.pace.projectedMinor, null);
  });
});

test('a bill with nothing printed about direction is money out', async () => {
  const current = monthsAgo(0);

  addRecord({ at: dayIn(current, 1), kind: 'bill', amountMinor: 2_500_00, counterparty: 'Tata Power', category: 'Utilities' });

  addRecord({ at: dayIn(current, 1), kind: 'bill', amountMinor: 99_000_00, extraction: '{"status":"unpaid"}' });

  addRecord({ at: dayIn(current, 1), kind: 'ticket', amountMinor: 7_000_00 });

  const screen = await request('/api/insights');
  assert.equal(screen.body.spent.amountMinor, 2_500_00);
  assert.equal(screen.body.recordCount, 3, 'all three are in the month, only one is in the total');
  assert.equal(screen.body.excludedRecordCount, 0, 'nothing was hidden from the person');
  assert.deepEqual(
    screen.body.categories.map((slice) => [slice.name, slice.amountMinor]),
    [['Utilities', 2_500_00]],
  );
  assert.deepEqual(
    screen.body.counterparties.map((slice) => slice.name),
    ['Tata Power'],
  );
});

test('a figure quoted on a document is not money the person received', async () => {
  const current = monthsAgo(0);

  addRecord({ at: dayIn(current, 1), kind: 'document', direction: 'in', amountMinor: 50_000_00, title: 'Insurance quote' });
  addRecord({ at: dayIn(current, 1), kind: 'message', direction: 'in', amountMinor: 20_000_00, title: 'Someone promising to pay' });

  addRecord({ at: dayIn(current, 1), kind: 'receipt', direction: 'in', amountMinor: 12_000_00, counterparty: 'Client' });

  const screen = await request('/api/insights');
  assert.equal(screen.body.received.amountMinor, 12_000_00);
  assert.equal(screen.body.received.amountLabel, formatMinorUnits(12_000_00, 'INR'));

  assert.equal(screen.body.spent.amountMinor, 0);
});

test('nothing to compare against is not a fall of one hundred percent', async () => {
  const current = monthsAgo(0);
  addRecord({ at: dayIn(current, 1), amountMinor: 3_000_00 });

  const screen = await request('/api/insights');
  assert.equal(screen.body.period.key, keyOf(current));
  assert.equal(screen.body.comparison.previousMonthMinor, 0);
  assert.equal(screen.body.comparison.changePercent, null);

  addRecord({ at: dayIn(monthsAgo(1), 10), amountMinor: 6_000_00 });
  const compared = await request(`/api/insights?period=${keyOf(current)}`);
  assert.equal(compared.body.comparison.previousMonthMinor, 6_000_00);
  assert.equal(compared.body.comparison.changePercent, -50);
});

test('a budget covers one calendar month, and anything else is turned away in words', async () => {
  const set = await request('/api/insights/budget', 'PUT', { amount: '30000', currency: 'INR' });
  assert.equal(set.status, 200);
  assert.equal(set.body.budget?.amountLabel, formatMinorUnits(30_000_00, 'INR'));
  assert.equal(set.body.budget?.period, 'monthly');

  const weekly = await request('/api/insights/budget', 'PUT', { amount: '7000', currency: 'INR', period: 'weekly' });
  assert.equal(weekly.status, 400);
  assert.match(weekly.body.error, /one calendar month/i);

  assert.doesNotMatch(weekly.body.error, /period|monthly|weekly|enum|invalid/i);

  const read = await request('/api/insights/budget');
  assert.equal(read.body.budget?.amountMinor, 30_000_00);

  assert.equal((await request('/api/insights/budget', 'DELETE')).status, 200);
  const gone = await request('/api/insights/budget', 'DELETE');
  assert.equal(gone.status, 404);
  assert.match(gone.body.error, /No budget is set\./);
});

test('a budget set while the calendar month is quiet still finds the money it is about', async () => {

  const previous = monthsAgo(1);
  addRecord({ at: dayIn(previous, 20), amountMinor: 4_000_00 });

  const set = await request('/api/insights/budget', 'PUT', { amount: '25000' });
  assert.equal(set.status, 200);
  assert.equal(set.body.budget?.amountLabel, formatMinorUnits(25_000_00, 'INR'));
  assert.equal(set.body.budget?.remainingMinor, 21_000_00);
  assert.equal(set.body.budget?.overspent, false);

  const screen = await request('/api/insights');
  assert.equal(screen.body.period.key, keyOf(previous));
  assert.equal(screen.body.spent.amountMinor, 4_000_00);
});

test('advice is written about the month on the screen, and never about a projection it does not show', async () => {
  const previous = monthsAgo(1);
  addRecord({ at: dayIn(previous, 28), amountMinor: 6_000_00, counterparty: 'Sharma Kirana Store', category: 'Food' });
  responder = () => ({
    headline: 'A quiet month',
    verdict: 'on_track',
    reasons: [`${formatMinorUnits(6_000_00, 'INR')} went out in all.`],
    moves: [],
    watch: [],
  });

  const advised = await request('/api/insights/advice', 'POST', {});
  assert.equal(advised.status, 200);
  assert.equal(advised.body.advice.verdict, 'on_track');

  const digest = prompts.at(-1)?.messages?.find((message) => message.role === 'user')?.content ?? '';

  assert.ok(digest.includes(labelOf(previous)), digest);
  assert.ok(digest.includes(formatMinorUnits(6_000_00, 'INR')), digest);

  assert.match(digest, /no projected total for this period/i);
  assert.doesNotMatch(digest, /projecting/);
});

test('an empty month is described to the model as empty, not as restraint', async () => {
  addRecord({ at: dayIn(monthsAgo(1), 10), amountMinor: 6_000_00 });
  responder = () => ({ headline: 'Nothing saved here yet', verdict: 'on_track', reasons: [], moves: [], watch: [] });

  const advised = await request(`/api/insights/advice?period=${keyOf(monthsAgo(0))}`, 'POST', {});
  assert.equal(advised.status, 200);
  const digest = prompts.at(-1)?.messages?.find((message) => message.role === 'user')?.content ?? '';
  assert.match(digest, /Nothing with an amount on it was saved in this period/);

  assert.match(digest, /not because spending was low/);
});

test('advice that cannot be written is explained in the person\'s own terms, and the status says whether to try again', async () => {
  addRecord({ at: dayIn(monthsAgo(0), 1), amountMinor: 3_000_00, counterparty: 'Sharma Kirana Store' });
  const secrets = /groq|llama|gpt-oss|rate.?limit|qwen|gemini|bearer|api key|token/i;

  responder = () =>
    new Response(
      JSON.stringify({
        error: {
          message:
            'Rate limit reached for model `openai/gpt-oss-120b` in organization org_01 on tokens per minute (TPM): Limit 6000',
          code: 'rate_limit_exceeded',
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
  const limited = await request('/api/insights/advice', 'POST', {});

  assert.equal(limited.status, 502, 'a failure that may pass says so');
  assert.match(limited.body.error, /try again in a moment/i);

  assert.match(limited.body.error, /figures above are still correct/i);
  assert.ok(!secrets.test(JSON.stringify(limited.body)), `vendor detail leaked: ${JSON.stringify(limited.body)}`);

  responder = () =>
    new Response(JSON.stringify({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }), { status: 401 });
  const refused = await request('/api/insights/advice', 'POST', {});

  assert.equal(refused.status, 503, 'a failure that cannot pass says that instead');
  assert.match(refused.body.error, /unavailable on this server/i);
  assert.match(refused.body.error, /figures above are still correct/i);
  assert.ok(!secrets.test(JSON.stringify(refused.body)), `vendor detail leaked: ${JSON.stringify(refused.body)}`);
});

test('advice that comes back in the wrong shape is a sentence, not a server error', async () => {
  addRecord({ at: dayIn(monthsAgo(0), 1), amountMinor: 3_000_00, counterparty: 'Sharma Kirana Store' });

  responder = () => ({ verdict: 'doing fine', notes: ['spending looks normal'] });
  const unusable = await request('/api/insights/advice', 'POST', {});

  assert.equal(unusable.status, 502, 'a shape nobody could use is worth another tap, not a broken screen');
  assert.match(unusable.body.error, /form we could not use/i);
  assert.match(unusable.body.error, /figures above are still correct/i);

  assert.doesNotMatch(unusable.body.error, /headline|verdict|on_track|zod|expected|received|invalid/i);
  assert.equal(calls, 2, 'asked once, repaired once, then gave up — not an unbounded retry');
});

test('a request body that is not an object is a sentence, not a crash', async () => {
  addRecord({ at: dayIn(monthsAgo(0), 1), amountMinor: 3_000_00, counterparty: 'Sharma Kirana Store' });
  responder = () => ({ headline: 'A quiet month', verdict: 'on_track', reasons: [], moves: [], watch: [] });

  for (const body of [null, 'just a string', 42, [], true]) {
    const answer = await request('/api/insights/advice', 'POST', body);
    assert.ok(answer.status < 500, `a body of ${JSON.stringify(body)} answered ${answer.status}`);
    const text = JSON.stringify(answer.body);
    assert.doesNotMatch(text, /Cannot read propert|undefined is not|TypeError/i, `a JavaScript error reached the person: ${text}`);
  }
});

test('the written advice never names the model that wrote it', async () => {

  addRecord({ at: dayIn(monthsAgo(0), 1), amountMinor: 3_000_00, counterparty: 'Sharma Kirana Store' });
  responder = () => ({ headline: 'A quiet month', verdict: 'on_track', reasons: [], moves: [], watch: [] });

  const advised = await request('/api/insights/advice', 'POST', {});
  assert.equal(advised.status, 200);
  assert.equal(Reflect.get(advised.body as object, 'model'), undefined, 'the response named the model');
  const text = JSON.stringify(advised.body);
  for (const token of ['groq', 'gpt-oss', 'llama', 'qwen', 'gemini', 'gsk_', 'xai-', 'openai']) {
    assert.ok(!text.toLowerCase().includes(token), `the advice response carried "${token}": ${text}`);
  }
});

test('a counter kept in a drawer stops at the cap and says how many it left out', async () => {

  const current = monthsAgo(0);
  const ids: string[] = [];
  for (let index = 0; index < DRILL_DOWN_LIMIT + 3; index += 1) {
    ids.push(
      addRecord({
        at: dayIn(current, 1),
        amountMinor: 100_00,
        counterparty: 'Sharma Kirana Store',
        category: 'Groceries',
      }),
    );
  }

  const screen = await request('/api/insights');
  const slice = screen.body.categories.find((row) => row.name === 'Groceries');
  assert.ok(slice, 'the category was not in the screen at all');
  assert.equal(slice.count, DRILL_DOWN_LIMIT + 3, 'the total hid entries');
  assert.equal(slice.recordIds.length, DRILL_DOWN_LIMIT, 'the list ignored the cap');
  assert.equal(slice.moreCount, 3, 'the entries beyond the cap were silently dropped');

  for (const id of slice.recordIds) assert.ok(ids.includes(id), `drill-down named a foreign record: ${id}`);
});

test('every summed row names its own records, and the three exclusion reasons do not borrow from each other', async () => {

  const current = monthsAgo(0);
  const groceries = [
    addRecord({ at: dayIn(current, 3), amountMinor: 250_00, counterparty: 'Sharma Kirana Store', category: 'Groceries' }),
    addRecord({ at: dayIn(current, 4), amountMinor: 310_00, counterparty: 'Sharma Kirana Store', category: 'Groceries' }),
    addRecord({ at: dayIn(current, 5), amountMinor: 90_00, counterparty: 'Corner Shop', category: 'Groceries' }),
  ];
  const rent = addRecord({ at: dayIn(current, 6), amountMinor: 12_000_00, counterparty: 'Landlord', category: 'Rent' });

  const noCurrency = addRecord({ at: dayIn(current, 7), amountMinor: 400_00, currency: null, counterparty: 'Auto' });
  const otherCurrency = addRecord({ at: dayIn(current, 8), amountMinor: 60_00, currency: 'USD', counterparty: 'Bookshop' });
  const unreadable = addRecord({ at: dayIn(current, 9), amountMinor: 700_00, extraction: 'not json at all', counterparty: 'Chemist' });

  const screen = await request('/api/insights');
  assert.equal(screen.status, 200);

  const grocerySlice = screen.body.categories.find((row) => row.name === 'Groceries');
  assert.ok(grocerySlice);
  assert.deepEqual([...grocerySlice.recordIds].sort(), [...groceries].sort());
  assert.equal(grocerySlice.count, 3);
  assert.equal(grocerySlice.moreCount, 0);

  const landlord = screen.body.counterparties.find((party) => party.name === 'Landlord');
  assert.ok(landlord);
  assert.deepEqual(landlord.recordIds, [rent]);
  const sharma = screen.body.counterparties.find((party) => party.name === 'Sharma Kirana Store');
  assert.ok(sharma);
  assert.deepEqual([...sharma.recordIds].sort(), [groceries[0], groceries[1]].sort());

  const third = screen.body.days.find((day) => day.date.endsWith('-03'));
  assert.ok(third);
  assert.deepEqual(third.recordIds, [groceries[0]]);
  assert.equal(third.amountMinor, 250_00);
  const second = screen.body.days.find((day) => day.date.endsWith('-01'));
  assert.ok(second);
  assert.deepEqual(second.recordIds, []);
  assert.equal(second.count, 0);
  assert.equal(second.moreCount, 0);

  assert.deepEqual(screen.body.excluded.missingCurrency.recordIds, [noCurrency]);
  assert.deepEqual(screen.body.excluded.otherCurrency.recordIds, [otherCurrency]);
  assert.deepEqual(screen.body.excluded.unreadable.recordIds, [unreadable]);
  assert.equal(
    screen.body.excludedRecordCount,
    screen.body.excluded.missingCurrency.count +
      screen.body.excluded.otherCurrency.count +
      screen.body.excluded.unreadable.count,
    'the headline count and the three buckets it is made of disagree',
  );

  const everyDrilledId = [
    ...screen.body.categories.flatMap((row) => row.recordIds),
    ...screen.body.counterparties.flatMap((row) => row.recordIds),
    ...screen.body.days.flatMap((row) => row.recordIds),
  ];
  for (const id of [noCurrency, otherCurrency, unreadable]) {
    assert.ok(!everyDrilledId.includes(id), `an uncounted record appeared inside a total: ${id}`);
  }
});

test('a charge paid twice reaches the person, with the records that prove it', async () => {

  const month = monthsAgo(1);
  const first = addRecord({
    at: dayIn(month, 10),
    amountMinor: 1_200_00,
    counterparty: 'Jain Hardware',
    category: 'Repairs',
  });
  const second = addRecord({
    at: dayIn(month, 10) + 60 * 60 * 1000,
    amountMinor: 1_200_00,
    counterparty: 'Jain Hardware',
    category: 'Repairs',
  });

  addRecord({ at: dayIn(month, 12), amountMinor: 430_00, counterparty: 'Auto' });

  addRecord({ at: dayIn(month, 10), owner: 'owner-b', amountMinor: 1_200_00, counterparty: 'Jain Hardware' });
  addRecord({ at: dayIn(month, 10) + 1000, owner: 'owner-b', amountMinor: 1_200_00, counterparty: 'Jain Hardware' });

  const screen = await request(`/api/insights?period=${keyOf(month)}`);
  assert.ok(Array.isArray(screen.body.alerts), 'the screen carried no alerts field at all');

  const duplicate = screen.body.alerts.find((alert) => alert.kind === 'possible-duplicate');
  assert.ok(duplicate, `no duplicate alert: ${JSON.stringify(screen.body.alerts)}`);

  assert.deepEqual([...duplicate.recordIds].sort(), [first, second].sort());

  assert.ok(
    duplicate.text.includes(formatMinorUnits(1_200_00, 'INR')),
    `the sentence did not name the stored amount: ${duplicate.text}`,
  );
  assert.ok(duplicate.text.includes('Jain Hardware'), `the sentence did not name the payee: ${duplicate.text}`);
  assert.equal(typeof duplicate.at, 'number');
});

test('an alert never says anything about a product, a limit or a machine', async () => {
  const month = monthsAgo(1);
  addRecord({ at: dayIn(month, 8), amountMinor: 3_400_00, counterparty: 'Verma Traders' });
  addRecord({ at: dayIn(month, 8) + 5 * 60 * 1000, amountMinor: 3_400_00, counterparty: 'Verma Traders' });

  const screen = await request(`/api/insights?period=${keyOf(month)}`);

  const SELLING = /\b(limit|limits|quota|tier|plan|upgrade|premium|subscription|trial)\b/i;
  const MACHINE = /\b(groq|openai|whisper|sqlite|undefined|null|NaN|endpoint|payload|record_?id|minor)\b|gsk_|%/i;

  for (const alert of screen.body.alerts) {
    assert.ok(!SELLING.test(alert.text), `an alert sold something: ${alert.text}`);
    assert.ok(!MACHINE.test(alert.text), `an alert spoke like a machine: ${alert.text}`);

    assert.ok(alert.text.trim().length > 12, `an alert was not a sentence: ${alert.text}`);
    assert.ok(alert.recordIds.length > 0, `an alert carried no evidence: ${alert.text}`);
  }
});

test('a brand-new account is told nothing is wrong, rather than being warned about its first week', async () => {

  const current = monthsAgo(0);
  addRecord({ at: dayIn(current, 1), amountMinor: 40_000_00, counterparty: 'Landlord', category: 'Rent' });
  addRecord({ at: dayIn(current, 1), amountMinor: 899_00, counterparty: 'Airtel', category: 'Phone' });
  addRecord({ at: dayIn(current, 2), amountMinor: 2_450_00, counterparty: 'Sharma Kirana Store' });

  const screen = await request('/api/insights');
  assert.deepEqual(screen.body.alerts, [], `a new account was warned: ${JSON.stringify(screen.body.alerts)}`);
});
