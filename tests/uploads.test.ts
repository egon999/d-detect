/*
 * The add-something flow, minus the screen.
 *
 * Everything here is logic that used to live inside `app/capture.tsx` and could therefore only
 * be checked by holding a phone: what happens to four receipts when the second one is refused,
 * what happens when someone stops the third while the first is still going up, and what the app
 * says when the operating system refuses the microphone. The screen composes these; these are
 * the parts where being wrong costs a person something they cannot get back.
 */

import { describe, it, expect } from 'vitest';

import { ApiError, UPLOAD_CANCELLED } from '../src/api/client';
import {
  AUDIO_SIZE_LIMIT_BYTES,
  RECORDING_HARD_LIMIT_MS,
  RECORDING_SOFT_LIMIT_MS,
  RECORD_TITLE_LIMIT,
  SAVE_SIZE_LIMIT_BYTES,
  createUploadQueue,
  decideAccess,
  formatRecordingLength,
  isUploadCancelled,
  recordingAdvice,
  runTracked,
  spokenRecordingLength,
  titleFromNote,
  tooLargeToSend,
  type AccessNeed,
  type QueueSnapshot,
} from '../src/api/files';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const entries = [
  { id: 'a', label: 'First', payload: 'a' },
  { id: 'b', label: 'Second', payload: 'b' },
  { id: 'c', label: 'Third', payload: 'c' },
];

describe('The queue that sends several picked files', () => {
  it('sends every item in the order they were picked', async () => {
    const sent: string[] = [];
    const queue = createUploadQueue<string, string>(entries, {
      send: async (payload) => {
        sent.push(payload);
        return `${payload}-saved`;
      },
    });

    const final = await queue.start();

    expect(sent).toEqual(['a', 'b', 'c']);
    expect(final.saved).toBe(3);
    expect(final.finished).toBe(true);
    expect(final.running).toBe(false);
    expect(final.items.map((item) => item.fraction)).toEqual([1, 1, 1]);
  });

  it('carries on past a failure, and keeps the server’s own sentence for the one that failed', async () => {
    // Four receipts where the second is a screenshot the server cannot read. Losing the other
    // three with it is the failure this queue exists to prevent.
    const sent: string[] = [];
    const landed: string[] = [];
    const queue = createUploadQueue<string, string>(entries, {
      send: async (payload) => {
        sent.push(payload);
        if (payload === 'b') throw new ApiError(415, 'That file is not something D-Detect can read.', null, null);
        return `${payload}-saved`;
      },
      onSaved: (result) => landed.push(result),
    });

    const final = await queue.start();

    expect(sent).toEqual(['a', 'b', 'c']);
    expect(landed).toEqual(['a-saved', 'c-saved']);
    expect(final.saved).toBe(2);
    expect(final.failed).toBe(1);
    expect(final.finished).toBe(true);

    const failed = final.items.find((item) => item.id === 'b');
    expect(failed?.state).toBe('failed');
    expect(failed?.error).toBe('That file is not something D-Detect can read.');
    // A failure must never be mistaken for the person's own cancellation.
    expect(final.stopped).toBe(0);
  });

  it('describes an unrecognisable failure without leaking it', async () => {
    const queue = createUploadQueue<string, string>([{ id: 'a', label: 'First', payload: 'a' }], {
      send: async () => {
        throw new TypeError('undefined is not an object (evaluating ‘r.blob’)');
      },
    });

    const final = await queue.start();
    const item = final.items[0];
    expect(item?.state).toBe('failed');
    expect(item?.error).toBe('That could not be saved. Please try again.');
    expect(item?.error).not.toContain('undefined');
  });

  it('stops the item that was named, not the one in flight', async () => {
    // The ordering this guards: the first item is already going up, so by the time the person
    // taps stop on the second, every index has shifted in the list they are looking at.
    const gate = deferred<string>();
    const sent: string[] = [];
    const queue = createUploadQueue<string, string>(entries, {
      send: async (payload) => {
        sent.push(payload);
        if (payload === 'a') return gate.promise;
        return `${payload}-saved`;
      },
    });

    const run = queue.start();
    expect(sent).toEqual(['a']);

    queue.stop('b');
    expect(queue.snapshot().items.map((item) => item.state)).toEqual(['sending', 'stopped', 'waiting']);

    gate.resolve('a-saved');
    const final = await run;

    expect(sent).toEqual(['a', 'c']);
    expect(final.items.map((item) => item.state)).toEqual(['saved', 'stopped', 'saved']);
    expect(final.stopped).toBe(1);
    expect(final.failed).toBe(0);
    expect(final.finished).toBe(true);
  });

  it('aborts the item in flight and moves to the next one', async () => {
    const aborted: string[] = [];
    const queue = createUploadQueue<string, string>(entries, {
      send: (payload, handle) =>
        new Promise<string>((resolve, reject) => {
          if (payload !== 'a') {
            resolve(`${payload}-saved`);
            return;
          }
          handle.signal.addEventListener('abort', () => {
            aborted.push(payload);
            reject(new ApiError(0, 'That upload was stopped.', UPLOAD_CANCELLED, null));
          });
        }),
    });

    const run = queue.start();
    queue.stop('a');
    const final = await run;

    expect(aborted).toEqual(['a']);
    expect(final.items.map((item) => item.state)).toEqual(['stopped', 'saved', 'saved']);
    expect(final.items[0]?.error).toBeNull();
  });

  it('disowns a send that lands after the person stopped it', async () => {
    // The race the stop button creates: the bytes were already on their way, so the server may
    // well answer. It is still not something the person asked to keep.
    const gate = deferred<string>();
    const landed: string[] = [];
    const queue = createUploadQueue<string, string>([{ id: 'a', label: 'First', payload: 'a' }], {
      send: () => gate.promise,
      onSaved: (result) => landed.push(result),
    });

    const run = queue.start();
    queue.stop('a');
    gate.resolve('a-saved');
    const final = await run;

    expect(landed).toEqual([]);
    expect(final.saved).toBe(0);
    expect(final.items[0]?.state).toBe('stopped');
  });

  it('stops everything left when the person closes the sheet', async () => {
    const gate = deferred<string>();
    const sent: string[] = [];
    const queue = createUploadQueue<string, string>(entries, {
      send: async (payload) => {
        sent.push(payload);
        if (payload === 'a') return gate.promise;
        return `${payload}-saved`;
      },
    });

    const run = queue.start();
    queue.stopAll();
    gate.resolve('a-saved');
    const final = await run;

    expect(sent).toEqual(['a']);
    expect(final.stopped).toBe(3);
    expect(final.saved).toBe(0);
  });

  it('puts only the failed items back in line when asked to try again', async () => {
    let attempt = 0;
    const sent: string[] = [];
    const queue = createUploadQueue<string, string>(entries, {
      send: async (payload) => {
        sent.push(payload);
        if (payload === 'b') {
          attempt += 1;
          if (attempt === 1) throw new ApiError(0, 'Cannot reach the server.', null, null);
        }
        return `${payload}-saved`;
      },
    });

    await queue.start();
    expect(queue.snapshot().failed).toBe(1);

    queue.retryFailed();
    expect(queue.snapshot().items.map((item) => item.state)).toEqual(['saved', 'waiting', 'saved']);

    const final = await queue.start();
    // Only the one that failed is sent a second time.
    expect(sent).toEqual(['a', 'b', 'c', 'b']);
    expect(final.saved).toBe(3);
    expect(final.failed).toBe(0);
  });

  it('sends again only the one failure the person asked about', async () => {
    const sent: string[] = [];
    let attempt = 0;
    const queue = createUploadQueue<string, string>(entries, {
      send: async (payload) => {
        sent.push(payload);
        if (payload === 'b') {
          attempt += 1;
          if (attempt === 1) throw new ApiError(0, 'Cannot reach the server.', null, null);
        }
        // The third is refused for its size, which a second attempt cannot change.
        if (payload === 'c') throw new ApiError(413, 'That file is too big to send.', null, null);
        return `${payload}-saved`;
      },
    });

    await queue.start();
    expect(queue.snapshot().failed).toBe(2);

    queue.retry('b');
    expect(queue.snapshot().items.map((item) => item.state)).toEqual(['saved', 'waiting', 'failed']);
    // The row put back in line is not still showing why the last attempt failed.
    expect(queue.snapshot().items[1]?.error).toBeNull();
    // The one that was left alone keeps its sentence.
    expect(queue.snapshot().items[2]?.error).toBe('That file is too big to send.');

    const final = await queue.start();
    expect(sent).toEqual(['a', 'b', 'c', 'b']);
    expect(final.saved).toBe(2);
    expect(final.failed).toBe(1);
  });

  it('ignores a request to send again anything that did not fail', async () => {
    const sent: string[] = [];
    const queue = createUploadQueue<string, string>(entries, {
      send: async (payload) => {
        sent.push(payload);
        return `${payload}-saved`;
      },
    });

    await queue.start();
    queue.retry('a');
    queue.retry('nothing-by-that-name');
    const final = await queue.start();

    expect(sent).toEqual(['a', 'b', 'c']);
    expect(final.saved).toBe(3);
  });

  it('reports each item’s own progress, and never a fraction it was not given', async () => {
    const seen: Array<number | null> = [];
    const queue = createUploadQueue<string, string>([{ id: 'a', label: 'First', bytes: 400, payload: 'a' }], {
      send: async (_payload, handle) => {
        handle.onProgress({ sent: 100, total: 400, fraction: 0.25 });
        handle.onProgress({ sent: 300, total: 400, fraction: 0.75 });
        // A platform that cannot measure the body says so rather than guessing.
        handle.onProgress({ sent: 300, total: null, fraction: null });
        return 'a-saved';
      },
      onChange: (snapshot: QueueSnapshot) => {
        const item = snapshot.items[0];
        if (item?.state === 'sending') seen.push(item.fraction);
      },
    });

    await queue.start();
    expect(seen).toEqual([null, 0.25, 0.75, null]);
  });

  it('picks up items added while it is already running', async () => {
    const gate = deferred<string>();
    const sent: string[] = [];
    const queue = createUploadQueue<string, string>([{ id: 'a', label: 'First', payload: 'a' }], {
      send: async (payload) => {
        sent.push(payload);
        if (payload === 'a') return gate.promise;
        return `${payload}-saved`;
      },
    });

    const run = queue.start();
    queue.add([{ id: 'd', label: 'Fourth', payload: 'd' }]);
    gate.resolve('a-saved');
    const final = await run;

    expect(sent).toEqual(['a', 'd']);
    expect(final.saved).toBe(2);
  });

  it('knows a stopped upload from a failed one', () => {
    expect(isUploadCancelled(new ApiError(0, 'That upload was stopped.', UPLOAD_CANCELLED, null))).toBe(true);
    expect(isUploadCancelled(new ApiError(0, 'Cannot reach the server.', null, null))).toBe(false);
    expect(isUploadCancelled(new Error('boom'))).toBe(false);
    expect(isUploadCancelled(null)).toBe(false);
  });
});

describe('The join between a queue and the transport', () => {
  it('cancels the upload when the signal aborts, and tidies up after itself', async () => {
    let cancels = 0;
    const gate = deferred<string>();
    const controller = new AbortController();

    const running = runTracked({ result: gate.promise, cancel: () => (cancels += 1) }, controller.signal);
    expect(cancels).toBe(0);

    controller.abort();
    expect(cancels).toBe(1);

    // The real transport rejects on abort; this fake resolves, which proves the listener is
    // removed either way rather than left attached to a long-lived signal.
    gate.resolve('late');
    await expect(running).resolves.toBe('late');
    controller.abort();
    expect(cancels).toBe(1);
  });

  it('cancels immediately when the signal was already aborted', async () => {
    let cancels = 0;
    const controller = new AbortController();
    controller.abort();

    await runTracked({ result: Promise.resolve('x'), cancel: () => (cancels += 1) }, controller.signal);
    expect(cancels).toBe(1);
  });
});

describe('The clock on a recording', () => {
  it('reads as a stopwatch', () => {
    expect(formatRecordingLength(0)).toBe('0:00');
    expect(formatRecordingLength(900)).toBe('0:00');
    expect(formatRecordingLength(7_000)).toBe('0:07');
    expect(formatRecordingLength(65_000)).toBe('1:05');
    expect(formatRecordingLength(10 * 60_000)).toBe('10:00');
  });

  it('pads the minutes once an hour has passed, so 1:04:09 is not read as four minutes', () => {
    expect(formatRecordingLength(3_600_000)).toBe('1:00:00');
    expect(formatRecordingLength(3_849_000)).toBe('1:04:09');
    expect(formatRecordingLength(2 * 3_600_000 + 11 * 60_000 + 5_000)).toBe('2:11:05');
  });

  it('never produces a negative or nonsense clock', () => {
    expect(formatRecordingLength(-5_000)).toBe('0:00');
    expect(formatRecordingLength(Number.NaN)).toBe('0:00');
    expect(formatRecordingLength(Number.POSITIVE_INFINITY)).toBe('0:00');
  });

  it('says the length in words for someone who cannot see it', () => {
    // A screen reader announces "4:07" as "four oh seven". Someone recording a meeting without
    // sight of the screen needs the other string.
    expect(spokenRecordingLength(0)).toBe('0 seconds');
    expect(spokenRecordingLength(1_000)).toBe('1 second');
    expect(spokenRecordingLength(47_000)).toBe('47 seconds');
    expect(spokenRecordingLength(65_000)).toBe('1 minute 5 seconds');
    expect(spokenRecordingLength(120_000)).toBe('2 minutes');
    expect(spokenRecordingLength(3_600_000)).toBe('1 hour');
    expect(spokenRecordingLength(3_780_000)).toBe('1 hour 3 minutes');
  });

  it('warns about length before the recording becomes a problem, and never with an invented size', () => {
    expect(recordingAdvice(0)).toBeNull();
    expect(recordingAdvice(10 * 60_000)).toBeNull();
    expect(recordingAdvice(RECORDING_SOFT_LIMIT_MS - 1)).toBeNull();

    const long = recordingAdvice(RECORDING_SOFT_LIMIT_MS);
    expect(long?.level).toBe('long');

    const limit = recordingAdvice(RECORDING_HARD_LIMIT_MS);
    expect(limit?.level).toBe('limit');

    expect(RECORDING_SOFT_LIMIT_MS).toBeLessThan(RECORDING_HARD_LIMIT_MS);
    for (const advice of [long, limit]) {
      expect(advice?.message).toBeTruthy();
      // No megabytes, no bitrates, no estimated anything: the only figure a person sees while
      // recording is the elapsed time the recorder actually reported.
      expect(advice?.message).not.toMatch(/\d|MB|kbps|bitrate/i);
    }
  });
});

describe('What to say when the phone refuses', () => {
  const needs: AccessNeed[] = ['camera', 'photos', 'microphone'];

  it('gets out of the way when access was granted', () => {
    for (const need of needs) {
      expect(decideAccess(need, { granted: true, canAskAgain: false })).toEqual({ kind: 'allowed' });
      expect(decideAccess(need, { granted: true, canAskAgain: true })).toEqual({ kind: 'allowed' });
    }
  });

  it('offers another try when the phone will ask again', () => {
    for (const need of needs) {
      const decision = decideAccess(need, { granted: false, canAskAgain: true });
      expect(decision.kind).toBe('retry');
      if (decision.kind === 'retry') {
        expect(decision.action).toBe('Try again');
        // Specifically not "go to your settings": the phone will put up its own prompt again,
        // and sending someone into Settings for that is a longer road to the same place.
        expect(decision.message).not.toMatch(/settings/i);
      }
    }
  });

  it('sends them to settings only when nothing else can change it', () => {
    for (const need of needs) {
      const decision = decideAccess(need, { granted: false, canAskAgain: false });
      expect(decision.kind).toBe('settings');
      if (decision.kind === 'settings') {
        expect(decision.action).toBe('Open settings');
        expect(decision.message).toMatch(/settings/i);
      }
    }
  });

  it('names the thing the person recognises, in words that are not a developer’s', () => {
    const decisions = needs.flatMap((need) => [
      decideAccess(need, { granted: false, canAskAgain: true }),
      decideAccess(need, { granted: false, canAskAgain: false }),
    ]);
    for (const decision of decisions) {
      if (decision.kind === 'allowed') continue;
      expect(decision.message).toMatch(/camera|photos|microphone/i);
      expect(decision.message).not.toMatch(
        /permission|denied|undetermined|granted|status|API|provider|android|ios|capture/i,
      );
      expect(decision.message).toContain('D-Detect');
    }
  });

  it('distinguishes the microphone from the camera, so the sentence matches the button', () => {
    const mic = decideAccess('microphone', { granted: false, canAskAgain: false });
    const camera = decideAccess('camera', { granted: false, canAskAgain: false });
    expect(mic).not.toEqual(camera);
  });
});

describe('Naming a note the person typed', () => {
  it('takes the name from their own first line', () => {
    expect(titleFromNote('Paid the plumber in cash\nHe is coming back on Friday')).toBe(
      'Paid the plumber in cash',
    );
    expect(titleFromNote('Rent for October')).toBe('Rent for October');
  });

  it('skips blank lines and tidies the spacing, without adding a word of its own', () => {
    expect(titleFromNote('\n\n   Deposit returned   \nminus two hundred')).toBe('Deposit returned');
    expect(titleFromNote('Spoke   to\tthe  landlord')).toBe('Spoke to the landlord');
  });

  it('cuts a long first line on a word boundary rather than refusing it', () => {
    const long = `${'word '.repeat(40)}end`;
    const title = titleFromNote(long);
    expect(title.length).toBeLessThanOrEqual(RECORD_TITLE_LIMIT);
    expect(title.endsWith('word')).toBe(true);
    // Every word in the name came out of what they wrote.
    expect(long).toContain(title);
  });

  it('cuts mid-word when there is no break late enough to leave a name', () => {
    const unbroken = 'x'.repeat(RECORD_TITLE_LIMIT + 40);
    expect(titleFromNote(unbroken)).toBe('x'.repeat(RECORD_TITLE_LIMIT));
  });

  it('has nothing to name an empty note', () => {
    expect(titleFromNote('')).toBe('');
    expect(titleFromNote('   \n  ')).toBe('');
  });
});

describe('Things too large to send', () => {
  it('says so before the upload rather than after it', () => {
    expect(tooLargeToSend(SAVE_SIZE_LIMIT_BYTES + 1, 'save')).toMatch(/25 MB/);
    expect(tooLargeToSend(AUDIO_SIZE_LIMIT_BYTES + 1, 'audio')).toMatch(/96 MB/);
  });

  it('lets through anything that fits', () => {
    expect(tooLargeToSend(SAVE_SIZE_LIMIT_BYTES, 'save')).toBeNull();
    expect(tooLargeToSend(2 * 1_048_576, 'save')).toBeNull();
    // Audio is allowed to be far larger than anything else, so a long meeting is not refused
    // against the wrong ceiling.
    expect(tooLargeToSend(50 * 1_048_576, 'audio')).toBeNull();
    expect(tooLargeToSend(50 * 1_048_576, 'save')).not.toBeNull();
  });

  it('never refuses a file it could not measure', () => {
    // The recorder reports no size. Refusing on that basis would block the one upload that
    // cannot be repeated.
    expect(tooLargeToSend(null, 'audio')).toBeNull();
    expect(tooLargeToSend(0, 'save')).toBeNull();
    expect(tooLargeToSend(Number.NaN, 'save')).toBeNull();
  });
});
