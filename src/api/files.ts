import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import {
  ApiError,
  UPLOAD_CANCELLED,
  apiUploadTracked,
  currentAuthHeaders,
  fileEndpoint,
  type TrackedUpload,
  type UploadProgress,
} from './client';
import type { DaybookRecord } from './daybook';
import type { Meeting } from './meetings';

export type { UploadProgress } from './client';

export type UploadFile = { uri: string; name: string; type: string; size?: number } | Blob;

export function appendUpload(form: FormData, field: string, file: UploadFile): void {
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    form.append(field, file);
    return;
  }
  form.append(field, file as unknown as Blob);
}

export function uploadBytes(file: UploadFile): number | null {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file.size;
  return typeof file.size === 'number' && file.size > 0 ? file.size : null;
}

const MEGABYTE = 1_048_576;

export const SAVE_SIZE_LIMIT_BYTES = 25 * MEGABYTE;
export const AUDIO_SIZE_LIMIT_BYTES = 96 * MEGABYTE;

export function tooLargeToSend(bytes: number | null, kind: 'save' | 'audio'): string | null {
  const limit = kind === 'audio' ? AUDIO_SIZE_LIMIT_BYTES : SAVE_SIZE_LIMIT_BYTES;
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0 || bytes <= limit) return null;
  const allowed = Math.round(limit / MEGABYTE);
  return kind === 'audio'
    ? `That audio is larger than ${allowed} MB, which is more than D-Detect can take in one go.`
    : `That file is larger than ${allowed} MB, which is more than D-Detect can take in one go. A photo of it usually works.`;
}

export function isUploadCancelled(error: unknown): boolean {
  return error instanceof ApiError && error.code === UPLOAD_CANCELLED;
}

export async function runTracked<T>(upload: TrackedUpload<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return upload.result;
  if (signal.aborted) upload.cancel();
  const stop = () => upload.cancel();
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await upload.result;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

export function trackedCapture(
  file: UploadFile,
  onProgress?: (progress: UploadProgress) => void,
): TrackedUpload<{ record: DaybookRecord }> {
  const form = new FormData();
  appendUpload(form, 'file', file);
  return sendTracked<{ record: DaybookRecord }>('/api/daybook/capture', form, file, onProgress);
}

export function trackedMeetingUpload(
  audio: UploadFile,
  options: { title?: string; durationMs?: number } = {},
  onProgress?: (progress: UploadProgress) => void,
): TrackedUpload<{ meeting: Meeting }> {
  const form = new FormData();
  appendUpload(form, 'audio', audio);

  if (options.title) form.append('title', options.title);
  if (typeof options.durationMs === 'number') form.append('durationMs', String(options.durationMs));
  return sendTracked<{ meeting: Meeting }>('/api/meetings', form, audio, onProgress);
}

function sendTracked<T>(
  path: string,
  form: FormData,
  file: UploadFile,
  onProgress?: (progress: UploadProgress) => void,
): TrackedUpload<T> {
  return apiUploadTracked<T>(path, form, {
    bytes: uploadBytes(file),

    ...(onProgress ? { onProgress } : {}),
  });
}

export type QueueItemState = 'waiting' | 'sending' | 'saved' | 'failed' | 'stopped';

export interface QueueItem {

  readonly id: string;

  readonly label: string;
  readonly bytes: number | null;
  readonly state: QueueItemState;

  readonly sent: number;

  readonly fraction: number | null;

  readonly error: string | null;
}

export interface QueueSnapshot {
  readonly items: readonly QueueItem[];
  readonly waiting: number;

  readonly saved: number;
  readonly failed: number;
  readonly stopped: number;

  readonly running: boolean;

  readonly finished: boolean;
}

export interface QueueEntry<P> {

  id?: string;
  label: string;
  bytes?: number | null;

  payload: P;
}

export type QueueSend<P, R> = (
  payload: P,
  handle: { onProgress: (progress: UploadProgress) => void; signal: AbortSignal },
) => Promise<R>;

export interface UploadQueueOptions<P, R> {
  send: QueueSend<P, R>;

  onChange?: (snapshot: QueueSnapshot) => void;

  onSaved?: (result: R, item: QueueItem) => void;

  describeError?: (error: unknown) => string;
}

export interface UploadQueue<P> {
  snapshot(): QueueSnapshot;

  add(entries: readonly QueueEntry<P>[]): void;

  start(): Promise<QueueSnapshot>;

  stop(id: string): void;

  stopAll(): void;

  retry(id: string): void;

  retryFailed(): void;
}

function defaultDescribeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'That could not be saved. Please try again.';
}

export function createUploadQueue<P, R>(
  entries: readonly QueueEntry<P>[],
  options: UploadQueueOptions<P, R>,
): UploadQueue<P> {
  interface Row {
    id: string;
    label: string;
    bytes: number | null;
    state: QueueItemState;
    sent: number;
    fraction: number | null;
    error: string | null;
    payload: P;
    controller: AbortController | null;
  }

  const describe = options.describeError ?? defaultDescribeError;
  const rows: Row[] = [];
  let running = false;

  let active: Promise<QueueSnapshot> | null = null;

  const makeRow = (entry: QueueEntry<P>, index: number): Row => ({
    id: entry.id ?? `item-${index + 1}`,
    label: entry.label,
    bytes: entry.bytes ?? null,
    state: 'waiting',
    sent: 0,
    fraction: null,
    error: null,
    payload: entry.payload,
    controller: null,
  });

  const toItem = (row: Row): QueueItem => ({
    id: row.id,
    label: row.label,
    bytes: row.bytes,
    state: row.state,
    sent: row.sent,
    fraction: row.fraction,
    error: row.error,
  });

  const snapshot = (): QueueSnapshot => {
    const items = rows.map(toItem);
    const count = (state: QueueItemState) => items.filter((item) => item.state === state).length;
    const waiting = count('waiting');
    const sending = count('sending');
    return {
      items,
      waiting,
      saved: count('saved'),
      failed: count('failed'),
      stopped: count('stopped'),
      running,
      finished: waiting === 0 && sending === 0,
    };
  };

  const emit = () => options.onChange?.(snapshot());

  const stateOf = (row: Row): QueueItemState => row.state;

  const requeue = (row: Row) => {
    row.state = 'waiting';
    row.sent = 0;
    row.fraction = null;
    row.error = null;
  };

  for (const [index, entry] of entries.entries()) rows.push(makeRow(entry, index));

  const run = async (): Promise<QueueSnapshot> => {

    if (active) return active;
    active = (async () => {
      running = true;
      emit();

      for (;;) {
        const row = rows.find((candidate) => candidate.state === 'waiting');
        if (!row) break;

        const controller = new AbortController();
        row.controller = controller;
        row.state = 'sending';
        row.sent = 0;
        row.fraction = null;
        row.error = null;
        emit();

        try {
          const result = await options.send(row.payload, {
            signal: controller.signal,
            onProgress: (progress) => {

              if (stateOf(row) !== 'sending') return;
              row.sent = progress.sent;
              row.fraction = progress.fraction;
              emit();
            },
          });
          row.controller = null;

          if (stateOf(row) !== 'sending') {
            emit();
            continue;
          }
          row.state = 'saved';
          row.fraction = 1;
          emit();
          options.onSaved?.(result, toItem(row));
        } catch (error) {
          row.controller = null;
          if (stateOf(row) === 'stopped' || isUploadCancelled(error)) {
            row.state = 'stopped';
            row.error = null;
            row.fraction = null;
            emit();
            continue;
          }
          row.state = 'failed';
          row.fraction = null;
          row.error = describe(error);
          emit();
        }
      }

      running = false;
      emit();
      return snapshot();
    })().finally(() => {
      active = null;
    });
    return active;
  };

  return {
    snapshot,
    add(more) {
      const base = rows.length;
      for (const [index, entry] of more.entries()) rows.push(makeRow(entry, base + index));
      emit();
    },
    start: run,
    stop(id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return;
      if (row.state === 'saved' || row.state === 'failed' || row.state === 'stopped') return;
      row.state = 'stopped';
      row.fraction = null;
      row.error = null;
      if (row.controller) {
        row.controller.abort();
        row.controller = null;
      }
      emit();
    },
    stopAll() {
      for (const row of rows) {
        if (row.state === 'waiting' || row.state === 'sending') {
          row.state = 'stopped';
          row.fraction = null;
          row.error = null;
          row.controller?.abort();
          row.controller = null;
        }
      }
      emit();
    },
    retry(id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || row.state !== 'failed') return;
      requeue(row);
      emit();
    },
    retryFailed() {
      for (const row of rows) {
        if (row.state !== 'failed') continue;
        requeue(row);
      }
      emit();
    },
  };
}

export const RECORD_TITLE_LIMIT = 120;
export const NOTE_LIMIT = 4_000;

export function titleFromNote(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const collapsed = (firstLine ?? text.trim()).replace(/\s+/g, ' ');
  if (collapsed.length <= RECORD_TITLE_LIMIT) return collapsed;
  const cut = collapsed.slice(0, RECORD_TITLE_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > RECORD_TITLE_LIMIT / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

export function formatRecordingLength(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
  return `${minutes}:${paddedSeconds}`;
}

export function spokenRecordingLength(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);

  if (hours === 0 && (seconds > 0 || minutes === 0)) {
    parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  }
  return parts.join(' ');
}

export const RECORDING_SOFT_LIMIT_MS = 45 * 60_000;
export const RECORDING_HARD_LIMIT_MS = 80 * 60_000;

export interface RecordingAdvice {

  level: 'long' | 'limit';
  message: string;
}

export function recordingAdvice(ms: number): RecordingAdvice | null {
  if (!Number.isFinite(ms) || ms < RECORDING_SOFT_LIMIT_MS) return null;
  if (ms >= RECORDING_HARD_LIMIT_MS) {
    return {
      level: 'limit',
      message: 'This is as long as one recording can be. Stop now and D-Detect will keep what you have.',
    };
  }
  return {
    level: 'long',
    message: 'This is a long one. It will take a while to send if your connection is slow.',
  };
}

export type AccessNeed = 'camera' | 'photos' | 'microphone';

export interface AccessStatus {
  granted: boolean;
  canAskAgain: boolean;
}

export type AccessDecision =
  | { kind: 'allowed' }

  | { kind: 'retry'; message: string; action: string }

  | { kind: 'settings'; message: string; action: string };

const ACCESS_COPY: Record<AccessNeed, { retry: string; settings: string }> = {
  camera: {
    retry: 'D-Detect needs the camera to take a photo of this.',
    settings: 'The camera is switched off for D-Detect. You can turn it back on in your phone settings.',
  },
  photos: {
    retry: 'D-Detect needs to see your photos to add one.',
    settings: 'Your photos are switched off for D-Detect. You can turn them back on in your phone settings.',
  },
  microphone: {
    retry: 'D-Detect needs the microphone to record a meeting.',
    settings: 'The microphone is switched off for D-Detect. You can turn it back on in your phone settings.',
  },
};

export function decideAccess(need: AccessNeed, status: AccessStatus): AccessDecision {
  if (status.granted) return { kind: 'allowed' };
  const copy = ACCESS_COPY[need];
  if (status.canAskAgain) return { kind: 'retry', message: copy.retry, action: 'Try again' };
  return { kind: 'settings', message: copy.settings, action: 'Open settings' };
}

export type FileSource = { uri: string; headers?: Record<string, string> };

export interface FileSourceState {
  source: FileSource | null;

  failed: boolean;

  isMissing: boolean;

  error: ApiError | null;
}

const FILE_SOURCE_IDLE: FileSourceState = { source: null, failed: false, isMissing: false, error: null };

function fileSourceFailure(cause: unknown): FileSourceState {
  const error = cause instanceof ApiError ? cause : new ApiError(0, '', null, null);
  return { source: null, failed: true, isMissing: error.isMissing, error };
}

async function fetchFileBytes(endpoint: string, signal?: AbortSignal): Promise<Response> {
  const send = (headers: Record<string, string>) => fetch(endpoint, { headers, signal });
  const first = await send(await currentAuthHeaders());
  if (first.ok) return first;
  if (first.status !== 401 && first.status !== 403) throw new ApiError(first.status, '', null, null);

  const second = await send(await currentAuthHeaders(true));
  if (second.ok) return second;
  throw new ApiError(second.status, '', null, null);
}

export function useFileSource(fileId: string | null | undefined): FileSourceState {
  const [state, setState] = useState<FileSourceState>(FILE_SOURCE_IDLE);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    const controller = new AbortController();

    if (!fileId) {
      setState(FILE_SOURCE_IDLE);
      return;
    }

    setState(FILE_SOURCE_IDLE);
    const endpoint = fileEndpoint(fileId);

    if (Platform.OS === 'web') {
      void (async () => {
        try {
          const response = await fetchFileBytes(endpoint, controller.signal);
          const blob = await response.blob();
          if (!active) return;
          objectUrl = URL.createObjectURL(blob);
          setState({ source: { uri: objectUrl }, failed: false, isMissing: false, error: null });
        } catch (cause) {

          if (active) setState(fileSourceFailure(cause));
        }
      })();
    } else {
      void (async () => {
        try {

          const headers = await currentAuthHeaders();
          if (active) setState({ source: { uri: endpoint, headers }, failed: false, isMissing: false, error: null });
        } catch (cause) {
          if (active) setState(fileSourceFailure(cause));
        }
      })();
    }

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId]);

  return state;
}
