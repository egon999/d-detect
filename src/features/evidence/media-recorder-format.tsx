/**
 * Pure helpers for the voice-memo recorder.
 *
 * Split out of `media-recorder.tsx` for one reason. That component is built around
 * `useAudioRecorder`, and a hook cannot be lazily imported, so `expo-audio` is a static
 * import there and the whole file is unloadable outside a native runtime. The mistakes a user
 * would actually notice — a clock reading 1:07 at sixty-seven seconds, a memo named after the
 * wrong timezone, a `.3gp` renamed to `.m4a` — all live in these three functions, so they sit
 * in a module a plain Node process can import and are covered in
 * `tests/media-recorder-format.test.ts`.
 *
 * No JSX in here; the extension matches its sibling so the pair stays adjacent in a listing.
 */

/**
 * Container used when a recording's URI carries no extension of its own.
 *
 * `.m4a` because that is what `RecordingPresets.HIGH_QUALITY` writes on both platforms, and
 * because it is one of the containers Groq Whisper accepts — see `whisperAcceptsExtension` in
 * `@services/ingestion/transcribe`. A memo in anything else is a memo that cannot be
 * transcribed, which is most of the point of recording it in this app.
 */
export const DEFAULT_MEMO_EXTENSION = '.m4a';

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Elapsed recording time as a clock: `0:07`, `4:32`, `1:04:09`.
 *
 * Floored, never rounded. A stopwatch showing `0:08` when 7.6 seconds have elapsed is claiming
 * time that has not passed; on a recording whose positions may later be cited in a finding, a
 * display that runs ahead of the file is worse than one that lags behind it.
 *
 * The hours field appears only once there are hours, so a two-minute statement reads `2:14`
 * rather than being padded out to `0:02:14` and made to look like a feature film.
 */
export function formatElapsedClock(ms: number): string {
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}:${pad2(seconds)}`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${pad2(totalMinutes % 60)}:${pad2(seconds)}`;
}

/**
 * The extension of a recording's own URI, lowercased and including the dot.
 *
 * Falls back to `DEFAULT_MEMO_EXTENSION` only when the URI carries no extension at all. An
 * extension that *is* present is never substituted for a more convenient one, because the
 * extension is what the transcription path reads to decide whether Whisper can open the file:
 * renaming a `.3gp` to `.m4a` would get it past `whisperAcceptsExtension` on the strength of a
 * name that contradicts its own bytes, and the failure would then surface as an unexplained
 * transcription error rather than as the honest refusal it is.
 */
export function memoExtension(uri: string): string {
  const lastSeparator = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'));
  const base = lastSeparator >= 0 ? uri.slice(lastSeparator + 1) : uri;
  // A recorder URI is a plain cache-directory path today, but a query string is stripped
  // anyway so that a `content://` or `file://…?foo` form from a future platform version
  // cannot end up with `?foo` inside what is treated as the extension.
  const withoutQuery = base.split(/[?#]/)[0] ?? '';
  const dot = withoutQuery.lastIndexOf('.');
  if (dot <= 0 || dot === withoutQuery.length - 1) return DEFAULT_MEMO_EXTENSION;
  return withoutQuery.slice(dot).toLowerCase();
}

/**
 * A filename for a memo, e.g. `Statement 2026-09-14 14.32.08.m4a`.
 *
 * Local time, not the UTC string `toISOString` produces. This name is the only handle the
 * person has on the file among a queue of several, and a statement recorded at 14:32 in Mumbai
 * appearing as `09:02` would be unrecognisable to the one person who knows which is which.
 *
 * Dots rather than colons between the time parts: a colon is illegal in a filename on Windows
 * and reserved on some Android volumes, and this name travels with the file if the case is
 * ever exported. The extension stays the last dotted segment, so the upload screen's title
 * derivation (`name.replace(/\.[^.]+$/, '')`) strips the container and keeps the timestamp.
 *
 * Seconds are included because two memos recorded within the same minute would otherwise be
 * given identical names, and the queue would then show two rows nobody can tell apart.
 */
export function memoFileName(at: Date, extension: string): string {
  const date = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  const time = `${pad2(at.getHours())}.${pad2(at.getMinutes())}.${pad2(at.getSeconds())}`;
  return `Statement ${date} ${time}${extension}`;
}

/**
 * The MIME type to declare for a recorded memo, from its extension.
 *
 * Deliberately narrow: only the containers this recorder can actually produce are named, and
 * anything else gets `null` rather than a guess. `PickedFile.mimeType` is nullable precisely so
 * that "not known" is expressible, and `@services/ingestion` classifies by extension anyway —
 * a wrong type here would be a confident wrong answer where an absent one costs nothing.
 */
export function memoMimeType(extension: string): string | null {
  switch (extension) {
    case '.m4a':
    case '.mp4':
      return 'audio/mp4';
    case '.wav':
      return 'audio/wav';
    case '.webm':
      return 'audio/webm';
    case '.3gp':
      return 'audio/3gpp';
    default:
      return null;
  }
}
