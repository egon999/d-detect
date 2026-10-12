import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { askJson, isAiFailure } from '../ai/index.ts';
import { accountOf } from '../auth.ts';
import { budgetAdvice, BUDGET_PERIOD, MIN_DAYS_FOR_PACE, MIN_RECORDS_FOR_PACE, spendingAlerts } from '../budget.ts';
import { db } from '../db.ts';
import { newId } from '../files.ts';
import { formatMinorUnits, normalizeCurrency, toMinorUnits } from '../money.ts';
import { detectRecurring, type RecurringRecord } from '../recurring.ts';
import type { Account } from '../auth.ts';

type Variables = { account: Account };

type MoneyRow = {

  id: string;
  kind: string;
  amount_minor: number | null;
  currency: string | null;
  direction: string | null;
  category: string | null;
  counterparty: string | null;
  status: string;
  extraction: string;
  at: number;
};

type BudgetRow = {
  id: string;
  user_id: string;
  period: string;
  amount_minor: number;
  currency: string;
  created_at: number;
  updated_at: number;
};

type Money = { amountMinor: number; amountLabel: string | null };

type BudgetView = {
  amountMinor: number;
  amountLabel: string;
  remainingMinor: number;
  remainingLabel: string;
  usedPercent: number;
  perDayLeftMinor: number;
  perDayLeftLabel: string;
  overspent: boolean;

  period: typeof BUDGET_PERIOD;
};

type MonthRef = { year: number; monthIndex: number };

type Period = {
  month: string;
  label: string;
  startsAt: number;
  endsAt: number;
  dayOfPeriod: number;
  daysInPeriod: number;
  daysLeft: number;

  current: boolean;
  year: number;
  monthIndex: number;
};

type AvailablePeriod = { key: string; label: string; hasData: true };

type CategorySlice = DrillDown & {
  name: string;
  amountMinor: number;
  amountLabel: string;
  sharePercent: number;
};

type CounterpartySlice = DrillDown & { name: string; amountMinor: number; amountLabel: string };

type DaySpend = DrillDown & { date: string; amountMinor: number };

type MonthSpend = { month: string; label: string; amountMinor: number; amountLabel: string };

export type DrillDown = { recordIds: string[]; count: number; moreCount: number };

export const DRILL_DOWN_LIMIT = 8;

type TallyEntry = { amountMinor: number; ids: string[] };

function measure(entry: TallyEntry): DrillDown {
  return {
    recordIds: entry.ids.slice(0, DRILL_DOWN_LIMIT),
    count: entry.ids.length,
    moreCount: Math.max(0, entry.ids.length - DRILL_DOWN_LIMIT),
  };
}

export function drillDownOf(recordIds: readonly string[]): DrillDown {
  return measure({ amountMinor: 0, ids: [...recordIds] });
}

export function tallyWithIds<T>(
  rows: readonly T[],
  nameOf: (row: T) => string | null,
  amountOf: (row: T) => number,
  idOf: (row: T) => string,
): Array<{ name: string; amountMinor: number } & DrillDown> {
  const tally = new Map<string, TallyEntry>();
  for (const row of rows) {
    const amountMinor = amountOf(row);
    if (amountMinor === 0) continue;
    const name = nameOf(row);
    if (name === null) continue;
    const seen = tally.get(name) ?? { amountMinor: 0, ids: [] };
    seen.amountMinor += amountMinor;
    seen.ids.push(idOf(row));
    tally.set(name, seen);
  }
  return [...tally.entries()]
    .map(([name, seen]) => ({ name, amountMinor: seen.amountMinor, ...measure(seen) }))
    .sort((left, right) => right.amountMinor - left.amountMinor);
}

type Excluded = Record<'missingCurrency' | 'otherCurrency' | 'unreadable', DrillDown>;

type Summary = {
  period: Period;

  hasData: boolean;
  currency: string | null;
  spentMinor: number;
  receivedMinor: number;
  budget: BudgetView | null;
  pace: {
    perDaySoFarMinor: number;
    perDaySoFarLabel: string | null;

    projectedMinor: number | null;
    projectedLabel: string | null;

    basedOnRecordCount: number;

    notEnoughYet: string | null;
  };
  categories: CategorySlice[];
  counterparties: CounterpartySlice[];
  days: DaySpend[];
  comparison: { previousMonthMinor: number; previousMonthLabel: string | null; changePercent: number | null };

  previousToDateMinor: number | null;
  recordCount: number;
  needsContextCount: number;
  excludedRecordCount: number;
  excluded: Excluded;
  previousMonths: MonthSpend[];
};

const HISTORY_MONTHS = 5;

const AVAILABLE_PERIODS = 24;

const PERIOD_SCAN_LIMIT = 20_000;

export { MIN_RECORDS_FOR_PACE };

const DAY_MS = 86_400_000;

const UNCATEGORISED = 'Uncategorised';

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

function money(minor: number, currency: string | null): Money {
  return { amountMinor: minor, amountLabel: amountLabelOf(minor, currency) };
}

export function amountLabelOf(minor: number, currency: string | null): string | null {
  return currency === null ? null : formatMinorUnits(minor, currency);
}

const TRANSACTIONAL = new Set(['payment', 'purchase', 'bill', 'receipt']);

const UNPAID = /\b(failed|failure|pending|unpaid|declined|cancelled|canceled|overdue|due|reversed|refunded|not paid|not received)\b/;

export type SpendRow = {
  kind: string;
  amount_minor: number | null;
  direction: string | null;
  status: string;
  extraction: string;
};

export function settlementOf(row: SpendRow): 'settled' | 'unsettled' | 'unreadable' {
  let status = '';
  try {
    const extraction: unknown = JSON.parse(row.extraction);
    if (extraction && typeof extraction === 'object' && 'status' in extraction && typeof extraction.status === 'string') {
      status = extraction.status.trim().toLowerCase();
    }
  } catch { return 'unreadable'; }
  if (!['complete', 'needs_context'].includes(row.status)) return 'unsettled';
  return UNPAID.test(status) ? 'unsettled' : 'settled';
}

export function isSettled(row: SpendRow): boolean {
  return settlementOf(row) === 'settled';
}

export function spendOf(row: SpendRow): number {
  if (row.amount_minor === null || !isSettled(row)) return 0;
  if (row.direction === 'out') return Math.abs(row.amount_minor);
  if (row.direction === null && row.amount_minor > 0 && TRANSACTIONAL.has(row.kind)) return row.amount_minor;
  return 0;
}

export function receiptOf(row: SpendRow): number {
  if (row.amount_minor === null || !isSettled(row)) return 0;
  if (row.direction !== 'in' || !TRANSACTIONAL.has(row.kind)) return 0;
  return Math.abs(row.amount_minor);
}

function sumSpend(rows: SpendRow[]): number {
  return rows.reduce((total, row) => total + spendOf(row), 0);
}

function parseMonth(raw: string): { year: number; monthIndex: number } | null {
  const match = MONTH_PATTERN.exec(raw.trim());
  const year = match?.[1];
  const month = match?.[2];
  if (!year || !month) return null;
  return { year: Number.parseInt(year, 10), monthIndex: Number.parseInt(month, 10) - 1 };
}

function monthKey(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function monthLabel(year: number, monthIndex: number): string {
  const name = new Intl.DateTimeFormat('en-IN', { month: 'long' }).format(new Date(year, monthIndex, 1));
  return year === new Date().getFullYear() ? name : `${name} ${year}`;
}

function boundsOf(year: number, monthIndex: number): { startsAt: number; endsAt: number; days: number } {
  const startsAt = new Date(year, monthIndex, 1, 0, 0, 0, 0).getTime();
  const endsAt = new Date(year, monthIndex + 1, 1, 0, 0, 0, 0).getTime() - 1;
  return { startsAt, endsAt, days: new Date(year, monthIndex + 1, 0).getDate() };
}

function shiftMonth(year: number, monthIndex: number, delta: number): { year: number; monthIndex: number } {
  const moved = new Date(year, monthIndex + delta, 1);
  return { year: moved.getFullYear(), monthIndex: moved.getMonth() };
}

function periodOf(raw: string | undefined): Period {
  const now = new Date();
  const asked = raw ? parseMonth(raw) : null;
  if (raw && (!asked || asked.year < 1900 || asked.year > 2100)) {
    throw new HTTPException(400, { message: 'Choose a valid month.' });
  }
  const year = asked?.year ?? now.getFullYear();
  const monthIndex = asked?.monthIndex ?? now.getMonth();

  const { startsAt, endsAt, days } = boundsOf(year, monthIndex);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const dayOfPeriod = todayStart < startsAt ? 0 : todayStart > endsAt ? days : now.getDate();

  return {
    month: monthKey(year, monthIndex),
    label: monthLabel(year, monthIndex),
    startsAt,
    endsAt,
    dayOfPeriod,
    daysInPeriod: days,
    daysLeft: days - dayOfPeriod,
    current: todayStart >= startsAt && todayStart <= endsAt,
    year,
    monthIndex,
  };
}

function budgetOf(userId: string): BudgetRow | undefined {
  return db.prepare('SELECT * FROM budgets WHERE user_id = ? AND period = ?').get(userId, BUDGET_PERIOD) as
    | BudgetRow
    | undefined;
}

function moneyMonths(userId: string): MonthRef[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(occurred_at, created_at) AS at
       FROM records
       WHERE user_id = ? AND amount_minor IS NOT NULL
       ORDER BY at DESC
       LIMIT ?`,
    )
    .all(userId, PERIOD_SCAN_LIMIT) as Array<{ at: number }>;

  const months: MonthRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const when = new Date(row.at);
    const key = monthKey(when.getFullYear(), when.getMonth());
    if (seen.has(key)) continue;
    seen.add(key);
    months.push({ year: when.getFullYear(), monthIndex: when.getMonth() });
  }
  return months;
}

function sameMonth(left: MonthRef, right: MonthRef): boolean {
  return left.year === right.year && left.monthIndex === right.monthIndex;
}

function isEarlier(candidate: MonthRef, reference: MonthRef): boolean {
  return (
    candidate.year < reference.year ||
    (candidate.year === reference.year && candidate.monthIndex < reference.monthIndex)
  );
}

function chooseMonth(asked: string | undefined, months: MonthRef[]): Period {
  const wanted = asked?.trim();
  if (wanted) return periodOf(wanted);

  const current = periodOf(undefined);
  if (months.some((month) => sameMonth(month, current))) return current;
  const earlier = months.find((month) => isEarlier(month, current));
  return earlier ? periodOf(monthKey(earlier.year, earlier.monthIndex)) : current;
}

function availablePeriodsOf(months: MonthRef[]): AvailablePeriod[] {
  return months.slice(0, AVAILABLE_PERIODS).map((month) => ({
    key: monthKey(month.year, month.monthIndex),
    label: monthLabel(month.year, month.monthIndex),
    hasData: true,
  }));
}

function monthQuery(period: string | undefined, month: string | undefined): string | undefined {
  return period ?? month;
}

function budgetView(row: BudgetRow, spentMinor: number, daysLeft: number): BudgetView {
  const remainingMinor = row.amount_minor - spentMinor;

  const spreadOver = Math.max(daysLeft, 1);
  const perDayLeftMinor = remainingMinor > 0 ? Math.floor(remainingMinor / spreadOver) : 0;

  return {
    amountMinor: row.amount_minor,
    amountLabel: formatMinorUnits(row.amount_minor, row.currency),
    remainingMinor,
    remainingLabel: formatMinorUnits(remainingMinor, row.currency),
    usedPercent: row.amount_minor > 0 ? Math.round((spentMinor / row.amount_minor) * 1000) / 10 : 0,
    perDayLeftMinor,
    perDayLeftLabel: formatMinorUnits(perDayLeftMinor, row.currency),
    overspent: remainingMinor < 0,
    period: BUDGET_PERIOD,
  };
}

export function dominantCurrencyOf(rows: Array<{ amount_minor: number | null; currency: string | null }>): string | null {
  const tally = new Map<string, { count: number; total: number }>();
  for (const row of rows) {
    if (row.amount_minor === null) continue;
    const code = normalizeCurrency(row.currency);
    if (!code) continue;
    const seen = tally.get(code) ?? { count: 0, total: 0 };
    tally.set(code, { count: seen.count + 1, total: seen.total + Math.abs(row.amount_minor) });
  }

  let best: { code: string; count: number; total: number } | null = null;
  for (const [code, seen] of tally) {
    if (!best || seen.count > best.count || (seen.count === best.count && seen.total > best.total)) {
      best = { code, count: seen.count, total: seen.total };
    }
  }
  return best?.code ?? null;
}

function dominantCurrency(rows: MoneyRow[], budget: BudgetRow | undefined): string | null {
  return budget ? budget.currency : dominantCurrencyOf(rows);
}

function windowRows(userId: string, from: number, to: number): MoneyRow[] {
  return db
    .prepare(
      `SELECT id, kind, amount_minor, currency, direction, category, counterparty, status, extraction,
              COALESCE(occurred_at, created_at) AS at
       FROM records
       WHERE user_id = ? AND COALESCE(occurred_at, created_at) >= ? AND COALESCE(occurred_at, created_at) <= ?
       ORDER BY COALESCE(occurred_at, created_at) DESC`,
    )
    .all(userId, from, to) as MoneyRow[];
}

function summarize(userId: string, period: Period): Summary {
  const history = shiftMonth(period.year, period.monthIndex, -HISTORY_MONTHS);
  const rows = windowRows(userId, boundsOf(history.year, history.monthIndex).startsAt, period.endsAt);

  const inPeriod = rows.filter((row) => row.at >= period.startsAt && row.at <= period.endsAt);
  const budgetRow = budgetOf(userId);

  const currency = dominantCurrency(inPeriod, budgetRow) ?? dominantCurrencyOf(rows);

  const hasData = inPeriod.some((row) => row.amount_minor !== null);

  const reported: MoneyRow[] = [];
  const left: Record<keyof Excluded, TallyEntry> = {
    missingCurrency: { amountMinor: 0, ids: [] },
    otherCurrency: { amountMinor: 0, ids: [] },
    unreadable: { amountMinor: 0, ids: [] },
  };
  for (const row of inPeriod) {
    if (row.amount_minor === null) continue;
    const code = normalizeCurrency(row.currency);
    if (settlementOf(row) === 'unreadable') left.unreadable.ids.push(row.id);
    else if (code === null) left.missingCurrency.ids.push(row.id);
    else if (code !== currency) left.otherCurrency.ids.push(row.id);
    else reported.push(row);
  }
  const excluded: Excluded = {
    missingCurrency: measure(left.missingCurrency),
    otherCurrency: measure(left.otherCurrency),
    unreadable: measure(left.unreadable),
  };
  const excludedRecordCount =
    excluded.missingCurrency.count + excluded.otherCurrency.count + excluded.unreadable.count;

  const spentMinor = sumSpend(reported);
  const receivedMinor = reported.reduce((total, row) => total + receiptOf(row), 0);

  const dayTally = Array.from({ length: period.daysInPeriod }, (): TallyEntry => ({ amountMinor: 0, ids: [] }));
  for (const row of reported) {
    const spend = spendOf(row);
    if (spend === 0) continue;
    const bucket = dayTally[new Date(row.at).getDate() - 1];
    if (bucket) {
      bucket.amountMinor += spend;
      bucket.ids.push(row.id);
    }
  }
  const days: DaySpend[] = dayTally.map((entry, index) => ({
    date: `${period.month}-${String(index + 1).padStart(2, '0')}`,
    amountMinor: entry.amountMinor,
    ...measure(entry),
  }));

  const categories: CategorySlice[] =
    currency === null
      ? []
      : tallyWithIds(reported, (row) => row.category?.trim() || UNCATEGORISED, spendOf, (row) => row.id).map(
          (slice) => ({
            ...slice,
            amountLabel: formatMinorUnits(slice.amountMinor, currency),
            sharePercent: spentMinor > 0 ? Math.round((slice.amountMinor / spentMinor) * 1000) / 10 : 0,
          }),
        );

  const counterparties: CounterpartySlice[] =
    currency === null
      ? []
      : tallyWithIds(reported, (row) => row.counterparty?.trim() || null, spendOf, (row) => row.id)
          .slice(0, 6)
          .map((slice) => ({ ...slice, amountLabel: formatMinorUnits(slice.amountMinor, currency) }));

  const previousMonths: MonthSpend[] = [];
  const sameCurrency = currency === null ? [] : rows.filter((row) => normalizeCurrency(row.currency) === currency);
  for (let back = HISTORY_MONTHS; currency !== null && back >= 1; back -= 1) {
    const shifted = shiftMonth(period.year, period.monthIndex, -back);
    const bounds = boundsOf(shifted.year, shifted.monthIndex);
    const amountMinor = sumSpend(
      sameCurrency.filter((row) => row.at >= bounds.startsAt && row.at <= bounds.endsAt),
    );
    previousMonths.push({
      month: monthKey(shifted.year, shifted.monthIndex),
      label: monthLabel(shifted.year, shifted.monthIndex),
      amountMinor,
      amountLabel: formatMinorUnits(amountMinor, currency),
    });
  }

  const previousMonthMinor = previousMonths.at(-1)?.amountMinor ?? 0;

  const previous = shiftMonth(period.year, period.monthIndex, -1);
  const previousBounds = boundsOf(previous.year, previous.monthIndex);
  const previousToDateMinor =
    currency === null || period.dayOfPeriod === 0
      ? null
      : sumSpend(
          sameCurrency.filter(
            (row) =>
              row.at >= previousBounds.startsAt &&
              row.at <=
                Math.min(
                  new Date(previous.year, previous.monthIndex, period.dayOfPeriod + 1).getTime() - 1,
                  previousBounds.endsAt,
                ),
          ),
        );

  const perDaySoFarMinor = period.dayOfPeriod > 0 ? Math.round(spentMinor / period.dayOfPeriod) : 0;

  const contributing = reported.filter((row) => spendOf(row) > 0).length;

  const tooFewDays = period.dayOfPeriod < MIN_DAYS_FOR_PACE;
  const tooFewRecords = contributing < MIN_RECORDS_FOR_PACE;
  const projectedMinor =
    period.current && !tooFewDays && !tooFewRecords && spentMinor > 0
      ? Math.round((spentMinor * period.daysInPeriod) / period.dayOfPeriod)
      : null;

  const notEnoughYet =
    period.current && !tooFewDays && tooFewRecords && spentMinor > 0
      ? `Only ${contributing} ${contributing === 1 ? 'entry' : 'entries'} so far — not enough to say where the month is heading.`
      : null;

  return {
    period,
    hasData,
    currency,
    spentMinor,
    receivedMinor,

    budget: budgetRow ? budgetView(budgetRow, spentMinor, period.daysLeft) : null,
    pace: {
      perDaySoFarMinor,
      perDaySoFarLabel: amountLabelOf(perDaySoFarMinor, currency),
      projectedMinor,
      projectedLabel: projectedMinor === null ? null : amountLabelOf(projectedMinor, currency),
      basedOnRecordCount: contributing,
      notEnoughYet,
    },
    categories,
    counterparties,
    days,
    comparison: {
      previousMonthMinor,
      previousMonthLabel: amountLabelOf(previousMonthMinor, currency),

      changePercent:
        previousMonthMinor > 0
          ? Math.round(((spentMinor - previousMonthMinor) / previousMonthMinor) * 1000) / 10
          : null,
    },
    previousToDateMinor,
    recordCount: inPeriod.length,
    needsContextCount: inPeriod.filter((row) => row.status === 'needs_context').length,
    excludedRecordCount,
    excluded,
    previousMonths,
  };
}

export const insights = new Hono<{ Variables: Variables }>();

const RECURRING_HISTORY_DAYS = 400;
const RECURRING_HISTORY_LIMIT = 2_000;

export function recurringHistory(userId: string, now: number): RecurringRecord[] {
  return db
    .prepare(
      `SELECT id, kind, occurred_at AS occurredAt, amount_minor AS amountMinor, currency,
              direction, counterparty, status
       FROM records
       WHERE user_id = ? AND status = 'complete' AND occurred_at IS NOT NULL AND occurred_at >= ?
       ORDER BY occurred_at DESC LIMIT ?`,
    )
    .all(userId, now - RECURRING_HISTORY_DAYS * DAY_MS, RECURRING_HISTORY_LIMIT) as RecurringRecord[];
}

insights.get('/', (context) => {
  const account = accountOf(context);
  const months = moneyMonths(account.id);
  const period = chooseMonth(monthQuery(context.req.query('period'), context.req.query('month')), months);
  const summary = summarize(account.id, period);

  const now = Date.now();
  const history = recurringHistory(account.id, now);
  const recurring = detectRecurring(history, now).map((item) => ({
    counterparty: item.counterparty,
    cadence: item.cadence,
    amountMinor: item.amountMinor,
    amountLabel: formatMinorUnits(item.amountMinor, item.currency),
    currency: item.currency,
    at: item.at,
    occurrences: item.occurrences,

    estimated: true,
  }));

  const currency = summary.currency;
  const advice = currency === null ? [] : budgetAdvice({
    currency,
    budgetMinor: summary.budget?.amountMinor ?? null,
    spentMinor: summary.spentMinor,
    dayOfPeriod: period.dayOfPeriod,
    daysInPeriod: period.daysInPeriod,
    daysLeft: period.daysLeft,
    current: period.current,
    committed: recurring
      .filter((item) => item.currency === currency && item.at > now && item.at <= period.endsAt)
      .map((item) => ({ counterparty: item.counterparty, amountMinor: item.amountMinor, at: item.at })),

    topCategory: (() => {
      const top = summary.categories.find((category) => category.name !== UNCATEGORISED);
      return top
        ? {
            name: top.name,
            amountMinor: top.amountMinor,
            sharePercent: Math.round(top.sharePercent),
            count: top.count,
          }
        : null;
    })(),
    previousToDateMinor: summary.previousToDateMinor,
    excludedRecordCount: summary.excludedRecordCount,
    needsContextCount: summary.needsContextCount,

    contributingRecordCount: summary.pace.basedOnRecordCount,
  });

  return context.json({
    period: {
      key: period.month,
      label: period.label,
      startedAt: period.startsAt,
      endedAt: period.endsAt,
      isCurrent: period.current,
      hasData: summary.hasData,
      dayOfPeriod: period.dayOfPeriod,
      daysInPeriod: period.daysInPeriod,
      daysLeft: period.daysLeft,

      month: period.month,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
    },

    availablePeriods: availablePeriodsOf(months),
    currency: summary.currency,
    spent: money(summary.spentMinor, summary.currency),
    received: money(summary.receivedMinor, summary.currency),
    budget: summary.budget,
    pace: summary.pace,
    categories: summary.categories,
    counterparties: summary.counterparties,
    days: summary.days,
    comparison: summary.comparison,
    recordCount: summary.recordCount,
    needsContextCount: summary.needsContextCount,
    excludedRecordCount: summary.excludedRecordCount,
    excluded: summary.excluded,
    previousMonths: summary.previousMonths,
    recurring,
    guidance: advice,

    alerts: spendingAlerts(history, now),
  });
});

function budgetViewFor(userId: string, period: Period): BudgetView | null {
  const row = budgetOf(userId);
  if (!row) return null;
  const spentMinor = sumSpend(
    windowRows(userId, period.startsAt, period.endsAt).filter(
      (candidate) => normalizeCurrency(candidate.currency) === row.currency,
    ),
  );
  return budgetView(row, spentMinor, period.daysLeft);
}

function periodFor(userId: string, asked: string | undefined): Period {
  return chooseMonth(asked, moneyMonths(userId));
}

insights.get('/budget', (context) => {
  const account = accountOf(context);
  const period = periodFor(account.id, monthQuery(context.req.query('period'), context.req.query('month')));
  return context.json({ budget: budgetViewFor(account.id, period) });
});

const BudgetInput = z.object({
  amount: z.string(),
  currency: z.string().optional(),

  period: z.string().optional(),
});

insights.put('/budget', async (context) => {
  const account = accountOf(context);
  const parsed = BudgetInput.safeParse(await context.req.json().catch(() => ({})));
  if (!parsed.success) throw new HTTPException(400, { message: 'Give the budget an amount.' });
  const input = parsed.data;
  if (input.currency && !normalizeCurrency(input.currency)) {
    throw new HTTPException(400, { message: 'Choose a supported currency.' });
  }
  if (input.period !== undefined && input.period.trim().toLowerCase() !== BUDGET_PERIOD) {
    throw new HTTPException(400, { message: 'A budget covers one calendar month.' });
  }

  const existing = budgetOf(account.id);
  const period = periodFor(account.id, monthQuery(context.req.query('period'), context.req.query('month')));
  const currency =
    normalizeCurrency(input.currency ?? null) ??
    dominantCurrency(windowRows(account.id, period.startsAt, period.endsAt), existing);
  if (!currency) throw new HTTPException(400, { message: 'Choose a currency for this budget.' });

  const amountMinor = toMinorUnits(input.amount, currency);
  if (amountMinor === null) throw new HTTPException(400, { message: 'That amount could not be read.' });
  if (amountMinor <= 0) throw new HTTPException(400, { message: 'A budget has to be more than zero.' });

  const now = Date.now();
  db.prepare(
    `INSERT INTO budgets (id, user_id, period, amount_minor, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, period) DO UPDATE SET
       amount_minor = excluded.amount_minor,
       currency = excluded.currency,
       updated_at = excluded.updated_at`,
  ).run(existing?.id ?? newId('bud'), account.id, BUDGET_PERIOD, amountMinor, currency, now, now);

  return context.json({ budget: budgetViewFor(account.id, period) });
});

insights.delete('/budget', (context) => {
  const account = accountOf(context);
  const result = db
    .prepare('DELETE FROM budgets WHERE user_id = ? AND period = ?')
    .run(account.id, BUDGET_PERIOD);
  if (result.changes === 0) throw new HTTPException(404, { message: 'No budget is set.' });
  return context.json({ budget: null });
});

const Advice = z.object({
  headline: z.string().max(200),
  verdict: z.enum(['on_track', 'tight', 'over']),
  reasons: z.array(z.string().max(400)).transform((items) => items.slice(0, 5)),
  moves: z.array(z.object({ action: z.string().max(400), impact: z.string().max(400) })).transform((items) => items.slice(0, 5)),
  watch: z.array(z.string().max(400)).transform((items) => items.slice(0, 4)),
});

function digestFor(summary: Summary): string {
  const periodLine = `Period: ${summary.period.label} (day ${summary.period.dayOfPeriod} of ${summary.period.daysInPeriod}, ${summary.period.daysLeft} days left)`;

  const emptyLine = summary.hasData
    ? null
    : 'Nothing with an amount on it was saved in this period. The figures below are zero because the period is empty, not because spending was low: say so plainly and do not read the zeros as a habit or praise them.';
  const currency = summary.currency;
  if (currency === null) {
    return [
      periodLine,
      `Records in the period: ${summary.recordCount}`,
      emptyLine ??
        'No amount with a recognisable currency was recorded in this period, so there are no spending figures.',
    ].join('\n');
  }

  const lines: string[] = [
    periodLine,
    ...(emptyLine === null ? [] : [emptyLine]),
    `Currency: ${currency}`,
    `Spent so far: ${formatMinorUnits(summary.spentMinor, currency)}`,
    `Money in: ${formatMinorUnits(summary.receivedMinor, currency)}`,
    `Records in the period: ${summary.recordCount}`,
    summary.budget
      ? `Budget: ${summary.budget.amountLabel}, ${summary.budget.remainingLabel} remaining, ${summary.budget.usedPercent}% used, ${summary.budget.perDayLeftLabel} a day for the days left${summary.budget.overspent ? ', already overspent' : ''}`
      : 'Budget: none set.',

    summary.pace.projectedLabel === null
      ? `Pace: ${summary.pace.perDaySoFarLabel} a day so far. There is no projected total for this period, because ${
          !summary.period.current
            ? 'it has already ended and the spend above is the final figure'
            : summary.pace.notEnoughYet !== null
              ? `only ${summary.pace.basedOnRecordCount} ${summary.pace.basedOnRecordCount === 1 ? 'record has' : 'records have'} contributed to it, which is too few for one to mean anything`
              : 'too little of it has run for one to mean anything'
        }. Do not state one or work one out.`
      : `Pace: ${summary.pace.perDaySoFarLabel} a day so far, projecting ${summary.pace.projectedLabel} for the full period (from ${summary.pace.basedOnRecordCount} records)`,
    summary.categories.length > 0
      ? `Categories by spend: ${summary.categories
          .slice(0, 5)
          .map((slice) => `${slice.name} ${slice.amountLabel} (${slice.sharePercent}% of spend, ${slice.count} records)`)
          .join('; ')}`
      : 'Categories by spend: none recorded.',
    summary.counterparties.length > 0
      ? `Biggest counterparties: ${summary.counterparties
          .map((slice) => `${slice.name} ${slice.amountLabel} (${slice.count} records)`)
          .join('; ')}`
      : 'Biggest counterparties: none recorded.',
    summary.comparison.previousMonthMinor > 0
      ? `Previous month spend: ${summary.comparison.previousMonthLabel}${
          summary.comparison.changePercent === null
            ? ''
            : ` (${summary.comparison.changePercent > 0 ? '+' : ''}${summary.comparison.changePercent}% against this period)`
        }`
      : 'Previous month spend: nothing recorded.',

    summary.previousToDateMinor === null
      ? 'Previous month at the same point: not comparable.'
      : `Previous month by this same day: ${formatMinorUnits(summary.previousToDateMinor, currency)}`,
    `Records still missing context: ${summary.needsContextCount}`,
  ];
  if (summary.excluded.otherCurrency.count > 0) {
    lines.push(
      `Records left out because they are in another currency: ${summary.excluded.otherCurrency.count} (there is no conversion)`,
    );
  }
  if (summary.excluded.missingCurrency.count > 0) {
    lines.push(`Records left out because no currency was recorded: ${summary.excluded.missingCurrency.count}`);
  }
  if (summary.excluded.unreadable.count > 0) {
    lines.push(
      `Records left out because their extracted details could not be read: ${summary.excluded.unreadable.count}`,
    );
  }
  return lines.join('\n');
}

const ADVICE_RULES = `You read one person's own spending figures and answer as their careful, plain-spoken money advisor.

Rules, without exception:
- Use only the figures supplied below. They are the complete picture you are permitted to reason about.
- Never invent a transaction, a category, a counterparty or an amount. If a figure is not in the digest, it does not exist.
- Write every amount using the formatted labels exactly as they appear in the digest.
- Each reason must cite a real number from the digest.
- Each move must be concrete and doable this period, e.g. "Cap food delivery at the amount shown for the rest of the month".
- If no budget is set, advise on the spending pattern itself and do not invent a budget figure or suggest one as though it existed.
- Answer as a JSON object with these keys: headline (90 characters or fewer), verdict ('on_track' | 'tight' | 'over'), reasons (up to 3 strings), moves (up to 3 objects with action and impact), watch (up to 2 strings).`;

insights.post('/advice', async (context) => {
  const account = accountOf(context);

  const parsed: unknown = await context.req.json().catch(() => null);
  const body = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as {
    month?: unknown;
    period?: unknown;
  };
  const asked = monthQuery(
    typeof body.period === 'string' ? body.period : context.req.query('period'),
    typeof body.month === 'string' ? body.month : context.req.query('month'),
  );

  const summary = summarize(account.id, periodFor(account.id, asked));

  const answer = await askJson(Advice, {
    messages: [
      { role: 'system', content: ADVICE_RULES },
      { role: 'user', content: digestFor(summary) },
    ],
    temperature: 0.2,
  }).catch((cause: unknown) => {

    console.error('[insights] advice could not be written', cause);

    const failure = isAiFailure(cause) ? cause : null;

    if (failure === null || failure.kind === 'unreadable-answer') {
      throw new HTTPException(502, {
        message: 'Advice came back in a form we could not use. The figures above are still correct — try again.',
      });
    }

    throw new HTTPException(failure.retryable ? 502 : 503, {
      message: failure.retryable
        ? 'Advice could not be written just now. The figures above are still correct — try again in a moment.'
        : 'Written advice is unavailable on this server right now. The figures above are still correct.',
    });
  });

  return context.json({ advice: answer.value, generatedAt: Date.now() });
});

insights.get('/digest', (context) => {
  const account = accountOf(context);
  const period = periodOf(undefined);
  const rows = windowRows(account.id, period.startsAt, period.endsAt);
  const currency = dominantCurrency(rows, budgetOf(account.id));
  const inCurrency = (row: MoneyRow): boolean => currency !== null && normalizeCurrency(row.currency) === currency;
  const reported = rows.filter(inCurrency);

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1;
  const todayRows = rows.filter((row) => row.at >= todayStart && row.at <= todayEnd);
  const todaySpentMinor = sumSpend(todayRows.filter(inCurrency));
  const monthSpentMinor = sumSpend(reported);

  const openTasks = db.prepare('SELECT COUNT(*) AS total FROM tasks WHERE user_id = ? AND done_at IS NULL').get(
    account.id,
  ) as { total: number } | undefined;
  const needsContext = db
    .prepare(`SELECT COUNT(*) AS total FROM records WHERE user_id = ? AND status = 'needs_context'`)
    .get(account.id) as { total: number } | undefined;
  const lastCapture = db.prepare('SELECT MAX(created_at) AS at FROM records WHERE user_id = ?').get(account.id) as
    | { at: number | null }
    | undefined;

  const upcoming = db
    .prepare(
      `SELECT id, text, due_at, priority FROM tasks
       WHERE user_id = ? AND done_at IS NULL AND due_at IS NOT NULL
       ORDER BY due_at ASC LIMIT 3`,
    )
    .all(account.id) as Array<{ id: string; text: string; due_at: number | null; priority: string }>;

  return context.json({
    currency,
    today: {
      spentMinor: todaySpentMinor,
      spentLabel: amountLabelOf(todaySpentMinor, currency),
      recordCount: todayRows.length,
    },
    month: { spentMinor: monthSpentMinor, spentLabel: amountLabelOf(monthSpentMinor, currency) },
    openTasks: openTasks?.total ?? 0,
    needsContext: needsContext?.total ?? 0,
    lastCaptureAt: lastCapture?.at ?? null,
    upcomingTasks: upcoming.map((row) => ({
      id: row.id,
      text: row.text,
      dueAt: row.due_at,
      priority: row.priority,
    })),
  });
});
