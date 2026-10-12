import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export type TaskState = 'open' | 'done' | 'all';

export type TaskPriority = 'high' | 'normal' | 'low';

export type Task = {
  id: string;
  text: string;

  owner: string | null;
  priority: TaskPriority;

  dueAt: number | null;
  doneAt: number | null;

  overdue: boolean;
  meetingId: string | null;
  recordId: string | null;

  meetingTitle: string | null;
  recordTitle: string | null;
  createdAt: number;
};

export interface TaskQuery {
  state?: TaskState;

  recordId?: string;
}

export type NewTaskInput = {
  text: string;
  priority?: TaskPriority;

  due?: string | null;
  owner?: string | null;

  recordId?: string;
};

export type TaskPatch = Partial<{
  done: boolean;
  text: string;
  priority: TaskPriority;
  due: string | null;
  owner: string | null;
}>;

export async function listTasks(query: TaskQuery = {}): Promise<Task[]> {
  const data = await apiGet<{ tasks: Task[] }>('/api/tasks', {
    state: query.state ?? null,
    recordId: query.recordId ?? null,
  });
  return data.tasks;
}

export async function getTask(id: string): Promise<Task> {
  const data = await apiGet<{ task: Task }>(`/api/tasks/${id}`);
  return data.task;
}

export async function createTask(input: NewTaskInput): Promise<Task> {
  const data = await apiPost<{ task: Task }>('/api/tasks', input);
  return data.task;
}

export async function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  const data = await apiPatch<{ task: Task }>(`/api/tasks/${id}`, patch);
  return data.task;
}

export function deleteTask(id: string): Promise<{ deleted: true }> {
  return apiDelete<{ deleted: true }>(`/api/tasks/${id}`);
}

const MS_PER_DAY = 86_400_000;

export function toDueDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseDueDay(day: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const date = Number(parts[3]);
  const at = new Date(year, month - 1, date);

  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== date) return null;
  return at.getTime();
}

export type DueChoice = 'today' | 'tomorrow' | 'weekend' | 'next-week';

export function resolveDueChoice(choice: DueChoice, now: number): string {
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  const weekday = date.getDay(); 
  if (choice === 'tomorrow') date.setDate(date.getDate() + 1);
  if (choice === 'weekend' && weekday !== 0 && weekday !== 6) {
    date.setDate(date.getDate() + (6 - weekday));
  }
  if (choice === 'next-week') date.setDate(date.getDate() + ((8 - weekday) % 7 || 7));
  return toDueDay(date.getTime());
}

export function daysUntil(at: number, now: number): number {
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof now !== 'number' || !Number.isFinite(now)) {
    return 0;
  }
  const target = new Date(at);
  const today = new Date(now);
  const a = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((a - b) / MS_PER_DAY);
}

export function isTaskLate(task: Task, now: number): boolean {
  if (!task.overdue || task.dueAt === null || typeof task.dueAt !== 'number' || !Number.isFinite(task.dueAt)) {
    return false;
  }
  return daysUntil(task.dueAt, now) < 0;
}

export type TaskGroupKey = 'late' | 'today' | 'soon' | 'later' | 'undated' | 'done';

export interface TaskGroup {
  key: TaskGroupKey;
  tasks: Task[];
}

export const SOON_DAYS = 7;

const GROUP_ORDER: readonly TaskGroupKey[] = ['late', 'today', 'soon', 'later', 'undated', 'done'];

export function taskGroupKey(task: Task, now: number): TaskGroupKey {
  if (task.doneAt !== null) return 'done';
  if (task.dueAt === null || typeof task.dueAt !== 'number' || !Number.isFinite(task.dueAt)) {
    return 'undated';
  }
  const days = daysUntil(task.dueAt, now);
  if (days < 0) return 'late';
  if (days === 0) return 'today';
  return days < SOON_DAYS ? 'soon' : 'later';
}

export function groupTasks(tasks: readonly Task[], now: number): TaskGroup[] {
  const buckets = new Map<TaskGroupKey, Task[]>();
  for (const task of tasks) {
    const key = taskGroupKey(task, now);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(task);
    else buckets.set(key, [task]);
  }
  return GROUP_ORDER.flatMap((key) => {
    const bucket = buckets.get(key);
    return bucket && bucket.length > 0 ? [{ key, tasks: bucket }] : [];
  });
}

export function matchesTaskQuery(task: Task, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [task.text, task.owner, task.meetingTitle, task.recordTitle].some((value) =>
    value ? value.toLocaleLowerCase().includes(needle) : false,
  );
}

export function taskSource(
  task: Task,
): { kind: 'meeting' | 'record'; id: string; title: string | null } | null {
  if (task.meetingId) return { kind: 'meeting', id: task.meetingId, title: task.meetingTitle };
  if (task.recordId) return { kind: 'record', id: task.recordId, title: task.recordTitle };
  return null;
}

export const DAYS_IN_WEEK = 7;

export const WEEK_STARTS_ON = 1;

export function calendarGrid(year: number, monthIndex: number): Array<number | null> {
  const lead = (new Date(year, monthIndex, 1).getDay() - WEEK_STARTS_ON + DAYS_IN_WEEK) % DAYS_IN_WEEK;

  const length = new Date(year, monthIndex + 1, 0).getDate();
  const cells: Array<number | null> = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= length; day += 1) cells.push(day);
  while (cells.length % DAYS_IN_WEEK !== 0) cells.push(null);
  return cells;
}

export function shiftMonth(year: number, monthIndex: number, by: number): { year: number; monthIndex: number } {
  const moved = new Date(year, monthIndex + by, 1);
  return { year: moved.getFullYear(), monthIndex: moved.getMonth() };
}
