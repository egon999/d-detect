import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';

import { getUpcoming } from '@api/daybook';
import { useSession } from './session-provider';
import {
  cancelAllReminders,
  installNotificationHandler,
  listenForReminderTaps,
  loadReminderSettings,
  syncReminders,
  takeLaunchReminder,
} from './notifications';
import { asUpcoming, reminderHrefForData } from './reminder-plan';

export function Reminders(): null {
  const router = useRouter();
  const { status, user } = useSession();
  const signedIn = status === 'signedIn';
  const ownerId = user?.id ?? null;

  const lastOwner = useRef<string | null>(null);

  useEffect(() => {
    void installNotificationHandler();
  }, []);

  useEffect(() => {
    if (!signedIn || !ownerId) {

      if (lastOwner.current !== null) void cancelAllReminders();
      lastOwner.current = null;
      return;
    }
    lastOwner.current = ownerId;

    let cancelled = false;

    const sync = async () => {

      const settings = await loadReminderSettings();
      if (!settings.enabled) {
        if (!cancelled) await cancelAllReminders();
        return;
      }
      try {
        const upcoming = await getUpcoming();
        if (!cancelled) await syncReminders(asUpcoming(upcoming), settings);
      } catch {

      }
    };

    void sync();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void sync();
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [signedIn, ownerId]);

  const go = useCallback(
    (data: unknown) => {
      const href = reminderHrefForData(data);
      if (href) router.push(href as never);
    },
    [router],
  );

  useEffect(() => {
    if (!signedIn) return;
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    const start = async () => {
      unsubscribe = await listenForReminderTaps(go);
      if (cancelled) {
        unsubscribe();
        unsubscribe = null;
        return;
      }

      const launch = await takeLaunchReminder();
      if (launch) go(launch);
    };

    void start();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [signedIn, go]);

  return null;
}
