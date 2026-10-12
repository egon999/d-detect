import { apiDelete, apiGet, apiPost, apiPut, serverDate } from './client';

export type Money = { amountMinor: number; amountLabel: string | null };

export type InsightsPeriod = {

  key: string;

  label: string;
  startedAt: number;
  endedAt: number;

  isCurrent: boolean;

  hasData: boolean;
  dayOfPeriod: number;
  daysInPeriod: number;
  daysLeft: number;
};

export type AvailablePeriod = { key: string; label: string; hasData: boolean };

export type BudgetView = {
  amountMinor: number;
  amountLabel: string;
  remainingMinor: number;
  remainingLabel: string;
  usedPercent: number;
  perDayLeftMinor: number;
  perDayLeftLabel: string;
  overspent: boolean;

  period: 'monthly';
};

export type DrillDown = { recordIds: string[]; count: number; moreCount: number };

export type CategorySlice = DrillDown & {
  name: string;
  amountMinor: number;
  amountLabel: string;
  sharePercent: number;
};

export type CounterpartySlice = DrillDown & {
  name: string;
  amountMinor: number;
  amountLabel: string;
};
export type MonthSpend = { month: string; label: string; amountMinor: number; amountLabel: string };
export type DaySpend = DrillDown & { date: string; amountMinor: number };

export type InsightsPace = {
  perDaySoFarMinor: number;
  perDaySoFarLabel: string | null;

  projectedMinor: number | null;
  projectedLabel: string | null;

  basedOnRecordCount: number;

  notEnoughYet: string | null;
};

export type RecurringSummary = {
  counterparty: string;
  cadence: 'weekly' | 'monthly';
  amountMinor: number;
  amountLabel: string;
  currency: string;
  at: number;
  occurrences: number;

  estimated: boolean;
};

export type ExcludedRecords = { missingCurrency: DrillDown; otherCurrency: DrillDown; unreadable: DrillDown };

export type BudgetGuidanceKind = 'over' | 'pace' | 'committed' | 'concentration' | 'trend' | 'incomplete';

export const GUIDANCE_GAP_KIND: BudgetGuidanceKind = 'incomplete';

export type BudgetGuidance = {
  kind: BudgetGuidanceKind;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  text: string;
};

export type AlertKind = 'unusual-amount' | 'bill-not-arrived' | 'possible-duplicate' | 'new-payee';

export type SpendingAlert = {
  kind: AlertKind;

  text: string;
  recordIds: string[];

  at: number;
};

export type Insights = {
  period: InsightsPeriod;

  availablePeriods: AvailablePeriod[];
  currency: string | null;
  spent: Money;
  received: Money;
  budget: BudgetView | null;
  pace: InsightsPace;
  categories: CategorySlice[];
  counterparties: CounterpartySlice[];
  days: DaySpend[];
  comparison: { previousMonthMinor: number; previousMonthLabel: string | null; changePercent: number | null };
  recordCount: number;
  needsContextCount: number;
  excludedRecordCount: number;
  excluded: ExcludedRecords;
  previousMonths: MonthSpend[];
  recurring: RecurringSummary[];
  guidance: BudgetGuidance[];

  alerts: SpendingAlert[];
};

export type AdviceVerdict = 'on_track' | 'tight' | 'over';
export type AdviceMove = { action: string; impact: string };
export type Advice = {
  headline: string;
  verdict: AdviceVerdict;
  reasons: string[];
  moves: AdviceMove[];
  watch: string[];
};

export type AdviceResponse = { advice: Advice; generatedAt: number };

export type Digest = {
  currency: string | null;
  today: { spentMinor: number; spentLabel: string | null; recordCount: number };
  month: { spentMinor: number; spentLabel: string | null };
  openTasks: number;
  needsContext: number;
  lastCaptureAt: number | null;
  upcomingTasks: { id: string; text: string; dueAt: number | null; priority: string | null }[];
};

export function getInsights(period?: string): Promise<Insights> {
  return apiGet<Insights>('/api/insights', { period });
}

export async function getBudget(): Promise<BudgetView | null> {
  const data = await apiGet<{ budget: BudgetView | null }>('/api/insights/budget');
  return data.budget;
}

export async function setBudget(amount: string, currency: string | null): Promise<BudgetView | null> {
  const data = await apiPut<{ budget: BudgetView | null }>('/api/insights/budget', {
    amount,
    ...(currency ? { currency } : {}),
    period: 'monthly',
  });
  return data.budget;
}

export function clearBudget(): Promise<{ budget: null }> {
  return apiDelete<{ budget: null }>('/api/insights/budget');
}

export function getAdvice(period?: string): Promise<AdviceResponse> {
  return apiPost<AdviceResponse>('/api/insights/advice', { period });
}

export function getDigest(): Promise<Digest> {
  return apiGet<Digest>('/api/insights/digest');
}

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function currentMonthKey(): string {
  return monthKeyOf(serverDate());
}

export function monthLabelOf(key: string): string {
  const parts = MONTH_KEY.exec(key);
  if (!parts) return key;
  const midday = new Date(Number(parts[1]), Number(parts[2]) - 1, 1, 12);
  return midday.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export type PeriodChoice = { key: string; label: string; hasData: boolean; isCurrent: boolean };

export function periodChoices(
  shown: { key: string; label: string },
  available: AvailablePeriod[],
  currentKey: string,
): PeriodChoice[] {
  const byKey = new Map<string, PeriodChoice>();

  for (const entry of available) {
    if (!MONTH_KEY.test(entry.key)) continue;
    byKey.set(entry.key, {
      key: entry.key,
      label: entry.label,
      hasData: entry.hasData,
      isCurrent: entry.key === currentKey,
    });
  }

  for (const key of [shown.key, currentKey]) {
    if (!MONTH_KEY.test(key) || byKey.has(key)) continue;
    byKey.set(key, {
      key,
      label: key === shown.key ? shown.label : monthLabelOf(key),
      hasData: false,
      isCurrent: key === currentKey,
    });
  }

  return [...byKey.values()].sort((left, right) => (left.key < right.key ? 1 : -1));
}

export function fallbackPeriodKey(
  period: { key: string; isCurrent: boolean; hasData: boolean },
  available: AvailablePeriod[],
): string | null {
  if (period.hasData || !period.isCurrent) return null;
  let best: string | null = null;
  for (const entry of available) {

    if (!entry.hasData || entry.key >= period.key) continue;
    if (best === null || entry.key > best) best = entry.key;
  }
  return best;
}

export const UNCATEGORISED_NAME = 'Uncategorised';

export const UNCATEGORISED_LABEL = 'Not labelled';

export type CategoryLike = { name: string; amountMinor: number };

export type CategoryRow<T extends CategoryLike = CategorySlice> = T & {

  displayName: string;

  unlabelled: boolean;
};

export function orderedCategories<T extends CategoryLike>(categories: T[]): CategoryRow<T>[] {
  return categories
    .map((slice) => ({
      ...slice,
      displayName: slice.name === UNCATEGORISED_NAME ? UNCATEGORISED_LABEL : slice.name,
      unlabelled: slice.name === UNCATEGORISED_NAME,
    }))
    .sort((left, right) => {
      if (left.unlabelled !== right.unlabelled) return left.unlabelled ? 1 : -1;
      if (right.amountMinor !== left.amountMinor) return right.amountMinor - left.amountMinor;
      return left.displayName.localeCompare(right.displayName);
    });
}

export function spendingGuidance(guidance: BudgetGuidance[]): BudgetGuidance[] {
  if (!Array.isArray(guidance)) return [];
  return guidance.filter((line) => line.kind !== GUIDANCE_GAP_KIND);
}

export type ExclusionReason = keyof ExcludedRecords;

function entries(count: number): string {
  return count === 1 ? '1 entry' : `${count} entries`;
}

export function hiddenEntryCount(count: number, shown: number | null): number {
  if (shown === null) return 0;
  if (!Number.isFinite(count) || !Number.isFinite(shown)) return 0;
  return Math.max(0, Math.trunc(count) - Math.trunc(shown));
}

export function excludedReasonSheet(
  reason: ExclusionReason,
  count: number,
): { title: string; reason: string } {
  const copy = EXCLUDED_REASON_COPY[reason];
  const sentence = count === 1 ? copy.one : copy.many;
  return { title: copy.title, reason: `${entries(count)}. ${sentence}` };
}

const EXCLUDED_REASON_COPY: Record<ExclusionReason, { title: string; one: string; many: string }> = {
  missingCurrency: {
    title: 'No currency saved',
    one: 'The amount was read but the currency was not. Open it and set the currency, and it joins the month’s total.',
    many: 'The amounts were read but the currency was not. Open one and set the currency, and it joins the month’s total.',
  },
  otherCurrency: {
    title: 'In another currency',
    one: 'Read correctly, in a currency this month’s total cannot state. Nothing is wrong with it and nothing needs fixing.',
    many: 'Read correctly, in a currency this month’s total cannot state. Nothing is wrong with them and nothing needs fixing.',
  },
  unreadable: {
    title: 'Could not be read',
    one: 'Nothing could be read from it. The file is still here, so it can be read again.',
    many: 'Nothing could be read from them. The files are still here, so they can be read again.',
  },
};

export function drillDownLoadProblem(attempted: number, failed: number): string | null {
  if (failed <= 0 || attempted <= 0) return null;
  if (failed >= attempted) {
    return 'These entries could not be opened just now. Check your connection and try again.';
  }
  return `${failed} of these ${entries(attempted)} could not be opened just now, so this list is not all of them.`;
}

const MAX_INTEGER_DIGITS = 12;

export type BudgetAmountProblem =

  | 'empty'

  | 'unreadable'

  | 'tooPrecise'

  | 'notPositive'
  | 'tooLarge';

export type BudgetAmount =
  | { status: 'ok'; text: string; decimal: string; minorUnits: number }
  | { status: BudgetAmountProblem; text: string };

export function currencyDecimals(currency: string | null): number {
  if (!currency) return 2;
  try {
    return (
      new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function groupDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const groups = [digits.slice(-3)];
  let head = digits.slice(0, -3);
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head) groups.unshift(head);
  return groups.join(',');
}

export function readBudgetAmount(raw: string, decimals: number): BudgetAmount {
  const trimmed = raw.trim();
  if (!trimmed) return { status: 'empty', text: '' };

  const cleaned = trimmed.replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(cleaned)) return { status: 'unreadable', text: trimmed };

  const [wholeRaw = '', fraction = ''] = cleaned.split('.');
  const typedPoint = cleaned.includes('.');
  if (!wholeRaw && !fraction) return { status: 'unreadable', text: trimmed };
  if (fraction.length > decimals) return { status: 'tooPrecise', text: trimmed };

  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
  if (whole.length > MAX_INTEGER_DIGITS) return { status: 'tooLarge', text: trimmed };

  const text = `${groupDigits(whole)}${typedPoint ? `.${fraction}` : ''}`;
  const minorUnits = Number(`${whole}${fraction.padEnd(decimals, '0')}`);
  if (minorUnits <= 0) return { status: 'notPositive', text };

  return {
    status: 'ok',
    text,
    decimal: decimals > 0 ? `${whole}.${fraction.padEnd(decimals, '0')}` : whole,
    minorUnits,
  };
}

export function budgetAmountText(minorUnits: number, decimals: number): string {
  const digits = String(Math.max(0, Math.round(minorUnits))).padStart(decimals + 1, '0');
  const whole = decimals > 0 ? digits.slice(0, -decimals) : digits;
  const fraction = decimals > 0 ? digits.slice(-decimals) : '';
  const grouped = groupDigits(whole);
  return fraction && Number(fraction) !== 0 ? `${grouped}.${fraction}` : grouped;
}

export type AlertLook = {
  icon: string;
  tone: 'warn' | 'danger' | 'neutral';

  verb: string;
};

const ALERT_LOOKS: Record<AlertKind, AlertLook> = {
  'possible-duplicate': { icon: 'content-duplicate', tone: 'danger', verb: 'Check both' },
  'unusual-amount': { icon: 'trending-up', tone: 'warn', verb: 'Open it' },
  'bill-not-arrived': { icon: 'calendar-clock', tone: 'warn', verb: 'See the last one' },
  'new-payee': { icon: 'account-plus-outline', tone: 'neutral', verb: 'Open it' },
};

export function alertLook(kind: AlertKind | string): AlertLook {
  return (
    ALERT_LOOKS[kind as AlertKind] ?? {

      icon: 'information-outline',
      tone: 'neutral',
      verb: 'Open it',
    }
  );
}

export function showableAlerts(alerts: SpendingAlert[] | undefined | null): SpendingAlert[] | null {
  if (!Array.isArray(alerts)) return null;
  const real = alerts.filter(
    (alert) =>
      typeof alert?.text === 'string' &&
      alert.text.trim().length > 0 &&
      Array.isArray(alert.recordIds) &&
      alert.recordIds.length > 0,
  );
  return real.length > 0 ? real : null;
}

export function alertsHeading(count: number): string {
  return count === 1 ? 'One thing worth a look' : `${count} things worth a look`;
}
