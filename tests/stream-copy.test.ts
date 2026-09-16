import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { COPY_CHUNK_BYTES, copyWithDigest, digestStream, type ByteReader, type ByteWriter } from '@services/storage/stream-copy';
import { toTimedSegments, segmentsToText } from '@services/ingestion/transcribe';
import { mergeMediaText, orderRecognisedLines } from '@services/ingestion/video-frames';

/**
 * The chunked byte path, and the two places where a stray newline used to cost a recording
 * its timings.
 *
 * These are regression tests for defects found in the ingestion/storage audit, so each one
 * states the failure it pins rather than the function it calls:
 *
 * - `uploadEvidenceFile` used to read a whole original into one `Uint8Array` and hash it in a
 *   single synchronous call. At the 100 MB ceiling this app accepts, that is 100 MB resident
 *   on a handset whose per-process limit is often 192 MB, plus a second of frozen UI thread.
 *   The replacement streams in 1 MB chunks — so the property that has to hold, and that these
 *   tests pin, is that the streamed digest is *identical* to the whole-buffer one it replaced.
 *   A streaming hash that disagreed would silently invalidate every stored `sha256`, break
 *   `verifyEvidenceFile` for every existing record, and fail the hash check in
 *   `processEvidenceItem` — presenting as "this file was tampered with" on ordinary files.
 *
 * - `toTimedSegments` and `orderRecognisedLines` used to `trim()` their text, which removes
 *   newlines at the ends and leaves them in the middle. One embedded newline makes a single
 *   timed span occupy two lines of the transcript, which stalls the text-matching pointer
 *   described on `IngestResult.timedSegments` and drops the timings of every later span.
 *
 * Nothing here touches the filesystem: `copyWithDigest` takes structural handles, which is
 * what makes the byte-level control flow reachable from a plain Node process at all.
 */

/** A source over a fixed buffer, with the cursor semantics both platform handles have. */
function readerOver(bytes: Uint8Array, options: { stopAfter?: number } = {}): ByteReader & { reads: number[] } {
  let offset = 0;
  const reads: number[] = [];
  return {
    reads,
    readBytes(length: number): Uint8Array {
      // Mirrors the real handles: a read is clamped to what remains, and an exhausted file
      // answers with an empty array rather than throwing.
      if (options.stopAfter !== undefined && offset >= options.stopAfter) return new Uint8Array();
      const end = Math.min(offset + length, bytes.length);
      const chunk = bytes.subarray(offset, end);
      offset = end;
      reads.push(chunk.length);
      return chunk;
    },
  };
}

/** A destination that accumulates what it was handed, so the copy can be compared byte for byte. */
function collectingWriter(): ByteWriter & { written(): Uint8Array } {
  const chunks: Uint8Array[] = [];
  return {
    writeBytes(bytes: Uint8Array) {
      // Copied, not retained: the real handles are handed subarray views over a buffer the
      // caller may reuse, and a test that aliased them could pass while production did not.
      chunks.push(new Uint8Array(bytes));
    },
    written() {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    },
  };
}

/** Deterministic, non-repeating bytes, so a misordered or duplicated chunk cannot go unnoticed. */
function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + (i >> 8) * 17) & 0xff;
  return out;
}

/** No real timers: the production default yields a macrotask per chunk. */
const immediate = () => Promise.resolve();

describe('copyWithDigest — the streamed replacement for a whole-buffer read', () => {
  it('produces exactly the digest a whole-buffer hash would, across many chunks', async () => {
    const bytes = pattern(9000);
    const destination = collectingWriter();

    const result = await copyWithDigest({
      source: readerOver(bytes),
      destination,
      totalBytes: bytes.length,
      chunkBytes: 1000,
      yieldToHost: immediate,
    });

    // The property the entire storage layer rests on. If these ever disagree, every digest
    // written by this build is incompatible with every digest already on a user's device.
    expect(result.sha256).toBe(bytesToHex(sha256(bytes)));
    expect(result.bytesCopied).toBe(bytes.length);
    expect(destination.written()).toEqual(bytes);
  });

  it('agrees with the whole-buffer hash when the file is not a whole number of chunks', async () => {
    // The off-by-one that a "hash the chunks" implementation gets wrong: a final short chunk.
    const bytes = pattern(2561);
    const destination = collectingWriter();

    const result = await copyWithDigest({
      source: readerOver(bytes),
      destination,
      totalBytes: bytes.length,
      chunkBytes: 512,
      yieldToHost: immediate,
    });

    expect(result.sha256).toBe(bytesToHex(sha256(bytes)));
    expect(destination.written()).toEqual(bytes);
  });

  it('never asks for more than one chunk at a time, whatever the file size', async () => {
    // The memory bound is the whole point: peak heap must be the chunk size, not the file
    // size. A regression that read the file in one call would still hash correctly and would
    // still pass every assertion above, so the read sizes themselves have to be pinned.
    const bytes = pattern(10_000);
    const source = readerOver(bytes);

    await copyWithDigest({ source, destination: collectingWriter(), totalBytes: bytes.length, chunkBytes: 1024, yieldToHost: immediate });

    expect(Math.max(...source.reads)).toBeLessThanOrEqual(1024);
    expect(source.reads.reduce((sum, n) => sum + n, 0)).toBe(bytes.length);
  });

  it('yields the thread between chunks so a large copy cannot freeze the UI', async () => {
    const bytes = pattern(4096);
    const yieldToHost = vi.fn(async () => {});

    await copyWithDigest({ source: readerOver(bytes), destination: collectingWriter(), totalBytes: bytes.length, chunkBytes: 1024, yieldToHost });

    // Four chunks, three gaps: the last chunk does not pay for a yield it has no use for.
    expect(yieldToHost).toHaveBeenCalledTimes(3);
  });

  it('stops mid-file when the signal is aborted, rather than finishing the copy', async () => {
    const bytes = pattern(8192);
    const controller = new AbortController();
    const destination = collectingWriter();

    await expect(copyWithDigest({
      source: readerOver(bytes),
      destination,
      totalBytes: bytes.length,
      chunkBytes: 1024,
      signal: controller.signal,
      // Aborting from the yield is what a user pressing Stop actually does: the tap is
      // handled on the thread the copy keeps handing back.
      yieldToHost: async () => { controller.abort(); },
    })).rejects.toThrow(/cancelled/i);

    // Stopped early — the abandoned job must not have written the whole file.
    expect(destination.written().length).toBeLessThan(bytes.length);
  });

  it('refuses a source that ends early instead of storing a truncated original', async () => {
    // A picker cache file reclaimed by the OS mid-copy. Hashing what was read would produce a
    // perfectly valid digest of the wrong file, and write it onto the record as the
    // original's fingerprint — corruption that verifies as correct forever after.
    const bytes = pattern(4096);

    await expect(copyWithDigest({
      source: readerOver(bytes, { stopAfter: 2048 }),
      destination: collectingWriter(),
      totalBytes: bytes.length,
      chunkBytes: 1024,
      yieldToHost: immediate,
    })).rejects.toThrow(/could not be read completely/i);
  });

  it('refuses an empty file with the sentence the queue shows', async () => {
    await expect(copyWithDigest({
      source: readerOver(new Uint8Array()),
      destination: collectingWriter(),
      totalBytes: 0,
      yieldToHost: immediate,
    })).rejects.toThrow(/empty/i);
  });

  it('defaults to 1 MB chunks', () => {
    expect(COPY_CHUNK_BYTES).toBe(1024 * 1024);
  });
});

describe('digestStream — hashing a recording without loading it', () => {
  it('matches the whole-buffer hash, which is what lets audio skip the read entirely', async () => {
    // Audio and video are handed to the transcriber and the frame sampler as a URI; their
    // bytes are never needed in JS. Ingestion previously read a 90 MB recording into memory
    // purely to hash it and then threw the buffer away.
    const bytes = pattern(7000);
    expect(await digestStream({ source: readerOver(bytes), totalBytes: bytes.length, chunkBytes: 1024, yieldToHost: immediate }))
      .toBe(bytesToHex(sha256(bytes)));
  });

  it('refuses a short read rather than returning a digest of the wrong file', async () => {
    const bytes = pattern(4096);
    await expect(digestStream({
      source: readerOver(bytes, { stopAfter: 1024 }),
      totalBytes: bytes.length,
      chunkBytes: 512,
      yieldToHost: immediate,
    })).rejects.toThrow(/could not be read completely/i);
  });
});

describe('a newline inside one span must not desynchronise the timings after it', () => {
  it('keeps one Whisper segment on one line of the transcript', () => {
    // Whisper returns an embedded newline on a long pause or a chunk boundary landing
    // mid-phrase. `trim()` left it in place.
    const segments = toTimedSegments([
      { start: 0, end: 2, text: 'He said he would pay\nby Friday' },
      { start: 2, end: 4, text: 'and then he stopped answering' },
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.text).toBe('He said he would pay by Friday');

    // The contract on `IngestResult.timedSegments`: one line per segment, in order. Before
    // the fix this text had three lines for two segments, so `buildSegments` matched the
    // first line against nothing, stalled its pointer, and lost the timing of every
    // subsequent span in the recording.
    const lines = segmentsToText(segments).split('\n');
    expect(lines).toHaveLength(segments.length);
    expect(lines).toEqual(segments.map((segment) => segment.text));
  });

  it('keeps the line-for-line correspondence over carriage returns and runs of spaces', () => {
    const segments = toTimedSegments([
      { start: 0, end: 1, text: '  Total paid\r\n   INR 40,000.00  ' },
      { start: 1, end: 2, text: 'UTR 40382881' },
    ]);

    expect(segments[0]?.text).toBe('Total paid INR 40,000.00');
    expect(segmentsToText(segments).split('\n')).toHaveLength(2);
  });

  it('still drops a segment that is only whitespace', () => {
    // Whisper emits these around silence. A blank line would break the same correspondence.
    const segments = toTimedSegments([
      { start: 0, end: 1, text: '\n  \r\n ' },
      { start: 1, end: 2, text: 'the only thing said' },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.index).toBe(0);
    expect(segments[0]?.startMs).toBe(1000);
  });

  it('keeps one recognised frame line on one line of the merged video text', () => {
    // The same defect on the other signal: a `RecognisedLine` whose text wraps would
    // contribute two lines but one timed segment.
    // `languages` is empty because ML Kit usually attributes none, and `orderRecognisedLines`
    // reads only the geometry and the text — the field is carried, not consulted.
    const lines = orderRecognisedLines([
      { text: 'Payment successful\nRef 4471', top: 10, left: 0, languages: [] },
      { text: 'INR 40,000.00', top: 40, left: 0, languages: [] },
    ]);

    expect(lines).toEqual(['Payment successful Ref 4471', 'INR 40,000.00']);

    const merged = mergeMediaText({ speech: [], frames: [{ atMs: 5000, lines }] });

    // Every timed segment appears verbatim as its own line of the merged text — the
    // invariant `buildSegments` walks.
    const textLines = merged.text.split('\n');
    for (const segment of merged.timedSegments) {
      expect(textLines).toContain(segment.text);
      expect(segment.text).not.toContain('\n');
    }
    expect(merged.timedSegments).toHaveLength(2);
  });

  it('keeps speech and frame text in step when both signals carry a wrapped line', () => {
    const speech = toTimedSegments([{ start: 14.2, end: 17.8, text: 'I transferred it\nyesterday' }]);
    const frames = [{ atMs: 20_000, lines: orderRecognisedLines([{ text: 'Sent\n40,000', top: 0, left: 0, languages: [] }]) }];

    const merged = mergeMediaText({ speech, frames });
    const textLines = merged.text.split('\n');

    // Indices stay a valid walk order across both sections, and each segment is findable as
    // its own line — the two conditions a citation into a recording depends on.
    merged.timedSegments.forEach((segment, position) => {
      expect(segment.index).toBe(position);
      expect(textLines).toContain(segment.text);
    });
    expect(merged.timedSegments[0]?.startMs).toBe(14_200);
  });
});
