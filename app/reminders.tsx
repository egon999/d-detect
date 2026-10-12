import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';

import {
  Button,
  Notice,
  ScreenScroll,
  Section,
  SelectField,
  SkeletonList,
  Stack,
  Text,
  type SelectOption,
} from '@ui';

import {
  asUpcoming,
  EVENING_HOUR_OPTIONS,
  MORNING_HOUR_OPTIONS,
  hourLabel,
  reminderWords,
  type Occasion,
  type ReminderDetail,
  type ReminderSettings,
} from '../src/services/reminder-plan';
import {
  cancelAllReminders,
  ensureRemindersAllowed,
  loadReminderSettings,
  openSystemNotificationSettings,
  readPermission,
  saveReminderSettings,
  supportedOnThisDevice,
  syncReminders,
} from '../src/services/notifications';
import { getUpcoming } from '../src/api/daybook';

type Enabled = 'on' | 'off';

const DETAIL_OPTIONS: ReadonlyArray<SelectOption<ReminderDetail>> = [
  {
    value: 'discreet',
    label: 'Just that something is due',
    description: 'Nothing about what it is, or how much',
  },
  {
    value: 'titles',
    label: 'What is due',
    description: 'The name as you saved it, and the day',
  },
  {
    value: 'full',
    label: 'What is due, and the amount',
    description: 'Also the amount written on the record, when there is one',
  },
];

function previewOccasion(detail: ReminderDetail): Occasion {
  const due = new Date();
  due.setDate(due.getDate() + 1);
  due.setHours(0, 0, 0, 0);
  return {
    slot: 'evening',
    day: '',
    dayAt: Date.now(),
    items: [
      {
        kind: 'record',
        key: 'preview',
        title: 'A shop you paid',
        dueAt: due.getTime(),

        amountLabel: detail === 'full' ? '₹4,500' : null,
        recordId: 'preview',
        taskId: null,
      },
    ],
  };
}

export default function RemindersScreen() {
  const router = useRouter();
  const supported = supportedOnThisDevice();

  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [permission, setPermission] = useState<{ granted: boolean | null; canAskAgain: boolean }>({
    granted: null,
    canAskAgain: false,
  });
  const [asking, setAsking] = useState(false);

  const refresh = useCallback(async () => {
    const [stored, current] = await Promise.all([loadReminderSettings(), readPermission()]);
    setSettings(stored);
    setPermission(current);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (patch: Partial<ReminderSettings>) => {
      if (!settings) return;
      const next = { ...settings, ...patch };
      setSettings(next);
      await saveReminderSettings(next);
      if (!next.enabled) {
        await cancelAllReminders();
        return;
      }
      try {
        const upcoming = await getUpcoming();

        await syncReminders(asUpcoming(upcoming), next);
      } catch {

      }
    },
    [settings],
  );

  const preview = useMemo(() => {
    if (!settings) return null;

    return reminderWords(previewOccasion(settings.detail), settings.detail);
  }, [settings]);

  const askNow = useCallback(async () => {
    if (!settings) return;
    setAsking(true);
    const decision = await ensureRemindersAllowed(settings);
    setAsking(false);

    if (decision.action === 'open-settings') await openSystemNotificationSettings();
    await refresh();
  }, [settings, refresh]);

  if (!settings) {
    return (
      <ScreenScroll title="Reminders" back onBack={() => router.back()}>
        <SkeletonList count={3} />
      </ScreenScroll>
    );
  }

  const on = settings.enabled;
  const permissionMissing = permission.granted !== true;

  const cannotAsk = permission.granted === false && !permission.canAskAgain;

  return (
    <ScreenScroll
      title="Reminders"
      overline="Settings"
      back
      onBack={() => router.back()}
      subtitle={on ? 'A quiet nudge the day before, and again on the day.' : 'Nothing is set to arrive.'}
    >
      <Stack gap="huge">
        {!supported ? (
          <Notice
            tone="neutral"
            icon="information-outline"
            message="Reminders need the phone app. Everything else works here as usual."
          />
        ) : null}

        <Section
          title="Reminders"
          first
          hint="One reminder the evening before something is due, and one on the day itself."
        >
          <SelectField<Enabled>
            value={on ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'Send them' },
              { value: 'off', label: 'Do not send them' },
            ]}
            onChange={(next) => void update({ enabled: next === 'on' })}
          />
        </Section>

        {on && supported ? (
          <>
            {permissionMissing ? (
              <Section title="Your phone">
                <Notice
                  tone={cannotAsk ? 'warn' : 'info'}
                  icon="bell-off-outline"
                  title={
                    cannotAsk
                      ? 'Your phone is not letting this app send reminders'
                      : 'Your phone has not been asked yet'
                  }
                  message={
                    cannotAsk
                      ? 'You can turn them back on in your phone settings. Everything else here works without them.'
                      : 'Allow reminders and this app can nudge you before something is due.'
                  }
                />
                {cannotAsk ? (
                  <Button
                    label="Open phone settings"
                    variant="secondary"
                    icon="cog-outline"
                    onPress={() => void openSystemNotificationSettings()}
                    accessibilityHint="Open your phone's settings for this app"
                  />
                ) : (
                  <Button
                    label="Allow reminders"
                    variant="secondary"
                    icon="bell-outline"
                    loading={asking}
                    onPress={() => void askNow()}
                    accessibilityHint="Ask your phone to allow reminders"
                  />
                )}
              </Section>
            ) : null}

            <Section title="When" hint="These are the two times a reminder can arrive.">
              <Stack gap="huge">
                <SelectField<string>
                  label="The evening before"
                  value={String(settings.eveningHour)}
                  options={EVENING_HOUR_OPTIONS.map((hour) => ({
                    value: String(hour),
                    label: hourLabel(hour),
                  }))}
                  onChange={(next) => void update({ eveningHour: Number(next) })}
                  hint="Early enough that a shop is still open."
                />

                <SelectField<string>
                  label="On the day"
                  value={settings.morningHour === null ? 'off' : String(settings.morningHour)}
                  options={[
                    ...MORNING_HOUR_OPTIONS.map((hour) => ({
                      value: String(hour),
                      label: hourLabel(hour),
                    })),
                    { value: 'off', label: 'No second reminder' },
                  ]}
                  onChange={(next) => void update({ morningHour: next === 'off' ? null : Number(next) })}
                  hint="For anything you would rather deal with after you have woken up."
                />
              </Stack>
            </Section>

            <Section
              title="What shows on the lock screen"
              hint="A lock screen is in front of whoever is standing near you. This is what they can read."
            >
              <SelectField<ReminderDetail>
                value={settings.detail}
                options={DETAIL_OPTIONS}
                onChange={(next) => void update({ detail: next })}
              />

              {preview ? (
                <Stack gap="sm">
                  <Text variant="caption" colorToken="textTertiary">
                    That looks like this
                  </Text>
                  <Notice tone="neutral" icon="bell-outline" title={preview.title} message={preview.body} />
                </Stack>
              ) : null}
            </Section>
          </>
        ) : null}

        <Section title="Quiet hours" hint="Nothing from this app arrives at night.">
          <Text variant="bodySmall" colorToken="textSecondary">
            Reminders stay between 7am and 8pm. If a time you picked would fall outside that, the
            reminder moves earlier rather than later, so it is never waiting for you in the middle
            of the night.
          </Text>
        </Section>
      </Stack>
    </ScreenScroll>
  );
}
