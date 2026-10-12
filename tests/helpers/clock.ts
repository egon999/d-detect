/**
 * Control over the two machine-specific things this product's logic reads: what day it is, and
 * which calendar the device is keeping.
 *
 * ## Why this exists
 *
 * Almost every date decision in D-Detect is deliberately *local*. A due date is stored as local
 * midnight, a task due today must not read as overdue, "Today" and "Yesterday" headings group by
 * the device's own calendar, and a date typed `03/04` means the third of April. India is +05:30
 * and never shifts for daylight saving, so the failure that keeps appearing is not a DST one: any
 * trip through UTC moves the date by a whole day for five and a half hours out of every
 * twenty-four. A test written in Kolkata that reaches for `toISOString` passes here and fails on a
 * CI runner set to UTC, and the reverse is just as true — which is the only kind of failure that
 * teaches a reader nothing, because the code and the assertion are both "correct" on the machine
 * where they were written.
 *
 * The existing date tests avoid this by building every expectation from local parts and passing
 * `now` in as an argument. That convention is right and this helper does not replace it. What it
 * adds is the ability to *prove* the convention holds, by re-running the same assertions in a zone
 * where a UTC round trip would land on a different date.
 *
 * ## Why the timezone is changed by assigning `process.env.TZ` at runtime
 *
 * Setting `TZ` in the environment before Node starts does not work on this machine: Node honours
 * `TZ=UTC` but silently ignores arbitrary IANA names, so `TZ=America/Los_Angeles npx vitest`
 * quietly runs in Asia/Calcutta and a cross-timezone comparison made that way is vacuous — it was,
 * and two of four "different timezone" runs turned out to be duplicates. Assigning
 * `process.env.TZ` at runtime does work, in the main process and inside a Vitest worker alike,
 * because the assignment triggers Node's own notification to ICU that the configuration changed.
 *
 * `delete process.env.TZ` does *not* trigger that notification. Deleting the variable leaves the
 * previously set zone cached, so a helper that cleaned up by deleting would leak the last zone it
 * set into every test that ran afterwards in the same worker — the worst possible outcome here,
 * because the leak is invisible and order-dependent. Restoring therefore assigns the captured
 * system zone first (which fixes the cache) and only then deletes the variable (which restores the
 * environment's shape, if it had no `TZ` to begin with).
 */

import { vi } from 'vitest';

/**
 * The zone this process started in, captured at import time, before anything has had a chance to
 * change it. Read from `Intl` rather than from `process.env.TZ`, because on a developer machine
 * the variable is usually unset and the real zone comes from the operating system.
 */
export const SYSTEM_TIME_ZONE: string = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Whether `TZ` was present in the environment before any of this ran. */
const TZ_WAS_SET = process.env.TZ !== undefined;

/**
 * Zones picked because each one breaks a different assumption, not for geographical coverage:
 *
 * - `UTC` is where a `toISOString` bug is invisible, so it is the control.
 * - `Asia/Kolkata` is the audience, and the half-hour offset that motivates all of this.
 * - `Asia/Kathmandu` is +05:45, which breaks arithmetic that assumes whole or half hours.
 * - `Pacific/Kiritimati` is +14:00: its local date is a day ahead of UTC's for most of the day.
 * - `Pacific/Marquesas` is -09:30: behind UTC, and a half hour in the other direction.
 * - `Pacific/Chatham` is +12:45 and observes daylight saving, so its offset is not even constant.
 * - `America/Los_Angeles` crosses DST on dates a North American reader would recognise.
 */
export const TEST_TIME_ZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Pacific/Kiritimati',
  'Pacific/Marquesas',
  'Pacific/Chatham',
  'America/Los_Angeles',
] as const;

export type TestTimeZone = (typeof TEST_TIME_ZONES)[number];

/** The zone currently in force, as ICU sees it rather than as the environment claims. */
export function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The name ICU will report after being asked for `zone`.
 *
 * Several IANA names are aliases, and ICU answers with the older one: ask for `Asia/Kolkata` and
 * every subsequent reading says `Asia/Calcutta`. A check written as a string comparison against
 * the requested name therefore fails on a zone that was adopted perfectly, which is why the
 * verification below compares against this instead.
 *
 * Also the only honest way to reject a name: a garbage zone assigned through `process.env.TZ` does
 * not raise anything, it leaves the process in `Etc/Unknown` — a calendar with no offset at all,
 * which would quietly make every later date assertion in the worker meaningless. Asking `Intl`
 * first means a typo is refused before anything is mutated.
 */
export function canonicalTimeZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(
      `"${zone}" is not a timezone this Node build knows. Assigning it would leave the process in ` +
        'Etc/Unknown and every date assertion after it would be meaningless. Pick a zone from ' +
        'TEST_TIME_ZONES, which tests/helpers/clock.test.ts checks are all genuinely adopted.',
    );
  }
}

function applyTimeZone(zone: string): void {
  const expected = canonicalTimeZone(zone);
  process.env.TZ = zone;
  if (currentTimeZone() !== expected) {
    throw new Error(
      `This Node build did not accept the timezone "${zone}" — it is still in ` +
        `"${currentTimeZone()}". Any comparison made in it would be a comparison with itself. ` +
        'Pick a zone from TEST_TIME_ZONES, which are checked by tests/helpers/clock.test.ts.',
    );
  }
}

function restoreTimeZone(previous: string | undefined): void {
  // Assign first so ICU is told; delete second so the environment looks as it did. The order is
  // not cosmetic: deleting alone would leave the last zone set here in force for every later test.
  applyTimeZone(previous ?? SYSTEM_TIME_ZONE);
  if (previous === undefined && !TZ_WAS_SET) delete process.env.TZ;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

/**
 * Runs `body` with the device calendar set to `zone`, restoring the previous zone afterwards even
 * if `body` throws. An async `body` is awaited before the zone is put back, so a test that does
 * its work in a promise still sees the zone it asked for.
 */
export function inTimeZone<T>(zone: string, body: () => T): T {
  const previous = process.env.TZ;
  applyTimeZone(zone);
  let handedOff = false;
  try {
    const result = body();
    if (isThenable(result)) {
      handedOff = true;
      return Promise.resolve(result).finally(() => restoreTimeZone(previous)) as T;
    }
    return result;
  } finally {
    if (!handedOff) restoreTimeZone(previous);
  }
}

/**
 * Runs the same assertions once per zone in {@link TEST_TIME_ZONES}, naming the zone in any
 * failure. This is the point of the whole file: a date function that reads the device calendar is
 * only proven correct by being asked the same question from several calendars.
 */
export function inEveryTimeZone(body: (zone: string) => void): void {
  for (const zone of TEST_TIME_ZONES) {
    try {
      inTimeZone(zone, () => body(zone));
    } catch (error) {
      if (error instanceof Error) {
        error.message = `in ${zone}: ${error.message}`;
      }
      throw error;
    }
  }
}

/**
 * A timestamp built from local calendar parts, which is how every date in this product is actually
 * created — a person picks the 4th of April and means their own 4th of April. Spelling the parts
 * out keeps the expectation true in whatever zone the test is running in, where a literal like
 * `Date.parse('2026-04-04')` would silently mean UTC midnight and be the 3rd in Marquesas.
 */
export function localTime(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return new Date(year, monthIndex, day, hour, minute, second, 0).getTime();
}

/** The `YYYY-MM-DD` the device's own calendar would call this instant. */
export function localDayString(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Pins `Date.now()` and `new Date()` to `at` until {@link unfreezeClock} is called.
 *
 * Only `Date` is faked. Faking the timers as well would stop any `setTimeout` the code under test
 * owns from ever firing unless the test remembered to advance them, which turns an unrelated
 * async test into a silent ten-second timeout — a failure that points at the wrong file. The
 * functions in this product take `now` as an argument precisely so they do not need this; it is
 * here for the handful of call sites that still default to `Date.now()` internally and so offer no
 * seam to inject through.
 */
export function freezeClockAt(at: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

/** Hands the real clock back. Safe to call when the clock was never frozen. */
export function unfreezeClock(): void {
  vi.useRealTimers();
}

/** Runs `body` with the clock pinned to `at`, restoring the real clock afterwards. */
export function atTime<T>(at: number, body: () => T): T {
  freezeClockAt(at);
  let handedOff = false;
  try {
    const result = body();
    if (isThenable(result)) {
      handedOff = true;
      return Promise.resolve(result).finally(() => unfreezeClock()) as T;
    }
    return result;
  } finally {
    if (!handedOff) unfreezeClock();
  }
}
