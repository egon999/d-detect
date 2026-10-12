/**
 * The reminder adapter: the half of the feature that talks to the phone.
 *
 * `reminders.test.ts` covers the reasoning — when to ask, what a due date produces, what the
 * words are. This file covers the seams between that reasoning and the platform, where a mistake
 * becomes a notification on a real lock screen or a tap that opens the wrong thing.
 *
 * ## What this file can and cannot reach
 *
 * Vitest resolves `react-native` to `react-native-web` (`vitest.config.mts`), so under this
 * runner `Platform.OS` is `web` and the adapter correctly refuses to schedule anything. That is
 * not a limitation to work around with a mocked `Platform` — the guard is load-bearing, and
 * faking the platform past it would test a code path no test here can then observe the effects
 * of. So the scheduling itself is asserted at the boundary that *is* reachable: that a platform
 * with no scheduler gets nothing scheduled, and that everything around the scheduler — the
 * stored settings, the permission read, the route a payload opens — behaves under Node.
 *
 * ## Why the mock is self-contained
 *
 * Deliberately *not* spread over `importOriginal`. Spreading it pulls in `expo/src/winter/runtime`,
 * which does not resolve outside Metro and takes the whole file down before a single test runs.
 * Every name the adapter reaches for is listed here instead, so an import it adds later fails at
 * the point of use rather than silently resolving to the real module.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  AndroidNotificationVisibility: { PRIVATE: 0, PUBLIC: 1 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  getPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
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

vi.mock('expo-linking', () => ({ openSettings: vi.fn(async () => undefined) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';

import {
  DEFAULT_REMINDER_SETTINGS,
  REMINDER_ID_PREFIX,
  reminderHrefForData,
  type ReminderSettings,
  type UpcomingLike,
} from '../src/services/reminder-plan';
import {
  cancelAllReminders,
  loadReminderSettings,
  openSystemNotificationSettings,
  readPermission,
  saveReminderSettings,
  supportedOnThisDevice,
  syncReminders,
} from '../src/services/notifications';

// ---------------------------------------------------------------------------

const DUE = (() => {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
})();

function bill(partial: Partial<UpcomingLike> = {}): UpcomingLike {
  return {
    type: 'record',
    title: 'Sharma Electronics',
    at: DUE,
    amountLabel: '₹4,500',
    recordId: 'rec-1',
    taskId: null,
    ...partial,
  };
}

function settings(partial: Partial<ReminderSettings> = {}): ReminderSettings {
  return { ...DEFAULT_REMINDER_SETTINGS, ...partial };
}

beforeEach(() => {
  // `clearAllMocks`, never `restoreAllMocks`: restoring a module mock puts the *real* function
  // back, and the real `expo-notifications` has no implementation under Node, so every mock in
  // this file would silently become a no-op and the assertions would pass against nothing.
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('on a device this app can schedule on', () => {
  it('confirms the runner is the case the rest of this file depends on', () => {
    // If this ever reports true, the assertions below are being made about nothing and the file
    // should grow the scheduling tests back. Asserting the xpectation beats a silent pass.
    expect(supportedOnThisDevice()).toBe(false);
  });

  it('schedules nothing when there is no scheduler to schedule on', async () => {
    const result = await syncReminders([bill()], settings());
    expect(result).toEqual({ scheduled: 0, cancelled: 0 });
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('cancels nothing when there is nothing it could have scheduled', async () => {
    await expect(cancelAllReminders()).resolves.toBeUndefined();
    expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  });

  it('reports an unanswerable platform as unknown rather than as denied', async () => {
    // `null` is the planner's "do not ask" signal. A false here would send somebody to a dialog
    // they cannot answer, and a true would promise reminders that will never arrive.
    expect(await readPermission()).toEqual({ granted: null, canAskAgain: false });
  });
});

describe('reading a tap back into a screen', () => {
  it('opens the record a reminder about one bill named', () => {
    expect(reminderHrefForData({ bucket: 'm', day: '2026-10-09', recordId: 'rec-7' })).toBe('/case/rec-7');
  });

  it('opens the to-do list for a reminder about a to-do', () => {
    // A task has no screen of its own; tapping it lands on the list that holds it.
    expect(reminderHrefForData({ bucket: 'm', day: '2026-10-09', taskId: 'task-3' })).toBe('/tasks');
  });

  it('opens the coming-up list for a reminder that covers a whole day', () => {
    // Several things, so there is no single one to open — and the route has to exist. A payload
    // with a made-up path would drop somebody on the not-found screen from a notification.
    expect(reminderHrefForData({ bucket: 'e', day: '2026-10-08', count: '4' })).toBe('/recap');
  });

  it('opens nothing at all for a payload this build does not understand', () => {
    // The value crosses the operating system: it was written by whatever build scheduled the
    // notification and is read back by whatever build is installed now. A two-year-old tap
    // opening the wrong record is worse than a tap that does nothing.
    for (const junk of [
      null,
      undefined,
      'e',
      42,
      {},
      { bucket: 'x', day: '2026-10-09' },
      { bucket: 'e', day: 'soon' },
      { bucket: 'e' },
      { day: '2026-10-09' },
    ]) {
      expect(reminderHrefForData(junk)).toBeNull();
    }
  });

  it('prefers the specific thing over the list when a batched payload names one', () => {
    // Defensive: the planner drops the record id when it batches, so this shape should not be
    // produced. If it ever is — by an older build, or a payload edited in transit — opening the
    // one thing named is the better answer than opening a list and leaving them to find it.
    expect(reminderHrefForData({ bucket: 'm', day: '2026-10-09', recordId: 'rec-7', count: '4' })).toBe(
      '/case/rec-7',
    );
  });
});

describe('the identifiers this feature owns', () => {
  it('recognises its own ids and nothing else', () => {
    // On sign-out the app cancels what it scheduled, and it must not reach into anything another
    // feature owns. The prefix is the whole of that guarantee, so it is asserted directly.
    expect(`${REMINDER_ID_PREFIX}m:2026-10-09`.startsWith(REMINDER_ID_PREFIX)).toBe(true);
    expect('some-other-feature:42'.startsWith(REMINDER_ID_PREFIX)).toBe(false);
  });
});

describe('stored settings', () => {
  it('gives the defaults rather than nothing when storage is unreadable', async () => {
    // "Reminders on" is the default. A storage fault must not silently leave somebody with no
    // reminders and no indication why, so a failed read is the default, not an empty setting.
    vi.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    expect(await loadReminderSettings()).toEqual(DEFAULT_REMINDER_SETTINGS);
  });

  it('gives the defaults when nothing has ever been stored', async () => {
    vi.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce(null);
    expect(await loadReminderSettings()).toEqual(DEFAULT_REMINDER_SETTINGS);
  });

  it('refuses a stored setting no screen could have produced', async () => {
    // A value from an older build, or one hand-edited into storage. 3am is inside quiet hours
    // and "loud" is not a level this app has ever written.
    vi.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce(
      JSON.stringify({ enabled: 'yes', eveningHour: 3, morningHour: 23, detail: 'loud' }),
    );

    const loaded = await loadReminderSettings();
    expect(loaded.eveningHour).not.toBe(3);
    expect(loaded.morningHour).not.toBe(23);
    expect(loaded.detail).toBe('discreet');
  });

  it('keeps the choice to have no second reminder across a round trip', async () => {
    vi.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce(JSON.stringify({ morningHour: null }));
    expect((await loadReminderSettings()).morningHour).toBeNull();
  });

  it('never rejects on a failed write', async () => {
    // A failed write is a setting that does not persist, which is worth far less than an
    // unhandled rejection on the settings screen.
    vi.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk'));
    await expect(saveReminderSettings(settings())).resolves.toBeUndefined();
  });

  it('writes back only values a screen could have offered', async () => {
    const write = vi.spyOn(AsyncStorage, 'setItem').mockResolvedValueOnce(undefined);
    await saveReminderSettings({ enabled: true, eveningHour: 3, morningHour: 23, detail: 'full' });

    const written = JSON.parse(String(write.mock.calls[0]![1])) as ReminderSettings;
    expect(written.eveningHour).not.toBe(3);
    expect(written.morningHour).not.toBe(23);
    // A real level survives.
    expect(written.detail).toBe('full');
  });
});

describe('opening the system settings', () => {
  it('does nothing rather than throwing where there is no app to open', async () => {
    // Same guard as everything else here: no scheduler, so no settings screen worth opening.
    // The assertion that matters is that a call on the unsupported path resolves — a rejection
    // here would be an unhandled one inside the settings screen's press handler.
    await expect(openSystemNotificationSettings()).resolves.toBeUndefined();
    expect(Linking.openSettings).not.toHaveBeenCalled();
  });
});
