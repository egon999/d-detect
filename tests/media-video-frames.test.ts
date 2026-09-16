import { describe, expect, it } from 'vitest';

import { classifyDocumentType, extractFromText } from '@domain/extraction/deterministic';
import type { RecognisedLine } from '@services/ingestion/ocr';
import type { TimedSegment } from '@services/ingestion/types';
import {
  FRAME_TEXT_HEADING,
  MAX_FRAMES,
  SPEECH_HEADING,
  TARGET_INTERVAL_MS,
  dedupeFrameReadings,
  frameSimilarity,
  mergeMediaText,
  orderRecognisedLines,
  planFrameTimes,
} from '@services/ingestion/video-frames';

/**
 * The pure half of the video path: which frames get sampled, what order their text comes out
 * in, which frames are the same picture twice, and how the two signals are merged.
 *
 * `readVideoFrameText` itself is not here and cannot be: it drives `expo-video-thumbnails`,
 * `expo-file-system` and the ML Kit binding, none of which exist in Node. Everything it decides
 * before touching them is in these functions.
 *
 * The last block is the important one. It runs the merged text through the real deterministic
 * extractor and reproduces the handoff documented on `IngestResult.timedSegments`, which is the
 * only way to establish that this output format does not mislead the code that will consume it.
 */

const line = (text: string, top: number | null, left: number | null = 0): RecognisedLine => ({
  text,
  top,
  left,
  languages: [],
});

/** `count` distinct tokens starting at `from`, as one line of text. */
const tokens = (from: number, count: number): string =>
  Array.from({ length: count }, (_, index) => `w${from + index}`).join(' ');

describe('planFrameTimes', () => {
  it('samples slice midpoints, not slice starts', () => {
    // The first frame of a recording is very often a black frame or a fade-in, and the final
    // millisecond frequently refuses to decode. Midpoints avoid both without special cases.
    const plan = planFrameTimes(12_000);
    expect(plan.times).toEqual([2000, 6000, 10_000]);
    expect(plan.intervalMs).toBe(4000);
  });

  it('covers a short clip at roughly the target interval', () => {
    const plan = planFrameTimes(60_000);
    expect(plan.times).toHaveLength(12);
    expect(plan.intervalMs).toBe(TARGET_INTERVAL_MS);
  });

  it('takes one frame from a clip shorter than the interval', () => {
    expect(planFrameTimes(2000)).toEqual({ times: [1000], intervalMs: 2000 });
  });

  it('caps a long recording at the frame budget and spreads them evenly', () => {
    const plan = planFrameTimes(30 * 60 * 1000);
    expect(plan.times).toHaveLength(MAX_FRAMES);
    expect(plan.intervalMs).toBe(150_000);
    expect(plan.times[0]).toBe(75_000);
    expect(plan.times[MAX_FRAMES - 1]).toBe(1_725_000);
    // Never past the end, which is what would make the decoder refuse the tail.
    expect(plan.times[MAX_FRAMES - 1]).toBeLessThan(30 * 60 * 1000);
  });

  it('falls back to a fixed ladder when the duration is unknown', () => {
    const plan = planFrameTimes(null);
    expect(plan.times).toHaveLength(MAX_FRAMES);
    expect(plan.times[0]).toBe(2500);
    expect(plan.times[1]).toBe(7500);
    expect(plan.intervalMs).toBe(TARGET_INTERVAL_MS);
  });

  it('treats a zero, negative or non-finite duration as unknown rather than as a clip', () => {
    const ladder = planFrameTimes(null);
    expect(planFrameTimes(0)).toEqual(ladder);
    expect(planFrameTimes(-1)).toEqual(ladder);
    expect(planFrameTimes(Number.NaN)).toEqual(ladder);
    expect(planFrameTimes(Number.POSITIVE_INFINITY)).toEqual(ladder);
  });
});

describe('orderRecognisedLines', () => {
  it('sorts top to bottom, because ML Kit does not emit blocks in reading order', () => {
    // On a chat screenshot an unordered read can put a reply above the message it answers,
    // which inverts the meaning of the conversation.
    const ordered = orderRecognisedLines([
      line('I will send it tomorrow', 240),
      line('Where is the receipt?', 120),
    ]);
    expect(ordered).toEqual(['Where is the receipt?', 'I will send it tomorrow']);
  });

  it('breaks a tie on the same row left to right', () => {
    expect(orderRecognisedLines([line('45,000.00', 100, 300), line('Total', 100, 40)])).toEqual([
      'Total',
      '45,000.00',
    ]);
  });

  it('leaves lines with no geometry where they were rather than guessing', () => {
    const ordered = orderRecognisedLines([
      line('no frame reported', null),
      line('bottom', 500),
      line('top', 10),
    ]);
    // The two positioned lines sort against each other; the unpositioned one keeps its
    // original relative place instead of being pushed to an end nothing measured.
    expect(ordered).toEqual(['no frame reported', 'top', 'bottom']);
  });

  it('drops blank lines and trims the rest', () => {
    expect(orderRecognisedLines([line('   ', 10), line('  Paid  ', 20)])).toEqual(['Paid']);
  });
});

describe('frameSimilarity', () => {
  it('is 1 for the same text and 0 for nothing in common', () => {
    expect(frameSimilarity('Payment successful', 'Payment successful')).toBe(1);
    expect(frameSimilarity('Payment successful', 'Delivery pending')).toBe(0);
  });

  it('treats two empty frames as the same and an empty against a full one as different', () => {
    expect(frameSimilarity('', '')).toBe(1);
    expect(frameSimilarity('', 'Payment successful')).toBe(0);
  });

  it('ignores word order, because position in a frame of a UI is not information', () => {
    expect(frameSimilarity('Total paid 1200', '1200 paid Total')).toBe(1);
  });
});

describe('dedupeFrameReadings', () => {
  it('collapses the identical tail frames an unknown duration produces', () => {
    // Android answers a request past the end of a video with the final frame rather than an
    // error, so the fixed ladder in `planFrameTimes` reads the same picture several times.
    const last = { atMs: 40_000, lines: ['Payment successful', 'INR 45,000.00'] };
    const kept = dedupeFrameReadings([
      { atMs: 5000, lines: ['Opening the app'] },
      last,
      { atMs: 45_000, lines: [...last.lines] },
      { atMs: 50_000, lines: [...last.lines] },
    ]);
    expect(kept.map((frame) => frame.atMs)).toEqual([5000, 40_000]);
  });

  it('collapses a dense screen whose only change is the clock and the battery', () => {
    const screen = (clock: string, battery: string) => [
      clock,
      `${battery}%`,
      tokens(1, 40),
    ];
    const kept = dedupeFrameReadings([
      { atMs: 0, lines: screen('432', '82') },
      { atMs: 5000, lines: screen('433', '81') },
    ]);
    expect(kept).toHaveLength(1);
  });

  it('keeps both frames of a sparse screen, where the same change is most of the content', () => {
    // Documented behaviour rather than a wart: erring towards keeping a frame costs a repeated
    // block of text, while dropping one costs whatever figure had changed on it.
    const kept = dedupeFrameReadings([
      { atMs: 0, lines: ['432', 'Paid'] },
      { atMs: 5000, lines: ['433', 'Paid'] },
    ]);
    expect(kept).toHaveLength(2);
  });

  it('compares against the last kept frame, so a slow scroll eventually earns an entry', () => {
    // Each frame is a near-duplicate of the one before it, but the drift accumulates. Comparing
    // neighbours would keep only the first; comparing against the last kept keeps the drift.
    const kept = dedupeFrameReadings([
      { atMs: 0, lines: [tokens(1, 20)] },
      { atMs: 5000, lines: [tokens(2, 20)] },
      { atMs: 10_000, lines: [tokens(3, 20)] },
      { atMs: 15_000, lines: [tokens(4, 20)] },
    ]);
    expect(kept.map((frame) => frame.atMs)).toEqual([0, 10_000]);
  });

  it('drops a frame that had no readable text at all', () => {
    expect(dedupeFrameReadings([{ atMs: 0, lines: [] }, { atMs: 5000, lines: ['Paid'] }])).toEqual([
      { atMs: 5000, lines: ['Paid'] },
    ]);
  });
});

const speech: TimedSegment[] = [
  { index: 0, text: 'I transferred it on the fourteenth.', startMs: 480, endMs: 3120, source: 'speech' },
  { index: 1, text: 'He says he never got it.', startMs: 3400, endMs: 6280, source: 'speech' },
];

const frames = [
  { atMs: 12_000, lines: ['Payment successful', 'Amount INR 45,000.00'] },
  { atMs: 24_000, lines: ['UPI reference 402113998211'] },
];

describe('mergeMediaText', () => {
  it('produces nothing at all from nothing', () => {
    expect(mergeMediaText({ speech: [], frames: [] })).toEqual({ text: '', timedSegments: [] });
  });

  it('omits the heading for a signal that produced no text', () => {
    const speechOnly = mergeMediaText({ speech, frames: [] });
    expect(speechOnly.text).toContain(SPEECH_HEADING);
    expect(speechOnly.text).not.toContain(FRAME_TEXT_HEADING);

    const framesOnly = mergeMediaText({ speech: [], frames });
    expect(framesOnly.text).toContain(FRAME_TEXT_HEADING);
    expect(framesOnly.text).not.toContain(SPEECH_HEADING);
  });

  it('puts speech first and keeps the two signals visually distinguishable', () => {
    const merged = mergeMediaText({ speech, frames });
    expect(merged.text.indexOf(SPEECH_HEADING)).toBeLessThan(merged.text.indexOf(FRAME_TEXT_HEADING));
  });

  it('re-indexes across both sections and carries the right clock positions', () => {
    const merged = mergeMediaText({ speech, frames });
    expect(merged.timedSegments.map((segment) => segment.index)).toEqual([0, 1, 2, 3, 4]);
    expect(merged.timedSegments.map((segment) => segment.source)).toEqual([
      'speech',
      'speech',
      'frame-text',
      'frame-text',
      'frame-text',
    ]);
    expect(merged.timedSegments.map((segment) => segment.startMs)).toEqual([
      480, 3400, 12_000, 12_000, 24_000,
    ]);
  });

  it('gives frame text a start but no end, because an instant is not an interval', () => {
    const merged = mergeMediaText({ speech: [], frames });
    for (const segment of merged.timedSegments) {
      expect('endMs' in segment).toBe(false);
    }
  });

  it('emits one segment per recognised line, so a labelled value keeps its own line', () => {
    const merged = mergeMediaText({ speech: [], frames });
    expect(merged.timedSegments.map((segment) => segment.text)).toEqual([
      'Payment successful',
      'Amount INR 45,000.00',
      'UPI reference 402113998211',
    ]);
  });

  it('keeps every segment as its own verbatim line of the text, in the same order', () => {
    // This correspondence is the whole contract the timing handoff rests on.
    const merged = mergeMediaText({ speech, frames });
    const content = merged.text
      .split('\n')
      .filter((row) => row.length > 0 && row !== SPEECH_HEADING && row !== FRAME_TEXT_HEADING);
    expect(content).toEqual(merged.timedSegments.map((segment) => segment.text));
  });

  it('separates frames with a blank line so one screen does not read as the next', () => {
    const merged = mergeMediaText({ speech: [], frames });
    expect(merged.text).toBe(
      [
        FRAME_TEXT_HEADING,
        '',
        'Payment successful',
        'Amount INR 45,000.00',
        '',
        'UPI reference 402113998211',
      ].join('\n'),
    );
  });
});

describe('the merged format against the real extractor', () => {
  const merged = mergeMediaText({ speech, frames });
  const extract = () =>
    extractFromText({
      evidenceId: 'evd_video',
      title: 'Screen recording',
      text: merged.text,
      method: 'DETERMINISTIC',
    });

  it('uses headings that cannot be read as a chat timestamp', () => {
    // `classifyDocumentType` labels anything containing a `[0:09]`-style marker a chat export,
    // so the obvious per-line timestamp prefix would make the extractor confident and wrong.
    expect(`${SPEECH_HEADING}\n${FRAME_TEXT_HEADING}`).not.toMatch(/\[\d{1,2}:\d{2}\]/);
    expect(classifyDocumentType(merged.text)).not.toBe('Chat export');
  });

  it('uses headings that cannot be read as a labelled value', () => {
    // `extractParties` and `extractChatMessages` both key off `Label: value` on its own line.
    expect(SPEECH_HEADING).not.toContain(':');
    expect(FRAME_TEXT_HEADING).not.toContain(':');
    expect(extract().parties).toEqual([]);
  });

  it('leaves an on-screen amount readable, prefix-free, with its label still in context', () => {
    const amounts = extract().amounts.map((field) => field.normalized);
    expect(amounts).toContain(45000);
  });

  it('supports the documented timing handoff into buildSegments', () => {
    // Reproduces, without touching `src/domain/extraction/deterministic.ts`, exactly what the
    // note on `IngestResult.timedSegments` asks that file to do: walk the built segments with a
    // pointer over the timed list, and advance only on a text match.
    const built = extract().segments;
    const timed = new Map<string, TimedSegment>();
    let pointer = 0;
    for (const segment of built) {
      const candidate = merged.timedSegments[pointer];
      if (candidate !== undefined && candidate.text === segment.text.trim()) {
        timed.set(segment.id, candidate);
        pointer += 1;
      }
    }

    // Every timing found a home, and the two headings were skipped rather than mistimed.
    expect(pointer).toBe(merged.timedSegments.length);
    expect(timed.size).toBe(merged.timedSegments.length);
    expect(built).toHaveLength(merged.timedSegments.length + 2);

    const receipt = built.find((segment) => segment.text.includes('never got it'));
    expect(receipt).toBeDefined();
    expect(timed.get(receipt?.id ?? '')?.startMs).toBe(3400);
    expect(timed.get(receipt?.id ?? '')?.endMs).toBe(6280);
  });

  it('does not mistime a repeated line, which is why the pointer only advances on a match', () => {
    const repeated = mergeMediaText({
      speech: [
        { index: 0, text: 'Yes.', startMs: 1000, endMs: 1400, source: 'speech' },
        { index: 1, text: 'Was it paid in full?', startMs: 2000, endMs: 3000, source: 'speech' },
        { index: 2, text: 'Yes.', startMs: 9000, endMs: 9400, source: 'speech' },
      ],
      frames: [],
    });
    const built = extractFromText({
      evidenceId: 'evd_audio',
      title: 'Statement',
      text: repeated.text,
      method: 'DETERMINISTIC',
    }).segments;

    const starts: number[] = [];
    let pointer = 0;
    for (const segment of built) {
      const candidate = repeated.timedSegments[pointer];
      if (candidate !== undefined && candidate.text === segment.text.trim()) {
        starts.push(candidate.startMs);
        pointer += 1;
      }
    }
    expect(starts).toEqual([1000, 2000, 9000]);
  });
});
