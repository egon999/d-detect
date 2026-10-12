import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { db } from './db.ts';
import { config } from './env.ts';
import { NO_ROOM_LEFT, wouldOverrunStorage } from './limits.ts';

export type StoredFile = {
  id: string;
  user_id: string;
  sha256: string;
  mime: string;
  bytes: number;
  original_name: string;
  stored_path: string;
  created_at: number;
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/x-pn-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'audio/3gpp': '3gp',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/caf': 'caf',
  'audio/x-caf': 'caf',
};

export function extensionFor(mime: string): string {
  return EXTENSIONS[mime.toLowerCase()] ?? 'bin';
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'heif', 'mif1', 'msf1']);

const HEIF_HELP =
  'This photo is in a format the app cannot read. Take a screenshot of it and upload that, ' +
  'or set your iPhone camera format to "Most Compatible" and take the photo again.';

function filesRoot(): string {
  return resolve(config.dataDir, 'files');
}

function ownerDirectory(userId: string): string {

  return resolve(filesRoot(), createHash('sha256').update(userId).digest('hex'));
}

export function megabytes(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

export function isImage(mime: string): boolean {
  return mime.toLowerCase().startsWith('image/');
}

export type UploadRefusalReason =
  | 'empty'
  | 'too_large'
  | 'unsupported_format'
  | 'wrong_format'
  | 'cannot_decode'
  | 'no_room';

export class UploadRefused extends Error {
  readonly reason: UploadRefusalReason;

  constructor(reason: UploadRefusalReason, message: string) {
    super(message);
    this.name = 'UploadRefused';
    this.reason = reason;
  }
}

export function isAudio(mime: string): boolean {
  return mime.toLowerCase().startsWith('audio/');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

const STORE_GRACE_MS = 60_000;

export function storeUpload(
  userId: string,
  bytes: Uint8Array,
  mime: string,
  originalName: string,
  maxBytes: number = config.maxUploadBytes,
): StoredFile {
  if (bytes.byteLength === 0) {
    throw new UploadRefused('empty', 'That file has nothing in it. Pick it again, or take a fresh screenshot.');
  }
  if (bytes.byteLength > maxBytes) {
    throw new UploadRefused(
      'too_large',
      `That file is larger than ${megabytes(maxBytes)} MB. Send a smaller copy, or a screenshot of it.`,
    );
  }

  mime = mime.toLowerCase().split(';')[0]!.trim();
  if (mime === 'application/octet-stream' || !mime) {
    const ext = originalName.split('.').pop()?.toLowerCase();
    mime = Object.entries(EXTENSIONS).find(([, value]) => value === ext)?.[0] ?? mime;
  }
  const tag = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4)).toLowerCase();
  if (mime === 'image/heic' || mime === 'image/heif' || (tag(4) === 'ftyp' && HEIF_BRANDS.has(tag(8)))) {
    throw new UploadRefused('cannot_decode', HEIF_HELP);
  }
  if (!(mime in EXTENSIONS)) {
    throw new UploadRefused(
      'unsupported_format',
      'Choose an image, PDF, Word document, text file or audio recording.',
    );
  }
  const starts = (...prefix: number[]) => prefix.every((value, index) => bytes[index] === value);
  const ascii = new TextDecoder().decode(bytes.slice(0, 16));
  if ((mime === 'image/png' && !starts(137, 80, 78, 71, 13, 10, 26, 10)) ||
      (mime === 'image/jpeg' && !starts(255, 216, 255)) ||
      (mime === 'image/webp' && !(ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')) ||
      (mime === 'application/pdf' && !ascii.startsWith('%PDF-')) ||
      (mime.includes('wordprocessingml') && !starts(80, 75))) {
    throw new UploadRefused('wrong_format', 'The file does not match its format. Upload the original file.');
  }
  originalName = originalName.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()?.slice(0, 240) || 'upload';

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const existing = db
    .prepare('SELECT * FROM files WHERE user_id = ? AND sha256 = ?')
    .get(userId, sha256) as StoredFile | undefined;
  if (existing) {
    return existing;
  }

  if (wouldOverrunStorage(userId, bytes.byteLength)) {
    throw new UploadRefused('no_room', NO_ROOM_LEFT);
  }

  const directory = ownerDirectory(userId);
  mkdirSync(directory, { recursive: true });

  const storedPath = resolve(directory, `${sha256}.${extensionFor(mime)}`);
  writeFileSync(storedPath, bytes);

  const row: StoredFile = {
    id: newId('file'),
    user_id: userId,
    sha256,
    mime,
    bytes: bytes.byteLength,
    original_name: originalName,
    stored_path: storedPath,
    created_at: Date.now(),
  };

  db.prepare(
    `INSERT INTO files (id, user_id, sha256, mime, bytes, original_name, stored_path, created_at)
     VALUES (@id, @user_id, @sha256, @mime, @bytes, @original_name, @stored_path, @created_at)`,
  ).run(row);

  return row;
}

export function fileById(id: string, userId: string): StoredFile | null {
  const row = db
    .prepare('SELECT * FROM files WHERE id = ? AND user_id = ?')
    .get(id, userId) as StoredFile | undefined;
  return row ?? null;
}

export function fileBytes(file: StoredFile, owner: string | undefined): Uint8Array {
  if (file.user_id !== owner) throw new Error('That file does not exist.');
  return new Uint8Array(readFileSync(file.stored_path));
}

const ORPHANS = `SELECT id, user_id, stored_path FROM files
   WHERE NOT EXISTS (SELECT 1 FROM records    WHERE records.file_id    = files.id)
     AND NOT EXISTS (SELECT 1 FROM meetings   WHERE meetings.file_id   = files.id)
     AND NOT EXISTS (SELECT 1 FROM case_items WHERE case_items.file_id = files.id)`;

type OrphanRow = { id: string; user_id: string; stored_path: string };

function removeFile(row: OrphanRow): boolean {
  const target = resolve(row.stored_path);
  if (!target.startsWith(filesRoot() + sep)) {
    console.warn('[detact] refusing to delete a stored file outside the data directory:', row.id);
    return false;
  }
  try {
    const result = db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').run(row.id, row.user_id);
    if (result.changes === 0) return false;
  } catch (cause) {
    console.warn('[detact] could not release the file row', row.id, cause);
    return false;
  }
  try {
    unlinkSync(target);
  } catch (cause) {

    if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[detact] the file row is gone but its bytes remain at', target, cause);
    }
  }
  return true;
}

function collect(rows: OrphanRow[]): number {
  let removed = 0;
  for (const row of rows) {
    if (removeFile(row)) removed += 1;
  }
  return removed;
}

export function collectOrphanFiles(owner: string): number {
  const rows = db
    .prepare(`${ORPHANS} AND files.user_id = ? AND files.created_at <= ?`)
    .all(owner, Date.now() - STORE_GRACE_MS) as OrphanRow[];
  return collect(rows);
}

export function collectAllOrphanFiles(): number {
  return collect(db.prepare(ORPHANS).all() as OrphanRow[]);
}
