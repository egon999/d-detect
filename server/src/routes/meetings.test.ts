import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'detact-meetings-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';

process.env.DETACT_RATE_LIMITS = 'off';

process.env.DEV_ALLOW_DEVICE_IDENTITY = 'true';
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

const { db, ensureUser } = await import('../db.ts');
const { app } = await import('../app.ts');
const { collectAllOrphanFiles, fileBytes, storeUpload } = await import('../files.ts');
const { recoverStaleMeetings } = await import('./meetings.ts');

const DEVICE = 'devicetest01';
const OWNER = `device:${DEVICE}`;

type ChatBody = { messages?: Array<{ role: string; content: string }> };
type Segment = { bytes: Uint8Array; name: string };

let sent: Segment[] = [];
let prompts: string[] = [];

let hear: (segment: Segment, index: number) => string | null = () => null;
let read: (body: ChatBody) => Promise<unknown> | unknown = () => {
  throw new Error('This test did not authorize a model call.');
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);

  if (url.includes('/audio/transcriptions')) {
    const form = init?.body;
    assert.ok(form instanceof FormData, 'The audio has to be sent as multipart form data.');
    const part = form.get('file');
    assert.ok(part instanceof Blob, 'The audio has to be sent as a file part.');
    const segment: Segment = {
      bytes: new Uint8Array(await part.arrayBuffer()),
      name: part instanceof File ? part.name : '',
    };
    const index = sent.length;
    sent.push(segment);
    const text = hear(segment, index);
    if (text === null) return new Response('the model is warming up', { status: 503 });
    return Response.json({ text, language: 'hindi' });
  }

  assert.ok(url.includes('/chat/completions'), `Unexpected network call: ${url}`);
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as ChatBody) : {};
  const system = body.messages?.find((message) => message.role === 'system');
  if (system) prompts.push(system.content);
  return Response.json({ choices: [{ message: { content: JSON.stringify(await read(body)) } }] });
};

beforeEach(() => {
  db.exec('DELETE FROM jobs; DELETE FROM signals; DELETE FROM signal_scans; DELETE FROM cases; DELETE FROM meetings; DELETE FROM records; DELETE FROM tasks; DELETE FROM budgets; DELETE FROM files; DELETE FROM users;');
  ensureUser(OWNER, null, null);
  sent = [];
  prompts = [];
  hear = () => null;
  read = () => { throw new Error('This test did not authorize a model call.'); };
});

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-meetings-'));
  rmSync(target, { recursive: true, force: true });
});

const MP3_FRAME_BYTES = 417;
const MP3_FRAME_MS = (1152 * 1000) / 44_100;

function mp3Bytes(frames: number): Uint8Array {
  const out = new Uint8Array(frames * MP3_FRAME_BYTES);
  for (let index = 0; index < frames; index += 1) {
    const at = index * MP3_FRAME_BYTES;
    out[at] = 0xff;
    out[at + 1] = 0xfb;
    out[at + 2] = 0x90;
  }
  return out;
}

const WAV_BYTE_RATE = 16_000;

function wavBytes(dataBytes: number): Uint8Array {
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const write = (at: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) out[at + index] = text.charCodeAt(index);
  };
  write(0, 'RIFF');
  view.setUint32(4, out.byteLength - 8, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); 
  view.setUint16(22, 1, true); 
  view.setUint32(24, 8_000, true);
  view.setUint32(28, WAV_BYTE_RATE, true);
  view.setUint16(32, 2, true); 
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  return out;
}

function wavData(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => new TextDecoder('latin1').decode(bytes.subarray(at, at + 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(view.getUint32(4, true), bytes.byteLength - 8, 'A segment overstates its own length.');
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === 'data') {
      assert.equal(at + 8 + size, bytes.byteLength, 'A segment declares more audio than it carries.');
      return bytes.subarray(at + 8, at + 8 + size);
    }
    at += 8 + size + (size % 2);
  }
  assert.fail('A segment has no data chunk.');
}

const ONE_REQUEST = 24 * 1024 * 1024;

type Meeting = {
  id: string;
  title: string;
  status: string;
  language: string | null;
  durationMs: number | null;
  startedAt: number;
  startedAtEstimated: boolean;
  note: string;
  createdAt: number;
  error: string | null;
  fileId: string | null;
  summary: string | null;
  transcript: string | null;
  intelligence: {
    topics?: string[];
    keyPoints?: string[];
    decisions?: string[];
    attention?: string[];
    actionItems?: Array<{ text: string; due: string | null; dueAt: number | null; fingerprint?: string }>;
  };
  tasks: Array<{ id: string; text: string; owner: string | null; priority: string; dueAt: number | null; doneAt: number | null }>;
};

type Body = { meeting: Meeting; task: { id: string }; error: string; duplicate?: boolean };

async function send(path: string, method = 'GET', body?: unknown, device = DEVICE) {
  const form = body instanceof FormData;
  const response = await app.request(`/api${path}`, {
    method,
    headers: { 'x-device-id': device, ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}) },
    body: form ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

function upload(bytes: Uint8Array, name: string, mime: string, durationMs?: number): FormData {
  const form = new FormData();
  form.set('audio', new File([bytes], name, { type: mime }));
  if (durationMs !== undefined) form.set('durationMs', String(durationMs));
  return form;
}

async function eventually(predicate: () => boolean, what = 'Background work') {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`${what} did not settle within eight seconds.`);
}

function jobFinished() {
  return (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status NOT IN ('done', 'failed', 'cancelled')").get() as { n: number }).n === 0;
}

function statusOf(meetingId: string): string {
  return (db.prepare('SELECT status FROM meetings WHERE id = ?').get(meetingId) as { status: string }).status;
}

function row(meetingId: string) {
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) as {
    status: string;
    error: string | null;
    transcript: string | null;
    duration_ms: number | null;
    started_at: number;
    started_at_estimated: number;
    note: string;
    summary: string | null;
  };
}

function job(meetingId: string) {
  return db
    .prepare('SELECT status, detail FROM jobs WHERE subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(meetingId) as { status: string; detail: string | null } | undefined;
}

function plainLanguage(said: string | null, what: string): void {
  assert.ok(said && said.trim().length > 0, `${what} left the person with no explanation.`);
  const words = said ?? '';
  for (const developerish of [
    /\bundefined\b/i,
    /\bnull\b/i,
    /\berror:/i,
    /\bexception\b/i,
    /\bat\s+\w+\s*\(/,
    /[/\\](?:src|node_modules)[/\\]/,
    /\.(?:ts|js|json)\b/,
    /\b(?:ZodError|HTTPException|SQLITE|fetch failed)\b/i,
    /\b[45]\d{2}\b/,
    /[{}[\]<>]/,
    /\b(?:file_id|user_id|meeting_id|started_at|due_at|fingerprint|transcript_id)\b/,
    /\bmtg_|\bjob_|\bfile_|\btask_/,
  ]) {
    assert.ok(!developerish.test(words), `${what} showed the person developer vocabulary: ${words}`);
  }

  assert.ok(/[.!?]$/.test(words.trim()), `${what} is not a sentence: ${words}`);
}

const SPOKEN = {
  receipt: 'प्रिया: रसीद मैं शुक्रवार तक भेज दूँगी।',
  hall: 'अरुण: हॉल की बुकिंग मैं देख लेता हूँ।',
  minutes: 'रवि: मीटिंग के मिनट्स सबको भेजने हैं।',
  auditor: 'प्रिया: ऑडिटर को फ़ोन करना अभी बाकी है।',
  invoice: 'अरुण: इनवॉइस 2026-09-30 तक मंज़ूर हो जाएगा।',
  quarter: 'रवि: बाकी काम ऑडिट के बाद अगली तिमाही में देखेंगे।',
};

const TRANSCRIPT = Object.values(SPOKEN).join('\n');

function seedMeeting(
  options: {
    transcript?: string;
    startedAt?: number;
    startedAtEstimated?: boolean;
    status?: string;
    intelligence?: unknown;
    fileId?: string | null;
  } = {},
): string {
  const id = 'mtg_seeded';
  const now = Date.now();
  db.prepare(
    `INSERT INTO meetings (id, user_id, title, file_id, transcript, language, intelligence, status, error,
       started_at, started_at_estimated, created_at, updated_at)
     VALUES (?, ?, 'Meeting', ?, ?, 'Hindi', ?, ?, 'The model was unavailable.', ?, ?, ?, ?)`,
  ).run(
    id,
    OWNER,
    options.fileId ?? null,
    options.transcript ?? TRANSCRIPT,
    JSON.stringify(options.intelligence ?? {}),
    options.status ?? 'transcribed',
    options.startedAt ?? now,
    options.startedAtEstimated ? 1 : 0,
    now,
    now,
  );
  return id;
}

function intelligence(
  actionItems: Array<Record<string, unknown>> = [],
  extra: Record<string, unknown> = {},
) {
  return {
    title: 'साप्ताहिक समीक्षा',
    summary: 'टीम ने रसीद और बजट पर बात की।',
    language: 'Hindi',
    topics: ['रसीद'],
    keyPoints: [],
    decisions: [],
    attention: [],
    actionItems,
    ...extra,
  };
}

test('a recording that fits in one request is sent whole and its length is measured, not assumed', async () => {
  const bytes = mp3Bytes(400);
  hear = () => 'दस मिनट की बातचीत';
  read = () => intelligence();

  const created = await send('/meetings', 'POST', upload(bytes, 'meeting.mp3', 'audio/mpeg'));
  assert.equal(created.status, 202);
  await eventually(jobFinished);

  assert.equal(sent.length, 1, 'A short recording must not be split.');
  assert.equal(sent[0]?.bytes.byteLength, bytes.byteLength);

  const meeting = (await send(`/meetings/${created.body.meeting.id}`)).body.meeting;
  assert.equal(meeting.status, 'complete');
  assert.equal(meeting.durationMs, Math.round(400 * MP3_FRAME_MS));

  assert.equal(meeting.startedAt, meeting.createdAt - (meeting.durationMs ?? 0));
  assert.equal(meeting.title, 'साप्ताहिक समीक्षा');
  assert.equal(meeting.language, 'Hindi');
});

test('an mp3 too large for one request is transcribed in ordered segments with nothing dropped', async () => {

  const frames = 60_400;
  const bytes = mp3Bytes(frames);
  assert.ok(bytes.byteLength > ONE_REQUEST);

  hear = (_segment, index) => `भाग ${index + 1}`;
  read = () => intelligence();

  const created = await send('/meetings', 'POST', upload(bytes, 'long meeting.mp3', 'audio/mpeg'));
  assert.equal(created.status, 202);
  await eventually(jobFinished);

  assert.equal(sent.length, 2);
  for (const segment of sent) {
    assert.ok(segment.bytes.byteLength <= ONE_REQUEST, 'A segment was larger than one Whisper request.');

    assert.equal(segment.bytes[0], 0xff);
    assert.equal(segment.bytes[1], 0xfb);
    assert.equal(segment.bytes.byteLength % MP3_FRAME_BYTES, 0);
    assert.ok(segment.name.endsWith('.mp3'), 'Whisper needs a filename it recognises.');
  }

  const joined = Buffer.concat(sent.map((segment) => Buffer.from(segment.bytes)));
  assert.equal(joined.byteLength, bytes.byteLength);
  assert.ok(joined.equals(Buffer.from(bytes)), 'The segments do not add back up to the recording.');

  const meeting = (await send(`/meetings/${created.body.meeting.id}`)).body.meeting;
  assert.equal(meeting.status, 'complete');
  assert.equal(meeting.transcript, 'भाग 1\nभाग 2', 'The transcript must be every segment, in order.');
  assert.equal(meeting.durationMs, Math.round(frames * MP3_FRAME_MS));
});

test('a long wav is split into whole riff files and measured from its own header', async () => {
  const dataBytes = WAV_BYTE_RATE * 1_600;
  const bytes = wavBytes(dataBytes);
  assert.ok(bytes.byteLength > ONE_REQUEST);

  hear = (_segment, index) => `hissa ${index + 1}`;
  read = () => intelligence();

  const created = await send('/meetings', 'POST', upload(bytes, 'meeting.wav', 'audio/wav', 90_000));
  assert.equal(created.status, 202);
  await eventually(jobFinished);

  assert.equal(sent.length, 2);
  let carried = 0;
  for (const segment of sent) {
    assert.ok(segment.bytes.byteLength <= ONE_REQUEST);
    carried += wavData(segment.bytes).byteLength;
  }
  assert.equal(carried, dataBytes, 'The segments carry less audio than was uploaded.');

  const meeting = (await send(`/meetings/${created.body.meeting.id}`)).body.meeting;

  assert.equal(meeting.durationMs, 1_600_000);
  assert.equal(meeting.transcript, 'hissa 1\nhissa 2');
});

test('one failed segment leaves no partial transcript and a state the person can act on', async () => {
  const bytes = mp3Bytes(60_400);
  hear = (_segment, index) => (index === 0 ? 'पहला भाग' : null);

  const created = await send('/meetings', 'POST', upload(bytes, 'meeting.mp3', 'audio/mpeg'));
  const id = created.body.meeting.id;
  await eventually(jobFinished);

  assert.equal(sent.length, 2, 'The second segment has to have been attempted.');
  const stored = row(id);
  assert.equal(stored.status, 'failed');
  assert.ok((stored.error ?? '').length > 0, 'A failure the person can read has to be recorded.');
  assert.equal(stored.transcript, null, 'Half a meeting must never be stored as the meeting.');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0);

  hear = (_segment, index) => `भाग ${index + 1}`;
  read = () => intelligence();
  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);
  assert.equal(statusOf(id), 'complete');
});

test('a recording no splitter can divide is refused with the real limit and nothing is kept', async () => {

  const bytes = new Uint8Array(25 * 1024 * 1024);
  const response = await send('/meetings', 'POST', upload(bytes, 'meeting.m4a', 'audio/m4a'));

  assert.equal(response.status, 413);
  assert.match(response.body.error, /24 MB/, 'The refusal has to quote the limit that was hit.');
  assert.match(response.body.error, /MP3/, 'The refusal has to say what would work instead.');
  assert.equal(sent.length, 0, 'Nothing should have been sent to Whisper.');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n, 0);
});

test('an oversized body is refused against the limit its own route enforces', async () => {
  const declared = async (path: string, length: number) => {
    const response = await app.request(`/api${path}`, {
      method: 'POST',
      headers: { 'x-device-id': DEVICE, 'content-length': String(length) },
      body: 'x',
    });
    return { status: response.status, error: ((await response.json()) as Body).error };
  };

  const meeting = await declared('/meetings', 200 * 1024 * 1024);
  assert.equal(meeting.status, 413);
  assert.match(meeting.error, /96 MB/);

  const capture = await declared('/daybook/capture', 40 * 1024 * 1024);
  assert.equal(capture.status, 413);
  assert.match(capture.error, /25 MB/);
});

test('a meeting being read says it has been transcribed, never that it is transcribing', async () => {
  let finish!: (value: unknown) => void;
  hear = () => 'प्रिया रसीद भेजेंगी';
  read = () => new Promise((done) => { finish = done; });

  const created = await send('/meetings', 'POST', upload(mp3Bytes(400), 'meeting.mp3', 'audio/mpeg'));
  const id = created.body.meeting.id;

  await eventually(() => statusOf(id) === 'transcribed', 'Transcription');
  const waiting = row(id);
  assert.equal(waiting.error, null);
  assert.ok((waiting.transcript ?? '').length > 0, 'The transcript is saved before it is read.');

  finish(intelligence());
  await eventually(jobFinished);
  assert.equal(statusOf(id), 'complete');
});

test('analysis failing after transcription leaves the words, an error and a way forward', async () => {
  hear = () => 'प्रिया रसीद भेजेंगी';
  read = () => { throw new Error('the model is down'); };

  const created = await send('/meetings', 'POST', upload(mp3Bytes(400), 'meeting.mp3', 'audio/mpeg'));
  const id = created.body.meeting.id;
  await eventually(jobFinished);

  const stored = row(id);
  assert.equal(stored.status, 'transcribed');
  assert.ok((stored.error ?? '').length > 0);
  assert.ok((stored.transcript ?? '').length > 0, 'Transcription succeeded, so its result is kept.');

  const before = sent.length;
  read = () => intelligence();
  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);
  assert.equal(statusOf(id), 'complete');
  assert.equal(sent.length, before, 'A second Whisper call was made for a transcript already held.');
});

test('a failure from an abandoned run cannot put a finished meeting back behind a spinner', async () => {
  const id = seedMeeting();

  const waiting: Array<(reason: unknown) => void> = [];
  let collapsed = false;
  read = () => new Promise((_done, reject) => {
    if (collapsed) reject(new Error('the model gave up'));
    else waiting.push(reject);
  });

  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(() => waiting.length > 0, 'The analysis call');

  db.prepare("UPDATE meetings SET status = 'complete', error = NULL WHERE id = ?").run(id);
  collapsed = true;
  for (const reject of waiting) reject(new Error('the model gave up'));
  await eventually(jobFinished);

  const stored = row(id);
  assert.equal(stored.status, 'complete', 'A late failure moved a finished meeting backwards.');
  assert.equal(stored.error, null);
});

test('a restart leaves no meeting in a state the client would poll forever', async () => {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO meetings (id, user_id, title, transcript, intelligence, status, error, started_at, created_at, updated_at)
     VALUES (?, ?, 'Meeting', ?, '{}', ?, NULL, ?, ?, ?)`,
  );
  insert.run('mtg_words', OWNER, 'कुछ कहा गया', 'transcribing', now, now, now);
  insert.run('mtg_silent', OWNER, null, 'transcribing', now, now, now);
  insert.run('mtg_midread', OWNER, 'कुछ कहा गया', 'transcribed', now, now, now);
  insert.run('mtg_done', OWNER, 'कुछ कहा गया', 'complete', now, now, now);
  db.prepare(
    "INSERT INTO jobs (id, user_id, kind, subject_id, status, created_at, updated_at) VALUES ('job_stale', ?, 'meeting', 'mtg_words', 'transcribing', ?, ?)",
  ).run(OWNER, now, now);

  assert.equal(recoverStaleMeetings(), 3);

  assert.equal(statusOf('mtg_words'), 'transcribed');
  assert.equal(statusOf('mtg_silent'), 'failed');
  assert.equal(statusOf('mtg_midread'), 'transcribed');
  for (const id of ['mtg_words', 'mtg_silent', 'mtg_midread']) {
    assert.ok((row(id).error ?? '').length > 0, `${id} was left with no explanation.`);
  }

  assert.equal(statusOf('mtg_done'), 'complete');
  assert.equal(row('mtg_done').error, null);
  assert.equal((await send('/meetings/mtg_done/retry', 'POST')).status, 400);

  assert.equal(jobFinished(), true, 'The job the client reads its progress from is still running.');
  const stale = db.prepare("SELECT detail FROM jobs WHERE id = 'job_stale'").get() as { detail: string | null };
  assert.ok((stale.detail ?? '').length > 0);
});

test('a recording with nothing audible and one too quiet to make out are told apart', async () => {

  hear = () => '';
  const silent = (await send('/meetings', 'POST', upload(mp3Bytes(400), 'silence.mp3', 'audio/mpeg'))).body.meeting.id;
  await eventually(jobFinished);

  const nothing = row(silent);
  assert.equal(nothing.status, 'failed');
  plainLanguage(nothing.error, 'A recording with nothing audible in it');
  assert.match(nothing.error ?? '', /plays back/, 'The first thing to check is whether the file plays.');
  assert.equal(nothing.transcript, null, 'Nothing audible is not a transcript.');

  assert.equal(job(silent)?.status, 'failed');
  assert.ok((job(silent)?.detail ?? '').length > 0);
  assert.notEqual(job(silent)?.detail, nothing.error);

  db.exec('DELETE FROM jobs; DELETE FROM meetings;');
  hear = () => ' ... ';
  const quiet = (await send('/meetings', 'POST', upload(mp3Bytes(400), 'faint.mp3', 'audio/mpeg'))).body.meeting.id;
  await eventually(jobFinished);

  const faint = row(quiet);
  assert.equal(faint.status, 'failed');
  plainLanguage(faint.error, 'A recording too quiet to make out');
  assert.match(faint.error ?? '', /too quiet/);
  assert.match(faint.error ?? '', /closer/, 'The next move is to get nearer the people speaking.');
  assert.notEqual(faint.error, nothing.error, 'Two different problems were given the same sentence.');
  assert.equal(faint.transcript, null, 'Punctuation was stored as somebody’s transcript.');

  assert.match(job(quiet)?.detail ?? '', /\.\.\./);

  hear = () => TRANSCRIPT;
  read = () => intelligence([
    { text: 'रसीद भेजना', owner: 'प्रिया', priority: 'high', due: null, dueDate: null, quote: SPOKEN.receipt },
  ]);
  assert.equal((await send(`/meetings/${quiet}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);
  assert.equal(statusOf(quiet), 'complete');
  assert.equal(row(quiet).error, null);
});

test('a meeting with no recording, and one whose recording is gone, each say which', async () => {

  const none = seedMeeting({ transcript: '', status: 'failed', fileId: null });
  assert.equal((await send(`/meetings/${none}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const missing = row(none);
  assert.equal(missing.status, 'failed');
  plainLanguage(missing.error, 'A meeting with no recording');
  assert.match(missing.error ?? '', /no recording/);
  assert.equal(sent.length, 0, 'There was nothing to send to the transcriber.');

  assert.equal(job(none)?.status, 'failed');
  assert.match(job(none)?.detail ?? '', new RegExp(none));

  db.exec('DELETE FROM jobs; DELETE FROM meetings;');
  const stored = storeUpload(OWNER, mp3Bytes(400), 'audio/mpeg', 'meeting.mp3');
  const gone = seedMeeting({ transcript: '', status: 'failed', fileId: stored.id });
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM files WHERE id = ?').run(stored.id);
  db.pragma('foreign_keys = ON');

  assert.equal((await send(`/meetings/${gone}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const lost = row(gone);
  assert.equal(lost.status, 'failed');
  plainLanguage(lost.error, 'A meeting whose recording is gone');
  assert.match(lost.error ?? '', /no longer saved/);
  assert.notEqual(lost.error, missing.error, 'Two different problems were given the same sentence.');
  assert.equal(sent.length, 0);

  assert.match(job(gone)?.detail ?? '', new RegExp(stored.id));
});

test('a recording the disk refuses to take says so without naming the disk', async () => {

  const empty = await send('/meetings', 'POST', upload(new Uint8Array(0), 'meeting.mp3', 'audio/mpeg'));
  assert.equal(empty.status, 400);
  plainLanguage(empty.body.error, 'An empty recording');
  assert.match(empty.body.error, /recording/i, 'An empty upload was not answered as a recording.');
  assert.doesNotMatch(
    empty.body.error,
    /screenshot|photo|image|document/i,
    'A meeting recording was answered as if it were a different kind of file.',
  );

  const owner = resolve(directory, 'files', createHash('sha256').update(OWNER).digest('hex'));
  rmSync(owner, { recursive: true, force: true });
  writeFileSync(owner, 'not a directory');
  try {
    const refused = await send('/meetings', 'POST', upload(mp3Bytes(400), 'meeting.mp3', 'audio/mpeg'));
    assert.equal(refused.status, 400, 'Storing the recording was expected to fail and did not.');
    plainLanguage(refused.body.error, 'A recording the disk refused');
    assert.ok(!refused.body.error.includes(directory), 'A path on the server reached the app.');
    assert.ok(!/E[A-Z]{4,}/.test(refused.body.error), 'A system error code reached the app.');

    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n, 0);
  } finally {
    rmSync(owner, { force: true });
  }
});

test('a provider failing says one plain sentence and keeps its own words to the job row', async () => {
  const id = seedMeeting();

  read = () => {
    throw new Error(
      '429 {"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile`","type":"tokens"}}\n' +
        '    at Object.chat (E:\\Project Evid\\detact\\server\\src\\ai\\providers.ts:214:11)',
    );
  };

  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const stored = row(id);
  assert.equal(stored.status, 'transcribed', 'The words survived, so the meeting stands at transcribed.');
  plainLanguage(stored.error, 'A provider failure');
  assert.match(stored.error ?? '', /try reading it again/i);
  assert.equal(stored.transcript, TRANSCRIPT, 'The words already paid for are kept.');

  assert.match(job(id)?.detail ?? '', /429/);
  assert.match(job(id)?.detail ?? '', /llama-3\.3-70b-versatile/);
  assert.ok(!(stored.error ?? '').includes('429'));
  assert.ok(!(stored.error ?? '').includes('llama'));
  assert.ok(!(stored.error ?? '').includes('providers.ts'));
});

test('a deadline becomes a date only when the transcript pinned it to one day', async () => {

  const heldOn = new Date(2026, 8, 25, 10, 0).getTime();
  const id = seedMeeting({ startedAt: heldOn });

  read = () => intelligence([
    { text: 'रसीद भेजना', owner: 'प्रिया', priority: 'high', due: 'शुक्रवार तक', dueDate: '2026-10-02', quote: SPOKEN.receipt },
    { text: 'हॉल बुक करना', owner: null, priority: 'normal', due: '2026-09-30', quote: SPOKEN.hall },
    { text: 'ऑडिट के बाद देखना', owner: null, priority: 'low', due: 'अगली तिमाही', dueDate: null, quote: SPOKEN.quarter },
  ]);

  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const meeting = (await send(`/meetings/${id}`)).body.meeting;
  const dueOf = (text: string) => meeting.tasks.find((task) => task.text === text)?.dueAt;
  assert.equal(dueOf('रसीद भेजना'), new Date(2026, 9, 2, 23, 59, 59, 999).getTime());

  assert.equal(dueOf('हॉल बुक करना'), new Date(2026, 8, 30, 23, 59, 59, 999).getTime());

  assert.equal(dueOf('ऑडिट के बाद देखना'), null);

  const items = meeting.intelligence.actionItems ?? [];
  assert.equal(items.find((item) => item.text === 'ऑडिट के बाद देखना')?.due, 'अगली तिमाही');
  assert.equal(items.find((item) => item.text === 'रसीद भेजना')?.due, 'शुक्रवार तक');

  assert.ok(prompts.length > 0);
  assert.match(prompts[0] ?? '', /2026-09-25/);
  assert.match(prompts[0] ?? '', /Friday/);
});

test('a start time this server worked out anchors no spoken deadline', async () => {

  const heldOn = new Date(2026, 8, 25, 10, 0).getTime();
  const id = seedMeeting({ startedAt: heldOn, startedAtEstimated: true });

  read = () => intelligence([

    { text: 'रसीद भेजना', owner: 'प्रिया', priority: 'high', due: 'शुक्रवार तक', dueDate: '2026-10-02', quote: SPOKEN.receipt },

    { text: 'इनवॉइस मंज़ूर करना', owner: 'अरुण', priority: 'normal', due: '2026-09-30', quote: SPOKEN.invoice },
  ]);

  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const meeting = (await send(`/meetings/${id}`)).body.meeting;
  assert.equal(meeting.status, 'complete');
  assert.equal(meeting.startedAtEstimated, true, 'The app has to be able to ask rather than state.');

  const task = (text: string) => meeting.tasks.find((entry) => entry.text === text);
  assert.equal(task('रसीद भेजना')?.dueAt, null, 'A guessed start time resolved a spoken deadline.');
  assert.equal(task('इनवॉइस मंज़ूर करना')?.dueAt, new Date(2026, 8, 30, 23, 59, 59, 999).getTime());

  const items = meeting.intelligence.actionItems ?? [];
  assert.equal(items.find((item) => item.text === 'रसीद भेजना')?.due, 'शुक्रवार तक');
  assert.equal(items.find((item) => item.text === 'रसीद भेजना')?.dueAt, null);

  assert.ok(prompts.length > 0);
  assert.doesNotMatch(prompts[0] ?? '', /2026-09-25/, 'A derived date was handed to the model as fact.');
  assert.match(prompts[0] ?? '', /not known/, 'The model has to be told there is no day.');
});

test('correcting the start time makes it a fact, and the next reading may count from it', async () => {
  const id = seedMeeting({ startedAt: new Date(2026, 8, 25, 10, 0).getTime(), startedAtEstimated: true });
  assert.equal(row(id).started_at_estimated, 1);

  const corrected = new Date(2026, 7, 14, 15, 30).getTime();
  const patched = await send(`/meetings/${id}`, 'PATCH', {
    startedAt: corrected,
    title: 'रसीद वाली मीटिंग',
    note: 'सोसाइटी के ऑडिट पर बात हुई',
  });

  assert.equal(patched.status, 200);

  assert.equal(patched.body.meeting.startedAt, corrected);
  assert.equal(patched.body.meeting.startedAtEstimated, false, 'A date the person gave is a fact.');
  assert.equal(patched.body.meeting.title, 'रसीद वाली मीटिंग');
  assert.equal(patched.body.meeting.note, 'सोसाइटी के ऑडिट पर बात हुई');
  assert.equal(patched.body.meeting.transcript, TRANSCRIPT);
  assert.equal(row(id).started_at_estimated, 0);

  read = () => intelligence([
    { text: 'रसीद भेजना', owner: 'प्रिया', priority: 'high', due: 'शुक्रवार तक', dueDate: '2026-08-21', quote: SPOKEN.receipt },
  ]);
  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const meeting = (await send(`/meetings/${id}`)).body.meeting;
  assert.equal(meeting.tasks[0]?.dueAt, new Date(2026, 7, 21, 23, 59, 59, 999).getTime());
  assert.match(prompts[0] ?? '', /2026-08-14/, 'The corrected day is what the model counts from.');
});

test('a correction is only ever those three things, and is refused in plain words otherwise', async () => {
  const id = seedMeeting();

  const refused = async (body: unknown) => {
    const response = await send(`/meetings/${id}`, 'PATCH', body);
    assert.equal(response.status, 400, `This should have been refused: ${JSON.stringify(body)}`);
    plainLanguage(response.body.error, 'A refused correction');
    return response.body.error;
  };

  await refused({ status: 'complete' });
  await refused({ summary: 'कुछ और' });
  await refused({ transcript: 'कुछ और' });

  await refused({ startedAt: Date.now() + 40 * 24 * 60 * 60_000 });

  await refused({ startedAt: Math.floor(Date.now() / 1000) });
  await refused({ startedAt: 'शुक्रवार' });
  await refused({ title: '' });
  await refused({ note: 'क'.repeat(2_001) });
  await refused({});

  const unchanged = row(id);
  assert.equal(unchanged.note, '');
  assert.equal(unchanged.status, 'transcribed');
  assert.equal((await send(`/meetings/${id}`)).body.meeting.title, 'Meeting');

  const only = await send(`/meetings/${id}`, 'PATCH', { note: 'रसीद के बारे में' });
  assert.equal(only.status, 200);
  assert.equal(only.body.meeting.note, 'रसीद के बारे में');
  assert.equal(only.body.meeting.title, 'Meeting');
  assert.equal(only.body.meeting.startedAtEstimated, false);
});

test('a finding whose words are not in the transcript is dropped, not stored', async () => {
  const id = seedMeeting();

  read = () => intelligence(
    [

      { text: 'रसीद भेजना', owner: 'प्रिया', priority: 'high', due: null, dueDate: null, quote: SPOKEN.receipt },

      {
        text: 'अरुण पचास हज़ार रुपये जमा करेंगे',
        owner: 'अरुण',
        priority: 'high',
        due: null,
        dueDate: null,
        quote: 'अरुण: मैं पचास हज़ार रुपये कल जमा कर दूँगा।',
      },

      { text: 'नया बैंक खाता खोलना', owner: null, priority: 'normal', due: null, dueDate: null },
    ],
    {
      keyPoints: [
        { text: 'रसीद शुक्रवार तक आएगी', quote: SPOKEN.receipt },
        { text: 'बजट में दो लाख की कमी है', quote: 'प्रिया: बजट में दो लाख की कमी है।' },
      ],
      decisions: [{ text: 'ऑडिट के बाद आगे देखेंगे', quote: SPOKEN.quarter }],
      attention: [{ text: 'ऑडिटर से बात नहीं हुई', quote: SPOKEN.auditor }],

      topics: ['रसीद', 'बैंक लोन'],
    },
  );

  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const meeting = (await send(`/meetings/${id}`)).body.meeting;
  assert.equal(meeting.status, 'complete');

  const items = meeting.intelligence.actionItems ?? [];
  assert.deepEqual(items.map((item) => item.text), ['रसीद भेजना']);
  assert.deepEqual(meeting.tasks.map((task) => task.text), ['रसीद भेजना']);

  const owned = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE owner_name = ?').get('अरुण') as { n: number };
  assert.equal(owned.n, 0, 'A commitment nobody made was filed against a real person.');

  assert.deepEqual(meeting.intelligence.keyPoints, ['रसीद शुक्रवार तक आएगी']);
  assert.deepEqual(meeting.intelligence.decisions, ['ऑडिट के बाद आगे देखेंगे']);
  assert.deepEqual(meeting.intelligence.attention, ['ऑडिटर से बात नहीं हुई']);
  assert.deepEqual(meeting.intelligence.topics, ['रसीद']);

  for (const item of items) {
    assert.equal(item.fingerprint, undefined, 'An internal id reached the app.');
    assert.equal((item as Record<string, unknown>)['quote'], undefined);
  }
});

test('a summary sentence carrying a figure nobody said is dropped and the rest stands', async () => {
  const id = seedMeeting();

  read = () => intelligence([], {

    summary: 'इनवॉइस 2026 में मंज़ूर होगा। कुल बकाया 45,000 रुपये है।',
  });

  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const meeting = (await send(`/meetings/${id}`)).body.meeting;
  assert.equal(meeting.status, 'complete');
  assert.equal(meeting.summary, 'इनवॉइस 2026 में मंज़ूर होगा।');
  assert.ok(!(meeting.summary ?? '').includes('45,000'), 'An invented figure reached the summary.');
});

test('a reading the transcript supports none of is never published as a finished meeting', async () => {
  const id = seedMeeting();

  read = () => ({
    title: 'बैंक लोन की बैठक',
    summary: 'लोन 12,00,000 रुपये का मंज़ूर हुआ।',
    language: 'Hindi',
    topics: ['बैंक लोन'],
    keyPoints: [{ text: 'ब्याज दर नौ प्रतिशत', quote: 'मैनेजर: ब्याज दर नौ प्रतिशत रहेगी।' }],
    decisions: [{ text: 'लोन लेना तय हुआ', quote: 'सबने कहा कि लोन ले लेना चाहिए।' }],
    attention: [{ text: 'गारंटर चाहिए', quote: 'मैनेजर: एक गारंटर चाहिए होगा।' }],
    actionItems: [{ text: 'फ़ॉर्म भरना', owner: 'अरुण', priority: 'high', due: null, dueDate: null, quote: 'अरुण: फ़ॉर्म मैं भर दूँगा।' }],
  });

  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const stored = row(id);

  assert.notEqual(stored.status, 'complete');
  assert.equal(stored.status, 'transcribed');
  assert.equal(stored.summary, null);
  plainLanguage(stored.error, 'A reading that found nothing');
  assert.match(stored.error ?? '', /not enough/);

  const meeting = (await send(`/meetings/${id}`)).body.meeting;
  assert.equal(meeting.transcript, TRANSCRIPT);
  assert.equal(meeting.title, 'Meeting');
  assert.equal(meeting.tasks.length, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0);

  assert.equal(job(id)?.status, 'failed');
  assert.ok((job(id)?.detail ?? '').length > 0);
  assert.notEqual(job(id)?.detail, stored.error);

  read = () => intelligence([
    { text: 'रसीद भेजना', owner: 'प्रिया', priority: 'high', due: null, dueDate: null, quote: SPOKEN.receipt },
  ]);
  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);
  assert.equal(statusOf(id), 'complete');
  assert.equal(row(id).error, null);
});

test('re-reading a meeting keeps what the person touched and drops only what it wrote itself', async () => {
  const id = seedMeeting({ startedAt: new Date(2026, 9, 2).getTime() });

  db.prepare(
    `INSERT INTO tasks (id, user_id, text, owner_name, priority, due_at, meeting_id, created_at)
     VALUES ('task_mine', ?, 'सोसाइटी को चिट्ठी लिखनी है', 'मैं', 'high', NULL, ?, ?)`,
  ).run(OWNER, id, Date.now());

  const first = [
    { text: 'रसीद भेजना', owner: 'प्रिया', priority: 'normal', due: null, dueDate: null, quote: SPOKEN.receipt },
    { text: 'हॉल बुक करना', owner: 'अरुण', priority: 'low', due: null, dueDate: null, quote: SPOKEN.hall },
    { text: 'ऑडिटर को फ़ोन करना', owner: null, priority: 'high', due: null, dueDate: null, quote: SPOKEN.auditor },
    { text: 'मिनट्स भेजना', owner: 'रवि', priority: 'normal', due: null, dueDate: null, quote: SPOKEN.minutes },
  ];
  read = () => intelligence(first);
  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);
  assert.equal((await send(`/meetings/${id}`)).body.meeting.tasks.length, 5);

  const taskId = (text: string) =>
    (db.prepare('SELECT id FROM tasks WHERE text = ? AND user_id = ?').get(text, OWNER) as { id: string }).id;
  const done = taskId('रसीद भेजना');
  const edited = taskId('हॉल बुक करना');
  const dropped = taskId('ऑडिटर को फ़ोन करना');
  const alone = taskId('मिनट्स भेजना');

  assert.equal((await send(`/tasks/${done}`, 'PATCH', { done: true })).status, 200);
  assert.equal((await send(`/tasks/${edited}`, 'PATCH', { priority: 'high' })).status, 200);

  db.prepare("UPDATE meetings SET status = 'transcribed' WHERE id = ?").run(id);

  read = () => intelligence([
    first[0]!,
    first[1]!,

    { text: 'सबको मीटिंग के मिनट्स भेजना', owner: 'रवि', priority: 'high', due: '9 अक्टूबर', dueDate: '2026-10-09', quote: SPOKEN.minutes },
    { text: 'इनवॉइस मंज़ूर करना', owner: 'प्रिया', priority: 'normal', due: null, dueDate: null, quote: SPOKEN.invoice },
  ]);
  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const tasks = (await send(`/meetings/${id}`)).body.meeting.tasks;
  const find = (text: string) => tasks.find((task) => task.text === text);

  assert.equal(tasks.length, 5);

  assert.equal(find('रसीद भेजना')?.id, done);
  assert.ok((find('रसीद भेजना')?.doneAt ?? 0) > 0);

  assert.equal(find('हॉल बुक करना')?.id, edited);
  assert.equal(find('हॉल बुक करना')?.priority, 'high');

  assert.equal(find('मिनट्स भेजना'), undefined);
  assert.equal(find('सबको मीटिंग के मिनट्स भेजना')?.id, alone);
  assert.equal(find('सबको मीटिंग के मिनट्स भेजना')?.priority, 'high');
  assert.equal(find('सबको मीटिंग के मिनट्स भेजना')?.dueAt, new Date(2026, 9, 9, 23, 59, 59, 999).getTime());

  assert.equal(find('ऑडिटर को फ़ोन करना'), undefined);
  assert.equal(db.prepare('SELECT id FROM tasks WHERE id = ?').get(dropped), undefined);

  assert.ok(find('इनवॉइस मंज़ूर करना'));

  const mine = find('सोसाइटी को चिट्ठी लिखनी है');
  assert.equal(mine?.id, 'task_mine', 'A task the person typed was deleted by a re-read.');
  assert.equal(mine?.priority, 'high');
  assert.equal(mine?.owner, 'मैं');
});

test('a ticked task from before fingerprints existed is recognised, not listed twice', async () => {
  const id = seedMeeting();

  const ticked = Date.now() - 60_000;
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, owner_name, priority, due_at, done_at, meeting_id, created_at)
     VALUES ('task_old', ?, 'रसीद भेजना', 'प्रिया', 'normal', NULL, ?, ?, ?)`,
  ).run(OWNER, ticked, id, ticked);

  read = () => intelligence([
    { text: 'रसीद भेजना', owner: 'प्रिया', priority: 'high', due: null, dueDate: null, quote: SPOKEN.receipt },
  ]);
  assert.equal((await send(`/meetings/${id}/retry`, 'POST')).status, 202);
  await eventually(jobFinished);

  const tasks = (await send(`/meetings/${id}`)).body.meeting.tasks;
  assert.equal(tasks.length, 1, 'A ticked task came back as a second, open copy of itself.');
  assert.equal(tasks[0]?.id, 'task_old');
  assert.equal(tasks[0]?.doneAt, ticked, 'A re-read un-ticked something the person had finished.');
  assert.equal(tasks[0]?.priority, 'normal', 'A re-read rewrote a task the person had already closed.');
});

function age(fileId: string): void {
  db.prepare('UPDATE files SET created_at = ? WHERE id = ?').run(Date.now() - 120_000, fileId);
}

function fileRow(fileId: string) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as { stored_path: string } | undefined;
}

test('a recording shared with a record outlives the meeting that stored it', async () => {
  hear = () => 'कुछ कहा गया';
  read = () => intelligence();
  const created = await send('/meetings', 'POST', upload(mp3Bytes(400), 'meeting.mp3', 'audio/mpeg'));
  await eventually(jobFinished);

  const meetingId = created.body.meeting.id;
  const fileId = created.body.meeting.fileId;
  assert.ok(fileId);
  const stored = fileRow(fileId)?.stored_path;
  assert.ok(stored && existsSync(stored));

  const now = Date.now();
  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, file_id, created_at, updated_at)
     VALUES ('rec_shared', ?, 'note', 'The same recording', ?, ?, ?)`,
  ).run(OWNER, fileId, now, now);
  age(fileId);

  assert.equal((await send(`/meetings/${meetingId}`, 'DELETE')).status, 200);
  assert.ok(fileRow(fileId), 'A file another thing still points at was deleted.');
  assert.ok(existsSync(stored));
  const download = await app.request(`/api/files/${fileId}`, { headers: { 'x-device-id': DEVICE } });
  assert.equal(download.status, 200);
  assert.equal((await download.arrayBuffer()).byteLength, 400 * MP3_FRAME_BYTES);

  assert.equal((await send('/daybook/records/rec_shared', 'DELETE')).status, 200);
  assert.equal(fileRow(fileId), undefined);
  assert.equal(existsSync(stored), false, 'The row is gone but the bytes are still on disk.');
  assert.equal((await send(`/files/${fileId}`)).status, 404);
});

test('a file young enough to still be uploading survives collection until it is not', async () => {
  const file = storeUpload(OWNER, wavBytes(64), 'audio/wav', 'orphan.wav');
  assert.ok(existsSync(file.stored_path));

  const first = await send('/tasks', 'POST', { text: 'रसीद देखना' });
  const second = await send('/tasks', 'POST', { text: 'बजट देखना' });

  assert.equal((await send(`/tasks/${first.body.task.id}`, 'DELETE')).status, 200);
  assert.ok(fileRow(file.id), 'A file that could still be in flight was collected.');

  age(file.id);
  assert.equal((await send(`/tasks/${second.body.task.id}`, 'DELETE')).status, 200);
  assert.equal(fileRow(file.id), undefined);
  assert.equal(existsSync(file.stored_path), false);
});

test('the sweep at startup takes what a dead request left behind', () => {
  const file = storeUpload(OWNER, wavBytes(64), 'audio/wav', 'stranded.wav');

  assert.equal(collectAllOrphanFiles(), 1);
  assert.equal(fileRow(file.id), undefined);
  assert.equal(existsSync(file.stored_path), false);
});

test('bytes are refused to anyone but their owner', async () => {
  const file = storeUpload(OWNER, wavBytes(64), 'audio/wav', 'mine.wav');

  assert.throws(() => fileBytes(file, 'device:someoneelse00'), /does not exist/);
  assert.throws(() => fileBytes(file, undefined), /does not exist/);
  assert.equal(fileBytes(file, OWNER).byteLength, 44 + 64);

  const theirs = await app.request(`/api/files/${file.id}`, { headers: { 'x-device-id': 'someoneelse00' } });
  assert.equal(theirs.status, 404);
});
