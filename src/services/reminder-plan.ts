export type ReminderDetail = 'discreet' | 'titles' | 'full';

export type ReminderSlot = 'evening' | 'morning';

export interface ReminderSettings {
  enabled: boolean;

  eveningHour: number;

  morningHour: number | null;
  detail: ReminderDetail;
}

const DEFAULT_MORNING_HOUR = 8;

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: true,
  eveningHour: 19,
  morningHour: DEFAULT_MORNING_HOUR,
  detail: 'discreet',
};

export const QUIET_HOURS_FROM = 20;
export const QUIET_HOURS_TO = 7;

export const EVENING_HOUR_OPTIONS: readonly number[] = [18, 19];
export const MORNING_HOUR_OPTIONS: readonly number[] = [8, 9, 10];

export const SCHEDULE_WINDOW_DAYS = 21;

export const MAX_SCHEDULED_REMINDERS = 48;

export type SlotKey = { slot: ReminderSlot; day: string };

export type Occasion = SlotKey & { dayAt: number; items: readonly DueThing[] };

export interface ReminderData {

  bucket: 'e' | 'm';

  day: string;

  recordId?: string;

  taskId?: string;

  count: string;
}

export interface PlannedReminder {

  id: string;

  at: number;
  title: string;
  body: string;
  data: ReminderData;

  fingerprint: string;
}

export type DueKind = 'record' | 'task';

export interface DueThing {
  kind: DueKind;

  key: string;

  title: string;

  dueAt: number;

  amountLabel: string | null;

  recordId: string | null;

  taskId: string | null;
}

export interface UpcomingLike {
  type: string;
  title: string;

  at: number | null;
  amountLabel: string | null;
  recordId: string | null;
  taskId: string | null;
}

export interface UpcomingApiLike extends UpcomingLike {

  estimatedAmountLabel?: string | null;

  estimatedFromOccurrences?: number | null;
  estimated?: boolean;
  overdue?: boolean;
  counterparty?: string | null;
  kind?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
}

export function dueThingsFromUpcoming(items: readonly UpcomingApiLike[]): DueThing[] {
  const things: DueThing[] = [];
  for (const item of items) {
    if (item.type !== 'record' && item.type !== 'task') continue;
    if (typeof item.at !== 'number' || !Number.isFinite(item.at) || item.at <= 0) continue;
    const kind: DueKind = item.type;
    things.push({
      kind,
      key: kind === 'record' ? `r:${item.recordId ?? item.title}` : `t:${item.taskId ?? item.title}`,
      title: item.title,
      dueAt: item.at,
      amountLabel: item.amountLabel,
      recordId: item.recordId,
      taskId: item.taskId,
    });
  }
  return things;
}

export function asUpcoming(items: readonly UpcomingApiLike[]): UpcomingLike[] {
  return items.map((item) => ({
    type: item.type,
    title: item.title,
    at: item.at,

    amountLabel: item.amountLabel,
    recordId: item.recordId,
    taskId: item.taskId,
  }));
}

export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function shiftDay(at: number, by: number): number {
  const date = new Date(at);
  date.setDate(date.getDate() + by);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function atHour(day: number, hour: number): number {
  const date = new Date(day);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

export function clampToQuietHours(day: number, hour: number): number {
  if (hour >= QUIET_HOURS_FROM) return atHour(day, QUIET_HOURS_FROM - 1);
  if (hour < QUIET_HOURS_TO) return atHour(shiftDay(day, -1), QUIET_HOURS_FROM - 1);
  return atHour(day, hour);
}

export function inQuietHours(at: number): boolean {
  const hour = new Date(at).getHours();
  return hour >= QUIET_HOURS_FROM || hour < QUIET_HOURS_TO;
}

export function normalizeSettings(value: unknown): ReminderSettings {
  const source = (value ?? {}) as Partial<Record<keyof ReminderSettings, unknown>>;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_REMINDER_SETTINGS.enabled,
    eveningHour: offeredHour(source.eveningHour, EVENING_HOUR_OPTIONS, DEFAULT_REMINDER_SETTINGS.eveningHour),
    morningHour:
      source.morningHour === null
        ? null
        : offeredHour(source.morningHour, MORNING_HOUR_OPTIONS, DEFAULT_MORNING_HOUR),
    detail: isDetail(source.detail) ? source.detail : DEFAULT_REMINDER_SETTINGS.detail,
  };
}

function isDetail(value: unknown): value is ReminderDetail {
  return value === 'discreet' || value === 'titles' || value === 'full';
}

function offeredHour(value: unknown, offered: readonly number[], fallback: number): number {
  return typeof value === 'number' && offered.includes(value) ? value : fallback;
}

export function hourLabel(hour: number): string {
  const onTheHour = ((hour % 24) + 24) % 24;
  if (onTheHour === 0) return '12am';
  if (onTheHour === 12) return '12pm';
  return onTheHour < 12 ? `${onTheHour}am` : `${onTheHour - 12}pm`;
}

export function planReminders(
  things: readonly DueThing[],
  settings: ReminderSettings,
  now: number,
): PlannedReminder[] {
  const safe = normalizeSettings(settings);
  if (!safe.enabled) return [];

  const occasions = slotOccasions(things, now);
  const reminders: PlannedReminder[] = [];

  for (const occasion of occasions) {
    const hour =
      occasion.slot === 'evening' ? safe.eveningHour : safe.morningHour;
    if (hour === null) continue;
    const at = clampToQuietHours(occasion.dayAt, hour);

    if (at <= now) continue;

    const words = reminderWords(occasion, safe.detail);
    reminders.push({
      id: reminderId(occasion.slot, occasion.day),
      at,
      title: words.title,
      body: words.body,
      data: reminderData(occasion),
      fingerprint: reminderFingerprint(at, words.title, words.body, occasion.items),
    });
  }

  reminders.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  return reminders.slice(0, MAX_SCHEDULED_REMINDERS);
}

function slotOccasions(things: readonly DueThing[], now: number): Occasion[] {
  const occasions: Occasion[] = [];
  const today = startOfDay(now);

  for (let offset = 0; offset <= SCHEDULE_WINDOW_DAYS; offset += 1) {
    const day = shiftDay(today, offset);
    const key = dayKey(day);

    const morning: DueThing[] = [];

    for (const thing of things) {
      if (startOfDay(thing.dueAt) === day) morning.push(thing);
    }

    const yesterday = shiftDay(day, -1);
    for (const thing of things) {
      if (thing.taskId === null) continue;
      if (startOfDay(thing.dueAt) === yesterday) morning.push(thing);
    }
    if (morning.length > 0) {
      occasions.push({ slot: 'morning', day: key, dayAt: day, items: morning });
    }

    const evening: DueThing[] = [];
    const tomorrow = shiftDay(day, 1);
    for (const thing of things) {
      if (startOfDay(thing.dueAt) === tomorrow) evening.push(thing);
    }
    if (evening.length > 0) {
      occasions.push({ slot: 'evening', day: key, dayAt: day, items: evening });
    }
  }

  return occasions;
}

export function reminderId(slot: ReminderSlot, day: string): string {
  return `detact-reminder:${slot === 'morning' ? 'm' : 'e'}:${day}`;
}

export const REMINDER_ID_PREFIX = 'detact-reminder:';

function reminderData(occasion: Occasion): ReminderData {
  const items = occasion.items;
  const data: ReminderData = {
    bucket: occasion.slot === 'morning' ? 'm' : 'e',
    day: occasion.day,
    count: String(items.length),
  };
  const recordIds = new Set(items.map((item) => item.recordId).filter((id): id is string => id !== null));
  if (items.length === 1 && recordIds.size === 1) {
    const only = items[0];
    if (only && only.recordId) data.recordId = only.recordId;
  }
  if (items.length === 1) {
    const only = items[0];
    if (only && only.taskId) data.taskId = only.taskId;
  }
  return data;
}

export function reminderFingerprint(
  at: number,
  title: string,
  body: string,
  items: readonly DueThing[],
): string {
  const contents = items
    .map((item) => `${item.key}@${dayKey(item.dueAt)}`)
    .sort()
    .join(',');
  return `${at}|${title}|${body}|${contents}`;
}

export const MAX_NAME_LENGTH = 44;

export function truncateName(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_NAME_LENGTH) return flat;
  const cut = flat.slice(0, MAX_NAME_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const SMALL_NUMBERS = [
  'none',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

function othersPhrase(count: number): string {
  const small = SMALL_NUMBERS[count];
  if (!small) return 'many others';
  return count === 1 ? 'one other' : `${small} others`;
}

function countPhrase(count: number): string {
  return SMALL_NUMBERS[count] ?? 'a lot of';
}

function thingsPhrase(count: number): string {
  return `${countPhrase(count)} ${count === 1 ? 'thing' : 'things'}`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function referenceDay(occasion: Occasion): number {
  const day = startOfDay(occasion.dayAt);
  return occasion.slot === 'evening' ? shiftDay(day, 1) : day;
}

function dueItems(occasion: Occasion): DueThing[] {
  const day = referenceDay(occasion);
  return occasion.items.filter((item) => startOfDay(item.dueAt) === day);
}

function lateCount(occasion: Occasion): number {
  const day = referenceDay(occasion);
  return occasion.items.filter((item) => startOfDay(item.dueAt) < day).length;
}

function dayPhrase(occasion: Occasion): string {
  return occasion.slot === 'evening' ? 'tomorrow' : 'today';
}

function nameList(names: readonly string[]): string {
  const shown = names.slice(0, 2);
  const extra = names.length - shown.length;
  if (extra <= 0) return shown.join(' and ');
  return `${shown.join(', ')} and ${othersPhrase(extra)}`;
}

function neutralHeadline(occasion: Occasion): string {
  const late = lateCount(occasion);
  const due = occasion.items.length - late;

  const lateClause = late === 1 ? ' and one already late' : ` and ${countPhrase(late)} already late`;

  if (late > 0 && due === 0) {
    return sentence(`${thingsPhrase(late)} ${late === 1 ? 'was' : 'were'} due yesterday`);
  }
  if (late > 0) {
    const noun = due === 1 ? 'One thing is' : `${thingsPhrase(due)} are`;
    return sentence(`${noun} due ${dayPhrase(occasion)}${lateClause}`);
  }
  if (due === 1) {
    return sentence(`one thing is due ${dayPhrase(occasion)}`);
  }
  return sentence(`${thingsPhrase(due)} are due ${dayPhrase(occasion)}`);
}

export function reminderWords(
  occasion: Occasion,
  detail: ReminderDetail,
): { title: string; body: string } {
  const title = neutralHeadline(occasion);
  if (detail === 'discreet') return { title, body: discreetBody(occasion) };

  const due = dueItems(occasion);
  const late = lateCount(occasion);

  if (due.length === 0) {
    const names = nameList(occasion.items.map((item) => truncateName(item.title)));
    return { title, body: `${names} ${occasion.items.length === 1 ? 'was' : 'were'} due yesterday` };
  }

  const names = due.map((item) => truncateName(item.title));

  const amount = detail === 'full' ? due[0]?.amountLabel : null;
  const headLead = amount ? `${amount} for ${names[0]}` : names[0]!;

  const restCount = due.length - (amount ? 1 : 2);
  const rest = restCount > 0 ? ` and ${othersPhrase(restCount)}` : due.length === 2 ? ` and ${names[1]}` : '';

  const lateClause = late === 0 ? '' : late === 1 ? ' (one is late)' : ` (${countPhrase(late)} are late)`;

  return { title, body: `${headLead}${rest} due ${dayPhrase(occasion)}${lateClause}` };
}

function discreetBody(occasion: Occasion): string {
  const late = lateCount(occasion);
  const due = occasion.items.length - late;
  if (due === 0) {
    return 'Open D-Detect to see what is still not done';
  }

  const lateClause =
    late === 0 ? '' : sentence(late === 1 ? 'One is late.' : `${countPhrase(late)} are late.`);
  return lateClause ? `Open D-Detect to see what. ${lateClause}` : 'Open D-Detect to see what.';
}

export function parseReminderData(value: unknown): ReminderData | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;
  if (source.bucket !== 'e' && source.bucket !== 'm') return null;
  if (typeof source.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.day)) return null;
  const data: ReminderData = {
    bucket: source.bucket,
    day: source.day,
    count: typeof source.count === 'string' ? source.count : '1',
  };
  if (typeof source.recordId === 'string' && source.recordId) data.recordId = source.recordId;
  if (typeof source.taskId === 'string' && source.taskId) data.taskId = source.taskId;
  return data;
}

export function isReminderId(identifier: string): boolean {
  return identifier.startsWith(REMINDER_ID_PREFIX);
}

export type ReminderDestination =
  | { kind: 'record'; recordId: string }
  | { kind: 'tasks' }
  | { kind: 'upcoming' }
  | null;

export function reminderDestination(data: ReminderData | null): ReminderDestination {
  if (!data) return null;
  if (data.recordId) return { kind: 'record', recordId: data.recordId };
  if (data.taskId) return { kind: 'tasks' };
  return { kind: 'upcoming' };
}

export function reminderHref(destination: ReminderDestination): string | null {
  if (!destination) return null;
  switch (destination.kind) {
    case 'record':
      return `/case/${destination.recordId}`;
    case 'tasks':
      return '/tasks';
    case 'upcoming':
      return '/recap';
  }
}

export function reminderHrefForData(data: unknown): string | null {
  return reminderHref(reminderDestination(parseReminderData(data)));
}

export interface PermissionSnapshot {

  granted: boolean | null;

  canAskAgain: boolean;
}

export interface AskHistory {
  asks: number;
  lastAskedAt: number | null;
}

export type PermissionDecision =
  | { action: 'granted' }
  | { action: 'ask' }
  | { action: 'skip' }
  | { action: 'open-settings' };

export const ASK_AGAIN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_ASKS = 2;

export function decidePermission(
  snapshot: PermissionSnapshot,
  history: AskHistory,
  settings: ReminderSettings,
): PermissionDecision {
  const safe = normalizeSettings(settings);
  if (!safe.enabled) return { action: 'skip' };
  if (snapshot.granted === true) return { action: 'granted' };
  if (snapshot.granted === null) return { action: 'skip' };
  if (!snapshot.canAskAgain) return { action: 'open-settings' };
  if (history.asks >= MAX_ASKS) return { action: 'skip' };
  if (history.lastAskedAt !== null && history.lastAskedAt > 0 && history.asks > 0) {

    const elapsed = Date.now() - history.lastAskedAt;
    if (elapsed >= 0 && elapsed < ASK_AGAIN_AFTER_MS) return { action: 'skip' };
  }
  return { action: 'ask' };
}

export function remindersAllowed(snapshot: PermissionSnapshot): boolean {
  return snapshot.granted === true;
}

export interface ExistingReminder {
  id: string;
  fingerprint: string;
}

export interface ReconcilePlan {

  cancel: string[];

  create: PlannedReminder[];
}

export function reconcile(
  desired: readonly PlannedReminder[],
  existing: readonly ExistingReminder[],
): ReconcilePlan {
  const held = new Map(existing.filter((row) => isReminderId(row.id)).map((row) => [row.id, row]));
  const wanted = new Map(desired.map((reminder) => [reminder.id, reminder]));

  const cancel: string[] = [];
  const create: PlannedReminder[] = [];

  for (const row of held.values()) {
    const wantedHere = wanted.get(row.id);
    if (!wantedHere || wantedHere.fingerprint !== row.fingerprint) cancel.push(row.id);
  }

  const cancelling = new Set(cancel);
  for (const reminder of wanted.values()) {
    if (cancelling.has(reminder.id)) {
      create.push(reminder);
      continue;
    }
    const row = held.get(reminder.id);
    if (!row || row.fingerprint !== reminder.fingerprint) create.push(reminder);
  }

  return { cancel, create };
}
