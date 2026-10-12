import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEFAULT_REMINDER_SETTINGS,
  MAX_ASKS,
  REMINDER_ID_PREFIX,
  decidePermission,
  dueThingsFromUpcoming,
  normalizeSettings,
  planReminders,
  reconcile,
  reminderId,
  type AskHistory,
  type ExistingReminder,
  type PermissionDecision,
  type ReminderSettings,
  type UpcomingLike,
} from './reminder-plan';

const SETTINGS_KEY = 'detact:reminders:v1';
const ASK_HISTORY_KEY = 'detact:reminders:asks:v1';

const CHANNEL_ID = 'due-reminders';

const ANDROID_COLOR = '#BEA860';

export function supportedOnThisDevice(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const notifications = await import('expo-notifications');
  await notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Due reminders',
    description: 'A reminder the day before something is due, and again on the day.',
    importance: notifications.AndroidImportance.DEFAULT,

    lockscreenVisibility: notifications.AndroidNotificationVisibility.PRIVATE,

    lightColor: ANDROID_COLOR,
    vibrationPattern: [0, 200, 100, 200],
  });
}

export async function readPermission(): Promise<{ granted: boolean | null; canAskAgain: boolean }> {
  if (!supportedOnThisDevice()) return { granted: null, canAskAgain: false };
  try {
    const notifications = await import('expo-notifications');
    const current = await notifications.getPermissionsAsync();

    return {
      granted: current.granted === true ? true : current.granted === false ? false : null,
      canAskAgain: current.canAskAgain !== false,
    };
  } catch {
    return { granted: null, canAskAgain: false };
  }
}

export async function loadReminderSettings(): Promise<ReminderSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_REMINDER_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_REMINDER_SETTINGS;
  }
}

export async function saveReminderSettings(settings: ReminderSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
  } catch {

  }
}

async function loadAskHistory(): Promise<AskHistory> {
  try {
    const raw = await AsyncStorage.getItem(ASK_HISTORY_KEY);
    if (!raw) return { asks: 0, lastAskedAt: null };
    const parsed = JSON.parse(raw) as Partial<AskHistory>;
    return {
      asks: typeof parsed.asks === 'number' && parsed.asks >= 0 ? parsed.asks : 0,
      lastAskedAt: typeof parsed.lastAskedAt === 'number' ? parsed.lastAskedAt : null,
    };
  } catch {
    return { asks: 0, lastAskedAt: null };
  }
}

async function noteAsk(at: number): Promise<void> {
  try {
    const history = await loadAskHistory();
    await AsyncStorage.setItem(
      ASK_HISTORY_KEY,
      JSON.stringify({ asks: Math.min(history.asks + 1, MAX_ASKS), lastAskedAt: at }),
    );
  } catch {

  }
}

export async function ensureRemindersAllowed(settings: ReminderSettings): Promise<PermissionDecision> {
  const history = await loadAskHistory();
  let decision = decidePermission(await readPermission(), history, settings);

  if (decision.action === 'ask' && supportedOnThisDevice()) {
    try {
      const notifications = await import('expo-notifications');
      const asked = await notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: false, allowSound: true },
      });
      await noteAsk(Date.now());
      decision = asked.granted ? { action: 'granted' } : await afterDenied(asked.canAskAgain !== false, history);
    } catch {
      decision = { action: 'skip' };
    }
  }

  if (decision.action === 'granted') await ensureChannel();
  return decision;
}

async function afterDenied(canAskAgain: boolean, history: AskHistory): Promise<PermissionDecision> {
  const next: AskHistory = { asks: history.asks + 1, lastAskedAt: Date.now() };
  return decidePermission({ granted: false, canAskAgain }, next, { ...DEFAULT_REMINDER_SETTINGS, enabled: true });
}

export async function openSystemNotificationSettings(): Promise<void> {
  if (!supportedOnThisDevice()) return;
  const Linking = await import('expo-linking');
  try {
    await Linking.openSettings();
  } catch {

  }
}

export async function syncReminders(
  upcoming: readonly UpcomingLike[],
  settings: ReminderSettings,
  now: number = Date.now(),
): Promise<{ scheduled: number; cancelled: number }> {
  if (!supportedOnThisDevice()) return { scheduled: 0, cancelled: 0 };
  const safe = normalizeSettings(settings);

  try {
    const notifications = await import('expo-notifications');

    const permission = await readPermission();
    const desired = permission.granted === true ? planReminders(dueThingsFromUpcoming(upcoming), safe, now) : [];

    const held = await notifications.getAllScheduledNotificationsAsync();
    const existing: ExistingReminder[] = held.map((request) => ({
      id: request.identifier,

      fingerprint: readFingerprint(request.content.data),
    }));

    const plan = reconcile(desired, existing);
    for (const id of plan.cancel) {
      await notifications.cancelScheduledNotificationAsync(id);
    }
    for (const reminder of plan.create) {
      await notifications.scheduleNotificationAsync({
        identifier: reminder.id,
        content: {
          title: reminder.title,
          body: reminder.body,
          data: { ...reminder.data, fingerprint: reminder.fingerprint },
          sound: 'default',
          ...(Platform.OS === 'android'
            ? { color: ANDROID_COLOR, vibrate: [0, 200, 100, 200] }
            : { interruptionLevel: 'active' as const }),
        },
        trigger: {
          type: notifications.SchedulableTriggerInputTypes.DATE,

          date: new Date(reminder.at),
          channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
        },
      });
    }

    return { scheduled: plan.create.length, cancelled: plan.cancel.length };
  } catch {
    return { scheduled: 0, cancelled: 0 };
  }
}

function readFingerprint(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const value = (data as Record<string, unknown>).fingerprint;
  return typeof value === 'string' ? value : '';
}

export async function cancelAllReminders(): Promise<void> {
  if (!supportedOnThisDevice()) return;
  try {
    const notifications = await import('expo-notifications');
    const held = await notifications.getAllScheduledNotificationsAsync();
    for (const request of held) {
      if (request.identifier.startsWith(REMINDER_ID_PREFIX)) {
        await notifications.cancelScheduledNotificationAsync(request.identifier);
      }
    }
  } catch {

  }
}

export async function installNotificationHandler(): Promise<void> {
  if (!supportedOnThisDevice()) return;
  try {
    const notifications = await import('expo-notifications');
    notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch {

  }
}

export async function takeLaunchReminder(): Promise<unknown> {
  if (!supportedOnThisDevice()) return null;
  try {
    const notifications = await import('expo-notifications');
    const response = notifications.getLastNotificationResponse();
    if (!response) return null;
    notifications.clearLastNotificationResponse();
    return response.notification.request.content.data;
  } catch {
    return null;
  }
}

export async function listenForReminderTaps(
  onTap: (data: unknown) => void,
): Promise<() => void> {
  if (!supportedOnThisDevice()) return () => {};
  try {
    const notifications = await import('expo-notifications');
    const subscription = notifications.addNotificationResponseReceivedListener((response) => {
      const identifier = response.notification.request.identifier;
      if (!identifier.startsWith(REMINDER_ID_PREFIX)) return;
      onTap(response.notification.request.content.data);
    });
    return () => subscription.remove();
  } catch {
    return () => {};
  }
}

export { reminderId };
