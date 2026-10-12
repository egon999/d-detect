import { apiDelete, apiGet, apiPatch, apiPost, apiUpload } from './client';
import { appendUpload, uploadBytes, type UploadFile } from './files';

export type MeetingStatus = 'transcribing' | 'transcribed' | 'complete' | 'failed';

export type MeetingActionItem = {
  text: string;
  owner: string | null;
  priority: string | null;
  due: string | null;
  dueAt: number | null;
};

export type MeetingIntelligence = {
  topics?: string[];
  keyPoints?: string[];
  decisions?: string[];
  actionItems?: MeetingActionItem[];
  attention?: string[];

  sources?: Record<string, string>;
  language?: string | null;
};

export type MeetingTask = {
  id: string;
  text: string;
  owner: string | null;
  priority: string | null;
  dueAt: number | null;
  doneAt: number | null;
};

export type Meeting = {
  id: string;
  title: string;
  status: MeetingStatus;
  language: string | null;
  durationMs: number | null;
  startedAt: number | null;

  startedAtEstimated: boolean;

  note: string;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  fileId: string | null;
  summary: string | null;
  intelligence: MeetingIntelligence;
  tasks: MeetingTask[];
};

export type MeetingDetail = Meeting & { transcript: string | null };

export type StartMeetingOptions = { title?: string; durationMs?: number };

export function startMeeting(audio: UploadFile, options: StartMeetingOptions = {}): Promise<{ meeting: Meeting }> {
  const form = new FormData();
  appendUpload(form, 'audio', audio);
  if (options.title) form.append('title', options.title);
  if (typeof options.durationMs === 'number') form.append('durationMs', String(options.durationMs));

  return apiUpload<{ meeting: Meeting }>('/api/meetings', form, undefined, uploadBytes(audio));
}

export async function listMeetings(limit?: number): Promise<Meeting[]> {
  const data = await apiGet<{ meetings: Meeting[] }>('/api/meetings', { limit });
  return data.meetings;
}

export async function getMeeting(id: string): Promise<MeetingDetail> {
  const data = await apiGet<{ meeting: MeetingDetail }>(`/api/meetings/${id}`);
  return data.meeting;
}

export type MeetingEdit = {
  title?: string;
  note?: string;

  startedAt?: number;
};

export async function updateMeeting(id: string, patch: MeetingEdit): Promise<MeetingDetail> {
  const data = await apiPatch<{ meeting: MeetingDetail }>(`/api/meetings/${id}`, patch);
  return data.meeting;
}

export function renameMeeting(id: string, title: string): Promise<MeetingDetail> {
  return updateMeeting(id, { title });
}

export function deleteMeeting(id: string): Promise<{ deleted: true }> {
  return apiDelete<{ deleted: true }>(`/api/meetings/${id}`);
}

export async function retryMeeting(id: string): Promise<Meeting> {
  const data = await apiPost<{ meeting: Meeting }>(`/api/meetings/${id}/retry`);
  return data.meeting;
}

export type MeetingProgress = { status: MeetingStatus; error: string | null };

export function meetingInProgress(meeting: MeetingProgress): boolean {
  if (meeting.status === 'complete' || meeting.status === 'failed') return false;
  return meeting.error === null;
}

export function meetingStoppedPartway(meeting: MeetingProgress): boolean {
  return meeting.status !== 'complete' && meeting.status !== 'failed' && meeting.error !== null;
}

export function canRetryMeeting(meeting: Pick<Meeting, 'status'>): boolean {
  return meeting.status === 'failed' || meeting.status === 'transcribed';
}

export function meetingTroubleMessage(error: string | null | undefined, fallback: string): string {
  const said = (error ?? '').trim();
  if (said.length === 0 || said.length > 400) return fallback;

  if (!/^\p{Lu}/u.test(said) || !/[.!?]$/.test(said)) return fallback;

  if (/[{}<>[\]|]|::|\.\w{2,4}:\d|\berror\b|\bexception\b|\bundefined\b|\bnull\b|https?:\/\//.test(said)) {
    return fallback;
  }
  return said;
}

export function meetingHasNothingToShow(meeting: MeetingDetail): boolean {
  const found = meeting.intelligence;
  const lists = [
    found.decisions ?? [],
    found.keyPoints ?? [],
    found.topics ?? [],
    found.attention ?? [],
    found.actionItems ?? [],
  ];
  if (lists.some((list) => list.length > 0)) return false;
  if (meeting.tasks.length > 0) return false;
  if ((meeting.summary ?? '').trim().length > 0) return false;
  return (meeting.transcript ?? '').trim().length === 0;
}

export const MEETING_POLL_MIN_MS = 2_500;

const MEETING_POLL_STEPS: ReadonlyArray<{ after: number; every: number }> = [
  { after: 0, every: MEETING_POLL_MIN_MS },
  { after: 30_000, every: 6_000 },
  { after: 2 * 60_000, every: 15_000 },
  { after: 6 * 60_000, every: 30_000 },
];

export function meetingPollDelayMs(watchedMs: number): number {
  const watched = Number.isFinite(watchedMs) && watchedMs > 0 ? watchedMs : 0;
  let delay = MEETING_POLL_MIN_MS;
  for (const step of MEETING_POLL_STEPS) {
    if (watched >= step.after) delay = step.every;
  }
  return delay;
}

export const MEETING_WATCH_CEILING_MS = 20 * 60_000;

export function meetingWatchExpired(watchedMs: number): boolean {
  return Number.isFinite(watchedMs) && watchedMs >= MEETING_WATCH_CEILING_MS;
}

const UNDETERMINED_LANGUAGES = new Set([
  'und',
  'unk',
  'unknown',
  'mul',
  'mis',
  'zxx',
  'qaa',
  'xx',
  'none',
  'null',
  'n/a',
  'na',
]);

const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

export function languageDisplayName(
  value: string | null | undefined,
  locales?: string | string[],
): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return null;
  if (UNDETERMINED_LANGUAGES.has(trimmed.toLowerCase())) return null;
  if (!LANGUAGE_TAG.test(trimmed)) return trimmed;

  try {
    const named = new Intl.DisplayNames(locales, { type: 'language' }).of(trimmed);
    if (!named) return null;

    if (named.toLowerCase() === trimmed.toLowerCase()) return null;
    if (/^(root|unknown)\b/i.test(named)) return null;
    return named;
  } catch {
    return null;
  }
}

export function formatRecordingClock(ms: number | null | undefined): string {
  const totalSeconds = Number.isFinite(ms) && (ms ?? 0) > 0 ? Math.floor((ms as number) / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return hours > 0 ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}` : `${mm}:${String(seconds).padStart(2, '0')}`;
}

export function formatSpokenLength(ms: number | null | undefined): string | null {
  if (!Number.isFinite(ms) || (ms ?? 0) <= 0) return null;
  const totalMinutes = Math.round((ms as number) / 60_000);
  if (totalMinutes < 1) return 'Under a minute';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

export function meetingParagraphs(transcript: string | null | undefined): string[] {
  return (transcript ?? '')
    .split(/\n+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

export function meetingPassages(paragraphs: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...paragraphs];
  return paragraphs.filter((piece) => piece.toLowerCase().includes(needle));
}

export function meetingSourceQuery(
  paragraphs: readonly string[],
  finding: string,
  quote: string | null | undefined,
): string | null {
  for (const candidate of [quote ?? '', finding]) {
    const needle = candidate.trim();
    if (needle.length > 0 && meetingPassages(paragraphs, needle).length > 0) return needle;
  }
  return null;
}

export function meetingStartInputs(at: number): { date: string; time: string } {
  const when = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${pad(when.getDate())}/${pad(when.getMonth() + 1)}/${when.getFullYear()}`,
    time: `${pad(when.getHours())}:${pad(when.getMinutes())}`,
  };
}

export function parseMeetingStart(dateText: string, timeText = ''): number | null {
  const date = dateText.trim();
  if (date.length === 0) return null;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(date);
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(date);

  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (dmy) {
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    const rawYear = dmy[3] ?? '';
    year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  } else {
    return null;
  }

  let hours = 0;
  let minutes = 0;
  const time = timeText.trim();
  if (time.length > 0) {
    const clock = /^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i.exec(time);
    const bare = /^(\d{1,2})\s*(am|pm)$/i.exec(time);
    if (clock) {
      hours = Number(clock[1]);
      minutes = Number(clock[2]);
      const half = clock[3]?.toLowerCase();
      if (half) {
        if (hours < 1 || hours > 12) return null;
        hours = (hours % 12) + (half === 'pm' ? 12 : 0);
      }
    } else if (bare) {
      hours = Number(bare[1]);
      if (hours < 1 || hours > 12) return null;
      hours = (hours % 12) + ((bare[2] ?? '').toLowerCase() === 'pm' ? 12 : 0);
    } else {
      return null;
    }
    if (hours > 23 || minutes > 59) return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null;
  const at = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) return null;
  return at.getTime();
}

export interface MeetingTextFacts {
  when?: string | null;
  length?: string | null;
  language?: string | null;
}

function cleanLines(values: ReadonlyArray<string | null | undefined>): string[] {
  return values
    .map((value) => (value ?? '').trim())
    .filter((value) => value.length > 0);
}

export function meetingPlainText(meeting: MeetingDetail, facts: MeetingTextFacts = {}): string {
  const lines: string[] = [];
  lines.push(meeting.title.trim() || 'Meeting');

  const header = cleanLines([facts.when, facts.length, facts.language]);
  if (header.length > 0) lines.push(header.join(' · '));

  const note = meeting.note.trim();
  if (note.length > 0) lines.push('', note);

  const summary = (meeting.summary ?? '').trim();
  if (summary.length > 0) lines.push('', 'Summary', summary);

  const decisions = cleanLines(meeting.intelligence.decisions ?? []);
  if (decisions.length > 0) lines.push('', 'Decided', ...decisions.map((item) => `- ${item}`));

  if (meeting.tasks.length > 0) {
    lines.push(
      '',
      'To do',
      ...meeting.tasks.map((task) => `- ${task.text.trim()}${task.doneAt === null ? '' : ' (done)'}`),
    );
  }

  const keyPoints = cleanLines(meeting.intelligence.keyPoints ?? []);
  if (keyPoints.length > 0) lines.push('', 'Worth remembering', ...keyPoints.map((item) => `- ${item}`));

  const watch = cleanLines(meeting.intelligence.attention ?? []);
  if (watch.length > 0) lines.push('', 'Keep an eye on', ...watch.map((item) => `- ${item}`));

  return lines.join('\n');
}
