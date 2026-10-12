import { z } from 'zod';

import { apiDelete, apiGet, apiPatch, apiPost, apiUpload } from './client';
import { appendUpload, uploadBytes, type UploadFile } from './files';
import type { Meeting } from './meetings';

export type DaybookStatus = 'processing' | 'needs_context' | 'complete' | 'unreadable' | 'failed';
export type DaybookDirection = 'out' | 'in';

export type DaybookQuestion = {
  id: string;
  field: string;
  prompt: string;
  options: string[];
};

export type DaybookRecord = {
  id: string;
  kind: string;
  title: string;
  occurredAt: number | null;
  occurredPrecision: string | null;
  amountMinor: number | null;
  currency: string | null;
  amountLabel: string | null;
  direction: DaybookDirection | null;
  counterparty: string | null;
  category: string | null;
  note: string | null;
  fileId: string | null;
  status: DaybookStatus;
  createdAt: number;
  updatedAt: number;
  extraction: unknown;
  question: DaybookQuestion | null;

  progress: string | null;
};

export type ManualRecordInput = {
  title: string;
  kind?: string;
  note?: string;
  amount?: string | number;
  currency?: string;
  direction?: DaybookDirection;
  counterparty?: string;
  category?: string;
  occurredAt?: number;
};

export type RecordPatch = Partial<{
  title: string;
  kind: string;
  note: string | null;
  amount: string | number | null;
  currency: string | null;
  direction: DaybookDirection | null;
  counterparty: string | null;
  category: string | null;
  occurredAt: number | null;
}>;

function wire(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === 'occurredAt') {
      body[key] = typeof value === 'number' ? new Date(value).toISOString() : value;
    } else if (key === 'amount') {
      body[key] = typeof value === 'number' ? String(value) : value;
    } else {
      body[key] = value;
    }
  }
  return body;
}

export function captureRecord(file: UploadFile): Promise<{ record: DaybookRecord }> {
  const form = new FormData();
  appendUpload(form, 'file', file);
  return apiUpload<{ record: DaybookRecord }>('/api/daybook/capture', form, undefined, uploadBytes(file));
}

export function createRecord(input: ManualRecordInput): Promise<{ record: DaybookRecord }> {
  return apiPost<{ record: DaybookRecord }>('/api/daybook/records', wire(input));
}

export type DaybookPage = {
  records: DaybookRecord[];

  nextCursor: number | null;
};

export type DaybookPageQuery = {
  limit?: number;

  before?: number | null;
};

export async function listRecordPage({ limit, before }: DaybookPageQuery = {}): Promise<DaybookPage> {
  const data = await apiGet<{ records?: DaybookRecord[]; nextCursor?: number | null }>(
    '/api/daybook/records',
    { limit, before: before ?? undefined },
  );
  return { records: data.records ?? [], nextCursor: data.nextCursor ?? null };
}

export async function listRecords(limit?: number): Promise<DaybookRecord[]> {
  const page = await listRecordPage({ limit });
  return page.records;
}

export async function getRecord(id: string): Promise<DaybookRecord> {
  const data = await apiGet<{ record: DaybookRecord }>(`/api/daybook/records/${id}`);
  return data.record;
}

export async function answerRecord(id: string, answer: string): Promise<DaybookRecord> {
  const data = await apiPost<{ record: DaybookRecord }>(`/api/daybook/records/${id}/answer`, { answer });
  return data.record;
}

export async function skipQuestion(id: string): Promise<DaybookRecord> {
  const data = await apiPost<{ record: DaybookRecord }>(
    `/api/daybook/records/${id}/question/skip`,
    {},
  );
  return data.record;
}

export async function updateRecord(id: string, patch: RecordPatch): Promise<DaybookRecord> {
  const data = await apiPatch<{ record: DaybookRecord }>(`/api/daybook/records/${id}`, wire(patch));
  return data.record;
}

export function deleteRecord(id: string): Promise<{ deleted: true }> {
  return apiDelete<{ deleted: true }>(`/api/daybook/records/${id}`);
}

export async function retryRecord(id: string): Promise<DaybookRecord> {
  const data = await apiPost<{ record: DaybookRecord }>(`/api/daybook/records/${id}/retry`, {});
  return data.record;
}

const DaybookSourceSchema = z.object({
  type: z.enum(['record', 'meeting', 'task']),
  id: z.string(),
  title: z.string(),
});

const DaybookAnswerSchema = z.object({
  text: z.string(),
  sources: z.array(DaybookSourceSchema),
  followUp: z.string().nullable(),
});

const AskResponseSchema = z.object({ answer: DaybookAnswerSchema });

export type DaybookSource = z.infer<typeof DaybookSourceSchema>;
export type DaybookAnswer = z.infer<typeof DaybookAnswerSchema>;

export async function askDaybook(question: string): Promise<DaybookAnswer> {
  const data = await apiPost<unknown>('/api/daybook/ask', { question });
  return AskResponseSchema.parse(data).answer;
}

const UpcomingItemSchema = z.object({
  id: z.string(),
  type: z.enum(['record', 'task', 'recurring']),
  title: z.string(),
  at: z.number(),
  amountLabel: z.string().nullable(),
  amountMinor: z.number().nullable(),
  currency: z.string().nullable(),
  counterparty: z.string().nullable(),
  kind: z.string().nullable(),
  recordId: z.string().nullable(),
  taskId: z.string().nullable(),
  overdue: z.boolean(),

  estimated: z.boolean(),
  estimatedAmountMinor: z.number().nullable(),
  estimatedAmountLabel: z.string().nullable(),
  estimatedFromOccurrences: z.number().nullable(),
});

const UpcomingResponseSchema = z.object({ upcoming: z.array(UpcomingItemSchema) });

export type UpcomingItem = z.infer<typeof UpcomingItemSchema>;

export async function getUpcoming(): Promise<UpcomingItem[]> {
  const data = await apiGet<unknown>('/api/daybook/upcoming');
  return UpcomingResponseSchema.parse(data).upcoming;
}

export type RecapPeriod = 'week' | 'month';

const RecapCategorySchema = z.object({
  category: z.string(),
  minor: z.number(),
  label: z.string().nullable(),
  share: z.number(),
});

const RecapCounterpartySchema = z.object({
  name: z.string(),
  minor: z.number(),
  label: z.string().nullable(),
  count: z.number(),
});

const RecapPreviousSchema = z.object({
  spentMinor: z.number(),
  spentLabel: z.string().nullable(),
  deltaMinor: z.number(),
  deltaLabel: z.string().nullable(),
});

const RecapHighlightSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spent'), amountMinor: z.number(), amountLabel: z.string().nullable() }),
  z.object({
    kind: z.literal('top_category'),
    category: z.string(),
    amountMinor: z.number(),
    amountLabel: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('biggest_payment'),
    amountMinor: z.number(),
    amountLabel: z.string().nullable(),
    counterparty: z.string().nullable(),
  }),
  z.object({ kind: z.literal('tasks_overdue'), count: z.number() }),
  z.object({
    kind: z.literal('spend_change'),
    direction: z.enum(['more', 'less']),
    amountMinor: z.number(),
    amountLabel: z.string().nullable(),
  }),
  z.object({ kind: z.literal('received'), amountMinor: z.number(), amountLabel: z.string().nullable() }),
  z.object({ kind: z.literal('tasks_done'), count: z.number() }),
  z.object({ kind: z.literal('meetings_recorded'), count: z.number() }),
]);

const RecapSchema = z.object({
  period: z.enum(['week', 'month']),
  from: z.number(),
  to: z.number(),
  currency: z.string().nullable(),
  spentMinor: z.number(),
  spentLabel: z.string().nullable(),
  receivedMinor: z.number(),
  receivedLabel: z.string().nullable(),
  records: z.number(),
  meetings: z.number(),
  tasksDone: z.number(),
  tasksOpen: z.number(),
  tasksOverdue: z.number(),
  byCategory: z.array(RecapCategorySchema),
  topCounterparties: z.array(RecapCounterpartySchema),
  previous: RecapPreviousSchema.nullable(),
  highlights: z.array(RecapHighlightSchema),
});

const RecapResponseSchema = z.object({ recap: RecapSchema });

export type RecapCategory = z.infer<typeof RecapCategorySchema>;
export type RecapCounterparty = z.infer<typeof RecapCounterpartySchema>;
export type RecapPrevious = z.infer<typeof RecapPreviousSchema>;
export type RecapHighlight = z.infer<typeof RecapHighlightSchema>;
export type DaybookRecap = z.infer<typeof RecapSchema>;

export async function getRecap(period: RecapPeriod): Promise<DaybookRecap> {
  const data = await apiGet<unknown>('/api/daybook/recap', { period });
  return RecapResponseSchema.parse(data).recap;
}

export type TimelineEntry =
  | { kind: 'entry'; key: string; at: number; record: DaybookRecord }
  | { kind: 'meeting'; key: string; at: number; meeting: Meeting };

export type TimelineDay = {

  key: string;

  at: number;
  data: TimelineEntry[];
};

export function entryTime(record: DaybookRecord): number {
  return record.occurredAt ?? record.createdAt;
}

export function meetingTime(meeting: Meeting): number {
  return meeting.startedAt ?? meeting.createdAt;
}

export function dayKey(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayHeading(at: number, now: number, locale?: string): string {
  const key = dayKey(at);
  if (key === dayKey(now)) return 'Today';

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return 'Yesterday';

  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function groupTimelineByDay(entries: readonly TimelineEntry[]): TimelineDay[] {
  const sorted = [...entries].sort((a, b) => (b.at - a.at) || a.key.localeCompare(b.key));

  const days: TimelineDay[] = [];
  let current: TimelineDay | null = null;

  for (const entry of sorted) {
    const key = dayKey(entry.at);
    if (!current || current.key !== key) {
      current = { key, at: startOfDay(entry.at), data: [] };
      days.push(current);
    }
    current.data.push(entry);
  }

  return days;
}

export type TimelineInput = {
  records: readonly DaybookRecord[];
  meetings: readonly Meeting[];

  recordsExhausted: boolean;
};

export function monthKey(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}`;
}

function startOfMonth(at: number, count: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth() + count, 1, 0, 0, 0, 0).getTime();
}

export function startOfMonthKey(key: string): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return new Date(year, month - 1, 1, 0, 0, 0, 0).getTime();
}

export function monthLabel(at: number, now: number, locale?: string): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, {
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export type MonthSelection = string | 'newest';

export function recentMonths(
  now: number,
  count = 24,
  locale?: string,
): Array<{ key: string; label: string; at: number }> {
  const months: Array<{ key: string; label: string; at: number }> = [];
  for (let back = 0; back < count; back += 1) {
    const at = startOfMonth(now, -back);
    months.push({ key: monthKey(at), label: monthLabel(at, now, locale), at });
  }
  return months;
}

export function jumpSummary(month: { key: string; label: string } | null): string | null {
  if (!month) return null;
  return `Showing ${month.label} and older. Pull down for the newest first.`;
}

export function buildTimeline({ records, meetings, recordsExhausted }: TimelineInput): TimelineDay[] {
  const entries: TimelineEntry[] = records.map((record) => ({
    kind: 'entry',
    key: `entry:${record.id}`,
    at: entryTime(record),
    record,
  }));

  let floor = Number.NEGATIVE_INFINITY;
  if (!recordsExhausted && entries.length > 0) {
    floor = entries.reduce((oldest, entry) => Math.min(oldest, entry.at), Number.POSITIVE_INFINITY);
  }

  for (const meeting of meetings) {
    const at = meetingTime(meeting);
    if (at < floor) continue;
    entries.push({ kind: 'meeting', key: `meeting:${meeting.id}`, at, meeting });
  }

  return groupTimelineByDay(entries);
}

export function isRecordInProgress(record: DaybookRecord): boolean {
  return record.status === 'processing';
}

export function isMeetingInProgress(meeting: Meeting): boolean {
  return meeting.status === 'transcribing' || meeting.status === 'transcribed';
}

export function inProgressRecordIds(records: readonly DaybookRecord[]): string[] {
  return records.filter(isRecordInProgress).map((record) => record.id);
}

export function inProgressMeetingIds(meetings: readonly Meeting[]): string[] {
  return meetings.filter(isMeetingInProgress).map((meeting) => meeting.id);
}

export function inProgressKey(
  records: readonly DaybookRecord[],
  meetings: readonly Meeting[],
): string {
  const ids = [...inProgressRecordIds(records), ...inProgressMeetingIds(meetings)];
  return ids.sort().join(',');
}

export const POLL_STEPS_MS: readonly number[] = [2000, 2000, 3000, 5000, 8000, 12000, 20000, 30000];
export const POLL_MAX_ATTEMPTS = 40;

export function pollDelayMs(attempt: number): number | null {
  if (attempt < 0) return POLL_STEPS_MS[0] ?? null;
  if (attempt >= POLL_MAX_ATTEMPTS) return null;
  const last = POLL_STEPS_MS[POLL_STEPS_MS.length - 1] ?? null;
  return POLL_STEPS_MS[attempt] ?? last;
}

export function recordsUnchanged(
  before: readonly DaybookRecord[],
  after: readonly DaybookRecord[],
): boolean {
  if (before.length !== after.length) return false;
  return before.every((record, index) => {
    const next = after[index];
    return (
      next !== undefined &&
      next.id === record.id &&
      next.status === record.status &&
      next.progress === record.progress &&
      next.updatedAt === record.updatedAt
    );
  });
}

export function meetingsUnchanged(
  before: readonly Meeting[],
  after: readonly Meeting[],
): boolean {
  if (before.length !== after.length) return false;
  return before.every((meeting, index) => {
    const next = after[index];
    return (
      next !== undefined &&
      next.id === meeting.id &&
      next.status === meeting.status &&
      next.updatedAt === meeting.updatedAt
    );
  });
}
