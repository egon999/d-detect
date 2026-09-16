/**
 * On-screen text in a video.
 *
 * ## Why a video needs two readings, not one
 *
 * A recording carries two independent records and neither one contains the other. What was
 * said is in the audio; what was *shown* — a payment confirmation screen, a chat thread
 * being scrolled, a bank balance — is only in the pixels. A screen recording of a UPI
 * confirmation with no narration transcribes to nothing at all, and a phone call recording
 * of someone reading out a reference number has no on-screen text. Reading only one of the
 * two would produce an empty result on half the videos this app is given, and an empty
 * result looks to a user exactly like a failure they caused.
 *
 * So the video path samples frames, runs each through the same local ML Kit recogniser used
 * for photographs (`./ocr`), and merges the result with the transcript from `./transcribe`.
 * Neither signal is sufficient and neither is authoritative: see `mergeMediaText` for how
 * they are kept distinguishable in the output.
 *
 * ## What this cannot do
 *
 * - **It does not watch the video.** It looks at a handful of stills. Text that appeared for
 *   one second between two samples is not in the output, and nothing here can tell the
 *   difference between "there was no text" and "the text was missed". `planFrameTimes`
 *   reports the interval it used so the caller can say which was sampled.
 * - **It cannot group lines into rows.** The binding behind `./ocr` gives each line a `left`
 *   and a `top` but no height or width, so there is no way to decide whether two lines share
 *   a row without inventing a pixel tolerance for an image of unknown scale. A receipt's
 *   label and its amount therefore stay on separate lines, which costs the deterministic
 *   extractor the role hint it reads from preceding context.
 * - **It has no confidence score,** for the reason set out at length in `./ocr`. Every value
 *   read off a frame is provisional.
 *
 * ## Purity
 *
 * Everything except `readVideoFrameText` is pure and has no native imports — the `./ocr`
 * import is `import type`, which TypeScript erases, so this module loads in a plain Node
 * process. The planning, ordering, de-duplication and merge logic is where the mistakes that
 * matter would live, and it is unit-tested directly in `tests/media-video-frames.test.ts`.
 */

import type { RecognisedLine } from './ocr';
import type { TimedSegment } from './types';

/**
 * Most frames sampled from one video, whatever its length.
 *
 * Each frame costs a decode to a temp JPEG plus two ML Kit passes (Latin and Devanagari,
 * both run by `recogniseText`), which on a mid-range Android handset is a few hundred
 * milliseconds each — so twelve frames is on the order of ten seconds of work with the user
 * watching a spinner, on top of however long the transcript upload took.
 *
 * Twelve rather than a number that scales with duration, because the cost is per frame and
 * the *value* is not: on a screen recording the same screen is on display for seconds at a
 * time, and on a thirty-minute clip no achievable number of samples reads the whole thing
 * anyway. A budget that grew with length would turn a long video into a several-minute
 * freeze and still miss most of it. Twelve fully covers the sixty-second screen recording
 * this feature exists for, and on anything longer the note tells the user the interval so
 * they know the reading is a sample rather than a transcript of the screen.
 */
export const MAX_FRAMES = 12;

/**
 * Preferred gap between samples, in milliseconds.
 *
 * Five seconds is roughly the shortest time a person holds something readable on screen when
 * they mean the viewer to read it, so it is the interval at which a sample is likely to land
 * on content rather than on a transition. Combined with `MAX_FRAMES` it gives complete
 * five-second coverage up to a minute, and degrades to an even spread beyond that.
 */
export const TARGET_INTERVAL_MS = 5_000;

/**
 * A single decoded frame's readable text.
 *
 * `lines` are already ordered top-to-bottom and stripped of blanks. Kept as lines rather
 * than one string because each line becomes its own citable segment, and because a labelled
 * value ("Total: INR 1,200.00") is only findable by the deterministic extractor while it
 * still has a line to itself.
 */
export interface FrameReading {
  /** Position in the video, in milliseconds. */
  atMs: number;
  lines: string[];
}

/** Why frame reading produced less than it might have. */
export type FrameLimitation =
  /** ML Kit is not in this build — Expo Go, or a build made before it was added. */
  | 'ocr-unavailable'
  /** The decoder refused a frame. Usually the end of the video, sometimes a broken file. */
  | 'decode-failed'
  /** The caller aborted, e.g. the user left the screen. */
  | 'cancelled';

export interface FrameTextOutcome {
  /** De-duplicated readings, in video order. Empty when no frame carried readable text. */
  frames: FrameReading[];
  /** How many frames were successfully decoded, before de-duplication. */
  decoded: number;
  /** Gap actually used between samples, so the caller's note can state it. */
  intervalMs: number;
  /**
   * What went wrong, in the order encountered, deduplicated. Empty on a clean pass.
   *
   * A list rather than a single value because "the decoder gave up after frame 7" and "the
   * user cancelled" are both true of the same run, and collapsing them would make the note
   * either alarmist or incomplete.
   */
  limitations: FrameLimitation[];
}

/**
 * Chooses the timestamps to sample, in milliseconds.
 *
 * Frames land at the midpoint of each equal slice rather than at its start. The first frame
 * of a video is very often not content — a black frame, a fade-in, a codec keyframe placed
 * before anything is drawn — and the last millisecond frequently fails to decode at all.
 * Sampling midpoints avoids both ends without needing to special-case them.
 *
 * When `durationMs` is unknown the plan is a fixed ladder at `TARGET_INTERVAL_MS` and the
 * caller stops at the first frame the decoder refuses. That is deliberately not a fallback
 * that pretends to know the length: on Android a request past the end returns the final
 * frame rather than an error, so the tail of such a plan yields the same picture several
 * times over — which `dedupeFrameReadings` collapses to one. The duplicate work is the price
 * of not having a duration, and it is bounded by `MAX_FRAMES`.
 */
export function planFrameTimes(durationMs: number | null): { times: number[]; intervalMs: number } {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) {
    const times: number[] = [];
    for (let i = 0; i < MAX_FRAMES; i += 1) {
      times.push(Math.round(TARGET_INTERVAL_MS * (i + 0.5)));
    }
    return { times, intervalMs: TARGET_INTERVAL_MS };
  }

  const slices = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(durationMs / TARGET_INTERVAL_MS)));
  const intervalMs = durationMs / slices;
  const times: number[] = [];
  for (let i = 0; i < slices; i += 1) {
    times.push(Math.round(intervalMs * (i + 0.5)));
  }
  return { times, intervalMs: Math.round(intervalMs) };
}

/**
 * Puts recognised lines into reading order and drops the empty ones.
 *
 * ML Kit returns blocks in its own order, which is not always top-to-bottom — on a chat
 * screenshot it will happily emit a later message before an earlier one, which would put a
 * reply above the message it answers and invert the meaning of the conversation. Sorting on
 * `top` restores the order a person reads in.
 *
 * Lines with no geometry keep their original relative position rather than being pushed to
 * one end: `top` is null only when the binding did not report a frame for that line, and
 * guessing it belongs first or last would be a claim about layout that nothing measured.
 * `left` breaks ties so a two-column row reads left to right.
 *
 * Each returned line is flattened to a single line, not merely trimmed. A `RecognisedLine`
 * is a *line* by ML Kit's reckoning, and on wrapped or oddly segmented text its `text` can
 * still contain a newline. That matters because `mergeMediaText` pushes each of these
 * strings into `lines` and simultaneously records one `TimedSegment` for it: a string
 * carrying an internal newline would contribute two lines of text but one timed segment,
 * stalling the text-matching pointer in `buildSegments` and costing every later segment on
 * the video its clock position. Collapsing here is safe because the merged text is assembled
 * from these very strings, so the line and the segment cannot disagree.
 */
export function orderRecognisedLines(lines: readonly RecognisedLine[]): string[] {
  const indexed = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.text.trim().length > 0);

  indexed.sort((a, b) => {
    const aTop = a.line.top;
    const bTop = b.line.top;
    if (aTop !== null && bTop !== null && aTop !== bTop) return aTop - bTop;
    if (aTop !== null && bTop !== null) {
      const aLeft = a.line.left;
      const bLeft = b.line.left;
      if (aLeft !== null && bLeft !== null && aLeft !== bLeft) return aLeft - bLeft;
    }
    return a.index - b.index;
  });

  return indexed.map((entry) => entry.line.text.replace(/\s+/g, ' ').trim());
}

/**
 * Above this token overlap, two frames are treated as the same picture.
 *
 * Not exact string equality, which fails on precisely the case it is needed for: a status bar
 * clock ticks from 14:32 to 14:33 and the battery percentage drops a point, so forty
 * identical-looking frames of a static screen are forty distinct strings.
 *
 * What 0.9 actually tolerates is worth stating, because Jaccard counts a changed token twice —
 * once as missing from each side. Suppressing a frame in which `k` tokens changed needs roughly
 * `18k` unchanged ones, so a dense screen whose only difference is the clock collapses to one
 * entry, while a nearly empty frame showing three words and a clock keeps both. That asymmetry
 * is the direction to err in: a near-duplicate that survives costs a repeated block of text,
 * whereas a frame wrongly dropped costs the one changed figure that was the reason to sample it.
 */
const DUPLICATE_SIMILARITY = 0.9;

/** Word tokens, lowercased, for the similarity measure. Punctuation is not a signal here. */
function tokenSet(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu);
  return new Set(tokens ?? []);
}

/**
 * Jaccard overlap of two frames' word sets, from 0 (nothing shared) to 1 (identical sets).
 *
 * Set overlap rather than an edit distance because what matters is whether the same *content*
 * is on screen, not whether it moved: a list that scrolled by one row shares almost all its
 * words and should be treated as the same screen, while a Levenshtein comparison would score
 * it as heavily changed. Word order is not information in a frame of a UI.
 */
export function frameSimilarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / (left.size + right.size - shared);
}

/**
 * Drops frames that show what the previous kept frame already showed.
 *
 * Compared against the last *kept* frame rather than the immediately preceding one. On a
 * static screen every frame is near-identical to its neighbour, so comparing neighbours
 * keeps nothing — but a slow scroll also has near-identical neighbours while drifting
 * steadily away from where it started, and comparing against the last kept frame lets that
 * drift accumulate until it crosses the threshold and earns a new entry. The first behaviour
 * is the one being suppressed; the second is the one that must survive.
 */
export function dedupeFrameReadings(readings: readonly FrameReading[]): FrameReading[] {
  const kept: FrameReading[] = [];
  let reference: string | null = null;

  for (const reading of readings) {
    if (reading.lines.length === 0) continue;
    const joined = reading.lines.join('\n');
    if (reference !== null && frameSimilarity(reference, joined) >= DUPLICATE_SIMILARITY) continue;
    kept.push(reading);
    reference = joined;
  }

  return kept;
}

/**
 * Headings that separate the two signals in the merged text.
 *
 * Plain sentences with no colon and no bracketed clock, and that is not incidental. The
 * deterministic extractor reads `Label: value` lines as parties (`extractParties`) and as
 * chat messages (`extractChatMessages`), and `classifyDocumentType` classifies anything
 * containing `[0:09]` as a chat export — so the obvious formats, "Speech: …" or a
 * "[00:14] …" prefix per line, would each make the extractor confidently wrong about a
 * video. Exported so the tests assert against the same strings the extractor will see.
 */
export const SPEECH_HEADING = 'Speech transcribed from this recording';
export const FRAME_TEXT_HEADING = 'On-screen text read from video frames';

/**
 * Combines a transcript and a set of frame readings into one block of text plus the timings
 * that point into it.
 *
 * The format follows `flattenCsvRows` in the one respect that matters: the extractor is
 * given lines it already knows how to read, and nothing is prefixed onto them. A content
 * line is emitted exactly as it was heard or read, because `extractAmounts` and
 * `extractDates` look back forty to fifty characters from a figure to work out its role, and
 * a "[00:14] " or "Frame 3: " prefix would sit inside that window and push the label that
 * gives the figure its meaning out of it. The clock positions ride in `timedSegments`
 * instead, out of band, where they cannot corrupt the text.
 *
 * Speech comes first because it is the record of what happened, and on-screen text second
 * because it is a reading of pixels. The two are separated by headings rather than by markup
 * so that the distinction survives being shown as plain text anywhere in the app.
 *
 * The returned `timedSegments` are re-indexed across both sections, in emission order, and
 * each one's `text` appears verbatim as its own line of `text` — the correspondence that
 * `IngestResult.timedSegments` documents and that `buildSegments` will rely on.
 */
export function mergeMediaText(input: {
  speech: readonly TimedSegment[];
  frames: readonly FrameReading[];
}): { text: string; timedSegments: TimedSegment[] } {
  const lines: string[] = [];
  const timedSegments: TimedSegment[] = [];

  if (input.speech.length > 0) {
    lines.push(SPEECH_HEADING, '');
    for (const segment of input.speech) {
      lines.push(segment.text);
      timedSegments.push({ ...segment, index: timedSegments.length });
    }
  }

  const framesWithText = input.frames.filter((frame) => frame.lines.length > 0);
  if (framesWithText.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(FRAME_TEXT_HEADING, '');
    framesWithText.forEach((frame, position) => {
      // Blank line between frames so each one reads as its own block, the way
      // `flattenCsvRows` separates rows. Without it a receipt's total would sit directly
      // under the previous frame's last line and look like part of the same screen.
      if (position > 0) lines.push('');
      for (const line of frame.lines) {
        lines.push(line);
        // No `endMs`. A frame was observed at an instant; the text was very probably on
        // screen for longer, but this pass did not measure when it appeared or when it went
        // away, and inventing an interval from the sampling gap would put a duration on
        // screen that describes the sampler rather than the video.
        timedSegments.push({
          index: timedSegments.length,
          text: line,
          startMs: frame.atMs,
          source: 'frame-text',
        });
      }
    });
  }

  return { text: lines.join('\n'), timedSegments };
}

/**
 * Decodes one frame to a temp image, or `null` if the decoder refused it.
 *
 * A separate function so the failure is a value rather than a caught exception at the call
 * site: `expo-video-thumbnails` rejects for a time past the end of the video on iOS and for a
 * corrupt file on both platforms, and the caller needs to branch on that rather than have its
 * control flow leave through a `catch`.
 */
async function decodeFrame(
  getThumbnailAsync: typeof import('expo-video-thumbnails').getThumbnailAsync,
  uri: string,
  atMs: number,
): Promise<string | null> {
  try {
    const thumbnail = await getThumbnailAsync(uri, { time: atMs, quality: 1 });
    return thumbnail.uri;
  } catch {
    return null;
  }
}

/**
 * Samples frames from a video and reads the text on them.
 *
 * Never throws. A video that cannot be decoded, a build without ML Kit and a cancelled run
 * all come back as an outcome with an empty `frames` list and a limitation naming what
 * happened, because the caller (`./ingest`) is documented never to reject a file.
 *
 * Temp files are deleted as soon as each frame has been read, not in a pass at the end.
 * `getThumbnailAsync` writes a full-resolution JPEG into the cache directory for every call,
 * so a twelve-frame pass over a 1080p recording leaves twelve files behind — several
 * megabytes per video ingested, accumulating silently on a phone with no code anywhere that
 * would ever clean them up. Deleting per frame rather than at the end also means a
 * cancellation midway through does not leak the frames already written.
 */
export async function readVideoFrameText(
  uri: string,
  durationMs: number | null,
  signal?: AbortSignal,
): Promise<FrameTextOutcome> {
  const { times, intervalMs } = planFrameTimes(durationMs);
  const readings: FrameReading[] = [];
  const limitations: FrameLimitation[] = [];
  let decoded = 0;

  const note = (limitation: FrameLimitation) => {
    if (!limitations.includes(limitation)) limitations.push(limitation);
  };

  // Lazily imported, all three of them: `expo-video-thumbnails`, `./ocr` (which statically
  // imports the ML Kit binding) and `expo-file-system` are native modules that do not exist
  // in a plain Node process. A static import would make this module's pure half — the
  // planning and merge logic that the tests actually cover — unimportable.
  let getThumbnailAsync: typeof import('expo-video-thumbnails').getThumbnailAsync;
  let recogniseText: typeof import('./ocr').recogniseText;
  let FileClass: typeof import('expo-file-system').File;
  try {
    const [thumbnails, ocr, fs] = await Promise.all([
      import('expo-video-thumbnails'),
      import('./ocr'),
      import('expo-file-system'),
    ]);
    getThumbnailAsync = thumbnails.getThumbnailAsync;
    recogniseText = ocr.recogniseText;
    FileClass = fs.File;
  } catch {
    return { frames: [], decoded: 0, intervalMs, limitations: ['ocr-unavailable'] };
  }

  for (const atMs of times) {
    if (signal?.aborted) {
      note('cancelled');
      break;
    }

    // `quality: 1` — no JPEG compression. The artefacts compression introduces land exactly
    // on the thin strokes of small on-screen type, which is the text worth reading here, and
    // the file exists for a few hundred milliseconds before being deleted, so a smaller one
    // buys nothing.
    const frameUri = await decodeFrame(getThumbnailAsync, uri, atMs);
    if (frameUri === null) {
      // Almost always the request landing past the end of the video, which is expected when
      // the duration was unknown. Stop rather than continue: every later time is further past
      // the end, so the remaining calls would fail the same way for the same reason.
      note('decode-failed');
      break;
    }
    decoded += 1;

    try {
      const outcome = await recogniseText(frameUri);
      if (outcome.ok) {
        const lines = orderRecognisedLines(outcome.result.lines);
        if (lines.length > 0) readings.push({ atMs, lines });
      } else if (outcome.reason === 'UNAVAILABLE') {
        // No text recognition in this build. Every remaining frame would report the same,
        // so decoding them would spend seconds of the user's time to learn nothing.
        note('ocr-unavailable');
        break;
      }
      // `NO_TEXT` and `FAILED` are per-frame and expected — a frame mid-transition, a blurred
      // pan. Neither says anything about the next frame, so neither is recorded as a
      // limitation on the whole pass.
    } finally {
      try {
        new FileClass(frameUri).delete();
      } catch {
        // The cache directory is the OS's to reclaim and a frame that cannot be deleted is
        // not a reason to fail an ingestion. Swallowed deliberately: there is nothing the
        // user could do about it and nothing this code can do beyond having tried.
      }
    }
  }

  return { frames: dedupeFrameReadings(readings), decoded, intervalMs, limitations };
}
