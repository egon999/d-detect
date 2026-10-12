/**
 * The date and grouping logic behind the tasks screen.
 *
 * All of it lives in `src/api/tasks.ts` rather than in the screen, because the screen imports
 * React Native and there is nothing to render into here. Everything under test is pure and
 * takes the current time as an argument, so none of these assertions depend on when they run.
 *
 * ## Why every expectation is built from local date parts
 *
 * The functions under test read the device's own calendar on purpose: a person who taps
 * "Today" means the day it is where they are standing. So the expectations are written the
 * same way — `new Date(year, monthIndex, day)` and `YYYY-MM-DD` strings — which makes them
 * true in every timezone rather than in the one this machine happens to be set to.
 *
 * That matters most for India, the audience this app is for. IST is +05:30 and never changes,
 * so the failure it exposes is not a daylight-saving one: it is that any conversion through
 * UTC moves the date by a day for five and a half hours out of every twenty-four. The late
 * and early boundary cases below are exactly the ones that break the moment anything in this
 * file reaches for `toISOString`, and they fail in Kolkata while passing in London, which is
 * why they are pinned here with the times spelled out.
 */

import { describe, it, expect } from 'vitest';

import {
  SOON_DAYS,
  calendarGrid,
  daysUntil,
  groupTasks,
  isTaskLate,
  matchesTaskQuery,
  parseDueDay,
  resolveDueChoice,
  shiftMonth,
  taskGroupKey,
  taskSource,
  toDueDay,
  type DueChoice,
  type Task,
} from '../src/api/tasks';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The start of a day on this machine's calendar, which is what the server stores. */
function day(year: number, monthIndex: number, date: number, hour = 0, minute = 0): number {
  return new Date(year, monthIndex, date, hour, minute).getTime();
}

/** The `YYYY-MM-DD` for a local date, computed independently of `toDueDay`. */
function stamp(year: number, monthIndex: number, date: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

const WEEKDAY = { sunday: 0, monday: 1, saturday: 6 } as const;

/**
 * A row shaped the way the server sends one.
 *
 * `overdue` defaults to the server's own rule — unfinished and dated, compared against the
 * clock rather than against the start of today — so the tests inherit the off-by-one that
 * `isTaskLate` exists to absorb instead of quietly assuming it away.
 */
function makeTask(fields: {
  id: string;
  text?: string;
  owner?: string | null;
  dueAt?: number | null;
  doneAt?: number | null;
  overdue?: boolean;
  priority?: Task['priority'];
  meetingId?: string | null;
  recordId?: string | null;
  meetingTitle?: string | null;
  recordTitle?: string | null;
}): Task {
  const dueAt = fields.dueAt ?? null;
  const doneAt = fields.doneAt ?? null;
  return {
    id: fields.id,
    text: fields.text ?? fields.id,
    owner: fields.owner ?? null,
    priority: fields.priority ?? 'normal',
    dueAt,
    doneAt,
    overdue: fields.overdue ?? (doneAt === null && dueAt !== null),
    meetingId: fields.meetingId ?? null,
    recordId: fields.recordId ?? null,
    meetingTitle: fields.meetingTitle ?? null,
    recordTitle: fields.recordTitle ?? null,
    createdAt: day(2026, 0, 1),
  };
}

// ---------------------------------------------------------------------------
// Days in, days out
// ---------------------------------------------------------------------------

describe('toDueDay', () => {
  it('reads the day off the local calendar at both ends of it', () => {
    // 00:30 and 23:45 are the two windows where a UTC conversion lands on the wrong date in
    // India: half past midnight in Kolkata is seven in the evening the day before, in UTC.
    expect(toDueDay(day(2026, 0, 1, 0, 30))).toBe('2026-01-01');
    expect(toDueDay(day(2026, 0, 1, 12, 0))).toBe('2026-01-01');
    expect(toDueDay(day(2026, 0, 1, 23, 45))).toBe('2026-01-01');
  });

  it('pads a single-digit month and day, which is what the server parses', () => {
    expect(toDueDay(day(2026, 8, 5))).toBe('2026-09-05');
    expect(toDueDay(day(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('parseDueDay', () => {
  it('returns the start of that day on the local calendar', () => {
    expect(parseDueDay('2026-03-14')).toBe(day(2026, 2, 14));
  });

  it('round-trips with toDueDay across month and year ends', () => {
    for (const at of [day(2026, 2, 31), day(2026, 3, 1), day(2026, 11, 31), day(2027, 0, 1)]) {
      const parsed = parseDueDay(toDueDay(at));
      expect(parsed).not.toBeNull();
      expect(toDueDay(parsed as number)).toBe(toDueDay(at));
    }
  });

  it('accepts a real leap day and refuses one that does not exist', () => {
    expect(parseDueDay('2024-02-29')).toBe(day(2024, 1, 29));
    expect(parseDueDay('2025-02-29')).toBeNull();
  });

  it('refuses a date that would silently roll into the next month', () => {
    // `new Date(2026, 3, 31)` is the 1st of May. Letting that through would save a due date
    // the person never chose.
    expect(parseDueDay('2026-04-31')).toBeNull();
    expect(parseDueDay('2026-02-30')).toBeNull();
    expect(parseDueDay('2026-13-01')).toBeNull();
  });

  it('refuses anything that is not a full date', () => {
    for (const nonsense of ['', '   ', 'today', '2026-03', '2026-3-14', '14/03/2026', '2026/03/14']) {
      expect(parseDueDay(nonsense)).toBeNull();
    }
  });

  it('tolerates surrounding whitespace, since the value travels as a string', () => {
    expect(parseDueDay('  2026-03-14  ')).toBe(day(2026, 2, 14));
  });
});

// ---------------------------------------------------------------------------
// The four shortcuts
// ---------------------------------------------------------------------------

describe('resolveDueChoice', () => {
  it('reads "today" off the clock at both ends of the day', () => {
    expect(resolveDueChoice('today', day(2026, 2, 14, 0, 5))).toBe('2026-03-14');
    expect(resolveDueChoice('today', day(2026, 2, 14, 23, 55))).toBe('2026-03-14');
  });

  it('steps "tomorrow" over the end of a month, a leap February and a year', () => {
    expect(resolveDueChoice('tomorrow', day(2026, 2, 31, 9, 0))).toBe('2026-04-01');
    expect(resolveDueChoice('tomorrow', day(2026, 3, 30, 9, 0))).toBe('2026-05-01');
    expect(resolveDueChoice('tomorrow', day(2024, 1, 28, 9, 0))).toBe('2024-02-29');
    expect(resolveDueChoice('tomorrow', day(2025, 1, 28, 9, 0))).toBe('2025-03-01');
    expect(resolveDueChoice('tomorrow', day(2026, 11, 31, 9, 0))).toBe('2027-01-01');
  });

  it('crosses midnight correctly from the last minute of a month', () => {
    // 23:59 on the 31st is the case a day's worth of arithmetic done in UTC gets wrong in
    // India, where it is already the 1st by UTC's reckoning.
    expect(resolveDueChoice('tomorrow', day(2026, 2, 31, 23, 59))).toBe('2026-04-01');
    expect(resolveDueChoice('today', day(2026, 2, 31, 23, 59))).toBe('2026-03-31');
  });

  it('means the coming Saturday by "this weekend"', () => {
    // Wednesday 11 March 2026 to Saturday the 14th.
    expect(resolveDueChoice('weekend', day(2026, 2, 11, 9, 0))).toBe('2026-03-14');
    // Thursday 30 April 2026 to Saturday 2 May: the weekend is in the next month.
    expect(resolveDueChoice('weekend', day(2026, 3, 30, 9, 0))).toBe('2026-05-02');
  });

  it('means today by "this weekend" when it is already the weekend', () => {
    // The weekend somebody means on a Sunday is the one they are standing in, not the one in
    // six days' time — a task pushed a week out is not what that tap asked for.
    expect(resolveDueChoice('weekend', day(2026, 2, 14, 9, 0))).toBe('2026-03-14'); // Saturday
    expect(resolveDueChoice('weekend', day(2026, 2, 15, 9, 0))).toBe('2026-03-15'); // Sunday
  });

  it('means the Monday that starts the following week by "next week"', () => {
    expect(resolveDueChoice('next-week', day(2026, 2, 11, 9, 0))).toBe('2026-03-16'); // Wed
    expect(resolveDueChoice('next-week', day(2026, 2, 14, 9, 0))).toBe('2026-03-16'); // Sat
    expect(resolveDueChoice('next-week', day(2026, 2, 15, 9, 0))).toBe('2026-03-16'); // Sun
    expect(resolveDueChoice('next-week', day(2026, 2, 16, 9, 0))).toBe('2026-03-23'); // Mon
    // And over the end of a month.
    expect(resolveDueChoice('next-week', day(2026, 2, 30, 9, 0))).toBe('2026-04-06');
  });

  it('holds its weekday promises on every day of a week', () => {
    // Sunday 8 March 2026 through Saturday the 14th.
    for (let offset = 0; offset < 7; offset += 1) {
      const now = day(2026, 2, 8 + offset, 10, 0);
      const weekday = new Date(now).getDay();

      const weekend = parseDueDay(resolveDueChoice('weekend', now));
      expect(weekend).not.toBeNull();
      const weekendDay = new Date(weekend as number).getDay();
      if (weekday === WEEKDAY.saturday || weekday === WEEKDAY.sunday) {
        expect(daysUntil(weekend as number, now)).toBe(0);
      } else {
        expect(weekendDay).toBe(WEEKDAY.saturday);
      }

      const next = parseDueDay(resolveDueChoice('next-week', now));
      expect(next).not.toBeNull();
      expect(new Date(next as number).getDay()).toBe(WEEKDAY.monday);
      // Always ahead, and never further than a fortnight — the two ways an off-by-one in the
      // modulo would show up as a date nobody asked for.
      const away = daysUntil(next as number, now);
      expect(away).toBeGreaterThan(0);
      expect(away).toBeLessThanOrEqual(7);
    }
  });

  it('never resolves to a day that has already gone', () => {
    const choices: DueChoice[] = ['today', 'tomorrow', 'weekend', 'next-week'];
    for (let offset = 0; offset < 40; offset += 1) {
      // Walks over the end of March and into May, at an hour either side of midday.
      for (const hour of [1, 13, 23]) {
        const now = day(2026, 2, 20 + offset, hour, 30);
        for (const choice of choices) {
          const resolved = parseDueDay(resolveDueChoice(choice, now));
          expect(resolved).not.toBeNull();
          expect(daysUntil(resolved as number, now)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Counting days
// ---------------------------------------------------------------------------

describe('daysUntil', () => {
  it('counts calendar days, not elapsed hours', () => {
    // An hour apart but two different days, and twenty-two hours apart on one.
    expect(daysUntil(day(2026, 2, 14, 0, 30), day(2026, 2, 13, 23, 30))).toBe(1);
    expect(daysUntil(day(2026, 2, 13, 23, 30), day(2026, 2, 13, 1, 30))).toBe(0);
  });

  it('counts backwards for a day that has gone', () => {
    expect(daysUntil(day(2026, 2, 13), day(2026, 2, 14, 9, 0))).toBe(-1);
    expect(daysUntil(day(2026, 2, 7), day(2026, 2, 14, 9, 0))).toBe(-7);
  });

  it('counts over the end of a month, a leap February and a year', () => {
    expect(daysUntil(day(2026, 3, 1), day(2026, 2, 31, 9, 0))).toBe(1);
    expect(daysUntil(day(2024, 2, 1), day(2024, 1, 28, 9, 0))).toBe(2);
    expect(daysUntil(day(2027, 0, 1), day(2026, 11, 31, 9, 0))).toBe(1);
    expect(daysUntil(day(2026, 11, 31), day(2026, 0, 1, 9, 0))).toBe(364);
  });
});

// ---------------------------------------------------------------------------
// Late, which is not the same as overdue
// ---------------------------------------------------------------------------

describe('isTaskLate', () => {
  const now = day(2026, 2, 14, 10, 0);

  it('does not call something due today late, whatever the server says', () => {
    // The server sets `overdue` by comparing the start of the due day against the current
    // moment, so everything due today arrives already flagged. Repeating that to a person
    // would mark their whole day overdue at one minute past midnight.
    const task = makeTask({ id: 'today', dueAt: day(2026, 2, 14) });
    expect(task.overdue).toBe(true);
    expect(isTaskLate(task, now)).toBe(false);
  });

  it('calls a day that has gone late', () => {
    expect(isTaskLate(makeTask({ id: 'yesterday', dueAt: day(2026, 2, 13) }), now)).toBe(true);
  });

  it('is never late when it is finished, dated or not', () => {
    const done = makeTask({ id: 'done', dueAt: day(2026, 2, 1), doneAt: day(2026, 2, 2) });
    expect(done.overdue).toBe(false);
    expect(isTaskLate(done, now)).toBe(false);
  });

  it('is never late without a date, and never late ahead of time', () => {
    expect(isTaskLate(makeTask({ id: 'undated' }), now)).toBe(false);
    expect(isTaskLate(makeTask({ id: 'tomorrow', dueAt: day(2026, 2, 15) }), now)).toBe(false);
  });

  it('defers to the server on whether a task is outstanding at all', () => {
    // A past date with `overdue: false` means the server no longer considers it outstanding.
    // The device's calendar does not get to overrule that.
    const settled = makeTask({ id: 'settled', dueAt: day(2026, 1, 1), overdue: false });
    expect(isTaskLate(settled, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

describe('taskGroupKey', () => {
  const now = day(2026, 2, 14, 10, 0);

  it('sorts one task into the heading a person would expect', () => {
    expect(taskGroupKey(makeTask({ id: 'a', dueAt: day(2026, 2, 12) }), now)).toBe('late');
    expect(taskGroupKey(makeTask({ id: 'b', dueAt: day(2026, 2, 14, 23, 0) }), now)).toBe('today');
    expect(taskGroupKey(makeTask({ id: 'c', dueAt: day(2026, 2, 16) }), now)).toBe('soon');
    expect(taskGroupKey(makeTask({ id: 'd', dueAt: day(2026, 3, 20) }), now)).toBe('later');
    expect(taskGroupKey(makeTask({ id: 'e' }), now)).toBe('undated');
    expect(
      taskGroupKey(makeTask({ id: 'f', dueAt: day(2026, 2, 1), doneAt: day(2026, 2, 2) }), now),
    ).toBe('done');
  });

  it('reaches six days past today under the week ahead and no further', () => {
    for (let ahead = 1; ahead < SOON_DAYS; ahead += 1) {
      expect(taskGroupKey(makeTask({ id: `in-${ahead}`, dueAt: day(2026, 2, 14 + ahead) }), now)).toBe(
        'soon',
      );
    }
    expect(taskGroupKey(makeTask({ id: 'week', dueAt: day(2026, 2, 14 + SOON_DAYS) }), now)).toBe(
      'later',
    );
  });

  it('puts a finished task under Finished even when its date has gone', () => {
    const task = makeTask({
      id: 'late-but-done',
      dueAt: day(2025, 11, 1),
      doneAt: day(2026, 2, 13),
      overdue: false,
    });
    expect(taskGroupKey(task, now)).toBe('done');
  });
});

describe('groupTasks', () => {
  const now = day(2026, 2, 14, 10, 0);

  it('returns the headings in reading order whatever order the tasks arrive in', () => {
    const groups = groupTasks(
      [
        makeTask({ id: 'undated' }),
        makeTask({ id: 'later', dueAt: day(2026, 4, 1) }),
        makeTask({ id: 'done', dueAt: day(2026, 2, 2), doneAt: day(2026, 2, 3) }),
        makeTask({ id: 'today', dueAt: day(2026, 2, 14) }),
        makeTask({ id: 'late', dueAt: day(2026, 2, 10) }),
        makeTask({ id: 'soon', dueAt: day(2026, 2, 17) }),
      ],
      now,
    );
    expect(groups.map((group) => group.key)).toEqual([
      'late',
      'today',
      'soon',
      'later',
      'undated',
      'done',
    ]);
  });

  it('leaves out a heading with nothing under it', () => {
    const groups = groupTasks(
      [makeTask({ id: 'a' }), makeTask({ id: 'b', dueAt: day(2026, 2, 10) })],
      now,
    );
    expect(groups.map((group) => group.key)).toEqual(['late', 'undated']);
  });

  it('keeps the order the server sent inside a heading', () => {
    // The server has already ordered these and its order is the one that gets rendered. A
    // task dated later arriving first is not a mistake to correct here — re-sorting would be
    // a second opinion from a different clock.
    const groups = groupTasks(
      [
        makeTask({ id: 'third', dueAt: day(2026, 2, 19) }),
        makeTask({ id: 'first', dueAt: day(2026, 2, 16) }),
        makeTask({ id: 'second', dueAt: day(2026, 2, 18) }),
      ],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.tasks.map((task) => task.id)).toEqual(['third', 'first', 'second']);
  });

  it('loses nothing and duplicates nothing', () => {
    const tasks = [
      makeTask({ id: 'a', dueAt: day(2026, 2, 10) }),
      makeTask({ id: 'b' }),
      makeTask({ id: 'c', dueAt: day(2026, 2, 14) }),
      makeTask({ id: 'd', dueAt: day(2026, 5, 14) }),
      makeTask({ id: 'e', doneAt: day(2026, 2, 13) }),
    ];
    const grouped = groupTasks(tasks, now).flatMap((group) => group.tasks.map((task) => task.id));
    expect(grouped.slice().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('has nothing to show for an empty list', () => {
    expect(groupTasks([], now)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Finding and tracing a task
// ---------------------------------------------------------------------------

describe('matchesTaskQuery', () => {
  const task = makeTask({
    id: 'one',
    text: 'Send the signed lease back',
    owner: 'Priya',
    meetingId: 'meeting-1',
    meetingTitle: 'Call with the landlord',
  });

  it('matches everything on an empty or blank query', () => {
    expect(matchesTaskQuery(task, '')).toBe(true);
    expect(matchesTaskQuery(task, '   ')).toBe(true);
  });

  it('searches the wording, the name on it and where it came from', () => {
    expect(matchesTaskQuery(task, 'lease')).toBe(true);
    expect(matchesTaskQuery(task, 'priya')).toBe(true);
    expect(matchesTaskQuery(task, 'landlord')).toBe(true);
  });

  it('ignores case and surrounding spaces', () => {
    expect(matchesTaskQuery(task, '  LEASE  ')).toBe(true);
  });

  it('says no when nothing on the task answers it', () => {
    expect(matchesTaskQuery(task, 'electricity')).toBe(false);
  });

  it('copes with a task that has no name, meeting or entry on it', () => {
    const bare = makeTask({ id: 'bare', text: 'Ring the bank' });
    expect(matchesTaskQuery(bare, 'bank')).toBe(true);
    expect(matchesTaskQuery(bare, 'priya')).toBe(false);
  });

  it('searches the entry a task is about by name', () => {
    const about = makeTask({
      id: 'about',
      text: 'Chase this up',
      recordId: 'record-1',
      recordTitle: 'Electricity bill, March',
    });
    expect(matchesTaskQuery(about, 'electricity')).toBe(true);
  });
});

describe('taskSource', () => {
  it('names the meeting a task came out of', () => {
    const task = makeTask({ id: 'a', meetingId: 'm1', meetingTitle: 'Call with the landlord' });
    expect(taskSource(task)).toEqual({ kind: 'meeting', id: 'm1', title: 'Call with the landlord' });
  });

  it('names the entry a task is about when there is no meeting', () => {
    const task = makeTask({ id: 'b', recordId: 'r1', recordTitle: 'Lease agreement' });
    expect(taskSource(task)).toEqual({ kind: 'record', id: 'r1', title: 'Lease agreement' });
  });

  it('prefers the meeting when a task has both', () => {
    const task = makeTask({ id: 'c', meetingId: 'm1', recordId: 'r1' });
    expect(taskSource(task)?.kind).toBe('meeting');
  });

  it('passes an unreadable title through as null rather than inventing one', () => {
    // The server only joins a title it is sure belongs to the same person. The caller writes
    // its own wording for that case; what it must never do is print the id.
    expect(taskSource(makeTask({ id: 'd', meetingId: 'm1' }))?.title).toBeNull();
  });

  it('has nothing to point at for a task somebody typed', () => {
    expect(taskSource(makeTask({ id: 'e' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The month grid
// ---------------------------------------------------------------------------

describe('calendarGrid', () => {
  it('always fills whole weeks, so the sheet does not change height month to month', () => {
    for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
      expect(calendarGrid(2026, monthIndex).length % 7).toBe(0);
    }
  });

  it('starts the 1st under its own weekday, counting from Monday', () => {
    // 1 March 2026 is a Sunday, which is the last column of a Monday-first week: six blanks.
    const cells = calendarGrid(2026, 2);
    expect(new Date(2026, 2, 1).getDay()).toBe(WEEKDAY.sunday);
    expect(cells.indexOf(1)).toBe(6);
    expect(cells.slice(0, 6).every((cell) => cell === null)).toBe(true);
  });

  it('has no leading blanks for a month that starts on a Monday', () => {
    // 1 June 2026 is a Monday.
    expect(new Date(2026, 5, 1).getDay()).toBe(WEEKDAY.monday);
    expect(calendarGrid(2026, 5)[0]).toBe(1);
  });

  it('gets February right in a leap year and in an ordinary one', () => {
    const dates = (year: number) => calendarGrid(year, 1).filter((cell) => cell !== null);
    expect(dates(2024)).toHaveLength(29);
    expect(dates(2025)).toHaveLength(28);
    expect(dates(2026)).toHaveLength(28);
    expect(dates(2000)).toHaveLength(29);
    // 1900 was not a leap year; 2100 will not be either.
    expect(dates(2100)).toHaveLength(28);
  });

  it('holds every date of the month once, in order, with no gaps', () => {
    for (const [year, monthIndex, length] of [
      [2026, 0, 31],
      [2026, 3, 30],
      [2026, 1, 28],
      [2024, 1, 29],
      [2026, 11, 31],
    ] as const) {
      const cells = calendarGrid(year, monthIndex);
      const dates = cells.filter((cell): cell is number => cell !== null);
      expect(dates).toEqual(Array.from({ length }, (_, index) => index + 1));
      // The dates sit in one unbroken run: no blank between the 1st and the last.
      const first = cells.indexOf(1);
      expect(cells.slice(first, first + length).every((cell) => cell !== null)).toBe(true);
    }
  });

  it('pads the end of the last week rather than leaving it short', () => {
    const cells = calendarGrid(2026, 1); // February 2026: 28 days starting on a Sunday.
    const last = cells.lastIndexOf(28);
    expect(cells.slice(last + 1).every((cell) => cell === null)).toBe(true);
  });
});

describe('shiftMonth', () => {
  it('steps forward and back inside a year', () => {
    expect(shiftMonth(2026, 2, 1)).toEqual({ year: 2026, monthIndex: 3 });
    expect(shiftMonth(2026, 2, -1)).toEqual({ year: 2026, monthIndex: 1 });
  });

  it('carries over the end of a year in both directions', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, monthIndex: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, monthIndex: 11 });
  });

  it('steps a whole year at a time without drifting', () => {
    expect(shiftMonth(2026, 6, 12)).toEqual({ year: 2027, monthIndex: 6 });
    expect(shiftMonth(2026, 6, -12)).toEqual({ year: 2025, monthIndex: 6 });
  });

  it('cannot skip a month, however short the one it lands on', () => {
    // Stepping from a 31-day month into February is where day-of-month arithmetic rolls over
    // and silently loses a month.
    expect(shiftMonth(2026, 0, 1)).toEqual({ year: 2026, monthIndex: 1 });
    expect(shiftMonth(2026, 2, -1)).toEqual({ year: 2026, monthIndex: 1 });
    // Twelve single steps from January land on January.
    let cursor = { year: 2026, monthIndex: 0 };
    for (let step = 0; step < 12; step += 1) {
      cursor = shiftMonth(cursor.year, cursor.monthIndex, 1);
    }
    expect(cursor).toEqual({ year: 2027, monthIndex: 0 });
  });
});

// ---------------------------------------------------------------------------
// The two ends meeting
// ---------------------------------------------------------------------------

describe('a date chosen in the grid and a date chosen by a shortcut agree', () => {
  it('lands in the heading the shortcut promised', () => {
    const now = day(2026, 2, 11, 9, 0); // Wednesday.
    const cases: Array<[DueChoice, 'today' | 'soon']> = [
      ['today', 'today'],
      ['tomorrow', 'soon'],
      ['weekend', 'soon'],
      ['next-week', 'soon'],
    ];
    for (const [choice, heading] of cases) {
      const dueAt = parseDueDay(resolveDueChoice(choice, now));
      expect(dueAt).not.toBeNull();
      const task = makeTask({ id: choice, dueAt });
      expect(taskGroupKey(task, now)).toBe(heading);
      expect(isTaskLate(task, now)).toBe(false);
    }
  });

  it('matches the grid cell for the same day', () => {
    const now = day(2026, 2, 11, 9, 0);
    const picked = toDueDay(day(2026, 2, 14));
    expect(resolveDueChoice('weekend', now)).toBe(picked);
    expect(picked).toBe(stamp(2026, 2, 14));
  });
});
