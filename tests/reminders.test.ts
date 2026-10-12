/**
 * The reminder planner.
 *
 * This is the only part of the reminder feature that can be tested at all — the rest is calls
 * into a native scheduler — and it is also the part where a mistake is worst. A notification
 * is the one thing this app says to somebody who is not looking at it, on a lock screen other
 * people can read, hours or weeks after the code that wrote it ran. There is no screen around
 * it to soften a bad sentence, no way to take it back, and the person who gets hurt by a
 * careless one is the person sharing a phone or standing in a queue.
 *
 * So six things are pinned down here, and each one prevents something specific:
 *
 *  - **What a due date produces.** Two reminders and not four, on the days they should be, with
 *    nothing scheduled into the past and nothing scheduled about a month away.
 *  - **What gets cancelled.** A to-do ticked off, a bill deleted, a date moved — each has to
 *    withdraw the reminder that was going to be sent, because a reminder about something
 *    already done is worse than no reminder: it is the app being wrong out loud.
 *  - **How a day batches.** Four things due on one day is one notification. Somebody whose
 *    phone buzzes four times learns to swipe this app away, and swiping is permanent.
 *  - **The visible text at every privacy level.** No amount and no name may reach the title at
 *    any level, because the title is what a collapsed lock-screen notification shows. Every
 *    string a person can see is also run through the leak and sentence checks, so no id, no
 *    status code and no developer phrasing can ship in the most public text this app produces.
 *  - **Quiet hours.** Nothing at 3am, enforced on the one path from an hour to an instant,
 *    including for stored settings no screen would ever produce.
 *  - **When permission is asked for.** Never at launch, at most twice ever, and never again
 *    once the phone says asking cannot help.
 *
 * `expo-notifications` is mocked rather than imported for real: it is a native module with no
 * implementation under Node, and importing it is the documented way to make this file hang. The
 * factory spreads `importOriginal` so that production code adding one more import from the
 * module does not red out the whole file with an unrelated "no export named" error.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPermissionsAsync: vi.fn(async () => ({ granted: false, canAskAgain: true })),
  requestPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  scheduleNotificationAsync: vi.fn(async () => 'scheduled'),
  cancelScheduledNotificationAsync: vi.fn(async () => undefined),
  getAllScheduledNotificationsAsync: vi.fn(async () => []),
  setNotificationChannelAsync: vi.fn(async () => null),
  setNotificationHandler: vi.fn(),
  getLastNotificationResponse: vi.fn(() => null),
  clearLastNotificationResponse: vi.fn(),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
}));

import {
  ASK_AGAIN_AFTER_MS,
  DEFAULT_REMINDER_SETTINGS,
  EVENING_HOUR_OPTIONS,
  MAX_ASKS,
  MAX_NAME_LENGTH,
  MAX_SCHEDULED_REMINDERS,
  MORNING_HOUR_OPTIONS,
  QUIET_HOURS_FROM,
  QUIET_HOURS_TO,
  SCHEDULE_WINDOW_DAYS,
  asUpcoming,
  clampToQuietHours,
  dayKey,
  decidePermission,
  dueThingsFromUpcoming,
  hourLabel,
  inQuietHours,
  isReminderId,
  normalizeSettings,
  parseReminderData,
  planReminders,
  reconcile,
  reminderDestination,
  reminderHref,
  reminderHrefForData,
  reminderId,
  reminderWords,
  shiftDay,
  startOfDay,
  truncateName,
  type DueThing,
  type ExistingReminder,
  type Occasion,
  type ReminderDetail,
  type ReminderSettings,
  type UpcomingApiLike,
  type UpcomingLike,
} from '../src/services/reminder-plan';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A fixed Tuesday afternoon, built from local parts.
 *
 * Local rather than a UTC epoch literal, because every date rule in this product is about the
 * day on the person's own calendar — the same reason the planner uses `setHours` throughout.
 * An epoch literal would make this file pass in one timezone and fail in another.
 */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return date.getTime();
}

const NOW = at(2026, 10, 6, 14, 30);

function thing(partial: Partial<DueThing> & { dueAt: number }): DueThing {
  return {
    kind: 'record',
    key: `k:${partial.dueAt}:${partial.title ?? 'x'}`,
    title: 'Electricity bill',
    amountLabel: null,
    recordId: 'rec-1',
    taskId: null,
    ...partial,
  };
}

function task(partial: Partial<DueThing> & { dueAt: number }): DueThing {
  return thing({
    kind: 'task',
    title: 'Ask the shop for the bill',
    recordId: null,
    taskId: 'task-1',
    ...partial,
  });
}

function settings(partial: Partial<ReminderSettings> = {}): ReminderSettings {
  return { ...DEFAULT_REMINDER_SETTINGS, ...partial };
}

/**
 * An occasion, defaulting to the shape that is easy to get wrong: the evening *before*.
 *
 * `dayAt` is the day the reminder fires on, and for an evening reminder that is the day before
 * the thing is due. A fixture that paired `slot: 'evening'` with a `dayAt` on the due day looked
 * reasonable and described a reminder about something that had already happened — which is how
 * the "was due yesterday" bug survived review the first time. Override `dayAt` to build a
 * morning occasion; the default is the evening one because it is the one with two dates in it.
 */
function occasion(partial: Partial<Occasion> & { items: readonly DueThing[] }): Occasion {
  const dayAt = partial.dayAt ?? at(2026, 10, 6, 19);
  return {
    slot: 'evening',
    day: dayKey(dayAt),
    dayAt,
    ...partial,
  };
}

const DETAIL_LEVELS: ReminderDetail[] = ['discreet', 'titles', 'full'];

// ---------------------------------------------------------------------------
// The copy checks, borrowed from the account-settings suite
// ---------------------------------------------------------------------------

/**
 * Anything that is machinery rather than language.
 *
 * The same list the account screen's copy is held to, plus the words this feature in particular
 * would be tempted to use. "Sync", "schedule" and "notification" are developer words for what
 * the person experiences as being reminded; a provider name on a lock screen tells a stranger
 * which services somebody uses.
 */
const LEAKS = [
  /auth\//i,
  /firebase|firestore|googleapis|grpc|xhr|axios|expo/i,
  /\berror\s*\(/i,
  /\b(?:TypeError|RangeError|SyntaxError|ReferenceError|Exception)\b/,
  /\bundefined\b|\bnull\b|\bNaN\b/,
  /[{}[\]<>]|=>/,
  // A status code, but not the back half of a rupee figure: "₹4,500" is a real amount read off
  // a real bill and is exactly what the top detail level is for, so the digits either side of a
  // separator are excluded rather than the whole check being dropped.
  /\bHTTP\b|(?<![\d,.])[45]\d\d(?![\d,.])/,
  /\bAPI\b|\bSDK\b|\btoken\b/i,
  /\bsync(?:ed|ing|hronis)?\b/i,
  /\bschedul(?:e|ed|ing)\b/i,
  /\bnotification\b/i,
  /\bpayload\b|\bchannel\b|\btrigger\b/i,
  /\bid\b[:=]|\brec-|\btask-/i,
  // The shapes a count takes when a developer wrote it rather than a person: "1 item(s)", a
  // stray "0 things", or the word the product never shows anybody.
  /\(s\)|\bitem\b|\bentry\b|\brecord\b/i,
  /\b0 (?:things?|due|late)\b/,
];

/** Reads as something a person wrote: words, and a capital at the front. */
function readsLikeCopy(text: string): boolean {
  if (text.trim() !== text) return false;
  if (text.length < 8 || text.length > 160) return false;
  if (!/^[A-Z₹$€£]/.test(text)) return false;
  return text.split(/\s+/).length >= 3;
}

/** Fails with the offending string in the message, so a red test names the sentence. */
function expectCleanCopy(text: string): void {
  for (const leak of LEAKS) {
    expect(leak.test(text), `"${text}" matches ${leak}`).toBe(false);
  }
  expect(readsLikeCopy(text), `"${text}" does not read like copy`).toBe(true);
}

// ---------------------------------------------------------------------------

describe('what a due date produces', () => {
  it('turns one bill into exactly two reminders: the evening before and the morning of', () => {
    const due = at(2026, 10, 9);
    const plan = planReminders([thing({ dueAt: due })], settings(), NOW);

    expect(plan).toHaveLength(2);
    // The evening one belongs to the 8th and the morning one to the 9th — a reminder "the
    // evening before" that fired on the due day itself would arrive after the deadline.
    const evening = plan.find((r) => r.data.bucket === 'e');
    const morning = plan.find((r) => r.data.bucket === 'm');
    expect(evening?.data.day).toBe('2026-10-08');
    expect(morning?.data.day).toBe('2026-10-09');
    expect(new Date(evening!.at).getHours()).toBe(DEFAULT_REMINDER_SETTINGS.eveningHour);
    expect(new Date(morning!.at).getHours()).toBe(DEFAULT_REMINDER_SETTINGS.morningHour);
    expect(evening!.at).toBeLessThan(morning!.at);
    expect(evening!.at).toBeLessThan(due + 24 * 60 * 60 * 1000);
  });

  it('never places a reminder in the past', () => {
    // The evening slot for something due tomorrow is 7pm *today*, which has not yet happened
    // at 2:30pm. The morning slot for something due today is 8am today, which has.
    const plan = planReminders(
      [thing({ dueAt: at(2026, 10, 6), title: 'Due today' }), thing({ dueAt: at(2026, 10, 7), title: 'Due tomorrow' })],
      settings(),
      NOW,
    );
    for (const reminder of plan) {
      expect(reminder.at).toBeGreaterThan(NOW);
    }
    // Today's morning slot is gone, so nothing claims to remind about it.
    expect(plan.some((r) => r.data.bucket === 'm' && r.data.day === '2026-10-06')).toBe(false);
  });

  it('says nothing at all about something a month away', () => {
    const faraway = shiftDay(NOW, SCHEDULE_WINDOW_DAYS + 5);
    expect(planReminders([thing({ dueAt: faraway })], settings(), NOW)).toEqual([]);
  });

  it('gives an undated to-do no reminder rather than one dated 1970', () => {
    // A to-do with no due date is the ordinary case in this app. The guard matters because a
    // missing date reaching a scheduler becomes either an alarm at the epoch — which fires at
    // once, for every undated thing somebody owns — or a NaN that silently schedules nothing.
    const upcoming: UpcomingLike[] = [
      { type: 'task', title: 'Get round to this', at: null, amountLabel: null, recordId: null, taskId: 't1' },
      { type: 'task', title: 'And this', at: 0, amountLabel: null, recordId: null, taskId: 't2' },
      { type: 'task', title: 'Pay the rent', at: at(2026, 10, 9), amountLabel: null, recordId: null, taskId: 't3' },
    ];
    const things = dueThingsFromUpcoming(upcoming);
    expect(things.map((t) => t.title)).toEqual(['Pay the rent']);
    for (const one of things) {
      expect(Number.isFinite(one.dueAt)).toBe(true);
      expect(one.dueAt).toBeGreaterThan(0);
    }
  });

  it('refuses to remind anybody about a figure the product worked out itself', () => {
    // A recurring prediction has no amount on any record — the server derives it from past
    // payments. Announcing it as "₹1,200 is due tomorrow" states a figure about somebody's
    // money that nothing in their own records contains.
    const upcoming: UpcomingLike[] = [
      { type: 'recurring', title: 'Probably the broadband', at: at(2026, 10, 9), amountLabel: null, recordId: 'r9', taskId: null },
      { type: 'record', title: 'Electricity bill', at: at(2026, 10, 9), amountLabel: '₹4,500', recordId: 'r1', taskId: null },
    ];
    const things = dueThingsFromUpcoming(upcoming);
    expect(things).toHaveLength(1);
    expect(things[0]!.title).toBe('Electricity bill');
  });

  it('mentions a late to-do once and never a late bill', () => {
    // A to-do can be ticked off, so "this was due yesterday" is both actionable and true. A
    // saved bill has no such state: most dated bills were paid and the app was never told, so
    // the same sentence about one would be wrong about most of the documents it named.
    const plan = planReminders(
      [task({ dueAt: at(2026, 10, 7), title: 'Call the landlord' }), thing({ dueAt: at(2026, 10, 7) })],
      settings(),
      NOW,
    );
    const morningAfter = plan.find((r) => r.data.bucket === 'm' && r.data.day === '2026-10-08');
    expect(morningAfter).toBeDefined();
    expect(morningAfter!.data.count).toBe('1');

    // And only once: the day after that carries nothing.
    expect(plan.some((r) => r.data.bucket === 'm' && r.data.day === '2026-10-09')).toBe(false);
  });

  it('never queues more reminders than the platform will keep', () => {
    // iOS holds 64 pending local notifications and silently discards the rest, so an unbounded
    // plan means a busy month stops producing reminders with nothing on screen to say so.
    const many = Array.from({ length: 200 }, (_, index) =>
      thing({ dueAt: shiftDay(NOW, (index % SCHEDULE_WINDOW_DAYS) + 1), title: `Bill ${index}`, key: `k${index}` }),
    );
    const plan = planReminders(many, settings(), NOW);
    expect(plan.length).toBeLessThanOrEqual(MAX_SCHEDULED_REMINDERS);
    // What is dropped is the furthest out, so what is kept is always the most urgent.
    const sorted = [...plan].sort((a, b) => a.at - b.at);
    expect(plan.map((r) => r.at)).toEqual(sorted.map((r) => r.at));
  });

  it('schedules nothing when reminders are switched off', () => {
    expect(planReminders([thing({ dueAt: at(2026, 10, 9) })], settings({ enabled: false }), NOW)).toEqual([]);
  });

  it('drops the second reminder of the day when somebody turns it off, keeping the first', () => {
    const plan = planReminders([thing({ dueAt: at(2026, 10, 9) })], settings({ morningHour: null }), NOW);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.data.bucket).toBe('e');
  });
});

describe('batching a day', () => {
  it('turns four things due on one day into one reminder a slot, not one a thing', () => {
    const due = at(2026, 10, 9);
    const plan = planReminders(
      [
        thing({ dueAt: due, title: 'Electricity bill', key: 'a' }),
        thing({ dueAt: due, title: 'Water bill', key: 'b' }),
        task({ dueAt: due, title: 'Return the deposit form', key: 'c' }),
        thing({ dueAt: due, title: 'Broadband', key: 'd' }),
      ],
      settings(),
      NOW,
    );

    // A phone that buzzes four times teaches somebody to swipe this app away, and swiping is
    // permanent. So no day-and-slot pair may ever hold more than one reminder.
    const slots = plan.map((r) => `${r.data.day}:${r.data.bucket}`);
    expect(new Set(slots).size).toBe(slots.length);

    // The two reminders about the 9th each carry all four things.
    const aboutTheDay = plan.filter((r) => r.data.day === '2026-10-08' || (r.data.day === '2026-10-09' && r.data.bucket === 'm'));
    expect(aboutTheDay).toHaveLength(2);
    for (const reminder of aboutTheDay) {
      expect(reminder.data.count).toBe('4');
    }

    // Plus one late notice the morning after, for the to-do alone — a bill never gets one,
    // because the app was not told whether it was paid.
    const lateNotice = plan.filter((r) => r.data.day === '2026-10-10');
    expect(lateNotice).toHaveLength(1);
    expect(lateNotice[0]!.data.count).toBe('1');
    expect(plan).toHaveLength(3);
  });

  it('gives a batched reminder no single thing to open, and a lone one the thing itself', () => {
    const due = at(2026, 10, 9);
    const batched = planReminders(
      [thing({ dueAt: due, recordId: 'r1', key: 'a' }), thing({ dueAt: due, recordId: 'r2', key: 'b' })],
      settings(),
      NOW,
    );
    for (const reminder of batched) {
      expect(reminder.data.recordId).toBeUndefined();
      expect(reminderDestination(reminder.data)).toEqual({ kind: 'upcoming' });
    }

    const lone = planReminders([thing({ dueAt: due, recordId: 'r1' })], settings(), NOW);
    expect(reminderDestination(lone[0]!.data)).toEqual({ kind: 'record', recordId: 'r1' });

    const loneTask = planReminders([task({ dueAt: due, taskId: 't7' })], settings(), NOW);
    expect(reminderDestination(loneTask[0]!.data)).toEqual({ kind: 'tasks' });
  });

  it('keeps each day in its own reminder rather than merging the week', () => {
    const plan = planReminders(
      [thing({ dueAt: at(2026, 10, 9), key: 'a' }), thing({ dueAt: at(2026, 10, 12), key: 'b' })],
      settings(),
      NOW,
    );
    const days = new Set(plan.map((r) => r.data.day));
    expect(days.size).toBe(4);
    for (const reminder of plan) {
      expect(reminder.data.count).toBe('1');
    }
  });
});

describe('what gets cancelled', () => {
  /** What the phone is holding right now, derived from a plan rather than hand-written. */
  function held(things: readonly DueThing[], from: ReminderSettings = settings()): ExistingReminder[] {
    return planReminders(things, from, NOW).map((r) => ({ id: r.id, fingerprint: r.fingerprint }));
  }

  it('withdraws every reminder when a to-do is ticked off', () => {
    const open = [task({ dueAt: at(2026, 10, 9), taskId: 't1' })];
    const existing = held(open);
    // A to-do has three: the evening before, the morning of, and the late notice the morning
    // after. All three have to go. A reminder that still arrives about something already done
    // teaches somebody the reminders are wrong, and then the one that mattered gets ignored too.
    expect(existing).toHaveLength(3);

    // Ticked off means the server stops listing it, so the desired plan is empty. The
    // cancellation falls out of that difference rather than out of a cleanup pass somebody has
    // to remember to run, which is the only version that cannot be forgotten at a call site.
    const plan = reconcile(planReminders([], settings(), NOW), existing);
    expect(plan.cancel.sort()).toEqual(existing.map((e) => e.id).sort());
    expect(plan.create).toEqual([]);
  });

  it('withdraws the reminder for a deleted bill and leaves an unrelated one alone', () => {
    const before = [
      thing({ dueAt: at(2026, 10, 9), recordId: 'r1', key: 'a', title: 'Electricity bill' }),
      thing({ dueAt: at(2026, 10, 14), recordId: 'r2', key: 'b', title: 'Water bill' }),
    ];
    const existing = held(before);
    const after = [before[1]!];

    const plan = reconcile(planReminders(after, settings(), NOW), existing);
    // The two slots about the 9th go; the two about the 14th are untouched, not cancelled and
    // re-created — a cancel-and-reschedule has a window in which the alarm is not armed at all.
    expect(plan.cancel).toHaveLength(2);
    expect(plan.create).toEqual([]);
    for (const id of plan.cancel) {
      expect(id).toContain('2026-10-0');
    }
  });

  it('moves both reminders when a due date changes', () => {
    const existing = held([thing({ dueAt: at(2026, 10, 9), key: 'a' })]);
    const plan = reconcile(planReminders([thing({ dueAt: at(2026, 10, 16), key: 'a' })], settings(), NOW), existing);

    expect(plan.cancel.sort()).toEqual([reminderId('evening', '2026-10-08'), reminderId('morning', '2026-10-09')].sort());
    expect(plan.create.map((r) => r.id).sort()).toEqual(
      [reminderId('evening', '2026-10-15'), reminderId('morning', '2026-10-16')].sort(),
    );
  });

  it('rewrites a reminder whose words changed without changing which day it is about', () => {
    // Raising the detail level changes what a lock screen shows. A reminder already waiting
    // with the old wording has to be replaced, or somebody who just chose to hide their
    // amounts would still have tonight's reminder announcing one.
    const things = [thing({ dueAt: at(2026, 10, 9), amountLabel: '₹4,500' })];
    const existing = held(things, settings({ detail: 'full' }));
    const plan = reconcile(planReminders(things, settings({ detail: 'discreet' }), NOW), existing);

    expect(plan.cancel).toHaveLength(2);
    expect(plan.create).toHaveLength(2);
    // Same identifiers: the same two slots, re-worded.
    expect(plan.create.map((r) => r.id).sort()).toEqual(plan.cancel.slice().sort());
  });

  it('leaves a reminder completely alone when nothing about it has changed', () => {
    const things = [thing({ dueAt: at(2026, 10, 9) })];
    const plan = reconcile(planReminders(things, settings(), NOW), held(things));
    expect(plan).toEqual({ cancel: [], create: [] });
  });

  it('never cancels a notification this feature did not create', () => {
    const foreign: ExistingReminder[] = [
      { id: 'some-other-feature:42', fingerprint: 'x' },
      { id: 'detact-reminder:e:2026-10-08', fingerprint: 'stale' },
    ];
    const plan = reconcile([], foreign);
    expect(plan.cancel).toEqual(['detact-reminder:e:2026-10-08']);
    expect(isReminderId('some-other-feature:42')).toBe(false);
  });

  it('replaces a reminder left behind by a build that wrote no fingerprint', () => {
    const things = [thing({ dueAt: at(2026, 10, 9) })];
    const desired = planReminders(things, settings(), NOW);
    const plan = reconcile(desired, desired.map((r) => ({ id: r.id, fingerprint: '' })));
    expect(plan.cancel).toHaveLength(2);
    expect(plan.create).toHaveLength(2);
  });
});

describe('the visible text', () => {
  it('keeps every amount and every name out of the title at every level', () => {
    // The title is the one line a collapsed lock-screen notification shows, in front of whoever
    // is standing there. "₹4,500 to Sharma Electronics" on it is somebody's financial life
    // published to a room they did not choose.
    const one = occasion({
      items: [thing({ dueAt: at(2026, 10, 7), title: 'Sharma Electronics', amountLabel: '₹4,500' })],
    });
    for (const detail of DETAIL_LEVELS) {
      const { title } = reminderWords(one, detail);
      expect(title).not.toContain('Sharma');
      expect(title).not.toContain('4,500');
      expect(title).not.toContain('₹');
      expectCleanCopy(title);
    }
  });

  it('says nothing about the thing at all on the discreet default', () => {
    expect(DEFAULT_REMINDER_SETTINGS.detail).toBe('discreet');
    const { title, body } = reminderWords(
      occasion({ items: [thing({ dueAt: at(2026, 10, 7), title: 'Sharma Electronics', amountLabel: '₹4,500' })] }),
      'discreet',
    );
    for (const text of [title, body]) {
      expect(text).not.toContain('Sharma');
      expect(text).not.toContain('4,500');
      expectCleanCopy(text);
    }
    // The day belongs in the title, where it survives being collapsed; the body adds only that
    // there is something to open. A body that repeated the title verbatim would look like a bug.
    expect(title).toMatch(/tomorrow/);
    expect(body).not.toBe(title);
  });

  it('names the thing at the middle level and still states no amount', () => {
    const { body } = reminderWords(
      occasion({ items: [thing({ dueAt: at(2026, 10, 7), title: 'Sharma Electronics', amountLabel: '₹4,500' })] }),
      'titles',
    );
    expect(body).toContain('Sharma Electronics');
    expect(body).not.toContain('4,500');
    expectCleanCopy(body);
  });

  it('states the amount at the top level, and only the one written on the record', () => {
    const withAmount = reminderWords(
      occasion({ items: [thing({ dueAt: at(2026, 10, 7), title: 'Sharma Electronics', amountLabel: '₹4,500' })] }),
      'full',
    );
    expect(withAmount.body).toContain('₹4,500');
    expect(withAmount.body).toContain('Sharma Electronics');

    // No amount on the record means no amount in the sentence — not a zero, not a blank, and
    // not a figure worked out from anything.
    const withoutAmount = reminderWords(
      occasion({ items: [thing({ dueAt: at(2026, 10, 7), title: 'Sharma Electronics', amountLabel: null })] }),
      'full',
    );
    expect(withoutAmount.body).not.toMatch(/[₹$€£]|\b0\b/);
    expectCleanCopy(withoutAmount.body);
  });

  it('never totals several amounts into one figure', () => {
    const { body } = reminderWords(
      occasion({
        items: [
          thing({ dueAt: at(2026, 10, 7), title: 'Electricity', amountLabel: '₹4,500', key: 'a' }),
          thing({ dueAt: at(2026, 10, 7), title: 'Water', amountLabel: '₹1,200', key: 'b' }),
          thing({ dueAt: at(2026, 10, 7), title: 'Broadband', amountLabel: '₹900', key: 'c' }),
        ],
      }),
      'full',
    );
    // The only figure present is one that is written on a record, and it is attached to the
    // name it belongs to so it cannot read as a sum. The other two amounts are dropped rather
    // than added: three figures in one line is a total with extra steps.
    expect(body).toContain('₹4,500');
    expect(body).toContain('Electricity');
    expect(body).not.toContain('₹6,600');
    expect(body).not.toContain('₹1,200');
    expect(body).not.toContain('₹900');
    expect(body.match(/₹/g)).toHaveLength(1);
    expectCleanCopy(body);
  });

  it('reads as plain English for every shape of day at every level', () => {
    const shapes: Array<{ name: string; value: Occasion }> = [
      {
        name: 'one thing tomorrow',
        value: occasion({ items: [thing({ dueAt: at(2026, 10, 7) })] }),
      },
      {
        name: 'three things today',
        value: occasion({
          slot: 'morning',
          dayAt: at(2026, 10, 7),
          items: [
            thing({ dueAt: at(2026, 10, 7), title: 'Electricity', key: 'a', amountLabel: '₹4,500' }),
            thing({ dueAt: at(2026, 10, 7), title: 'Water', key: 'b' }),
            task({ dueAt: at(2026, 10, 7), title: 'Return the form', key: 'c' }),
          ],
        }),
      },
      {
        name: 'one late only',
        value: occasion({
          slot: 'morning',
          dayAt: at(2026, 10, 7),
          items: [task({ dueAt: at(2026, 10, 6), title: 'Call the landlord' })],
        }),
      },
      {
        name: 'two late only',
        value: occasion({
          slot: 'morning',
          dayAt: at(2026, 10, 7),
          items: [
            task({ dueAt: at(2026, 10, 6), title: 'Call the landlord', key: 'a' }),
            task({ dueAt: at(2026, 10, 6), title: 'Email the society', key: 'b' }),
          ],
        }),
      },
      {
        name: 'one due and one late',
        value: occasion({
          slot: 'morning',
          dayAt: at(2026, 10, 7),
          items: [
            thing({ dueAt: at(2026, 10, 7), title: 'Electricity', key: 'a', amountLabel: '₹4,500' }),
            task({ dueAt: at(2026, 10, 6), title: 'Call the landlord', key: 'b' }),
          ],
        }),
      },
      {
        name: 'six things',
        value: occasion({
          items: Array.from({ length: 6 }, (_, index) =>
            thing({ dueAt: at(2026, 10, 7), title: `Bill number ${index}`, key: `k${index}` }),
          ),
        }),
      },
    ];

    for (const shape of shapes) {
      for (const detail of DETAIL_LEVELS) {
        const { title, body } = reminderWords(shape.value, detail);
        expectCleanCopy(title);
        expectCleanCopy(body);
        // A reminder that does not say which day it is about is not a reminder.
        expect(`${title} ${body}`).toMatch(/today|tomorrow|yesterday/);
      }
    }
  });

  it('never calls tomorrow\'s bill late, on the evening reminder about it', () => {
    // The bug this pins down: the evening reminder fires on day D and is about day D+1, so
    // deriving "what is this about" from the fire day put tomorrow's bill in the past and had
    // the app announce, on a lock screen, the night before, that a bill which was not yet due
    // "was due yesterday". Every evening reminder was wrong in that build.
    const evening = occasion({
      slot: 'evening',
      dayAt: at(2026, 10, 8, 19),
      items: [thing({ dueAt: at(2026, 10, 9), title: 'Sharma Electronics', amountLabel: '₹4,500' })],
    });
    for (const detail of DETAIL_LEVELS) {
      const { title, body } = reminderWords(evening, detail);
      expect(`${title} ${body}`).not.toMatch(/yesterday|late/i);
      expect(`${title} ${body}`).toMatch(/tomorrow/);
    }
  });

  it('agrees the verb with the count when everything in a slot is late', () => {
    // "Call the landlord and Email the society was due yesterday" is the kind of sentence that
    // makes an app look broken to somebody who is already inclined not to trust it.
    const { body } = reminderWords(
      occasion({
        slot: 'morning',
        dayAt: at(2026, 10, 8, 8),
        items: [
          task({ dueAt: at(2026, 10, 7), title: 'Call the landlord', key: 'a' }),
          task({ dueAt: at(2026, 10, 7), title: 'Email the society', key: 'b' }),
        ],
      }),
      'titles',
    );
    expect(body).toContain('were due yesterday');

    const one = reminderWords(
      occasion({
        slot: 'morning',
        dayAt: at(2026, 10, 8, 8),
        items: [task({ dueAt: at(2026, 10, 7), title: 'Call the landlord' })],
      }),
      'titles',
    );
    expect(one.body).toContain('was due yesterday');
  });

  it('cuts a very long name at a word rather than mid-syllable', () => {
    const long = 'Payment to the Maharashtra State Electricity Distribution Company Limited office';
    const cut = truncateName(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/\s…$/);
    // A name written across two lines in the keyboard renders as a broken box in a notification.
    expect(truncateName('Pay  the\n  landlord')).toBe('Pay the landlord');
  });

  it('carries no words in the payload, so a three-week-old tap shows current wording', () => {
    const plan = planReminders([thing({ dueAt: at(2026, 10, 9), title: 'Sharma Electronics' })], settings(), NOW);
    for (const reminder of plan) {
      expect(JSON.stringify(reminder.data)).not.toContain('Sharma');
    }
  });
});

describe('quiet hours', () => {
  it('offers only hours that are already outside them', () => {
    for (const hour of [...EVENING_HOUR_OPTIONS, ...MORNING_HOUR_OPTIONS]) {
      expect(inQuietHours(at(2026, 10, 7, hour))).toBe(false);
    }
    expect(inQuietHours(at(2026, 10, 7, 3))).toBe(true);
    expect(inQuietHours(at(2026, 10, 7, QUIET_HOURS_FROM))).toBe(true);
    expect(inQuietHours(at(2026, 10, 7, QUIET_HOURS_TO - 1))).toBe(true);
  });

  it('pulls a 3am reminder out of the night rather than leaving it there', () => {
    // The path that matters is not the settings screen — it is a stored value from an older
    // build, or a device that has changed timezone since the schedule was written.
    const day = at(2026, 10, 7);
    for (const hour of [0, 3, 6, 20, 23]) {
      const moment = clampToQuietHours(day, hour);
      expect(inQuietHours(moment)).toBe(false);
    }
    // It moves earlier, never later: a 3am reminder pushed to 8am on the due day would arrive
    // after the morning somebody needed it for.
    expect(clampToQuietHours(day, 3)).toBeLessThan(day);
    expect(clampToQuietHours(day, 22)).toBeLessThan(at(2026, 10, 8));
  });

  it('places nothing in the night for any day of a month-long plan', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      thing({ dueAt: shiftDay(NOW, index), title: `Bill ${index}`, key: `k${index}` }),
    );
    const plan = planReminders(many, settings(), NOW);
    expect(plan.length).toBeGreaterThan(0);
    for (const reminder of plan) {
      expect(inQuietHours(reminder.at)).toBe(false);
    }
  });

  it('refuses a stored hour nobody could have chosen', () => {
    const fixed = normalizeSettings({ enabled: true, eveningHour: 2, morningHour: 23, detail: 'loud' });
    expect(EVENING_HOUR_OPTIONS).toContain(fixed.eveningHour);
    expect(MORNING_HOUR_OPTIONS).toContain(fixed.morningHour);
    expect(fixed.detail).toBe('discreet');
  });

  it('keeps the defaults when the stored settings are rubbish', () => {
    for (const junk of [null, undefined, 0, 'yes', [], { enabled: 'true' }]) {
      const fixed = normalizeSettings(junk);
      expect(typeof fixed.enabled).toBe('boolean');
      expect(EVENING_HOUR_OPTIONS).toContain(fixed.eveningHour);
      expect(DETAIL_LEVELS).toContain(fixed.detail);
    }
    // Turning the second reminder off is a real choice and must survive a round trip.
    expect(normalizeSettings({ ...DEFAULT_REMINDER_SETTINGS, morningHour: null }).morningHour).toBeNull();
  });

  it('writes a time the way a person would say it', () => {
    expect(hourLabel(19)).toBe('7pm');
    expect(hourLabel(8)).toBe('8am');
    expect(hourLabel(12)).toBe('12pm');
    expect(hourLabel(0)).toBe('12am');
    for (const hour of [...EVENING_HOUR_OPTIONS, ...MORNING_HOUR_OPTIONS]) {
      expect(hourLabel(hour)).toMatch(/^\d{1,2}(am|pm)$/);
    }
  });
});

describe('asking for permission', () => {
  const never: { asks: number; lastAskedAt: number | null } = { asks: 0, lastAskedAt: null };

  it('asks when a due date is set and the phone has not been asked before', () => {
    expect(decidePermission({ granted: false, canAskAgain: true }, never, settings())).toEqual({ action: 'ask' });
  });

  it('does not ask at all when the person has turned reminders off', () => {
    // There is no honest version of asking for permission to do something nobody wants done.
    expect(decidePermission({ granted: false, canAskAgain: true }, never, settings({ enabled: false }))).toEqual({
      action: 'skip',
    });
  });

  it('stops asking once the phone says asking cannot help', () => {
    // Terminal on both platforms: iOS stops after one refusal, Android after two. The only
    // route back is the system settings app, so the app offers that and nothing else.
    expect(decidePermission({ granted: false, canAskAgain: false }, never, settings())).toEqual({
      action: 'open-settings',
    });
    expect(decidePermission({ granted: false, canAskAgain: false }, { asks: 2, lastAskedAt: NOW }, settings())).toEqual(
      { action: 'open-settings' },
    );
  });

  it('asks at most twice, ever', () => {
    const longAgo = Date.now() - ASK_AGAIN_AFTER_MS * 10;
    expect(decidePermission({ granted: false, canAskAgain: true }, { asks: 1, lastAskedAt: longAgo }, settings())).toEqual(
      { action: 'ask' },
    );
    expect(
      decidePermission({ granted: false, canAskAgain: true }, { asks: MAX_ASKS, lastAskedAt: longAgo }, settings()),
    ).toEqual({ action: 'skip' });
  });

  it('waits a week before asking a second time', () => {
    // Somebody who sets three due dates in one sitting must not be asked three times; a second
    // refusal in that state is a decision about the app, not about the reminder.
    const justNow = Date.now() - 60 * 1000;
    expect(decidePermission({ granted: false, canAskAgain: true }, { asks: 1, lastAskedAt: justNow }, settings())).toEqual(
      { action: 'skip' },
    );
  });

  it('asks again rather than never, when the stored instant cannot be trusted', () => {
    // A clock moved backwards, or a value written by a broken build, must not lock somebody out
    // of ever being asked.
    const future = Date.now() + ASK_AGAIN_AFTER_MS;
    expect(decidePermission({ granted: false, canAskAgain: true }, { asks: 1, lastAskedAt: future }, settings())).toEqual(
      { action: 'ask' },
    );
  });

  it('does nothing when the platform will not say what it allows', () => {
    // Web, or a device where the check throws. Asking into a void produces a dialog nobody can
    // answer; the app works without reminders instead.
    expect(decidePermission({ granted: null, canAskAgain: false }, never, settings())).toEqual({ action: 'skip' });
  });

  it('reports a granted permission as granted regardless of the ask history', () => {
    expect(decidePermission({ granted: true, canAskAgain: false }, { asks: 2, lastAskedAt: NOW }, settings())).toEqual({
      action: 'granted',
    });
  });
});

describe('reading a tap back', () => {
  it('routes a reminder written by this build', () => {
    const plan = planReminders([thing({ dueAt: at(2026, 10, 9), recordId: 'r1' })], settings(), NOW);
    const parsed = parseReminderData(plan[0]!.data);
    expect(parsed).not.toBeNull();
    expect(reminderDestination(parsed)).toEqual({ kind: 'record', recordId: 'r1' });
  });

  it('opens nothing rather than something arbitrary when the payload is unreadable', () => {
    // This value crosses the operating system: it is stored by Android or iOS and handed back
    // to a later launch, possibly of a different build. A two-year-old notification opening the
    // wrong record would be worse than opening none.
    for (const junk of [null, undefined, 'e', 42, {}, { bucket: 'x', day: '2026-10-09' }, { bucket: 'e', day: 'soon' }]) {
      expect(parseReminderData(junk)).toBeNull();
      expect(reminderDestination(parseReminderData(junk))).toBeNull();
    }
  });

  it('survives a payload that has lost its count', () => {
    const parsed = parseReminderData({ bucket: 'm', day: '2026-10-09' });
    expect(parsed?.count).toBe('1');
    expect(reminderDestination(parsed)).toEqual({ kind: 'upcoming' });
  });
});

describe('which screen a tap opens', () => {
  it('turns each destination into a route that exists', () => {
    // Written as route strings rather than as router calls so this can be checked without a
    // navigator — and so that a route that does not exist shows up here rather than as the
    // not-found screen appearing when somebody taps a reminder on a lock screen.
    expect(reminderHref({ kind: 'record', recordId: 'rec-7' })).toBe('/case/rec-7');
    expect(reminderHref({ kind: 'tasks' })).toBe('/tasks');
    // The coming-up list is a section of the recap screen; there is no `/upcoming` route, and
    // a made-up path here would drop somebody on not-found from a notification.
    expect(reminderHref({ kind: 'upcoming' })).toBe('/recap');
    expect(reminderHref(null)).toBeNull();
  });

  it('goes from a raw payload to a route in one step', () => {
    // This is the path a tap takes in production: the stored payload, straight to a route.
    expect(reminderHrefForData({ bucket: 'm', day: '2026-10-09', recordId: 'rec-7' })).toBe('/case/rec-7');
    expect(reminderHrefForData({ bucket: 'e', day: '2026-10-08', count: '3' })).toBe('/recap');
    expect(reminderHrefForData('nonsense')).toBeNull();
  });
});

describe('what the server sent, before anything is planned', () => {
  function api(partial: Partial<UpcomingApiLike> & { title: string }): UpcomingApiLike {
    return {
      type: 'record',
      at: at(2026, 10, 9),
      amountLabel: null,
      recordId: 'rec-1',
      taskId: null,
      ...partial,
    };
  }

  it('carries only the amount written on the record', () => {
    // The whole point of the narrowing. `estimatedAmountLabel` is a figure the server worked
    // out from past payments — it is nowhere in the person's own records — and a reminder may
    // not announce a number the product invented. Asserting the field is absent rather than
    // merely unused, because "present but ignored" is one refactor away from being read.
    const [narrowed] = asUpcoming([
      api({
        title: 'Sharma Electronics',
        amountLabel: '₹4,500',
        estimated: true,
        estimatedAmountLabel: '₹9,999',
        estimatedFromOccurrences: 6,
      }),
    ]);

    expect(narrowed).toEqual({
      type: 'record',
      title: 'Sharma Electronics',
      at: at(2026, 10, 9),
      amountLabel: '₹4,500',
      recordId: 'rec-1',
      taskId: null,
    });
    expect(Object.keys(narrowed!)).not.toContain('estimatedAmountLabel');
    expect(JSON.stringify(narrowed)).not.toContain('9,999');
  });

  it('leaves the amount empty when the only figure is a guess', () => {
    // A recurring prediction: the server has an amount for it, but it invented it. The reminder
    // gets nothing to say about money, which is the honest outcome.
    const [narrowed] = asUpcoming([
      api({ title: 'Electricity', type: 'recurring', amountLabel: null, estimatedAmountLabel: '₹1,200' }),
    ]);
    expect(narrowed?.amountLabel).toBeNull();

    // And it does not survive into a scheduled reminder either — the prediction never becomes
    // a due thing in the first place.
    expect(dueThingsFromUpcoming(asUpcoming([api({ title: 'Electricity', type: 'recurring' })]))).toEqual([]);
  });

  it('passes an undated to-do straight through to be dropped by the planner', () => {
    // Two separate rules: this one only narrows, and the planner is what decides a reminder
    // needs a day. Kept as one assertion so the split is visible — a null date has to survive
    // this function to reach the drop, and a `0` substituted here would schedule at the epoch.
    const [narrowed] = asUpcoming([api({ title: 'Ask for the bill', type: 'task', at: null, taskId: 'task-1' })]);
    expect(narrowed?.at).toBeNull();
    expect(dueThingsFromUpcoming([narrowed!])).toEqual([]);
  });

  it('keeps every field a reminder is allowed to use', () => {
    const [narrowed] = asUpcoming([api({ title: 'Rent', taskId: 'task-9', recordId: null, amountLabel: '₹12,000' })]);
    expect(narrowed).toEqual({
      type: 'record',
      title: 'Rent',
      at: at(2026, 10, 9),
      amountLabel: '₹12,000',
      recordId: null,
      taskId: 'task-9',
    });
  });
});

describe('the calendar', () => {
  beforeEach(() => {
    // Nothing to reset — every function here takes its clock as an argument, which is the whole
    // reason this file can test date behaviour at all.
  });

  it('works on the local calendar, not in UTC', () => {
    // In India a UTC-rounded day files everything after 5:30am under the previous date, which
    // would put a bill due on the 9th into the 8th's reminder and skip the 9th entirely.
    const afternoon = at(2026, 10, 9, 14, 30);
    expect(dayKey(afternoon)).toBe('2026-10-09');
    expect(new Date(startOfDay(afternoon)).getHours()).toBe(0);
    expect(new Date(startOfDay(afternoon)).getDate()).toBe(9);
  });

  it('steps whole days rather than adding 24 hours', () => {
    // A clock change inside the interval would otherwise land the answer at 11pm on the wrong
    // day, and both the evening slot and the late list are found by stepping exactly one day.
    const day = at(2026, 10, 9);
    expect(dayKey(shiftDay(day, 1))).toBe('2026-10-10');
    expect(dayKey(shiftDay(day, -1))).toBe('2026-10-08');
    expect(dayKey(shiftDay(at(2026, 10, 31), 1))).toBe('2026-11-01');
    expect(dayKey(shiftDay(at(2027, 1, 1), -1))).toBe('2026-12-31');
    expect(new Date(shiftDay(day, 5)).getHours()).toBe(0);
  });
});
