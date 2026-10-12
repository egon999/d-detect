import { spendOf } from '../routes/insights.ts';
import { exponentFor, formatMinorUnits } from '../money.ts';
import { cadenceSeries, type RecurringRecord } from '../recurring.ts';
import type { Draft } from './types.ts';

const DAY = 86_400_000;

const DATE_FORMAT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function dayText(at: number): string {
  return DATE_FORMAT.format(new Date(at));
}

function money(minor: number, currency: string): string {
  return formatMinorUnits(Math.abs(minor), currency);
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export type AnomalyRecord = RecurringRecord & { extraction: string };

function outgoings(records: AnomalyRecord[]): AnomalyRecord[] {
  return records.filter(
    (record) =>
      record.occurredAt !== null &&
      record.currency !== null &&
      record.amountMinor !== null &&
      record.amountMinor > 0 &&
      Boolean(record.counterparty?.trim()) &&
      spendOf({
        kind: record.kind,
        amount_minor: record.amountMinor,
        direction: record.direction,
        status: record.status,
        extraction: record.extraction,
      }) > 0,
  );
}

function duplicateFloor(currency: string): number {
  return 100 * 10 ** exponentFor(currency);
}

function payeeKey(record: AnomalyRecord): string {
  return record.counterparty!.trim().toLowerCase().replace(/\s+/g, ' ');
}

function duplicateCharges(records: AnomalyRecord[]): Draft[] {
  const buckets = new Map<string, AnomalyRecord[]>();
  for (const record of records) {
    const key = `${payeeKey(record)}|${record.currency}|${record.amountMinor}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }

  const drafts: Draft[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((left, right) => left.occurredAt! - right.occurredAt!);

    for (let index = 1; index < sorted.length; index += 1) {
      const earlier = sorted[index - 1]!;
      const later = sorted[index]!;
      if (later.occurredAt! - earlier.occurredAt! > 2 * DAY) continue;
      if (later.amountMinor! < duplicateFloor(later.currency!)) continue;

      const before = sorted[index - 2];
      const after = sorted[index + 1];
      if (before && earlier.occurredAt! - before.occurredAt! <= 2 * DAY) continue;
      if (after && after.occurredAt! - later.occurredAt! <= 2 * DAY) continue;

      const payee = later.counterparty!.trim();
      const earlierDay = dayText(earlier.occurredAt!);
      const laterDay = dayText(later.occurredAt!);

      drafts.push({
        kind: 'anomaly',
        rule: 'duplicate_charge',
        title: `Two payments to ${payee} look the same`,
        detail:
          earlierDay === laterDay
            ? `Both are for ${money(later.amountMinor!, later.currency!)} and both are dated ${laterDay}.`
            : `Both are for ${money(later.amountMinor!, later.currency!)}, one dated ${earlierDay} and one dated ${laterDay}.`,
        amountMinor: later.amountMinor,
        currency: later.currency,
        sources: [
          { kind: 'record', id: earlier.id },
          { kind: 'record', id: later.id },
        ],

        fingerprint: `duplicate_charge:${earlier.id}:${later.id}`,
      });
    }
  }
  return drafts;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function amountChanges(records: AnomalyRecord[]): Draft[] {
  const drafts: Draft[] = [];

  for (const series of cadenceSeries(records)) {
    if (series.occurrences.length < 4) continue;
    const latest = series.occurrences.at(-1)!;
    const now = latest.amountMinor!;
    const history = series.occurrences.slice(0, -1).map((record) => record.amountMinor!);
    const payee = series.counterparty;
    const nowText = money(now, series.currency);

    const flat = history[0]!;
    const steady = history.every((amount) => amount === flat) && flat > 0;

    let usual: number | null = null;
    let rising = false;
    let detail: string | null = null;

    if (steady && now !== flat && Math.abs((now - flat) / flat) >= 0.05) {
      usual = flat;
      rising = now > flat;
      detail =
        history.length === 1
          ? `The one before this was ${money(flat, series.currency)}. This one is ${nowText}.`
          : `The ${history.length} before this were all ${money(flat, series.currency)}. This one is ${nowText}.`;
    } else if (!steady && history.length >= 4) {
      const middle = median(history);
      const inBand =
        middle > 0 && Math.min(...history) >= middle * 0.65 && Math.max(...history) <= middle * 1.35;
      if (inBand && now >= middle * 2.5) {
        usual = middle;
        rising = true;
        detail = `Your last ${count(history.length, 'payment', 'payments')} to ${payee} ${history.length === 1 ? 'was' : 'were'} between ${money(Math.min(...history), series.currency)} and ${money(Math.max(...history), series.currency)}. This one is ${nowText}.`;
      }
    }
    if (detail === null || usual === null) continue;

    drafts.push({
      kind: 'anomaly',
      rule: 'recurring_amount_changed',
      title: `${payee} is ${rising ? 'higher' : 'lower'} this time`,
      detail,

      amountMinor: now,
      currency: series.currency,
      sources: [...series.occurrences.slice(-3)].map((record) => ({ kind: 'record' as const, id: record.id })),
      fingerprint: `recurring_amount_changed:${latest.id}`,
    });
  }
  return drafts;
}

function missedRecurring(records: AnomalyRecord[], now: number): Draft[] {
  const drafts: Draft[] = [];

  const latestByPayee = new Map<string, number>();
  for (const record of records) {
    const key = payeeKey(record);
    const at = record.occurredAt!;
    const seen = latestByPayee.get(key);
    if (seen === undefined || at > seen) latestByPayee.set(key, at);
  }

  for (const series of cadenceSeries(records)) {
    if (series.occurrences.length < 3) continue;
    const expectedAt = series.lastAt + series.medianGapMs;
    const lateBy = now - expectedAt;
    if (lateBy < 7 * DAY || lateBy > series.medianGapMs) continue;

    const latest = latestByPayee.get(series.counterparty.trim().toLowerCase().replace(/\s+/g, ' '));
    if (latest !== undefined && latest >= expectedAt) continue;

    drafts.push({
      kind: 'anomaly',
      rule: 'recurring_missing',
      title: `Nothing saved for ${series.counterparty} this time`,
      detail: `You have saved a payment to ${series.counterparty} about every ${Math.round(series.medianGapMs / DAY)} days. The last one is dated ${dayText(series.lastAt)}, ${Math.round((now - series.lastAt) / DAY)} days ago.`,
      dueAt: expectedAt,
      amountMinor: series.occurrences.at(-1)!.amountMinor,
      currency: series.currency,
      sources: series.occurrences.slice(-3).map((record) => ({ kind: 'record' as const, id: record.id })),

      fingerprint: `recurring_missing:${series.occurrences.at(-1)!.id}`,
    });
  }
  return drafts;
}

const UNFINISHED_AFTER_MS = 3 * DAY;

const UNREAD_AFTER_MS = DAY;

const NAMED_LIMIT = 6;

export type PendingRecord = {
  id: string;
  title: string;

  createdAt: number;

  question: string | null;

  unread: boolean;
};

function unfinishedEntries(records: PendingRecord[], now: number): Draft[] {
  const waiting = records
    .filter((record) => !record.unread && record.question !== null && now - record.createdAt >= UNFINISHED_AFTER_MS)
    .sort((left, right) => right.createdAt - left.createdAt);
  if (waiting.length === 0) return [];

  const named = waiting.slice(0, NAMED_LIMIT);
  const oldest = waiting.at(-1)!;
  const detail =
    waiting.length === 1
      ? `It is waiting on one thing: "${oldest.question}" It has been there since ${dayText(oldest.createdAt)}.`
      : `Each one is waiting on a single question. The oldest has been there since ${dayText(oldest.createdAt)}.`;

  return [
    {
      kind: 'anomaly',
      rule: 'unfinished_entries',
      title:
        waiting.length === 1
          ? `${oldest.title} is not finished`
          : `${count(waiting.length, 'entry', 'entries')} are waiting on one detail`,
      detail,
      sources: named.map((record) => ({ kind: 'record' as const, id: record.id })),
      fingerprint: `unfinished_entries:${named.map((record) => record.id).sort().join(',')}`,
    },
  ];
}

function unreadCaptures(records: PendingRecord[], now: number): Draft[] {
  const stuck = records
    .filter((record) => record.unread && now - record.createdAt >= UNREAD_AFTER_MS)
    .sort((left, right) => right.createdAt - left.createdAt);
  if (stuck.length === 0) return [];

  const named = stuck.slice(0, NAMED_LIMIT);
  return [
    {
      kind: 'anomaly',
      rule: 'unread_captures',
      title:
        stuck.length === 1
          ? `Nothing could be read from ${stuck[0]!.title}`
          : `Nothing could be read from ${count(stuck.length, 'file', 'files')}`,
      detail:
        stuck.length === 1
          ? 'A clearer photo, or a few words about what it is, is enough to finish it.'
          : 'A clearer photo, or a few words about what each one is, is enough to finish them.',
      sources: named.map((record) => ({ kind: 'record' as const, id: record.id })),
      fingerprint: `unread_captures:${named.map((record) => record.id).sort().join(',')}`,
    },
  ];
}

export type MeetingProgress = {
  id: string;
  title: string;
  startedAt: number;
  items: number;
  done: number;
};

const MEETING_SETTLE_MS = 14 * DAY;
const MEETING_STALE_MS = 60 * DAY;

function untouchedMeetings(meetings: MeetingProgress[], now: number): Draft[] {
  const drafts: Draft[] = [];
  for (const meeting of meetings) {
    const age = now - meeting.startedAt;
    if (age < MEETING_SETTLE_MS || age > MEETING_STALE_MS) continue;
    if (meeting.items < 3 || meeting.done > 0) continue;

    drafts.push({
      kind: 'anomaly',
      rule: 'meeting_untouched',
      title: `${count(meeting.items, 'thing', 'things')} from ${meeting.title} are still open`,
      detail: `That was ${Math.round(age / DAY)} days ago, on ${dayText(meeting.startedAt)}, and none of them are marked done.`,
      sources: [{ kind: 'meeting', id: meeting.id }],
      fingerprint: `meeting_untouched:${meeting.id}`,
    });
  }
  return drafts;
}

export function detectAnomalies(records: AnomalyRecord[], now: number = Date.now()): Draft[] {
  const usable = outgoings(records);
  if (usable.length === 0) return [];
  return [...duplicateCharges(usable), ...amountChanges(usable), ...missedRecurring(usable, now)];
}

export function detectPending(records: PendingRecord[], now: number = Date.now()): Draft[] {
  if (records.length === 0) return [];
  return [...unfinishedEntries(records, now), ...unreadCaptures(records, now)];
}

export function detectUntouchedMeetings(meetings: MeetingProgress[], now: number = Date.now()): Draft[] {
  return untouchedMeetings(meetings, now);
}
