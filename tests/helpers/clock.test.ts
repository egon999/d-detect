/**
 * Proves the clock and timezone helper, because a broken test tool is worse than none: it reports
 * success for assertions that were never really made.
 *
 * Two of these tests exist for failures that actually happened while the helper was being built.
 * The first is that Node silently ignores most IANA names passed through the `TZ` environment
 * variable on Windows, so a run "in Los Angeles" was really a second run in Asia/Calcutta and the
 * resulting agreement between zones meant nothing — hence the check that every zone in the list is
 * genuinely adopted. The second is that `delete process.env.TZ` leaves the last zone cached, so
 * cleanup that looked correct would have leaked a zone into every later test in the same worker.
 *
 * The test named for `toISOString` is the one that shows the tool has teeth: it demonstrates that
 * the zone list contains a zone where the UTC-conversion bug this helper is for would actually be
 * visible. Without it, every other test here could pass against a helper that changed nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  SYSTEM_TIME_ZONE,
  TEST_TIME_ZONES,
  atTime,
  canonicalTimeZone,
  currentTimeZone,
  freezeClockAt,
  inEveryTimeZone,
  inTimeZone,
  localDayString,
  localTime,
  unfreezeClock,
} from './clock';

describe('timezone control', () => {
  it('actually adopts every zone it offers', () => {
    for (const zone of TEST_TIME_ZONES) {
      inTimeZone(zone, () => {
        expect(currentTimeZone()).toBe(canonicalTimeZone(zone));
      });
    }
  });

  it('offers zones with distinct offsets, so a comparison between them is not a comparison with itself', () => {
    const midWinter = Date.UTC(2026, 0, 15, 12, 0, 0);
    const offsets = TEST_TIME_ZONES.map((zone) =>
      inTimeZone(zone, () => -new Date(midWinter).getTimezoneOffset()),
    );
    expect(new Set(offsets).size).toBe(TEST_TIME_ZONES.length);
  });

  it('includes a zone where a UTC conversion lands on a different date', () => {
    // 11pm on the 4th in Kolkata is still the 4th there and already the 5th nowhere, but the same
    // instant is the 4th in UTC and the 5th in Kiritimati. A function that formats a local
    // timestamp via toISOString would disagree with the calendar in at least one of these.
    const lateEvening = inTimeZone('Asia/Kolkata', () => localTime(2026, 3, 4, 23, 30));
    const localDates = TEST_TIME_ZONES.map((zone) => inTimeZone(zone, () => localDayString(lateEvening)));
    const isoDate = new Date(lateEvening).toISOString().slice(0, 10);
    expect(localDates.some((date) => date !== isoDate)).toBe(true);
  });

  it('puts the original zone back, including the case where TZ was never set', () => {
    const before = currentTimeZone();
    const envBefore = process.env.TZ;
    inTimeZone('Pacific/Kiritimati', () => {
      expect(currentTimeZone()).toBe('Pacific/Kiritimati');
    });
    expect(currentTimeZone()).toBe(before);
    expect(process.env.TZ).toBe(envBefore);
  });

  it('puts the zone back when the body throws', () => {
    const before = currentTimeZone();
    expect(() =>
      inTimeZone('Pacific/Marquesas', () => {
        throw new Error('assertion inside');
      }),
    ).toThrow('assertion inside');
    expect(currentTimeZone()).toBe(before);
  });

  it('holds the zone until an async body finishes, then puts it back', async () => {
    const before = currentTimeZone();
    const seen = await inTimeZone('Pacific/Chatham', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentTimeZone();
    });
    expect(seen).toBe('Pacific/Chatham');
    expect(currentTimeZone()).toBe(before);
  });

  it('nests without losing the outer zone', () => {
    inTimeZone('UTC', () => {
      inTimeZone('Asia/Kathmandu', () => {
        expect(currentTimeZone()).toBe(canonicalTimeZone('Asia/Kathmandu'));
      });
      expect(currentTimeZone()).toBe('UTC');
    });
    expect(currentTimeZone()).toBe(SYSTEM_TIME_ZONE);
  });

  it('refuses a typo before it can leave the process in Etc/Unknown', () => {
    expect(() => inTimeZone('Mars/Olympus_Mons', () => undefined)).toThrow(/is not a timezone/);
    expect(currentTimeZone()).toBe(SYSTEM_TIME_ZONE);
  });

  it('accepts a zone under its modern name even though ICU answers with the old one', () => {
    inTimeZone('Asia/Kolkata', () => {
      expect(currentTimeZone()).toBe('Asia/Calcutta');
      expect(-new Date().getTimezoneOffset()).toBe(330);
    });
  });
});

describe('inEveryTimeZone', () => {
  it('visits every zone once', () => {
    const visited: string[] = [];
    inEveryTimeZone((zone) => {
      visited.push(zone);
      expect(currentTimeZone()).toBe(canonicalTimeZone(zone));
    });
    expect(visited).toEqual([...TEST_TIME_ZONES]);
  });

  it('names the zone in the failure, so a reader knows which calendar broke it', () => {
    expect(() =>
      inEveryTimeZone((zone) => {
        if (zone === 'Pacific/Kiritimati') throw new Error('off by a day');
      }),
    ).toThrow('in Pacific/Kiritimati: off by a day');
    expect(currentTimeZone()).toBe(SYSTEM_TIME_ZONE);
  });
});

describe('local calendar arithmetic', () => {
  it('builds the same calendar date in every zone', () => {
    inEveryTimeZone(() => {
      const at = localTime(2026, 3, 4);
      const date = new Date(at);
      expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 3, 4]);
      expect(date.getHours()).toBe(0);
      expect(localDayString(at)).toBe('2026-04-04');
    });
  });

  it('keeps the day across a month boundary at the last minute of the month', () => {
    inEveryTimeZone(() => {
      expect(localDayString(localTime(2026, 1, 28, 23, 59))).toBe('2026-02-28');
      expect(localDayString(localTime(2026, 2, 1, 0, 1))).toBe('2026-03-01');
    });
  });
});

describe('clock control', () => {
  it('pins Date.now and new Date, and hands the real clock back', () => {
    const pinned = localTime(2026, 3, 4, 9, 15);
    const realBefore = Date.now();
    freezeClockAt(pinned);
    try {
      expect(Date.now()).toBe(pinned);
      expect(new Date().getTime()).toBe(pinned);
      expect(new Date().getDate()).toBe(4);
    } finally {
      unfreezeClock();
    }
    expect(Date.now()).toBeGreaterThanOrEqual(realBefore);
  });

  it('leaves timers running, so an unrelated await does not hang', async () => {
    const pinned = localTime(2026, 3, 4, 9, 15);
    await atTime(pinned, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      expect(Date.now()).toBe(pinned);
    });
    expect(Math.abs(Date.now() - pinned)).toBeGreaterThan(0);
  });

  it('hands the real clock back when the body throws', () => {
    const pinned = localTime(2026, 3, 4, 9, 15);
    expect(() =>
      atTime(pinned, () => {
        throw new Error('assertion inside');
      }),
    ).toThrow('assertion inside');
    expect(Date.now()).not.toBe(pinned);
  });

  it('can be combined with a zone, which is the pair most date bugs need', () => {
    // Late evening in Kolkata is the following day in Kiritimati. Code that decides "today" from
    // the pinned clock must answer with the zone's calendar, not with UTC's.
    const instant = inTimeZone('Asia/Kolkata', () => localTime(2026, 3, 4, 23, 30));
    inTimeZone('Pacific/Kiritimati', () =>
      atTime(instant, () => {
        expect(localDayString(Date.now())).toBe('2026-04-05');
      }),
    );
    inTimeZone('Asia/Kolkata', () =>
      atTime(instant, () => {
        expect(localDayString(Date.now())).toBe('2026-04-04');
      }),
    );
  });
});
