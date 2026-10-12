/**
 * The home timeline's pure logic.
 *
 * The home screen is a rendering of six decisions, all of which live outside it so that they
 * can be checked here rather than guessed at by scrolling a phone: which calendar day a thing
 * belongs to, which rows the server is still working on, how long to wait before asking it
 * again, whether a reply changed anything, and which month the timeline has been sent to.
 *
 * Each test below exists because the failure it catches is silent. A day boundary worked out in
 * UTC files an Indian evening under tomorrow and nobody notices until the date is wrong on a
 * receipt they need. A backoff that never returns `null` keeps a phone asking an unreachable
 * server all afternoon. A change-detector that misses a field freezes the one sentence the
 * reader is watching. A month jump with no way back looks like the newer half of somebody's
 * records has been deleted. None of these throw; they are all just quietly wrong.
 *
 * What a search box does with a keystroke, and where each kind of result opens, used to be
 * tested here because the home screen had a search box of its own. It does not any more —
 * there is one box, on its own screen — so those live in their own describe blocks below,
 * against `src/api/search.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  POLL_MAX_ATTEMPTS,
  POLL_STEPS_MS,
  buildTimeline,
  dayHeading,
  dayKey,
  entryTime,
  groupTimelineByDay,
  inProgressKey,
  inProgressMeetingIds,
  inProgressRecordIds,
  isMeetingInProgress,
  isRecordInProgress,
  jumpSummary,
  meetingTime,
  meetingsUnchanged,
  monthKey,
  monthLabel,
  pollDelayMs,
  recentMonths,
  recordsUnchanged,
  startOfDay,
  startOfMonthKey,
  type DaybookRecord,
  type DaybookStatus,
  type TimelineEntry,
} from '../src/api/daybook';
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_DEBOUNCE_SHORT_MS,
  SEARCH_MIN_CHARS,
  destinationFor,
  planSearch,
  type SearchResult,
} from '../src/api/search';
import type { Meeting, MeetingStatus } from '../src/api/meetings';

/**
 * A saved entry, with only the fields a test cares about spelled out.
 *
 * Built from the real type rather than a loose object, so a field added to a record forces this
 * factory to be updated instead of letting a test keep passing against a shape that no longer
 * exists.
 */
function record(over: Partial<DaybookRecord> & { id: string }): DaybookRecord {
  return {
    kind: 'payment',
    title: 'Something',
    occurredAt: null,
    occurredPrecision: null,
    amountMinor: null,
    currency: null,
    amountLabel: null,
    direction: null,
    counterparty: null,
    category: null,
    note: null,
    fileId: null,
    status: 'complete' as DaybookStatus,
    createdAt: 0,
    updatedAt: 0,
    extraction: null,
    question: null,
    progress: null,
    ...over,
  };
}

function meeting(over: Partial<Meeting> & { id: string }): Meeting {
  return {
    title: 'A conversation',
    status: 'complete' as MeetingStatus,
    language: null,
    durationMs: null,
    startedAt: null,
    startedAtEstimated: false,
    note: '',
    endedAt: null,
    createdAt: 0,
    updatedAt: 0,
    error: null,
    fileId: null,
    summary: null,
    intelligence: {},
    tasks: [],
    ...over,
  };
}

/** A local instant, built from local parts so the test means the same thing in every timezone. */
function at(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime();
}

// ---------------------------------------------------------------------------
// Which day a thing belongs to
// ---------------------------------------------------------------------------

describe('day keys and headings', () => {
  /**
   * The bug this exists for: `toISOString().slice(0, 10)` is UTC, so every evening after 17:30
   * in India would be filed under the following day — a bill paid on Monday night appearing
   * under Tuesday, with no error anywhere to say so.
   */
  it('files an instant under its local calendar day, not its UTC one', () => {
    expect(dayKey(at(2026, 1, 31, 23, 59))).toBe('2026-01-31');
    expect(dayKey(at(2026, 1, 31, 0, 1))).toBe('2026-01-31');
    expect(dayKey(at(2026, 2, 1, 0, 1))).toBe('2026-02-01');
  });

  it('pads single-digit months and days so the key sorts as a string', () => {
    expect(dayKey(at(2026, 2, 3))).toBe('2026-02-03');
  });

  it('anchors a day at local midnight', () => {
    const midnight = new Date(startOfDay(at(2026, 2, 1, 18, 42, 13, 500)));
    expect(midnight.getHours()).toBe(0);
    expect(midnight.getMinutes()).toBe(0);
    expect(midnight.getSeconds()).toBe(0);
    expect(midnight.getMilliseconds()).toBe(0);
    expect(dayKey(midnight.getTime())).toBe('2026-02-01');
  });

  it('says Today and Yesterday, and steps the calendar back across a month boundary', () => {
    const now = at(2026, 2, 1, 9, 30);
    expect(dayHeading(now, now)).toBe('Today');
    expect(dayHeading(at(2026, 2, 1, 23, 50), now)).toBe('Today');
    // 31 January is yesterday relative to 1 February — the step is a calendar one, so the
    // shorter month does not matter.
    expect(dayHeading(at(2026, 1, 31, 8, 0), now)).toBe('Yesterday');
  });

  it('writes an older day out, and only names the year when it is a different one', () => {
    const now = at(2026, 2, 1, 9, 30);

    const sameYear = dayHeading(at(2026, 1, 20), now, 'en-GB');
    expect(sameYear).toContain('20');
    expect(sameYear).toContain('January');
    expect(sameYear).not.toContain('2026');

    const otherYear = dayHeading(at(2025, 12, 20), now, 'en-GB');
    expect(otherYear).toContain('2025');
  });

  it('takes no locale of its own, so the device decides', () => {
    // The point of the optional argument: the screen never passes one, and the result is
    // whatever the phone is set to. Passing two different locales must give two different
    // strings, which is only true if the argument reaches `toLocaleDateString`.
    const now = at(2026, 2, 1);
    const gb = dayHeading(at(2026, 1, 20), now, 'en-GB');
    const de = dayHeading(at(2026, 1, 20), now, 'de-DE');
    expect(gb).not.toBe(de);
  });
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe('grouping the timeline by day', () => {
  it('cuts a run of entries into days, newest day first, across a month boundary', () => {
    const entries: TimelineEntry[] = [
      { kind: 'entry', key: 'entry:a', at: at(2026, 1, 30, 10), record: record({ id: 'a' }) },
      { kind: 'entry', key: 'entry:b', at: at(2026, 2, 1, 9), record: record({ id: 'b' }) },
      { kind: 'entry', key: 'entry:c', at: at(2026, 1, 31, 23, 30), record: record({ id: 'c' }) },
      { kind: 'entry', key: 'entry:d', at: at(2026, 1, 31, 7, 15), record: record({ id: 'd' }) },
    ];

    const days = groupTimelineByDay(entries);

    expect(days.map((day) => day.key)).toEqual(['2026-02-01', '2026-01-31', '2026-01-30']);
    // Within a day, newest first too.
    expect(days[1]?.data.map((entry) => entry.key)).toEqual(['entry:c', 'entry:d']);
    // The heading instant is that day's own midnight, not the first entry's time.
    expect(dayKey(days[1]?.at ?? 0)).toBe('2026-01-31');
  });

  it('does not open a second group for the same day when entries are out of order', () => {
    const entries: TimelineEntry[] = [
      { kind: 'entry', key: 'entry:a', at: at(2026, 2, 1, 8), record: record({ id: 'a' }) },
      { kind: 'entry', key: 'entry:b', at: at(2026, 1, 31, 8), record: record({ id: 'b' }) },
      { kind: 'entry', key: 'entry:c', at: at(2026, 2, 1, 20), record: record({ id: 'c' }) },
    ];

    const days = groupTimelineByDay(entries);
    expect(days).toHaveLength(2);
    expect(days[0]?.data).toHaveLength(2);
  });

  /**
   * A batch saved in one go shares a millisecond. Without the tie-break on `key` the sort is
   * unstable, and the list silently swaps two rows on every re-read — which looks like the app
   * shuffling somebody's records while they are reading them.
   */
  it('breaks a tied instant on the row key, so rows never swap between reads', () => {
    const instant = at(2026, 2, 1, 12);
    const entries: TimelineEntry[] = [
      { kind: 'entry', key: 'entry:c', at: instant, record: record({ id: 'c' }) },
      { kind: 'entry', key: 'entry:a', at: instant, record: record({ id: 'a' }) },
      { kind: 'entry', key: 'entry:b', at: instant, record: record({ id: 'b' }) },
    ];

    const first = groupTimelineByDay(entries)[0]?.data.map((entry) => entry.key);
    const again = groupTimelineByDay([...entries].reverse())[0]?.data.map((entry) => entry.key);

    expect(first).toEqual(['entry:a', 'entry:b', 'entry:c']);
    expect(again).toEqual(first);
  });

  it('returns nothing for nothing', () => {
    expect(groupTimelineByDay([])).toEqual([]);
  });

  it('dates an entry by when it happened, falling back to when it arrived', () => {
    expect(entryTime(record({ id: 'a', occurredAt: 500, createdAt: 900 }))).toBe(500);
    expect(entryTime(record({ id: 'b', occurredAt: null, createdAt: 900 }))).toBe(900);
    expect(meetingTime(meeting({ id: 'm', startedAt: 500, createdAt: 900 }))).toBe(500);
    expect(meetingTime(meeting({ id: 'n', startedAt: null, createdAt: 900 }))).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// Merging entries with recordings
// ---------------------------------------------------------------------------

describe('building the merged timeline', () => {
  const newEntry = record({ id: 'r1', occurredAt: at(2026, 2, 1, 9) });
  const oldRecording = meeting({ id: 'm1', startedAt: at(2025, 11, 4, 15) });
  const recentRecording = meeting({ id: 'm2', startedAt: at(2026, 2, 1, 14) });

  /**
   * Entries arrive a page at a time and recordings arrive as a block. Showing all of both at
   * once puts a three-month-old recording directly under this morning's bill, and the next page
   * of entries then inserts rows *above* it — the list visibly rewriting itself as you scroll.
   */
  it('holds back recordings older than the oldest loaded entry while pages remain', () => {
    const days = buildTimeline({
      records: [newEntry],
      meetings: [recentRecording, oldRecording],
      recordsExhausted: false,
    });

    const keys = days.flatMap((day) => day.data.map((entry) => entry.key));
    expect(keys).toContain('meeting:m2');
    expect(keys).not.toContain('meeting:m1');
  });

  it('shows every recording once the entries have run out', () => {
    const days = buildTimeline({
      records: [newEntry],
      meetings: [recentRecording, oldRecording],
      recordsExhausted: true,
    });

    const keys = days.flatMap((day) => day.data.map((entry) => entry.key));
    expect(keys).toContain('meeting:m1');
    expect(keys).toContain('meeting:m2');
  });

  it('shows every recording when there are no entries at all to measure against', () => {
    const days = buildTimeline({
      records: [],
      meetings: [oldRecording],
      recordsExhausted: false,
    });
    expect(days.flatMap((day) => day.data.map((entry) => entry.key))).toEqual(['meeting:m1']);
  });

  it('interleaves an entry and a recording from the same day in time order', () => {
    const days = buildTimeline({
      records: [record({ id: 'r2', occurredAt: at(2026, 2, 1, 8) }), newEntry],
      meetings: [recentRecording],
      recordsExhausted: true,
    });

    expect(days).toHaveLength(1);
    expect(days[0]?.data.map((entry) => entry.key)).toEqual([
      'meeting:m2',
      'entry:r1',
      'entry:r2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// What is still being worked on
// ---------------------------------------------------------------------------

describe('the in-progress predicate that drives the checks', () => {
  it('counts an entry as unfinished only while it is being read', () => {
    expect(isRecordInProgress(record({ id: 'a', status: 'processing' }))).toBe(true);
    for (const status of ['complete', 'needs_context', 'unreadable', 'failed'] as const) {
      expect(isRecordInProgress(record({ id: 'a', status }))).toBe(false);
    }
  });

  /**
   * `transcribed` is unfinished too, and that is the easy one to get wrong: the words are in,
   * but the notes, tasks and summary the row actually shows are not. A screen that stopped
   * checking here would leave the row saying nothing for ever.
   */
  it('counts a recording as unfinished until its notes are written, not just its words', () => {
    expect(isMeetingInProgress(meeting({ id: 'm', status: 'transcribing' }))).toBe(true);
    expect(isMeetingInProgress(meeting({ id: 'm', status: 'transcribed' }))).toBe(true);
    expect(isMeetingInProgress(meeting({ id: 'm', status: 'complete' }))).toBe(false);
    expect(isMeetingInProgress(meeting({ id: 'm', status: 'failed' }))).toBe(false);
  });

  it('lists the unfinished ids in the order given', () => {
    const rows = [
      record({ id: 'a', status: 'complete' }),
      record({ id: 'b', status: 'processing' }),
      record({ id: 'c', status: 'failed' }),
      record({ id: 'd', status: 'processing' }),
    ];
    expect(inProgressRecordIds(rows)).toEqual(['b', 'd']);
    expect(
      inProgressMeetingIds([
        meeting({ id: 'm1', status: 'complete' }),
        meeting({ id: 'm2', status: 'transcribing' }),
      ]),
    ).toEqual(['m2']);
  });

  /**
   * The screen polls on this string because it needs three behaviours from one value: stop,
   * keep waiting, and start over. Empty is stop; unchanged is keep waiting and let the delay
   * grow; changed is start over.
   */
  it('is empty when nothing is in flight', () => {
    expect(inProgressKey([record({ id: 'a' })], [meeting({ id: 'm' })])).toBe('');
    expect(inProgressKey([], [])).toBe('');
  });

  it('is stable whatever order the lists arrive in', () => {
    const a = record({ id: 'a', status: 'processing' });
    const b = record({ id: 'b', status: 'processing' });
    const m = meeting({ id: 'm', status: 'transcribing' });

    expect(inProgressKey([a, b], [m])).toBe(inProgressKey([b, a], [m]));
  });

  it('changes when something new starts and when something finishes', () => {
    const a = record({ id: 'a', status: 'processing' });
    const b = record({ id: 'b', status: 'processing' });

    const one = inProgressKey([a], []);
    const two = inProgressKey([a, b], []);
    const back = inProgressKey([a, record({ id: 'b', status: 'complete' })], []);

    expect(two).not.toBe(one);
    expect(back).toBe(one);
  });
});

// ---------------------------------------------------------------------------
// The backoff
// ---------------------------------------------------------------------------

describe('the backoff schedule', () => {
  it('starts quick, because most reads land in a couple of seconds', () => {
    expect(pollDelayMs(0)).toBe(POLL_STEPS_MS[0]);
    expect(pollDelayMs(1)).toBe(POLL_STEPS_MS[1]);
    expect(POLL_STEPS_MS[0]).toBeLessThanOrEqual(2000);
  });

  it('never gets shorter as the wait goes on', () => {
    for (let attempt = 1; attempt < POLL_STEPS_MS.length; attempt += 1) {
      const previous = pollDelayMs(attempt - 1);
      const current = pollDelayMs(attempt);
      expect(previous).not.toBeNull();
      expect(current).not.toBeNull();
      expect(current as number).toBeGreaterThanOrEqual(previous as number);
    }
  });

  it('holds at the longest step rather than growing without limit', () => {
    const last = POLL_STEPS_MS[POLL_STEPS_MS.length - 1];
    expect(pollDelayMs(POLL_STEPS_MS.length)).toBe(last);
    expect(pollDelayMs(POLL_STEPS_MS.length + 10)).toBe(last);
    expect(pollDelayMs(POLL_MAX_ATTEMPTS - 1)).toBe(last);
  });

  /**
   * The one that matters most. Without a `null` the screen asks an unreachable server until the
   * battery is flat, and the row spins for ever with nothing a person can do about it. `null`
   * is what turns a permanent spinner into a row that admits it is stuck and offers to start
   * the read again.
   */
  it('gives up, so a stuck row becomes an action instead of a spinner', () => {
    expect(pollDelayMs(POLL_MAX_ATTEMPTS)).toBeNull();
    expect(pollDelayMs(POLL_MAX_ATTEMPTS + 1)).toBeNull();
  });

  it('treats a nonsense attempt as the first one rather than giving up', () => {
    expect(pollDelayMs(-1)).toBe(POLL_STEPS_MS[0]);
  });

  it('is bounded in total, and generously enough for a slow read', () => {
    let total = 0;
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      total += pollDelayMs(attempt) ?? 0;
    }
    // Long enough that a photo taking minutes is still waited for, short enough that a phone
    // is not asking all afternoon.
    expect(total).toBeGreaterThan(5 * 60_000);
    expect(total).toBeLessThan(25 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// Whether a reply changed anything
// ---------------------------------------------------------------------------

describe('deciding that nothing changed', () => {
  it('is true for the same rows, so a check that found nothing redraws nothing', () => {
    const before = [record({ id: 'a', updatedAt: 5 }), record({ id: 'b', updatedAt: 6 })];
    const after = [record({ id: 'a', updatedAt: 5 }), record({ id: 'b', updatedAt: 6 })];
    expect(recordsUnchanged(before, after)).toBe(true);
  });

  it('notices a status, a timestamp, an id, an order or a length', () => {
    const before = [record({ id: 'a', status: 'processing', updatedAt: 5 })];

    expect(recordsUnchanged(before, [record({ id: 'a', status: 'complete', updatedAt: 5 })])).toBe(
      false,
    );
    expect(recordsUnchanged(before, [record({ id: 'a', status: 'processing', updatedAt: 6 })])).toBe(
      false,
    );
    expect(recordsUnchanged(before, [record({ id: 'z', status: 'processing', updatedAt: 5 })])).toBe(
      false,
    );
    expect(recordsUnchanged(before, [...before, record({ id: 'b' })])).toBe(false);
    expect(recordsUnchanged([], [])).toBe(true);
  });

  /**
   * The sentence under an unfinished row moves while its status does not. Leaving `progress` out
   * of this comparison freezes the one line the reader is watching — the row would say "Waiting
   * its turn to be read." for the whole read and then jump straight to finished.
   */
  it('notices the sentence under an unfinished row changing on its own', () => {
    const before = [
      record({ id: 'a', status: 'processing', updatedAt: 5, progress: 'Reading the file.' }),
    ];
    const after = [
      record({
        id: 'a',
        status: 'processing',
        updatedAt: 5,
        progress: 'Working out what it says.',
      }),
    ];
    expect(recordsUnchanged(before, after)).toBe(false);
  });

  it('notices a sentence appearing or clearing', () => {
    const none = [record({ id: 'a', status: 'processing', progress: null })];
    const some = [record({ id: 'a', status: 'processing', progress: 'Reading the file.' })];
    expect(recordsUnchanged(none, some)).toBe(false);
    expect(recordsUnchanged(some, none)).toBe(false);
  });

  it('compares recordings the same way', () => {
    const before = [meeting({ id: 'm', status: 'transcribing', updatedAt: 4 })];
    expect(meetingsUnchanged(before, [meeting({ id: 'm', status: 'transcribing', updatedAt: 4 })])).toBe(
      true,
    );
    expect(meetingsUnchanged(before, [meeting({ id: 'm', status: 'complete', updatedAt: 4 })])).toBe(
      false,
    );
    expect(meetingsUnchanged(before, [meeting({ id: 'm', status: 'transcribing', updatedAt: 9 })])).toBe(
      false,
    );
    expect(meetingsUnchanged(before, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Jumping to a month
// ---------------------------------------------------------------------------

describe('the month the timeline has been sent to', () => {
  it('writes a month key as YYYY-MM from local parts, so it never shifts a month', () => {
    expect(monthKey(at(2026, 2, 1, 0, 1))).toBe('2026-02');
    expect(monthKey(at(2026, 12, 31, 23, 59))).toBe('2026-12');
    expect(monthKey(at(2026, 9, 9))).toBe('2026-09');
  });

  /**
   * The failure this refuses: a key that is not a month silently becoming 1 January 1970. A
   * tyop in a route param, or a stale value in a persisted selection, would otherwise send
   * somebody to a date the product invented rather than doing nothing at all.
   */
  it('reads a month key back to the first instant of that month, local midnight', () => {
    const january = startOfMonthKey('2026-01');
    expect(january).not.toBeNull();
    const date = new Date(january as number);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(1);
    expect(date.getHours()).toBe(0);
    expect(dayKey(january as number)).toBe('2026-01-01');
  });

  it('refuses anything that is not a month rather than guessing one', () => {
    for (const bad of ['', 'newest', '2026', '2026-13', '2026-00', '26-01', '2026-1', 'yy-mm']) {
      expect(startOfMonthKey(bad)).toBeNull();
    }
    // A key the row did produce round-trips, which is what makes the null above a real refusal
    // rather than an over-eager regex.
    expect(startOfMonthKey(monthKey(at(2026, 7, 4)))).not.toBeNull();
  });

  it('names a month, spelling out the year only when it is not the current one', () => {
    const now = at(2026, 5, 20);
    expect(monthLabel(at(2026, 2, 1), now, 'en-GB')).toBe('February');
    expect(monthLabel(at(2025, 11, 1), now, 'en-GB')).toBe('November 2025');
  });

  it('offers the months most recent first, ending at this one', () => {
    const months = recentMonths(at(2026, 3, 15, 10), 4, 'en-GB');
    expect(months.map((month) => month.key)).toEqual(['2026-03', '2026-02', '2026-01', '2025-12']);
    expect(months[0]?.at).toBe(startOfMonthKey('2026-03'));
  });

  /**
   * The label is built from the month's own start, not from the day the caller happened to pass.
   * Feeding the 31st of a month into a shift is how a short month is skipped: 31 February rolls
   * forward into March, and the row would offer March twice and never offer February.
   */
  it('steps back through months of different lengths without skipping or repeating one', () => {
    const months = recentMonths(at(2026, 3, 31, 23, 30), 14, 'en-GB');
    const keys = months.map((month) => month.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      '2026-03', '2026-02', '2026-01', '2025-12', '2025-11', '2025-10', '2025-09',
      '2025-08', '2025-07', '2025-06', '2025-05', '2025-04', '2025-03', '2025-02',
    ]);
  });

  it('spans a year boundary in both directions', () => {
    const december = recentMonths(at(2026, 1, 15), 3, 'en-GB');
    expect(december.map((month) => month.key)).toEqual(['2026-01', '2025-12', '2025-11']);
    expect(monthLabel(december[1]?.at ?? 0, at(2026, 1, 15), 'en-GB')).toBe('December 2025');
  });

  /**
   * The sentence is the whole safety of the jump. Without it the list simply starts at a month
   * and the months in between are not on screen and not explained — which reads as records that
   * are gone. It has to name the month and it has to say how to get back.
   */
  it('says which month is showing and how to get back, and says nothing at the top', () => {
    expect(jumpSummary(null)).toBeNull();

    const sentence = jumpSummary({ key: '2025-08', label: 'August 2025' });
    expect(sentence).toContain('August 2025');
    expect(sentence).toContain('older');
    expect(sentence?.toLowerCase()).toContain('pull down');
  });
});

// ---------------------------------------------------------------------------
// Searching as you type
// ---------------------------------------------------------------------------

describe('when a keystroke is worth a request', () => {
  it('does nothing for an empty box, or one holding only spaces', () => {
    expect(planSearch('')).toEqual({ action: 'idle' });
    expect(planSearch('   ')).toEqual({ action: 'idle' });
    expect(planSearch('\n\t ')).toEqual({ action: 'idle' });
  });

  it('waits below the shortest query worth sending, and says what it is waiting for', () => {
    const plan = planSearch('a');
    expect(plan.action).toBe('wait');
    expect(SEARCH_MIN_CHARS).toBe(2);
    if (plan.action === 'wait') expect(plan.query).toBe('a');
  });

  it('trims and collapses whitespace, so the same words are one query', () => {
    expect(planSearch('  jio   recharge  ')).toEqual({
      action: 'run',
      query: 'jio recharge',
      delayMs: SEARCH_DEBOUNCE_MS,
    });
  });

  /**
   * A short query is almost always the start of a longer word, so firing at the second
   * keystroke spends a request on results that are about to be thrown away. Once the query is
   * longer the person is refining rather than starting, and the results should keep up.
   */
  it('pauses longer on a short query than on a long one', () => {
    expect(planSearch('ji')).toEqual({
      action: 'run',
      query: 'ji',
      delayMs: SEARCH_DEBOUNCE_SHORT_MS,
    });
    expect(planSearch('jio')).toEqual({
      action: 'run',
      query: 'jio',
      delayMs: SEARCH_DEBOUNCE_SHORT_MS,
    });
    expect(planSearch('jio ')).toEqual({
      action: 'run',
      query: 'jio',
      delayMs: SEARCH_DEBOUNCE_SHORT_MS,
    });
    expect(planSearch('jiof')).toEqual({
      action: 'run',
      query: 'jiof',
      delayMs: SEARCH_DEBOUNCE_MS,
    });
    expect(SEARCH_DEBOUNCE_SHORT_MS).toBeGreaterThan(SEARCH_DEBOUNCE_MS);
  });

  it('never asks for a pause long enough to feel broken', () => {
    for (const text of ['ab', 'abc', 'abcd', 'a longer sentence to look for']) {
      const plan = planSearch(text);
      expect(plan.action).toBe('run');
      if (plan.action === 'run') {
        expect(plan.delayMs).toBeGreaterThan(0);
        expect(plan.delayMs).toBeLessThanOrEqual(500);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Where a result opens
// ---------------------------------------------------------------------------

describe('where each kind of result opens', () => {
  const hit = (type: SearchResult['type'], id: string): Pick<SearchResult, 'type' | 'id'> => ({
    type,
    id,
  });

  /**
   * The route *template* is asserted, not a built path.
   *
   * `/record/a1` and `/record/[id]` with `id: 'a1'` are the same tap today, and only the second
   * is checked against the real route tree — so only the second fails to compile if the screen
   * is ever moved or renamed. Asserting the template keeps the test honest about which of the
   * two the app actually navigates with.
   */
  it('sends the three kinds that have their own screen to that screen, by id', () => {
    expect(destinationFor(hit('record', 'a1'))).toEqual({
      pathname: '/record/[id]',
      params: { id: 'a1' },
    });
    expect(destinationFor(hit('meeting', 'm1'))).toEqual({
      pathname: '/meeting/[id]',
      params: { id: 'm1' },
    });
    expect(destinationFor(hit('case', 'c1'))).toEqual({
      pathname: '/case/[id]',
      params: { id: 'c1' },
    });
  });

  /**
   * A to-do has no screen of its own — it lives in the list on the tasks tab — so finding one
   * has to land on that tab with the row named, or a person who searched for a to-do arrives
   * somewhere that does not show it and has to find it again by hand.
   */
  it('sends a to-do to the tasks tab with its id as the focus', () => {
    expect(destinationFor(hit('task', 't1'))).toEqual({
      pathname: '/(tabs)/tasks',
      params: { focus: 't1' },
    });
  });

  it('keeps the id exactly as given, so nothing is lost in the route', () => {
    for (const type of ['record', 'meeting', 'task', 'case'] as const) {
      const destination = destinationFor(hit(type, 'AbC-123_xyz'));
      expect(destination.params).toEqual(
        type === 'task' ? { focus: 'AbC-123_xyz' } : { id: 'AbC-123_xyz' },
      );
    }
  });

  it('gives every kind a destination, so no result is a dead tap', () => {
    for (const type of ['record', 'meeting', 'task', 'case'] as const) {
      expect(destinationFor(hit(type, 'x'))).toBeTruthy();
    }
  });
});
