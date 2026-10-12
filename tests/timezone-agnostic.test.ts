/**
 * The same date questions, asked from seven different calendars.
 *
 * `tests/task-dates.test.ts` already pins the boundary cases, and it is written correctly: every
 * expectation is built from local parts and `now` is always passed in. But a test written that way
 * still only ever runs in one timezone — the one the machine happens to be set to — so it proves
 * the functions are right *here*. The failure this file is for is the one that cannot be seen that
 * way: a function that reaches for `toISOString` or `Date.parse` answers correctly in the zone it
 * was written in and moves the date by a day somewhere else, and whichever of the two machines
 * disagrees, the person reading the failure has no reason to suspect the clock.
 *
 * India is +05:30 with no daylight saving, so the window where a UTC round trip changes the date
 * is five and a half hours wide and always open at the start of the day. That is why the hours
 * chosen below are 00:01 and 23:59 rather than midday: midday is correct in every zone no matter
 * how badly the function is written, and a test that only asks at midday is a test that cannot
 * fail.
 *
 * The zones come from `tests/helpers/clock.ts`, which checks that each one is genuinely adopted.
 * That check matters more than it sounds: passing an IANA name through the `TZ` environment
 * variable does not work on this platform, so an earlier attempt at this file ran "in Los Angeles"
 * four times while actually sitting in Asia/Calcutta, and the agreement it reported was agreement
 * with itself.
 */

import { describe, expect, it } from 'vitest';

import { inEveryTimeZone, localTime } from './helpers/clock';
import {
  calendarGrid,
  daysUntil,
  isTaskLate,
  parseDueDay,
  resolveDueChoice,
  shiftMonth,
  taskGroupKey,
  toDueDay,
  type Task,
} from '../src/api/tasks';
import { isoDateOf, normalizeTypedDate } from '../src/ui/format';

/**
 * A whole `Task`, with no cast. The fields are spelled out because the first version of this file
 * used `as Task` on a partial object and `doneAt` came through as `undefined`, which
 * `taskGroupKey` reads as finished — the test failed on a timezone question it was never asking.
 */
function task(dueAt: number | null, overdue: boolean): Task {
  return {
    id: 'task-1',
    text: 'Send the signed copy',
    owner: null,
    priority: 'normal',
    dueAt,
    doneAt: null,
    overdue,
    meetingId: null,
    recordId: null,
    meetingTitle: null,
    recordTitle: null,
    createdAt: localTime(2026, 2, 1, 9, 0),
  };
}

describe('a due day is the day it is where the person is standing', () => {
  it('reads the local date just after midnight, when a UTC conversion would say yesterday', () => {
    inEveryTimeZone(() => {
      expect(toDueDay(localTime(2026, 3, 4, 0, 1))).toBe('2026-04-04');
      expect(isoDateOf(localTime(2026, 3, 4, 0, 1))).toBe('2026-04-04');
    });
  });

  it('reads the local date just before midnight, when a UTC conversion would say tomorrow', () => {
    inEveryTimeZone(() => {
      expect(toDueDay(localTime(2026, 3, 4, 23, 59))).toBe('2026-04-04');
      expect(isoDateOf(localTime(2026, 3, 4, 23, 59))).toBe('2026-04-04');
    });
  });

  it('round-trips a stored day back to local midnight', () => {
    inEveryTimeZone(() => {
      const at = parseDueDay('2026-04-04');
      expect(at).not.toBeNull();
      expect(toDueDay(at as number)).toBe('2026-04-04');
      expect(new Date(at as number).getHours()).toBe(0);
    });
  });

  it('refuses a day that does not exist, rather than rolling it into the next month', () => {
    inEveryTimeZone(() => {
      expect(parseDueDay('2026-02-30')).toBeNull();
      expect(parseDueDay('2026-04-31')).toBeNull();
      expect(toDueDay(parseDueDay('2028-02-29') as number)).toBe('2028-02-29');
    });
  });

  it('keeps the month boundary on the right side of midnight', () => {
    inEveryTimeZone(() => {
      expect(toDueDay(localTime(2026, 1, 28, 23, 59))).toBe('2026-02-28');
      expect(toDueDay(localTime(2026, 2, 1, 0, 1))).toBe('2026-03-01');
      expect(toDueDay(localTime(2025, 11, 31, 23, 59))).toBe('2025-12-31');
      expect(toDueDay(localTime(2026, 0, 1, 0, 1))).toBe('2026-01-01');
    });
  });
});

describe('a task due today is not late in any timezone', () => {
  it('counts zero days to a task due today, at either end of the day', () => {
    inEveryTimeZone(() => {
      const dueToday = parseDueDay('2026-04-04') as number;
      expect(daysUntil(dueToday, localTime(2026, 3, 4, 0, 1))).toBe(0);
      expect(daysUntil(dueToday, localTime(2026, 3, 4, 23, 59))).toBe(0);
      expect(daysUntil(dueToday, localTime(2026, 3, 5, 0, 1))).toBe(-1);
      expect(daysUntil(dueToday, localTime(2026, 3, 3, 23, 59))).toBe(1);
    });
  });

  it('does not call a task late on the day it is due, even one minute before midnight', () => {
    inEveryTimeZone(() => {
      const dueToday = task(parseDueDay('2026-04-04') as number, true);
      expect(isTaskLate(dueToday, localTime(2026, 3, 4, 0, 1))).toBe(false);
      expect(isTaskLate(dueToday, localTime(2026, 3, 4, 23, 59))).toBe(false);
      expect(isTaskLate(dueToday, localTime(2026, 3, 5, 0, 1))).toBe(true);
      expect(taskGroupKey(dueToday, localTime(2026, 3, 4, 23, 59))).toBe('today');
    });
  });
});

describe('a shortcut means a day on this calendar', () => {
  it('resolves "today" to the local date at both ends of the day', () => {
    inEveryTimeZone(() => {
      expect(resolveDueChoice('today', localTime(2026, 3, 4, 0, 1))).toBe('2026-04-04');
      expect(resolveDueChoice('today', localTime(2026, 3, 4, 23, 59))).toBe('2026-04-04');
      expect(resolveDueChoice('tomorrow', localTime(2026, 3, 4, 23, 59))).toBe('2026-04-05');
    });
  });

  it('resolves the weekend and next week from the local weekday', () => {
    inEveryTimeZone(() => {
      // 1 April 2026 is a Wednesday, so the coming Saturday is the 4th and next Monday the 6th.
      const wednesdayNight = localTime(2026, 3, 1, 23, 59);
      expect(resolveDueChoice('weekend', wednesdayNight)).toBe('2026-04-04');
      expect(resolveDueChoice('next-week', wednesdayNight)).toBe('2026-04-06');
    });
  });
});

describe('calendar layout and typed dates owe nothing to the clock', () => {
  it('lays out a month identically in every zone', () => {
    const grids = new Set<string>();
    inEveryTimeZone(() => {
      grids.add(JSON.stringify(calendarGrid(2026, 3)));
      expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, monthIndex: 0 });
    });
    expect(grids.size).toBe(1);
  });

  it('reads a day-first typed date identically in every zone', () => {
    inEveryTimeZone(() => {
      expect(normalizeTypedDate('4/4/2026')).toBe('2026-04-04');
      expect(normalizeTypedDate('31/12/25')).toBe('2025-12-31');
      expect(normalizeTypedDate('29/2/2028')).toBe('2028-02-29');
      expect(normalizeTypedDate('29/2/2026')).toBeNull();
    });
  });
});
