/**
 * Speech transcription, via Groq's hosted Whisper.
 *
 * ## Why this is the one part of ingestion that leaves the device
 *
 * Everything else in `./ingest` is local: a PDF's text layer is parsed here, a CSV is
 * flattened here, an image goes through ML Kit here. There is no on-device speech model in
 * this build and no credible way to add one — the smallest usable Whisper weights are a
 * ~75 MB download that would have to ship in the APK or be fetched on first use, and the
 * React Native bindings that exist for them are unmaintained. So a recording is the single
 * source kind whose contents are sent somewhere, and the user has to be told that.
 *
 * That is also why this is gated on the user's own key rather than a key of ours. It is
 * their credential, their Groq account, and their decision to send a recording to it. With
 * no key the audio branch of ingestion still stores the file, still hashes it, and says
 * plainly that nothing was transcribed — see `MESSAGES.unavailable`. A missing key is the
 * expected state on a fresh install, not an error.
 *
 * ## Why Groq only, in a dual-provider app
 *
 * The chat layer talks to Groq and xAI, but xAI has no transcription endpoint, so an xAI
 * key cannot turn this feature on. Only a Groq key is consulted here, and the Settings
 * screen says so when an xAI key is the one being managed.
 *
 * ## Relationship to `../ai/groq-client`
 *
 * That file is the reference implementation for HTTP in this codebase and this one follows
 * it deliberately: the same `{ ok, reason, error }` failure shape, the same rule that a
 * provider's own words are never shown to a user, the same `retry-after`-honouring backoff,
 * the same AbortController-merged-with-the-caller's-signal timeout. It is not shared code
 * because the two requests have almost nothing in common on the wire — one is a few
 * kilobytes of JSON, the other is a multipart upload of the evidence itself — and the
 * places they differ are differences of *policy*, not of plumbing. Those are called out at
 * `MAX_TOTAL_ATTEMPTS` and in `attempt`.
 *
 * ## What a transcript is not
 *
 * It is a machine's reading of speech, with no confidence scores exposed by this endpoint
 * and no speaker labels at all. A misheard digit turning "fifteen hundred" into "fifty
 * hundred" would manufacture a contradiction that does not exist, which is the worst
 * failure this product can have. So nothing here may raise a finding on its own, exactly as
 * with OCR — see the same argument in `./ocr`. What the timings in `TimedSegment` buy is
 * that a person can be sent to 14.2s of the recording to check.
 */

import type { TimedSegment } from './types';
import { scrubKey } from '../ai/groq-client';
import { loadKey } from '../ai/credentials';

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * Models tried in order.
 *
 * `turbo` first: it is the cheaper and several times faster of the two, and on the material
 * this app sees — a phone recording of a conversation, a screen capture with narration —
 * the accuracy gap is not what decides whether a figure is legible. `whisper-large-v3` is
 * the fallback rather than the default because a user waiting on a 40 MB upload should not
 * also be paying for the slower model by default.
 *
 * Both ids verified against https://console.groq.com/docs/models. No other id belongs here:
 * a guessed model name answers with a 404 that this transport correctly reports as a
 * failure, so an invented one would present as "Groq is down".
 */
export const TRANSCRIPTION_MODEL_CHAIN = ['whisper-large-v3-turbo', 'whisper-large-v3'] as const;

/** The model tried first. Named for the UI, which reports it before anything has run. */
export const TRANSCRIPTION_MODEL = TRANSCRIPTION_MODEL_CHAIN[0];

/**
 * Groq's hard per-file limit, in bytes.
 *
 * Checked before the request rather than discovered from a 413, because a 413 arrives only
 * *after* the whole file has gone up the user's mobile uplink. Learning that a 90 MB video
 * was too big after spending 90 MB of someone's data allowance is not a failure mode worth
 * having when the size is known locally and for free.
 */
export const MAX_TRANSCRIPTION_BYTES = 100 * 1024 * 1024;

/**
 * Three minutes.
 *
 * Four times `../ai/groq-client`'s 45s, because the two requests are limited by different
 * things. A chat completion's body is a few kilobytes and the wait is inference; here the
 * body *is* the evidence file and the wait is almost entirely upload — Whisper turbo
 * transcribes an hour of audio in well under a minute, so on any connection worth using
 * inference is the smaller half.
 *
 * Three minutes is roughly 25 MB on a 1.5 Mbit/s mobile uplink plus inference on a long
 * recording. It does not make the 100 MB ceiling reachable on a slow connection, and it is
 * not meant to: the timeout's job is to bound how long someone stares at a spinner before
 * being told something, not to guarantee that every permitted file succeeds. A user who has
 * waited three minutes needs a sentence, not more waiting.
 */
export const TRANSCRIPTION_TIMEOUT_MS = 180_000;

/**
 * Total HTTP attempts for one call, across all models.
 *
 * `groq-client` allows 2 attempts × 3 models = 6, which is right when an attempt costs a
 * few kilobytes. Here every attempt re-uploads the entire file, so the same policy would
 * mean sending 100 MB six times — worse for the user than failing. Three is enough to ride
 * out one rate limit and one retired model, and not enough to quietly burn a data plan.
 */
const MAX_TOTAL_ATTEMPTS = 3;

/** Base for exponential backoff, overridden by a `retry-after` header when one is sent. */
const BACKOFF_BASE_MS = 700;

/**
 * Containers Whisper accepts, lowercase with the dot.
 *
 * From Groq's documented list (`flac, mp3, mp4, mpeg, mpga, m4a, ogg, opus, wav, webm`),
 * plus `.mov`: QuickTime is the same ISO base media container as `.mp4` under a different
 * brand, and the demuxer reads it. Everything else a phone can produce — `.mkv`, `.avi`,
 * `.3gp`, `.wma`, `.aac` — is refused *here*, with a sentence naming the problem, rather
 * than uploaded and refused by the provider in a message written for whoever made the call.
 */
const WHISPER_CONTAINERS: ReadonlySet<string> = new Set([
  '.flac',
  '.m4a',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
]);

/** Whether Whisper will read this container at all. `ext` includes the leading dot. */
export function whisperAcceptsExtension(ext: string): boolean {
  return WHISPER_CONTAINERS.has(ext.toLowerCase());
}

export type TranscriptionFailureReason =
  /** No key in the keystore. The expected state on a fresh install, not an error. */
  | 'unavailable'
  /** Provider returned 429 or an explicit quota message. */
  | 'rate_limited'
  /** Over `MAX_TRANSCRIPTION_BYTES`. Caught locally; nothing was uploaded. */
  | 'too_large'
  /** A container Whisper does not read. Caught locally; nothing was uploaded. */
  | 'unsupported_media'
  /** A reply arrived but was not a transcript this code could read. */
  | 'invalid_response'
  /** The request never completed — offline, DNS, captive portal, timeout, cancellation. */
  | 'network';

/**
 * A failure.
 *
 * Field names match `AIFailure` in `../ai/groq-client` so a caller that already handles one
 * reads this identically. `error` is always a sentence from `MESSAGES` below — never a
 * provider string, which can echo both the key and the request, and never an exception
 * message.
 */
export interface TranscriptionFailure {
  ok: false;
  reason: TranscriptionFailureReason;
  error: string;
}

export interface TranscriptionSuccess {
  ok: true;
  /**
   * The transcript, one line per entry of `segments`, in the same order.
   *
   * Assembled from the segments rather than taken from the reply's own `text` field, which
   * is one unbroken paragraph. A paragraph is useless to two things at once: the
   * deterministic extractor cuts segments on line breaks, and the timings below have to
   * line up with those lines to be attachable at all.
   */
  text: string;
  segments: TimedSegment[];
  /** Whisper's own language guess, or null when it reported none. Not user-supplied. */
  language: string | null;
  /** Length of the recording as Whisper measured it, or null when it reported none. */
  durationMs: number | null;
  /** The model that actually answered, which may be the fallback. */
  model: string;
  /** Wall-clock time for the whole call, upload included. */
  requestMs: number;
}

export type TranscriptionResult = TranscriptionSuccess | TranscriptionFailure;

export interface TranscriptionRequest {
  /** Local file URI. Streamed by the runtime; never read into memory by this module. */
  uri: string;
  /** Filename, which is what tells the provider's demuxer which container it is holding. */
  name: string;
  mimeType?: string | null;
  /**
   * Size in bytes, already known to the caller. Required, and deliberately not looked up
   * here: `./ingest` has the real byte count in hand, and a second filesystem read to
   * re-derive it would be both slower and a source of disagreement.
   */
  sizeBytes: number;
  /**
   * ISO-639-1 hint, e.g. `hi`. Omit to let Whisper detect.
   *
   * Worth passing when known — detection on a short or noisy clip is the main way a
   * transcript comes back as confident nonsense in the wrong language. But it is a hint the
   * caller must actually have, not a guess: forcing `en` on a Hindi recording produces
   * fluent English that was never said.
   */
  language?: string;
  /** Caller cancellation, e.g. the user leaving the screen or abandoning the upload. */
  signal?: AbortSignal;
  /** An already-resolved key, used instead of reading the keystore. See `requestGroqJson`. */
  key?: string;
  /** Test seam. Defaults to the global `fetch`. No test here reaches the network. */
  fetchImpl?: typeof fetch;
  /** Test seam for the backoff delay, so a retry test does not wait out a real one. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const MESSAGES = {
  unavailable:
    'No Groq key is set up yet, so this recording was stored without a transcript. Add a key in Settings to transcribe it — everything else works without one.',
  rejectedKey: 'Groq did not accept that key. Check it in Settings, or paste a new one from the Groq console.',
  rateLimited: 'Groq is rate limiting this key right now. Wait a minute and transcribe this recording again.',
  network: 'Could not reach Groq to transcribe this recording. Check your connection and try again.',
  timeout:
    'The recording did not finish uploading to Groq within three minutes. Try again on a faster connection, or use a shorter recording.',
  cancelled: 'Cancelled.',
  invalid: 'Groq replied with something this app could not read as a transcript. Try again.',
  refused: 'Groq refused this recording. Try again, or try a shorter one.',
  tooLarge: `This recording is larger than the 100 MB Groq accepts, so it was stored without a transcript. Split it, or record it again at a lower quality.`,
  unsupported:
    'This is not a container Groq can transcribe. Convert it to MP3, M4A, WAV or MP4 first — the file itself has still been stored unchanged.',
} as const;

function failure(reason: TranscriptionFailureReason, error: string): TranscriptionFailure {
  return { ok: false, reason, error };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whisper's `verbose_json` segment, narrowed to the fields this module reads. */
interface WhisperSegment {
  start?: unknown;
  end?: unknown;
  text?: unknown;
}

/**
 * Flattens a segment's text to exactly one line.
 *
 * Whisper's `verbose_json` segments are usually a single clean sentence, but not always: a
 * long pause mid-sentence, a recording with two speakers over each other, or a chunk boundary
 * landing inside a phrase can all produce a `text` with an embedded newline. Trimming, which
 * is what this used to do, removes the ones at the ends and leaves the ones in the middle.
 *
 * An embedded newline silently breaks the handoff documented on `IngestResult.timedSegments`.
 * `segmentsToText` joins segments with `\n`, so one segment carrying an internal newline
 * emits two lines while contributing one entry to the array — and `buildSegments` walks the
 * lines of the stored text with a pointer into that array, advancing only when a line matches
 * the segment it is pointing at. The two halves of the split segment match nothing, the
 * pointer stalls, and *every subsequent segment loses its timing*: a two-hour interview ends
 * up with timings on the first few spans and none after that, with no error anywhere.
 *
 * Collapsing every whitespace run to a single space is safe precisely because the transcript
 * text is assembled *from* these strings — whatever is stored here is what appears as the
 * line, so the two cannot disagree. It is not a normalisation of anyone's document: this
 * string is a machine's rendering of speech, and the spacing within it carries no meaning
 * that a citation could point at.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Turns Whisper's segments into `TimedSegment`s.
 *
 * Pure and exported so the unit conversion and the ordering guarantee are tested directly;
 * they are the part of this file that downstream citation correctness rests on.
 *
 * Three things happen here that are not obvious:
 *
 * - **Seconds to milliseconds.** Whisper reports floats in seconds. Rounding rather than
 *   truncating, because `extractionSchema` requires non-negative numbers and a truncated
 *   14.9 shown as "14s" is a worse answer than 15s for someone scrubbing to find it.
 * - **Empty and whitespace-only segments are dropped.** Whisper emits them around silence.
 *   Keeping one would put a blank line in `text` and an untimeable segment in the array,
 *   which would then desynchronise the text-matching handoff described on
 *   `IngestResult.timedSegments`.
 * - **`index` is assigned after filtering**, so it indexes this array rather than Whisper's,
 *   and stays a valid position into `text`'s lines.
 *
 * A segment whose `end` is missing or precedes its `start` keeps its `startMs` and loses
 * its `endMs`. That is the honest reduction: the moment it began was reported, the interval
 * was not, and inventing one from the next segment's start would attribute the following
 * silence to this sentence.
 */
export function toTimedSegments(
  raw: readonly WhisperSegment[],
  source: TimedSegment['source'] = 'speech',
): TimedSegment[] {
  const out: TimedSegment[] = [];

  for (const segment of raw) {
    // `oneLine`, not `trim`: an internal newline here would split one timed span across two
    // lines of the transcript and cost every later span its timing. See `oneLine`.
    const text = typeof segment.text === 'string' ? oneLine(segment.text) : '';
    if (text.length === 0) continue;

    const start = typeof segment.start === 'number' && Number.isFinite(segment.start) ? segment.start : null;
    if (start === null || start < 0) continue;

    const end = typeof segment.end === 'number' && Number.isFinite(segment.end) ? segment.end : null;
    const startMs = Math.round(start * 1000);
    const endMs = end !== null && end >= start ? Math.round(end * 1000) : null;

    out.push({
      index: out.length,
      text,
      startMs,
      ...(endMs !== null ? { endMs } : {}),
      source,
    });
  }

  return out;
}

/** The transcript text implied by a segment list: one line each, in order. */
export function segmentsToText(segments: readonly TimedSegment[]): string {
  return segments.map((segment) => segment.text).join('\n');
}

/**
 * The `type` for the multipart file part.
 *
 * The declared mime type is preferred when it names a media type, and otherwise derived
 * from the extension. Android's document picker very often reports
 * `application/octet-stream` for a file whose name is perfectly clear, and passing that
 * through leaves the provider guessing at the container from bytes alone.
 */
export function transcriptionMimeType(ext: string, declared?: string | null): string {
  const stated = (declared ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (stated.startsWith('audio/') || stated.startsWith('video/')) return stated;

  switch (ext.toLowerCase()) {
    case '.mp3':
    case '.mpga':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.wav':
      return 'audio/wav';
    case '.flac':
      return 'audio/flac';
    case '.ogg':
    case '.opus':
      return 'audio/ogg';
    case '.mp4':
    case '.mpeg':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    default:
      // Reached only for a container `whisperAcceptsExtension` already passed, so this is a
      // belt-and-braces default rather than a guess about an unknown file.
      return 'application/octet-stream';
  }
}

/** Lowercase extension including the dot, or '' when the name has none. */
function extensionOf(name: string): string {
  const clean = name.split('?')[0] ?? name;
  const dot = clean.lastIndexOf('.');
  if (dot <= 0 || dot === clean.length - 1) return '';
  return clean.slice(dot).toLowerCase();
}

/** Outcome of one HTTP attempt, before the body is read. */
type Attempt =
  | { status: 'ok'; body: unknown }
  /** Worth trying again with the same model. */
  | { status: 'retry'; afterMs: number; reason: TranscriptionFailureReason }
  /** This model will not work; move down the chain. */
  | { status: 'next-model' }
  /** Nothing will work; stop. */
  | { status: 'fatal'; failure: TranscriptionFailure };

async function attempt(
  model: string,
  request: TranscriptionRequest,
  ext: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<Attempt> {
  // The caller's signal and the timeout are separate reasons to stop and have to be told
  // apart afterwards: a user who walked away must not see an error, and a timeout must not
  // be retried (see below).
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), TRANSCRIPTION_TIMEOUT_MS);
  const onCallerAbort = () => timeoutController.abort();
  request.signal?.addEventListener('abort', onCallerAbort);

  try {
    const form = new FormData();
    // React Native's FormData takes `{ uri, name, type }` as a file part and streams the
    // file off disk. This is the only way to send a local file without materialising it:
    // the base64 alternative would hold a 90 MB recording in a JS string, at roughly 120 MB
    // after encoding, on a device that will kill the app for it.
    //
    // The cast is unavoidable and is a genuine platform difference, not a shortcut — the
    // DOM `FormData` in `lib.dom.d.ts` types the value as `string | Blob`, and React
    // Native's runtime implementation accepts this third shape that the DOM one has no
    // notion of.
    form.append('file', { uri: request.uri, name: request.name, type: transcriptionMimeType(ext, request.mimeType) } as unknown as Blob);
    form.append('model', model);
    // `verbose_json` rather than `json` purely for `segments`. Without the timings this
    // whole feature degrades to a wall of text no citation can point into.
    form.append('response_format', 'verbose_json');
    // Whisper is not a sampling model in the way a chat model is, but temperature above 0
    // enables its fallback decoding path, which makes the same recording transcribe
    // differently on two runs. In a product about comparing records against each other,
    // that is the app contradicting itself.
    form.append('temperature', '0');
    if (request.language) form.append('language', request.language);

    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      // `Content-Type` is deliberately absent. A multipart body is only parseable with the
      // boundary token, which the runtime generates and appends when it serialises the
      // FormData; setting the header here would send a boundary-less content type and every
      // request would come back 400.
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: timeoutController.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { status: 'fatal', failure: failure('unavailable', MESSAGES.rejectedKey) };
    }

    if (response.status === 413) {
      // Should be unreachable — `transcribeMedia` checks the size first. Handled anyway
      // because the ceiling is the provider's to change, and the day it drops below 100 MB
      // this must say something true rather than "Groq refused this recording".
      return { status: 'fatal', failure: failure('too_large', MESSAGES.tooLarge) };
    }

    if (response.status === 429) {
      // Groq sends `retry-after` in seconds. Honouring it beats guessing, and ignoring it
      // is how a client turns a rate limit into a ban.
      const header = Number.parseFloat(response.headers.get('retry-after') ?? '');
      const afterMs = Number.isFinite(header) ? Math.min(header * 1000, 20_000) : BACKOFF_BASE_MS * 4;
      return { status: 'retry', afterMs, reason: 'rate_limited' };
    }

    if (response.status === 404 || response.status === 400) {
      // A retired or renamed model. Nothing about this request will fix it; the other model
      // in the chain might answer it.
      return { status: 'next-model' };
    }

    if (response.status >= 500) {
      return { status: 'retry', afterMs: BACKOFF_BASE_MS, reason: 'network' };
    }

    if (!response.ok) {
      return { status: 'fatal', failure: failure('invalid_response', MESSAGES.refused) };
    }

    return { status: 'ok', body: (await response.json()) as unknown };
  } catch {
    if (request.signal?.aborted) {
      return { status: 'fatal', failure: failure('network', MESSAGES.cancelled) };
    }
    if (timeoutController.signal.aborted) {
      // Not retried, and this is where this transport departs from `groq-client` on
      // purpose. There, a timeout is a transient hiccup worth one more cheap request. Here
      // it means the file did not finish uploading in three minutes, so trying again spends
      // another three minutes and another copy of the user's data allowance to reach the
      // same conclusion.
      return { status: 'fatal', failure: failure('network', MESSAGES.timeout) };
    }
    return { status: 'retry', afterMs: BACKOFF_BASE_MS, reason: 'network' };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Reads the fields this module needs out of a `verbose_json` reply. */
function readTranscript(body: unknown): { segments: TimedSegment[]; language: string | null; durationMs: number | null } | null {
  if (typeof body !== 'object' || body === null) return null;
  const reply = body as { segments?: unknown; language?: unknown; duration?: unknown; text?: unknown };

  // `text` is the one field the endpoint always returns, so its absence means this is not a
  // transcript at all — an error envelope, an HTML error page that arrived with a 200, a
  // proxy's interstitial.
  if (typeof reply.text !== 'string') return null;

  const segments = Array.isArray(reply.segments) ? toTimedSegments(reply.segments as WhisperSegment[]) : [];

  const language = typeof reply.language === 'string' && reply.language.trim().length > 0 ? reply.language.trim() : null;
  const duration = typeof reply.duration === 'number' && Number.isFinite(reply.duration) && reply.duration >= 0 ? reply.duration : null;

  return { segments, language, durationMs: duration === null ? null : Math.round(duration * 1000) };
}

/**
 * Transcribes an audio or video file and returns its text with per-span timings.
 *
 * Never throws. Every failure is a typed `TranscriptionFailure` with a sentence from
 * `MESSAGES`, because the caller is `./ingest`, which is documented never to reject a file:
 * a recording that could not be transcribed is still evidence and is still stored.
 *
 * A successful call with zero segments is a real and honest outcome — a recording of a room
 * with nobody speaking. It is reported as success with empty `segments` and empty `text`,
 * and the caller says so; treating it as an error would blame the user for silence.
 */
export async function transcribeMedia(request: TranscriptionRequest): Promise<TranscriptionResult> {
  const ext = extensionOf(request.name);

  // Both local checks run before the key is even looked up, so a file that was never going
  // to work says why immediately instead of first telling the user to configure a key.
  if (!whisperAcceptsExtension(ext)) return failure('unsupported_media', MESSAGES.unsupported);
  if (request.sizeBytes > MAX_TRANSCRIPTION_BYTES) return failure('too_large', MESSAGES.tooLarge);

  const key = request.key ?? (await loadKey('groq')) ?? null;
  if (!key) return failure('unavailable', MESSAGES.unavailable);

  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const sleep = request.sleepImpl ?? wait;
  const started = Date.now();

  let lastFailure: TranscriptionFailure = failure('network', MESSAGES.network);
  let attempts = 0;

  for (const model of TRANSCRIPTION_MODEL_CHAIN) {
    while (attempts < MAX_TOTAL_ATTEMPTS) {
      if (request.signal?.aborted) return failure('network', MESSAGES.cancelled);
      attempts += 1;

      const outcome = await attempt(model, request, ext, key, fetchImpl);

      if (outcome.status === 'fatal') return outcome.failure;
      if (outcome.status === 'next-model') break;

      if (outcome.status === 'retry') {
        lastFailure =
          outcome.reason === 'rate_limited'
            ? failure('rate_limited', MESSAGES.rateLimited)
            : failure('network', MESSAGES.network);
        // No sleep before the last attempt — the delay would buy nothing.
        if (attempts < MAX_TOTAL_ATTEMPTS) await sleep(outcome.afterMs);
        continue;
      }

      const transcript = readTranscript(outcome.body);
      if (transcript === null) {
        lastFailure = failure('invalid_response', MESSAGES.invalid);
        continue;
      }

      return {
        ok: true,
        text: segmentsToText(transcript.segments),
        segments: transcript.segments,
        language: transcript.language,
        durationMs: transcript.durationMs,
        model,
        requestMs: Date.now() - started,
      };
    }
    if (attempts >= MAX_TOTAL_ATTEMPTS) break;
  }

  // `scrubKey` over a message that is already a fixed constant looks redundant, and it is
  // the cheapest possible insurance against the next person adding a provider detail to
  // `MESSAGES` or to a failure built above. Nothing that reaches a user or a stored record
  // from this file leaves without passing through it.
  return { ...lastFailure, error: scrubKey(lastFailure.error, key) };
}

/**
 * Whether transcription can be offered at all.
 *
 * Only checks for a key; deliberately makes no network call. A screen deciding whether to
 * render a "Transcribe" affordance must not spend the user's quota on that decision.
 */
export async function transcriptionAvailable(): Promise<boolean> {
  return (await loadKey('groq')) !== null;
}
