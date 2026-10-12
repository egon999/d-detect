import { formatMinorUnits } from './money.ts';
import {
  amountOutliers,
  duplicateCharges,
  newLargePayees,
  ordinalDay,
  overdueSeries,
  type RecurringRecord,
} from './recurring.ts';

export type AdviceKind = 'over' | 'pace' | 'committed' | 'concentration' | 'trend' | 'incomplete';

export type AdviceTone = 'ok' | 'warn' | 'danger' | 'neutral';

export type Advice = { kind: AdviceKind; tone: AdviceTone; text: string };

export type CommittedPayment = { counterparty: string; amountMinor: number; at: number };

export type BudgetFacts = {

  currency: string;

  budgetMinor: number | null;
  spentMinor: number;
  dayOfPeriod: number;
  daysInPeriod: number;
  daysLeft: number;

  current: boolean;
  committed: CommittedPayment[];
  topCategory: { name: string; amountMinor: number; sharePercent: number; count: number } | null;

  previousToDateMinor: number | null;
  excludedRecordCount: number;
  needsContextCount: number;

  contributingRecordCount?: number;

  largestEntry?: { label: string; amountMinor: number } | null;

  budgetSetOnDay?: number | null;
};

export const MIN_DAYS_FOR_PACE = 4;

export const MIN_RECORDS_FOR_PACE = 5;

const MAX_ONE_OFF_SHARE = 0.5;

export function projectionBlockedReason(facts: BudgetFacts): string | null {
  if (!facts.current || facts.spentMinor <= 0 || facts.dayOfPeriod < MIN_DAYS_FOR_PACE) return null;

  const contributing = facts.contributingRecordCount;
  if (contributing !== undefined && contributing < MIN_RECORDS_FOR_PACE) {

    return `Only ${contributing} ${plural(contributing, 'entry', 'entries')} so far — not enough to say where the month is heading.`;
  }

  const largest = facts.largestEntry;
  if (largest && largest.amountMinor > facts.spentMinor * MAX_ONE_OFF_SHARE) {
    return (
      `${formatMinorUnits(largest.amountMinor, facts.currency)} of this month is the one payment to ` +
      `${largest.label} — too much of it for a daily pace to mean anything.`
    );
  }

  return null;
}

export function projectionOf(facts: BudgetFacts): number | null {
  if (!facts.current || facts.spentMinor <= 0 || facts.dayOfPeriod < MIN_DAYS_FOR_PACE) return null;
  if (projectionBlockedReason(facts) !== null) return null;
  return Math.round((facts.spentMinor * facts.daysInPeriod) / facts.dayOfPeriod);
}

export const BUDGET_PERIOD = 'monthly';

const MIN_TREND_PERCENT = 15;

const MIN_CONCENTRATION_PERCENT = 35;

const MAX_DERIVED = 3;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function nameList(payments: CommittedPayment[]): string {
  const names = [...new Set(payments.map((payment) => payment.counterparty.trim()).filter(Boolean))];
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function budgetAgeClause(facts: BudgetFacts): string {
  const day = facts.budgetSetOnDay;
  if (day === undefined || day === null || day <= 1) return '';
  return ` The budget was set on the ${ordinalDay(day)}, so earlier days of the month are in that figure too.`;
}

export function budgetAdvice(facts: BudgetFacts): Advice[] {
  const cash = (minor: number) => formatMinorUnits(minor, facts.currency);
  const derived: Advice[] = [];

  const budget = facts.budgetMinor;
  const remaining = budget === null ? null : budget - facts.spentMinor;
  const projected = projectionOf(facts);
  const blocked = projectionBlockedReason(facts);
  const perDaySoFar = facts.dayOfPeriod > 0 ? Math.round(facts.spentMinor / facts.dayOfPeriod) : 0;

  if (remaining !== null && remaining < 0) {
    const tail = facts.current && facts.daysLeft > 0
      ? ` with ${facts.daysLeft} ${plural(facts.daysLeft, 'day', 'days')} of the month left`
      : '';
    derived.push({
      kind: 'over',
      tone: 'danger',
      text: `${cash(-remaining)} over the ${cash(budget!)} budget${tail}.${budgetAgeClause(facts)}`,
    });
  } else if (blocked !== null) {

    derived.push({ kind: 'pace', tone: 'neutral', text: blocked });
  } else if (projected !== null && budget !== null) {
    const gap = projected - budget;
    if (gap > 0) {

      const perDayLeft = facts.daysLeft > 0 && remaining! > 0 ? Math.floor(remaining! / facts.daysLeft) : null;
      const recovery = perDayLeft
        ? ` Holding to ${cash(perDayLeft)} a day for the last ${facts.daysLeft} ${plural(facts.daysLeft, 'day', 'days')} keeps it under.`
        : '';
      derived.push({
        kind: 'pace',
        tone: 'warn',
        text: `At ${cash(perDaySoFar)} a day the month lands near ${cash(projected)} — ${cash(gap)} over.${recovery}${budgetAgeClause(facts)}`,
      });
    } else {
      derived.push({
        kind: 'pace',
        tone: 'ok',
        text: `At ${cash(perDaySoFar)} a day the month lands near ${cash(projected)}, about ${cash(-gap)} under.`,
      });
    }
  } else if (projected !== null) {

    derived.push({
      kind: 'pace',
      tone: 'neutral',
      text: `At ${cash(perDaySoFar)} a day this month is heading for about ${cash(projected)}.`,
    });
  }

  if (facts.current && facts.committed.length > 0) {
    const committedMinor = facts.committed.reduce((total, payment) => total + payment.amountMinor, 0);
    const names = nameList(facts.committed);
    const who = names ? ` (${names})` : '';
    const count = facts.committed.length;
    const lead = `${cash(committedMinor)} of regular ${plural(count, 'payment', 'payments')} still due this month${who}`;

    if (remaining === null) {
      derived.push({ kind: 'committed', tone: 'neutral', text: `${lead}, going by what has gone out before.` });
    } else {
      const free = remaining - committedMinor;
      derived.push({
        kind: 'committed',
        tone: free < 0 ? 'danger' : free < committedMinor ? 'warn' : 'neutral',
        text:
          free < 0
            ? `${lead} — more than the ${cash(remaining)} left in the budget.`
            : `${lead}, leaving ${cash(free)} genuinely free.`,
      });
    }
  }

  const top = facts.topCategory;
  if (top && top.sharePercent >= MIN_CONCENTRATION_PERCENT) {
    const spread =
      top.count === 1 ? 'in a single entry' : `across ${top.count} ${plural(top.count, 'entry', 'entries')}`;

    const rest = facts.spentMinor - top.amountMinor;
    const without = top.count === 1 && rest > 0 ? ` Without it the month is ${cash(rest)}.` : '';
    derived.push({
      kind: 'concentration',
      tone: 'neutral',
      text: `${cash(top.amountMinor)} — ${top.sharePercent}% of the month — went to ${top.name}, ${spread}.${without}`,
    });
  }

  if (facts.previousToDateMinor !== null && facts.previousToDateMinor > 0) {
    const change = facts.spentMinor - facts.previousToDateMinor;
    const percent = Math.round((Math.abs(change) / facts.previousToDateMinor) * 100);
    if (percent >= MIN_TREND_PERCENT) {
      const point = facts.current ? 'the same point last month' : 'the same point the month before';
      derived.push({
        kind: 'trend',
        tone: 'neutral',
        text: `${cash(Math.abs(change))} ${change > 0 ? 'more' : 'less'} than ${point} (${cash(facts.previousToDateMinor)}).`,
      });
    }
  }

  const advice = derived.slice(0, MAX_DERIVED);

  const gaps: string[] = [];
  if (facts.needsContextCount > 0) {
    gaps.push(
      `${facts.needsContextCount} ${plural(facts.needsContextCount, 'entry needs', 'entries need')} one more detail`,
    );
  }
  if (facts.excludedRecordCount > 0) {

    gaps.push(
      `${facts.excludedRecordCount} ${plural(facts.excludedRecordCount, 'entry', 'entries')} could not be counted`,
    );
  }
  if (gaps.length > 0) {
    advice.push({
      kind: 'incomplete',
      tone: 'neutral',
      text: `Not everything is in these figures: ${gaps.join(', and ')}.`,
    });
  }

  return advice;
}

export type AlertKind = 'unusual-amount' | 'bill-not-arrived' | 'possible-duplicate' | 'new-payee';

export type SpendingAlert = {
  kind: AlertKind;

  text: string;
  recordIds: string[];

  at: number;
};

const MAX_ALERTS = 4;

export function spendingAlerts(records: RecurringRecord[], now: number = Date.now()): SpendingAlert[] {
  const alerts: SpendingAlert[] = [];

  const fresh = newLargePayees(records, now);
  const spoken = new Set(fresh.flatMap((payee) => payee.recordIds));
  for (const payee of fresh) {
    alerts.push({ kind: 'new-payee', text: payee.text, recordIds: payee.recordIds, at: payee.at });
  }

  for (const outlier of amountOutliers(records, now)) {
    if (spoken.has(outlier.recordId)) continue;
    alerts.push({
      kind: 'unusual-amount',
      text: outlier.text,

      recordIds: [outlier.recordId, ...outlier.comparedWith],
      at: outlier.at,
    });
  }

  for (const series of overdueSeries(records, now)) {

    alerts.push({
      kind: 'bill-not-arrived',
      text:
        `Nothing recorded for ${series.counterparty} yet — it was due about ` +
        `${series.overdueDays} ${plural(series.overdueDays, 'day', 'days')} ago, ${series.basis}`,
      recordIds: series.recordIds,
      at: series.nextAt,
    });
  }

  for (const duplicate of duplicateCharges(records, now)) {
    alerts.push({
      kind: 'possible-duplicate',
      text: duplicate.text,
      recordIds: duplicate.recordIds,
      at: duplicate.at,
    });
  }

  return alerts.sort((left, right) => right.at - left.at).slice(0, MAX_ALERTS);
}
