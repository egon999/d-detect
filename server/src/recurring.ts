import { formatMinorUnits } from './money.ts';

const DAY_MS = 86_400_000;

const HORIZON_DAYS = 45;

const OVERDUE_GRACE_DAYS = 3;

const TRANSACTIONAL = new Set(['payment', 'purchase', 'bill', 'receipt']);

export const MIN_SERIES_OCCURRENCES = 3;

export const MIN_OUTLIER_HISTORY = 5;

export type RecurringRecord = {
  id: string;
  kind: string;
  occurredAt: number | null;
  amountMinor: number | null;
  currency: string | null;
  direction: string | null;
  counterparty: string | null;
  status: string;
};

export type Cadence = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'half-yearly' | 'annual';

type CadenceShape = {
  cadence: Cadence;

  minDays: number;
  maxDays: number;

  label: string;
};

const CADENCES: readonly CadenceShape[] = [
  { cadence: 'weekly', minDays: 5, maxDays: 9, label: 'every week' },
  { cadence: 'fortnightly', minDays: 12, maxDays: 16, label: 'every two weeks' },

  { cadence: 'monthly', minDays: 21, maxDays: 35, label: 'every month' },
  { cadence: 'quarterly', minDays: 75, maxDays: 105, label: 'every three months' },
  { cadence: 'half-yearly', minDays: 160, maxDays: 205, label: 'every six months' },

  { cadence: 'annual', minDays: 340, maxDays: 395, label: 'once a year' },
];

function gapsNeeded(gaps: number): number {
  if (gaps <= 0) return 0;
  if (gaps <= 3) return gaps;
  return Math.max(Math.ceil((gaps * 3) / 4), gaps - 2);
}

function shapeOf(gapDays: number[]): CadenceShape | null {
  if (gapDays.length === 0) return null;
  const middle = median(gapDays);
  const shape = CADENCES.find((candidate) => middle >= candidate.minDays && middle <= candidate.maxDays);
  if (!shape) return null;

  const span = (shape.maxDays - shape.minDays) / 2;
  const tolerance = Math.min(Math.max(Math.round(middle / 7), 1), span);
  if (gapDays.filter((gap) => Math.abs(gap - middle) <= tolerance).length < gapsNeeded(gapDays.length)) return null;
  return shape;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function dayOfMonth(at: number): number {

  return new Date(at).getDate();
}

function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function daysBetween(from: number, to: number): number {
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function advanceMonths(lastAt: number, months: number, day: number): number {
  const from = new Date(lastAt);
  const target = new Date(from.getFullYear(), from.getMonth() + months, 1);
  const clamped = Math.min(day, daysInMonth(target.getFullYear(), target.getMonth()));
  return new Date(target.getFullYear(), target.getMonth(), clamped, from.getHours(), from.getMinutes()).getTime();
}

function monthsPerCycle(cadence: Cadence): number | null {
  switch (cadence) {
    case 'monthly': return 1;
    case 'quarterly': return 3;
    case 'half-yearly': return 6;
    case 'annual': return 12;
    default: return null;
  }
}

function ordinal(value: number): string {
  const hundred = value % 100;
  if (hundred >= 11 && hundred <= 13) return `${value}th`;
  const suffix = value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th';
  return `${value}${suffix}`;
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

export function inWords(count: number): string {
  return WORDS[count] ?? String(count);
}

export { ordinal as ordinalDay };

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isOutgoing(record: RecurringRecord): boolean {
  if (record.direction === 'in') return false;
  if (record.direction === 'out') return record.amountMinor !== null && record.amountMinor > 0;
  return record.amountMinor !== null && record.amountMinor > 0 && TRANSACTIONAL.has(record.kind);
}

const IDENTITY_NOISE = new Set([
  'pvt', 'ltd', 'limited', 'llp', 'inc', 'co', 'corp', 'corporation', 'company',
  'india', 'indian', 'bharat', 'bharti',
  'upi', 'neft', 'imps', 'rtgs', 'nach', 'ach', 'pos', 'atm', 'ref', 'txn', 'trf',
  'prepaid', 'postpaid', 'recharge', 'payment', 'payments', 'paid', 'bill', 'bills',
  'the', 'and', 'for', 'of',
]);

function identityTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 1 && !/^\d+$/.test(token) && !IDENTITY_NOISE.has(token));
}

function payeeKey(name: string): string {
  return normaliseCounterparty(name);
}

function normaliseCounterparty(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

const MAX_SHARED_TOKEN_NAMES = 12;

function payeeGroups(names: string[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (name: string): string => {
    let root = name;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
  };

  const tokens = new Map<string, Set<string>>();
  const byToken = new Map<string, string[]>();
  for (const name of names) {
    const set = new Set(identityTokens(name));
    tokens.set(name, set);
    for (const token of set) {
      const bucket = byToken.get(token);
      if (bucket) bucket.push(name);
      else byToken.set(token, [name]);
    }
  }

  for (const name of names) {
    if (!tokens.get(name)!.size) continue;
    const candidates = new Set<string>();
    for (const token of tokens.get(name)!) {
      for (const other of byToken.get(token) ?? []) {
        if (byToken.get(token)!.length <= MAX_SHARED_TOKEN_NAMES || other === name) candidates.add(other);
      }
    }
    for (const other of candidates) {
      if (other === name) continue;
      const mine = tokens.get(name)!;
      const theirs = tokens.get(other)!;
      if (!theirs.size) continue;
      if (mine.size <= theirs.size && [...mine].every((token) => theirs.has(token))) {
        union(name, other);
      } else if (theirs.size <= mine.size && [...theirs].every((token) => mine.has(token))) {
        union(name, other);
      }
    }
  }

  const result = new Map<string, string>();
  for (const name of names) result.set(name, find(name));
  return result;
}

function dominantCurrency(records: RecurringRecord[]): string {
  const tally = new Map<string, { count: number; total: number }>();
  for (const record of records) {
    if (!record.currency || record.amountMinor === null) continue;
    const seen = tally.get(record.currency) ?? { count: 0, total: 0 };
    tally.set(record.currency, { count: seen.count + 1, total: seen.total + Math.abs(record.amountMinor) });
  }
  let best: { currency: string; count: number; total: number } | null = null;
  for (const [currency, seen] of tally) {
    if (!best || seen.count > best.count || (seen.count === best.count && seen.total > best.total)) {
      best = { currency, count: seen.count, total: seen.total };
    }
  }
  return best?.currency ?? records[0]!.currency!;
}

export type RecurringSeries = {
  counterparty: string;

  aliases: string[];
  currency: string;
  cadence: Cadence;

  occurrences: RecurringRecord[];

  gapsMs: number[];
  medianGapMs: number;
  lastAt: number;

  medianAmountMinor: number;
  lowAmountMinor: number;
  highAmountMinor: number;

  steadyAmount: boolean;

  anchorDayOfMonth: number | null;

  nextAt: number;

  basis: string;

  recordIds: string[];

  overdueDays: number;

  lapsed: boolean;
};

export type AmountOutlier = {
  counterparty: string;
  currency: string;
  amountMinor: number;

  usualMinor: number;
  lowMinor: number;
  highMinor: number;

  recordId: string;
  at: number;

  comparedWith: string[];

  text: string;
};

function eligible(record: RecurringRecord, currency?: string): boolean {
  if (!isOutgoing(record)) return false;
  if (record.occurredAt === null || record.amountMinor === null || record.amountMinor <= 0) return false;
  if (!record.currency || !record.counterparty?.trim()) return false;
  if (currency !== undefined && record.currency !== currency) return false;
  return true;
}

function alreadyHappened(record: RecurringRecord, now: number): boolean {
  return record.occurredAt !== null && record.occurredAt <= now + DAY_MS;
}

function gapsBetween(occurrences: RecurringRecord[]): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < occurrences.length; index += 1) {
    gaps.push((occurrences[index]!.occurredAt! - occurrences[index - 1]!.occurredAt!) / DAY_MS);
  }
  return gaps;
}

function byAmount(records: RecurringRecord[]): RecurringRecord[][] {
  const sorted = [...records].sort((left, right) => left.amountMinor! - right.amountMinor!);
  const bands: RecurringRecord[][] = [];
  for (const record of sorted) {
    const band = bands.at(-1);
    const previous = band?.at(-1);
    if (!band || !previous || record.amountMinor! > previous.amountMinor! * 1.6) bands.push([record]);
    else band.push(record);
  }
  return bands;
}

function byDayOfMonth(records: RecurringRecord[]): RecurringRecord[][] {
  const sorted = [...records].sort((left, right) => dayOfMonth(left.occurredAt!) - dayOfMonth(right.occurredAt!));
  const clusters: RecurringRecord[][] = [];
  for (const record of sorted) {
    const cluster = clusters.at(-1);
    const previous = cluster?.at(-1);
    if (!cluster || !previous || dayOfMonth(record.occurredAt!) - dayOfMonth(previous.occurredAt!) > 2) {
      clusters.push([record]);
    } else {
      cluster.push(record);
    }
  }

  const first = clusters[0];
  const last = clusters.at(-1);
  if (
    clusters.length > 1 &&
    first && last && first !== last &&
    wrappedDistance(dayOfMonth(first[0]!.occurredAt!), dayOfMonth(last.at(-1)!.occurredAt!)) <= 2
  ) {
    last.push(...clusters.shift()!);
  }
  return clusters;
}

function wrappedDistance(left: number, right: number): number {
  const raw = Math.abs(left - right);
  return Math.min(raw, 31 - raw);
}

function cycleRank(cadence: Cadence): number {
  return CADENCES.findIndex((shape) => shape.cadence === cadence);
}

function oneSeries(records: RecurringRecord[]): boolean {
  return amountsSteady(records.map((record) => record.amountMinor!)) || anchorDay(records) !== null;
}

function mergedSeries(whole: RecurringRecord[]): { records: RecurringRecord[]; rank: number } | null {
  if (whole.length < MIN_SERIES_OCCURRENCES) return null;
  const shape = shapeOf(gapsBetween(whole));
  if (!shape) return null;

  const shortCycle = shape.cadence === 'weekly' || shape.cadence === 'fortnightly';
  if (!shortCycle && !oneSeries(whole)) return null;
  return { records: whole, rank: cycleRank(shape.cadence) };
}

function splitCandidates(whole: RecurringRecord[]): { pieces: RecurringRecord[][]; rank: number }[] {
  const splits: { pieces: RecurringRecord[][]; rank: number }[] = [];
  for (const groups of [byAmount(whole), byDayOfMonth(whole)]) {
    if (groups.length < 2) continue;
    const pieces: RecurringRecord[][] = [];
    let covered = 0;
    let rank = Infinity;
    for (const group of groups) {
      if (group.length < MIN_SERIES_OCCURRENCES) continue;
      const sorted = [...group].sort((left, right) => left.occurredAt! - right.occurredAt!);
      const shape = shapeOf(gapsBetween(sorted));
      if (!shape) continue;
      pieces.push(sorted);
      covered += sorted.length;
      rank = Math.min(rank, cycleRank(shape.cadence));
    }
    if (pieces.length < 2 || covered !== whole.length) continue;
    splits.push({ pieces, rank });
  }
  return splits;
}

function seriesPartitions(records: RecurringRecord[]): RecurringRecord[][] {
  const whole = [...records].sort((left, right) => left.occurredAt! - right.occurredAt!);
  const merged = mergedSeries(whole);
  const better = splitCandidates(whole)
    .filter((split) => split.rank > (merged?.rank ?? -1))
    .sort((left, right) => right.rank - left.rank || right.pieces.length - left.pieces.length)[0];

  if (better) return better.pieces;
  return merged ? [merged.records] : [];
}

const ANCHOR_DRIFT_DAYS = 6;

function anchorDay(occurrences: RecurringRecord[]): number | null {
  const days = occurrences.map((record) => dayOfMonth(record.occurredAt!));
  const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);
  if (spread(days) <= ANCHOR_DRIFT_DAYS) return Math.round(median(days));

  const rotated = days.map((day) => (day > 15 ? day - 31 : day));
  if (spread(rotated) > ANCHOR_DRIFT_DAYS) return null;
  const middle = Math.round(median(rotated));
  return middle <= 0 ? middle + 31 : middle;
}

function nextOccurrence(cadence: Cadence, lastAt: number, anchor: number | null): number {
  const months = monthsPerCycle(cadence);
  if (months === null) {
    const step = cadence === 'weekly' ? 7 : 14;
    return lastAt + step * DAY_MS;
  }

  const day = anchor ?? dayOfMonth(lastAt);
  let next = advanceMonths(lastAt, months, day);

  while (next <= lastAt) next = advanceMonths(next, months, day);
  return next;
}

function amountsSteady(amounts: number[]): boolean {
  const middle = median(amounts);
  if (middle <= 0) return true;
  return (Math.max(...amounts) - Math.min(...amounts)) / middle <= 0.2;
}

function monthsSpanned(occurrences: RecurringRecord[]): number {
  const first = new Date(occurrences[0]!.occurredAt!);
  const last = new Date(occurrences.at(-1)!.occurredAt!);
  return (last.getFullYear() - first.getFullYear()) * 12 + (last.getMonth() - first.getMonth()) + 1;
}

function basisOf(series: { cadence: Cadence; occurrences: RecurringRecord[]; anchorDayOfMonth: number | null }): string {
  const count = series.occurrences.length;
  const months = monthsSpanned(series.occurrences);
  const window = months === count && count <= 12 ? `the last ${inWords(count)} months` : `the last ${inWords(count)} payments`;

  if (series.cadence === 'weekly' || series.cadence === 'fortnightly') {
    return `based on ${window}, which came about ${series.cadence === 'weekly' ? 'seven' : 'fourteen'} days apart.`;
  }
  if (series.anchorDayOfMonth === null) {
    return `based on ${window}, which came about a month apart each time.`;
  }
  const days = series.occurrences.map((record) => dayOfMonth(record.occurredAt!));
  const low = Math.min(...days);
  const high = Math.max(...days);
  const anchor = ordinal(series.anchorDayOfMonth);
  if (low === high) return `based on ${window}, always on the ${anchor}.`;
  return `based on ${window}, between the ${ordinal(low)} and the ${ordinal(high)} — usually the ${anchor}.`;
}

function withClock(series: RecurringSeries, now: number): RecurringSeries {
  const overdueDays = Math.max(0, daysBetween(series.nextAt, now));
  return { ...series, overdueDays, lapsed: overdueDays > series.medianGapMs / DAY_MS };
}

export function recurringSeries(records: RecurringRecord[], now?: number): RecurringSeries[] {

  const names = [...new Set(records.filter((record) => eligible(record)).map((record) => payeeKey(record.counterparty!)))];
  const groups = payeeGroups(names);

  const grouped = new Map<string, RecurringRecord[]>();
  for (const record of records) {
    if (!eligible(record)) continue;
    const root = groups.get(payeeKey(record.counterparty!)) ?? payeeKey(record.counterparty!);
    const bucket = grouped.get(root);
    if (bucket) bucket.push(record);
    else grouped.set(root, [record]);
  }

  const series: RecurringSeries[] = [];
  for (const bucket of grouped.values()) {
    const currency = dominantCurrency(bucket);
    const inCurrency = bucket.filter((record) => record.currency === currency);
    for (const occurrences of seriesPartitions(inCurrency)) {
      if (occurrences.length < MIN_SERIES_OCCURRENCES) continue;

      const gapDays = gapsBetween(occurrences);
      const shape = shapeOf(gapDays);
      if (!shape) continue;

      const amounts = occurrences.map((record) => record.amountMinor!);
      const last = occurrences.at(-1)!;
      const medianGapMs = median(gapDays) * DAY_MS;
      const anchorDayOfMonth = anchorDay(occurrences);
      const nextAt = nextOccurrence(shape.cadence, last.occurredAt!, anchorDayOfMonth);
      const draft: RecurringSeries = {
        counterparty: last.counterparty!.trim(),
        aliases: [...new Set(occurrences.map((record) => record.counterparty!.trim()))].sort(),
        currency,
        cadence: shape.cadence,
        occurrences,
        gapsMs: gapDays.map((gap) => gap * DAY_MS),
        medianGapMs,
        lastAt: last.occurredAt!,
        medianAmountMinor: Math.round(median(amounts)),
        lowAmountMinor: Math.min(...amounts),
        highAmountMinor: Math.max(...amounts),
        steadyAmount: amountsSteady(amounts),
        anchorDayOfMonth,
        nextAt,
        basis: '',
        recordIds: occurrences.map((record) => record.id),
        overdueDays: 0,
        lapsed: false,
      };
      draft.basis = basisOf({
        cadence: draft.cadence,
        occurrences: draft.occurrences,
        anchorDayOfMonth: draft.anchorDayOfMonth,
      });
      series.push(now === undefined ? draft : withClock(draft, now));
    }
  }

  return series.sort(
    (left, right) =>
      left.nextAt - right.nextAt ||
      left.counterparty.localeCompare(right.counterparty) ||
      left.medianAmountMinor - right.medianAmountMinor,
  );
}

export type CadenceSeries = {
  counterparty: string;
  currency: string;
  cadence: 'weekly' | 'monthly';
  occurrences: RecurringRecord[];
  gapsMs: number[];
  medianGapMs: number;
  lastAt: number;
};

export function cadenceSeries(records: RecurringRecord[]): CadenceSeries[] {
  return recurringSeries(records)
    .filter((series): series is RecurringSeries & { cadence: 'weekly' | 'monthly' } =>
      series.cadence === 'weekly' || series.cadence === 'monthly',
    )
    .map((series) => ({
      counterparty: series.counterparty,
      currency: series.currency,
      cadence: series.cadence,
      occurrences: series.occurrences,
      gapsMs: series.gapsMs,
      medianGapMs: series.medianGapMs,
      lastAt: series.lastAt,
    }));
}

export type RecurringPrediction = {
  counterparty: string;

  aliases: string[];
  cadence: Cadence;

  cadenceLabel: string;
  amountMinor: number;
  currency: string;
  at: number;
  lastAt: number;
  occurrences: number;

  basis: string;

  steadyAmount: boolean;
  lowAmountMinor: number;
  highAmountMinor: number;
  recordIds: string[];
};

export function detectRecurring(records: RecurringRecord[], now: number = Date.now()): RecurringPrediction[] {

  const today = startOfDay(now);
  const horizon = today + (HORIZON_DAYS + 1) * DAY_MS;
  const floor = today - OVERDUE_GRACE_DAYS * DAY_MS;
  const predictions: RecurringPrediction[] = [];

  for (const series of recurringSeries(
    records.filter((record) => record.status === 'complete' && alreadyHappened(record, now)),
    now,
  )) {
    if (series.nextAt < floor || series.nextAt > horizon) continue;

    predictions.push({
      counterparty: series.counterparty,
      aliases: series.aliases,
      cadence: series.cadence,
      cadenceLabel: CADENCES.find((shape) => shape.cadence === series.cadence)!.label,
      amountMinor: Math.round(series.medianAmountMinor),
      currency: series.currency,
      at: series.nextAt,
      lastAt: series.lastAt,
      occurrences: series.occurrences.length,
      basis: series.basis,
      steadyAmount: series.steadyAmount,
      lowAmountMinor: series.lowAmountMinor,
      highAmountMinor: series.highAmountMinor,
      recordIds: series.recordIds,
    });
  }

  return predictions.sort((left, right) => left.at - right.at);
}

export function lapsedSeries(records: RecurringRecord[], now: number = Date.now()): RecurringSeries[] {
  return recurringSeries(records.filter((record) => alreadyHappened(record, now)), now)
    .filter(
      (series) =>
        series.lapsed &&

        now - series.lastAt <= Math.max(180 * DAY_MS, series.medianGapMs * 6),
    )
    .sort((left, right) => left.lastAt - right.lastAt);
}

export const OVERDUE_SILENCE_DAYS = 7;

export function overdueSeries(records: RecurringRecord[], now: number = Date.now()): RecurringSeries[] {
  return recurringSeries(
    records.filter((record) => record.status === 'complete' && alreadyHappened(record, now)),
    now,
  )
    .filter((series) => !series.lapsed && series.overdueDays >= OVERDUE_SILENCE_DAYS)
    .sort((left, right) => right.overdueDays - left.overdueDays);
}

const MAX_OUTLIERS = 20;

export function amountOutliers(records: RecurringRecord[], now?: number): AmountOutlier[] {
  const grouped = new Map<string, RecurringRecord[]>();
  for (const record of records) {
    if (!eligible(record)) continue;
    if (now !== undefined && !alreadyHappened(record, now)) continue;
    const key = `${payeeKey(record.counterparty!)}|${record.currency}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(record);
    else grouped.set(key, [record]);
  }

  const outliers: AmountOutlier[] = [];
  for (const bucket of grouped.values()) {
    if (bucket.length < MIN_OUTLIER_HISTORY) continue;
    const bySize = [...bucket].sort((left, right) => left.amountMinor! - right.amountMinor!);
    const amounts = bySize.map((record) => record.amountMinor!);
    const usual = median(amounts);
    if (usual <= 0) continue;
    const spread = median(amounts.map((amount) => Math.abs(amount - usual)));

    const scale = Math.max(spread, usual * 0.05);
    const ids = bucket.map((record) => record.id);

    for (let index = 0; index < bySize.length; index += 1) {
      const record = bySize[index]!;
      const distance = Math.abs(amounts[index]! - usual);
      if (distance < 4 * scale || distance < usual * 0.5) continue;

      const low = index === 0 ? amounts[1]! : amounts[0]!;
      const high = index === amounts.length - 1 ? amounts[amounts.length - 2]! : amounts.at(-1)!;
      outliers.push({
        counterparty: record.counterparty!.trim(),
        currency: record.currency!,
        amountMinor: record.amountMinor!,
        usualMinor: Math.round(usual),
        lowMinor: low,
        highMinor: high,
        recordId: record.id,
        at: record.occurredAt!,
        comparedWith: ids.filter((id) => id !== record.id),
        text:
          `${formatMinorUnits(record.amountMinor!, record.currency!)} to ${record.counterparty!.trim()}, ` +
          `where you usually pay about ${formatMinorUnits(Math.round(usual), record.currency!)} ` +
          `(${formatMinorUnits(low, record.currency!)} to ${formatMinorUnits(high, record.currency!)}).`,
      });
    }
  }

  return outliers.sort((left, right) => right.at - left.at).slice(0, MAX_OUTLIERS);
}

const DUPLICATE_WINDOW_MS = 36 * 60 * 60 * 1000;

export type DuplicateCharge = {
  counterparty: string;
  currency: string;
  amountMinor: number;

  recordIds: string[];

  at: number;

  text: string;
};

export function duplicateCharges(records: RecurringRecord[], now?: number): DuplicateCharge[] {
  const grouped = new Map<string, RecurringRecord[]>();
  for (const record of records) {
    if (!eligible(record) || record.status !== 'complete') continue;
    if (now !== undefined && !alreadyHappened(record, now)) continue;
    const key = `${payeeKey(record.counterparty!)}|${record.currency}|${record.amountMinor}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(record);
    else grouped.set(key, [record]);
  }

  const duplicates: DuplicateCharge[] = [];
  for (const bucket of grouped.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((left, right) => left.occurredAt! - right.occurredAt!);

    const clusters: RecurringRecord[][] = [];
    for (const record of sorted) {

      const cluster = clusters.at(-1);
      if (cluster && record.occurredAt! - cluster[0]!.occurredAt! <= DUPLICATE_WINDOW_MS) {
        cluster.push(record);
      } else {
        clusters.push([record]);
      }
    }

    const repeats = clusters.filter((cluster) => cluster.length > 1);
    if (repeats.length !== 1) continue;
    const repeat = repeats[0]!;
    const last = repeat.at(-1)!;
    const count = repeat.length;
    duplicates.push({
      counterparty: last.counterparty!.trim(),
      currency: last.currency!,
      amountMinor: last.amountMinor!,
      recordIds: repeat.map((record) => record.id),
      at: last.occurredAt!,
      text:
        `${capitalise(inWords(count))} payments of ${formatMinorUnits(last.amountMinor!, last.currency!)} ` +
        `to ${last.counterparty!.trim()} within a day of each other.`,
    });
  }

  return duplicates.sort((left, right) => right.at - left.at).slice(0, MAX_OUTLIERS);
}

export const MIN_HISTORY_FOR_NEW_PAYEE = 20;
export const MIN_HISTORY_DAYS_FOR_NEW_PAYEE = 60;

const NEW_PAYEE_RECENT_DAYS = 30;

const NEW_PAYEE_LARGE_MULTIPLE = 3;

export type NewLargePayee = {
  counterparty: string;
  currency: string;
  amountMinor: number;

  recordIds: string[];
  at: number;

  usualMinor: number;

  text: string;
};

export function newLargePayees(records: RecurringRecord[], now: number = Date.now()): NewLargePayee[] {
  const usable = records.filter(
    (record) => eligible(record) && record.status === 'complete' && alreadyHappened(record, now),
  );
  if (usable.length < MIN_HISTORY_FOR_NEW_PAYEE) return [];

  const dates = usable.map((record) => record.occurredAt!);
  if (daysBetween(Math.min(...dates), Math.max(...dates)) < MIN_HISTORY_DAYS_FOR_NEW_PAYEE) return [];

  const usual = median(usable.map((record) => record.amountMinor!));
  if (usual <= 0) return [];
  const floor = startOfDay(now) - NEW_PAYEE_RECENT_DAYS * DAY_MS;

  const grouped = new Map<string, RecurringRecord[]>();
  for (const record of usable) {
    const key = payeeKey(record.counterparty!);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(record);
    else grouped.set(key, [record]);
  }

  const found: NewLargePayee[] = [];
  for (const bucket of grouped.values()) {

    if (bucket.some((record) => record.occurredAt! < floor)) continue;
    const biggest = bucket.reduce((most, record) => (record.amountMinor! > most.amountMinor! ? record : most));
    if (biggest.amountMinor! < usual * NEW_PAYEE_LARGE_MULTIPLE) continue;
    found.push({
      counterparty: biggest.counterparty!.trim(),
      currency: biggest.currency!,
      amountMinor: biggest.amountMinor!,
      recordIds: bucket.map((record) => record.id),
      at: biggest.occurredAt!,
      usualMinor: Math.round(usual),
      text:
        `${formatMinorUnits(biggest.amountMinor!, biggest.currency!)} to ${biggest.counterparty!.trim()}, ` +
        `a payee with no earlier payments recorded.`,
    });
  }

  return found.sort((left, right) => right.amountMinor - left.amountMinor).slice(0, MAX_OUTLIERS);
}
