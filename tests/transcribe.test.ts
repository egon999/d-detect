import { describe, expect, it } from 'vitest';

import {
  MAX_TRANSCRIPTION_BYTES,
  TRANSCRIPTION_MODEL_CHAIN,
  segmentsToText,
  toTimedSegments,
  transcribeMedia,
  transcriptionMimeType,
  whisperAcceptsExtension,
} from '@services/ingestion/transcribe';

/**
 * Transcription transport.
 *
 * Every test here injects `fetchImpl` and `sleepImpl`, so nothing reaches the network and no
 * backoff is ever waited out. The `key` seam is used wherever a request has to be made at all,
 * which also keeps the keystore — a native module that does not exist in Node — out of the
 * picture; the one test that omits it is the test for what happens with no key configured.
 *
 * What is worth covering here is not the happy path, which is a JSON parse. It is the decisions:
 * which failures are caught locally before a byte is uploaded, which HTTP statuses retry versus
 * fall through to the next model versus stop, and the seconds-to-milliseconds conversion that
 * every future citation into a recording depends on.
 */

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch double that answers with a queued response per call and records what it was sent. */
function fetchQueue(responses: Response[]): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let next = 0;
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses[next];
    next += 1;
    if (response === undefined) throw new Error('fetch double ran out of queued responses');
    return response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A minimal `verbose_json` body of the shape the endpoint documents. */
const transcriptBody = {
  text: ' I paid him on the fourteenth. He never sent the receipt.',
  language: 'english',
  duration: 6.4,
  segments: [
    { id: 0, start: 0.48, end: 3.12, text: ' I paid him on the fourteenth.' },
    { id: 1, start: 3.4, end: 6.28, text: ' He never sent the receipt.' },
  ],
};

const request = (overrides: Partial<Parameters<typeof transcribeMedia>[0]> = {}) => ({
  uri: 'file:///cache/statement.m4a',
  name: 'statement.m4a',
  mimeType: 'audio/mp4',
  sizeBytes: 1_200_000,
  key: 'gsk_testkeytestkeytestkey',
  sleepImpl: async () => undefined,
  ...overrides,
});

describe('whisperAcceptsExtension', () => {
  it('accepts every container the endpoint documents', () => {
    for (const ext of ['.flac', '.m4a', '.mp3', '.mp4', '.mpeg', '.mpga', '.ogg', '.opus', '.wav', '.webm']) {
      expect(whisperAcceptsExtension(ext)).toBe(true);
    }
  });

  it('accepts .mov, which is the same container as .mp4 under another brand', () => {
    expect(whisperAcceptsExtension('.mov')).toBe(true);
  });

  it('is case insensitive, because a camera writes .MOV and a picker passes it through', () => {
    expect(whisperAcceptsExtension('.MOV')).toBe(true);
    expect(whisperAcceptsExtension('.M4A')).toBe(true);
  });

  it('refuses containers a phone can produce that Whisper cannot read', () => {
    // .3gp in particular: it is what expo-audio's LOW_QUALITY preset writes on Android, which
    // is why the recorder in `src/features/evidence/media-recorder.tsx` uses HIGH_QUALITY.
    for (const ext of ['.3gp', '.aac', '.amr', '.mkv', '.avi', '.wma', '']) {
      expect(whisperAcceptsExtension(ext)).toBe(false);
    }
  });
});

describe('transcriptionMimeType', () => {
  it('prefers a declared media type over the extension', () => {
    expect(transcriptionMimeType('.mp4', 'video/quicktime')).toBe('video/quicktime');
  });

  it('drops parameters from a declared type', () => {
    expect(transcriptionMimeType('.webm', 'video/webm; codecs="vp9,opus"')).toBe('video/webm');
  });

  it('ignores the octet-stream that Android pickers report for perfectly clear files', () => {
    expect(transcriptionMimeType('.m4a', 'application/octet-stream')).toBe('audio/mp4');
  });

  it('derives a type from the extension when none is declared', () => {
    expect(transcriptionMimeType('.mp3', null)).toBe('audio/mpeg');
    expect(transcriptionMimeType('.wav')).toBe('audio/wav');
    expect(transcriptionMimeType('.mov', '')).toBe('video/quicktime');
  });
});

describe('toTimedSegments', () => {
  it('converts Whisper seconds to milliseconds, rounding rather than truncating', () => {
    const segments = toTimedSegments([{ start: 14.2049, end: 17.8451, text: 'It was paid.' }]);
    expect(segments).toEqual([
      { index: 0, text: 'It was paid.', startMs: 14205, endMs: 17845, source: 'speech' },
    ]);
  });

  it('trims the leading space Whisper puts on every segment', () => {
    const segments = toTimedSegments([{ start: 0, end: 1, text: '  Yes.  ' }]);
    expect(segments[0]?.text).toBe('Yes.');
  });

  it('drops blank segments and renumbers so index stays a position into this array', () => {
    const segments = toTimedSegments([
      { start: 0, end: 1, text: 'One' },
      { start: 1, end: 2, text: '   ' },
      { start: 2, end: 3, text: 'Two' },
    ]);
    expect(segments.map((segment) => [segment.index, segment.text])).toEqual([
      [0, 'One'],
      [1, 'Two'],
    ]);
  });

  it('keeps a segment with no usable end but omits endMs rather than inventing one', () => {
    const segments = toTimedSegments([
      { start: 5, text: 'No end reported' },
      { start: 9, end: 4, text: 'End before start' },
    ]);
    expect(segments).toEqual([
      { index: 0, text: 'No end reported', startMs: 5000, source: 'speech' },
      { index: 1, text: 'End before start', startMs: 9000, source: 'speech' },
    ]);
    expect(segments[0] && 'endMs' in segments[0]).toBe(false);
  });

  it('drops a segment with no usable start, because an untimed span cannot be cited', () => {
    expect(toTimedSegments([{ end: 3, text: 'When?' }, { start: -1, text: 'Negative' }])).toEqual([]);
  });

  it('tags a different source when asked, for frame text', () => {
    const segments = toTimedSegments([{ start: 1, end: 2, text: 'Total 1200' }], 'frame-text');
    expect(segments[0]?.source).toBe('frame-text');
  });
});

describe('segmentsToText', () => {
  it('puts one segment per line, which is what the extractor cuts on', () => {
    const segments = toTimedSegments(transcriptBody.segments);
    expect(segmentsToText(segments)).toBe('I paid him on the fourteenth.\nHe never sent the receipt.');
  });
});

describe('transcribeMedia local refusals', () => {
  it('refuses an unreadable container without uploading anything', async () => {
    const { impl, calls } = fetchQueue([]);
    const result = await transcribeMedia(request({ name: 'clip.3gp', fetchImpl: impl }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported_media');
    expect(calls).toHaveLength(0);
  });

  it('refuses an oversize file locally rather than discovering it from a 413', async () => {
    const { impl, calls } = fetchQueue([]);
    const result = await transcribeMedia(
      request({ sizeBytes: MAX_TRANSCRIPTION_BYTES + 1, fetchImpl: impl }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_large');
    expect(result.error).toContain('100 MB');
    expect(calls).toHaveLength(0);
  });

  it('allows a file exactly on the limit', async () => {
    const { impl, calls } = fetchQueue([json(transcriptBody)]);
    const result = await transcribeMedia(
      request({ sizeBytes: MAX_TRANSCRIPTION_BYTES, fetchImpl: impl }),
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('reports a missing key as an expected state and points at Settings', async () => {
    // No `key` seam and no keystore in Node, so `loadKey` resolves null — the fresh-install path.
    const { impl, calls } = fetchQueue([]);
    const result = await transcribeMedia({
      uri: 'file:///cache/statement.m4a',
      name: 'statement.m4a',
      mimeType: 'audio/mp4',
      sizeBytes: 1000,
      fetchImpl: impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
    expect(result.error).toContain('Settings');
    expect(calls).toHaveLength(0);
  });

  it('stops before the request when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl, calls } = fetchQueue([]);
    const result = await transcribeMedia(request({ fetchImpl: impl, signal: controller.signal }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('network');
    expect(result.error).toBe('Cancelled.');
    expect(calls).toHaveLength(0);
  });
});

describe('transcribeMedia request shape', () => {
  it('posts multipart to the audio endpoint with the key as a bearer token', async () => {
    const { impl, calls } = fetchQueue([json(transcriptBody)]);
    await transcribeMedia(request({ fetchImpl: impl }));

    const call = calls[0];
    expect(call?.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toEqual({ Authorization: 'Bearer gsk_testkeytestkeytestkey' });
  });

  it("never sets Content-Type itself, because the boundary is the runtime's to generate", async () => {
    const { impl, calls } = fetchQueue([json(transcriptBody)]);
    await transcribeMedia(request({ fetchImpl: impl }));

    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('content-type');
  });

  it('asks for verbose_json at temperature zero so two runs of one recording agree', async () => {
    const { impl, calls } = fetchQueue([json(transcriptBody)]);
    await transcribeMedia(request({ fetchImpl: impl }));

    const form = calls[0]?.init.body as FormData;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('temperature')).toBe('0');
    expect(form.get('model')).toBe(TRANSCRIPTION_MODEL_CHAIN[0]);
  });

  it('omits the language field unless the caller actually knows one', async () => {
    const bare = fetchQueue([json(transcriptBody)]);
    await transcribeMedia(request({ fetchImpl: bare.impl }));
    expect((bare.calls[0]?.init.body as FormData).get('language')).toBeNull();

    const hinted = fetchQueue([json(transcriptBody)]);
    await transcribeMedia(request({ fetchImpl: hinted.impl, language: 'hi' }));
    expect((hinted.calls[0]?.init.body as FormData).get('language')).toBe('hi');
  });

  it('passes an abort signal so the timeout can fire', async () => {
    const { impl, calls } = fetchQueue([json(transcriptBody)]);
    await transcribeMedia(request({ fetchImpl: impl }));
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('transcribeMedia success', () => {
  it('returns the transcript as lines with millisecond timings and Whisper metadata', async () => {
    const { impl } = fetchQueue([json(transcriptBody)]);
    const result = await transcribeMedia(request({ fetchImpl: impl }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('I paid him on the fourteenth.\nHe never sent the receipt.');
    expect(result.segments).toEqual([
      { index: 0, text: 'I paid him on the fourteenth.', startMs: 480, endMs: 3120, source: 'speech' },
      { index: 1, text: 'He never sent the receipt.', startMs: 3400, endMs: 6280, source: 'speech' },
    ]);
    expect(result.language).toBe('english');
    expect(result.durationMs).toBe(6400);
    expect(result.model).toBe(TRANSCRIPTION_MODEL_CHAIN[0]);
  });

  it('treats a recording with no speech as an honest success, not a failure', async () => {
    const { impl } = fetchQueue([json({ text: '', language: null, duration: 12, segments: [] })]);
    const result = await transcribeMedia(request({ fetchImpl: impl }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('');
    expect(result.segments).toEqual([]);
    expect(result.language).toBeNull();
    expect(result.durationMs).toBe(12000);
  });
});

describe('transcribeMedia failures', () => {
  it('stops on a rejected key and says to check it, not that Groq is down', async () => {
    const { impl, calls } = fetchQueue([json({ error: 'invalid api key' }, 401)]);
    const result = await transcribeMedia(request({ fetchImpl: impl }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
    expect(result.error).toContain('did not accept that key');
    // One attempt only. A key that was refused will be refused again.
    expect(calls).toHaveLength(1);
  });

  it('honours retry-after on a 429 and succeeds on the retry', async () => {
    const { impl, calls } = fetchQueue([
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      json(transcriptBody),
    ]);
    const slept: number[] = [];
    const result = await transcribeMedia(
      request({
        fetchImpl: impl,
        sleepImpl: async (ms) => {
          slept.push(ms);
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(slept).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it('caps a hostile retry-after rather than sleeping for an hour', async () => {
    const { impl } = fetchQueue([
      new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
      json(transcriptBody),
    ]);
    const slept: number[] = [];
    await transcribeMedia(
      request({
        fetchImpl: impl,
        sleepImpl: async (ms) => {
          slept.push(ms);
        },
      }),
    );

    expect(slept).toEqual([20_000]);
  });

  it('gives up as rate limited after the attempt budget, without re-uploading forever', async () => {
    const { impl, calls } = fetchQueue([
      new Response('', { status: 429 }),
      new Response('', { status: 429 }),
      new Response('', { status: 429 }),
    ]);
    const result = await transcribeMedia(request({ fetchImpl: impl }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('rate_limited');
    // Three total attempts across the whole chain, because each one re-uploads the file.
    expect(calls).toHaveLength(3);
  });

  it('falls through to the next model when the first is retired', async () => {
    const { impl, calls } = fetchQueue([json({ error: 'model not found' }, 404), json(transcriptBody)]);
    const result = await transcribeMedia(request({ fetchImpl: impl }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe(TRANSCRIPTION_MODEL_CHAIN[1]);
    expect((calls[0]?.init.body as FormData).get('model')).toBe(TRANSCRIPTION_MODEL_CHAIN[0]);
    expect((calls[1]?.init.body as FormData).get('model')).toBe(TRANSCRIPTION_MODEL_CHAIN[1]);
  });

  it('retries a server error and then succeeds', async () => {
    const { impl, calls } = fetchQueue([new Response('', { status: 503 }), json(transcriptBody)]);
    const result = await transcribeMedia(request({ fetchImpl: impl }));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('reports a 200 that is not a transcript as an unreadable reply', async () => {
    // An HTML interstitial from a captive portal, or an error envelope with a 200.
    const { impl } = fetchQueue([json({ error: 'nope' }), json({ error: 'nope' }), json({ error: 'nope' })]);
    const result = await transcribeMedia(request({ fetchImpl: impl }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_response');
  });

  it('reports a transport throw as a network failure without leaking the exception', async () => {
    const impl = (async () => {
      throw new TypeError('Network request failed: gsk_testkeytestkeytestkey leaked here');
    }) as unknown as typeof fetch;
    const result = await transcribeMedia(request({ fetchImpl: impl }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('network');
    expect(result.error).not.toContain('gsk_');
    expect(result.error).not.toContain('Network request failed');
  });
});
