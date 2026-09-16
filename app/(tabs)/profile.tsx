/**
 * Profile and settings.
 *
 * One screen, ordered by how often someone arrives wanting each thing: who you are signed in
 * as, how the app looks, what the app is allowed to do, your password, what it remembers of
 * your searches, what it is holding of yours, and how to leave.
 *
 * One more appears only when it applies: if an anonymous session on this device left cases
 * behind, they are offered for handover into the account. It sits above the preferences and
 * disappears once there is nothing there, because it is a job to finish rather than a setting.
 *
 * ## Why "Your data" earns a place
 *
 * Everywhere else in this app, deleting is a soft delete — the record is hidden and its bytes
 * stay. That is deliberate and it is right for case work, but it means the app accumulates,
 * and what it accumulates is account numbers, salary slips, a home address typed into a draft
 * letter, and the full text of every document anyone has fed it. Until this section existed
 * there was no way for a person to end that, which for a product whose entire subject is other
 * people's evidence is not a missing feature so much as a missing promise.
 *
 * It sits second-to-last for the same reason everything else sits where it does: it is the
 * thing people come here for least often, and the thing they must never hit by accident.
 *
 * ## What is deliberately not here
 *
 * The case list. An earlier version showed the five most recent cases in a panel, which is
 * the Cases tab reproduced badly — a second place to look, kept in step by hand, with no
 * filtering and no room for the status a case actually needs. A settings screen that lists
 * your data is a settings screen that has run out of things to say.
 *
 * Also absent, and staying absent: any latency or connectivity check, any panel naming the
 * storage technology, and any badge that exists to look technical. "Where your cases are
 * saved" is a fact the user needs and it is one chip of plain English in the masthead; the
 * name of the database behind it is not their problem. The storage figure above the erase
 * button is the one number on this screen, and it is there because it is the size of what is
 * about to be destroyed — not because a settings screen ought to have a statistic in it.
 *
 * ## Sections rather than cards
 *
 * `Section` gives an overline and a hint, and the controls sit directly under it separated by
 * rules. The alternative — every group in its own bordered `Surface` — was what this screen
 * was, and six stacked boxes on a phone reads as a form generator's output. A `Surface` is
 * kept for the two groups that genuinely are discrete objects: the identity card, which is a
 * *thing*, and the AI panel, which owns a credential and a network call.
 */

import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { AIKeySection } from '@features/settings/ai-key-section';
import { confirmDestructive } from '@features/settings/confirm';
import { SettingToggle } from '@features/settings/toggle';
import { useTabBarInset } from '@features/navigation/tab-bar';
import { useRepository, useSession } from '@services';
import { providerLabel } from '@services/auth/account';
import { eraseEverything, storedDataSummary, type StoredDataSummary } from '@services/erase';
import { listDeviceCases } from '@services/migration';
import { clearSearchHistory, remembersSearches, setRememberSearches } from '@services/preferences';
import {
  Button,
  Chip,
  Divider,
  formatBytes,
  Notice,
  pluralize,
  Row,
  ScreenScroll,
  SegmentedControl,
  Section,
  Stagger,
  Surface,
  Text,
  TextField,
  UserAvatar,
  useTheme,
  type IconName,
  type ThemePreference,
} from '@ui';

/**
 * The colour scheme choices.
 *
 * Icons because the three words alone are ambiguous at a glance — "System" in particular
 * means nothing until you see the phone glyph next to it. Order is Light, Dark, System
 * rather than most-used-first: the two concrete options belong together, with the deferring
 * one at the end.
 */
const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; icon: IconName }> = [
  { value: 'light', label: 'Light', icon: 'white-balance-sunny' },
  { value: 'dark', label: 'Dark', icon: 'weather-night' },
  { value: 'system', label: 'System', icon: 'cellphone-cog' },
];

/**
 * The result of looking for work left behind by an anonymous session on this device.
 *
 * Three states rather than a count, because "not looked yet" and "could not look" have to lead
 * somewhere different. A failed scan must not hide the way in: device storage is the only copy
 * of that work, and `/previous-cases` has its own empty state, so when the scan fails the entry
 * point is still offered and the destination decides whether there is anything there. Only a
 * scan that finished and found nothing removes the section — an offer to recover nothing is
 * worse than no offer.
 */
type DeviceCaseScan = 'scanning' | 'unavailable' | { count: number };

export default function ProfileScreen() {
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const router = useRouter();
  const {
    user,
    isLocal,
    signOut,
    sendPasswordReset,
    updateUserPassword,
    updateUserProfile,
    error: sessionError,
  } = useSession();
  const { repository, kind, ready } = useRepository();

  const [name, setName] = useState(user?.displayName ?? '');
  const [editingName, setEditingName] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  /** The action in flight, by name, so each button knows whether the spinner is its own. */
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the session-level error has been dismissed by the user.
   *
   * `sessionError` lives in the session provider and cannot be cleared from here, so this
   * local flag hides it without touching the source. It resets whenever `sessionError` changes
   * to a new value — a fresh error from a later operation should be shown again.
   */
  const [sessionErrorDismissed, setSessionErrorDismissed] = useState(false);
  const prevSessionErrorRef = React.useRef(sessionError);
  if (prevSessionErrorRef.current !== sessionError) {
    prevSessionErrorRef.current = sessionError;
    if (sessionError) setSessionErrorDismissed(false);
  }
  /**
   * Whether recent searches are kept, and whether that is what storage actually said.
   *
   * `remember` is `null` only until the first read resolves. It must never stay there: it is
   * what disables the switch, so a `null` that survives a failed read is a control the user
   * cannot touch for the rest of the session.
   *
   * The fallback on failure is `false` — the setting that stores less. It is a guess either
   * way, and the two guesses are not equally bad: guessing "on" invites a tap that reads as
   * *turning history off* and in fact writes the very preference the user is trying to avoid
   * needing. Guessing "off" costs at most one redundant "yes, keep them". Nothing is written
   * here, so the stored preference is untouched until the user actually chooses; the search
   * screens keep reading storage directly and are unaffected by what this switch shows.
   *
   * `rememberUnread` records that the displayed value is that guess rather than the stored
   * one, because a switch showing a position nobody chose has to say so.
   */
  const [remember, setRemember] = useState<boolean | null>(null);
  const [rememberUnread, setRememberUnread] = useState(false);
  /** Bumped by the retry, to re-run the read below. */
  const [rememberAttempt, setRememberAttempt] = useState(0);
  const [deviceCases, setDeviceCases] = useState<DeviceCaseScan>('scanning');
  /**
   * How much there is to lose, or null until it has been measured.
   *
   * Only used to write the sentence above the erase button and the one inside its
   * confirmation. It is never a gate: the button works whether or not this ever resolves,
   * because a user who cannot be told the size still has the right to press it.
   */
  const [stored, setStored] = useState<StoredDataSummary | null>(null);

  const passwordAccount = user?.providerIds?.includes('password') ?? false;

  useEffect(() => {
    setName(user?.displayName ?? '');
  }, [user?.displayName]);

  useEffect(() => {
    let cancelled = false;
    setRemember(null);
    setRememberUnread(false);
    if (user) {
      void remembersSearches(user.id)
        .then((enabled) => {
          if (!cancelled) setRemember(enabled);
        })
        .catch(() => {
          // Not routed to the shared error Notice at the top: that one is for an action the
          // user just took, and this fires on arrival. The explanation belongs beside the
          // control it is about, where it can be acted on.
          if (cancelled) return;
          setRemember(false);
          setRememberUnread(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [user?.id, rememberAttempt]);

  /**
   * Looks for cases an anonymous session left in device storage.
   *
   * Only for a real account. `listDeviceCases` is given the signed-in uid and excludes it, so a
   * device account asking this question would be asking whether its own cases need moving into
   * itself. It reads AsyncStorage keys rather than the network, so it is cheap enough to run on
   * every visit instead of being cached and going stale after a handover.
   */
  useEffect(() => {
    if (isLocal || !user?.id) {
      setDeviceCases({ count: 0 });
      return;
    }
    let cancelled = false;
    setDeviceCases('scanning');
    void listDeviceCases(user.id)
      .then((found) => {
        if (!cancelled) setDeviceCases({ count: found.length });
      })
      .catch(() => {
        if (!cancelled) setDeviceCases('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, isLocal]);

  /**
   * Measures what an erase would take.
   *
   * Runs on arrival rather than on the press, so the confirmation can open with the figures
   * already in it. A dialog that appears and then rewrites its own sentence a moment later is
   * a dialog people stop reading, and this is the one in the app that most needs reading.
   *
   * `storedDataSummary` absorbs its own failures and answers zero, so there is no error path
   * here — an unmeasurable store is shown as a section with no sentence above the button,
   * which is accurate: we do not know, so we do not say.
   */
  useEffect(() => {
    if (!user?.id || !ready) return;
    let cancelled = false;
    void storedDataSummary(repository, user.id).then((summary) => {
      if (!cancelled) setStored(summary);
    });
    return () => {
      cancelled = true;
    };
  }, [repository, user?.id, ready]);

  /**
   * Runs one account action at a time.
   *
   * Serialised on purpose: these all mutate the same Firebase user, and two in flight means a
   * reauthentication racing a profile write. `busy` is the action's name rather than a boolean
   * so a single spinner appears on the button that was pressed.
   */
  const perform = useCallback(
    async (action: string, work: () => Promise<void>, success?: string) => {
      if (busy) return;
      setBusy(action);
      setError(null);
      setNotice(null);
      try {
        await work();
        if (success) setNotice(success);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That change could not be saved. Try again.');
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const leave = useCallback(() => {
    confirmDestructive({
      title: 'Sign out?',
      message: 'Your cases stay where they are saved. You can sign back in at any time.',
      confirmLabel: 'Sign out',
      onConfirm: () => {
        void perform('signout', async () => {
          await signOut();
          router.replace('/sign-in');
        });
      },
    });
  }, [perform, signOut, router]);

  /**
   * The one irreversible action in the app.
   *
   * Two things make the copy here different from every other confirmation. It names the real
   * figures rather than saying "all your data", because a user deciding whether to press this
   * is deciding about *their* three cases and *their* 120 MB, not about an abstraction. And it
   * says where the copies are: on a device account this phone holds the only one and nothing
   * can bring it back, while on a real account the sign-in survives and would open an empty
   * app — two different situations that the same sentence would misdescribe one of.
   *
   * It signs out afterwards in both cases. A device account has no choice, since its identity
   * goes with the rest; a real account could stay, but staying would leave someone looking at
   * an app that has just been emptied under them, wondering whether it worked.
   */
  const eraseAll = useCallback(() => {
    if (!user) return;

    const scale =
      stored === null
        ? 'Every case, every file you added, your draft details and any AI key'
        : isLocal
          ? `${pluralize(stored.cases, 'case')}, ${formatBytes(stored.bytes)} of files, your draft details and any AI key`
          : `${pluralize(stored.cases, 'case')}, ${formatBytes(stored.bytes)} of files on this phone, your draft details and any AI key`;

    confirmDestructive({
      title: 'Delete everything?',
      message: isLocal
        ? `${scale} — gone for good. This phone holds the only copy, so there is nothing to restore from. You will be signed out; your theme setting stays.`
        : `${scale} — gone for good, from your account as well as this phone. Your sign-in still works: signing in again gives you an empty app.`,
      confirmLabel: 'Delete everything',
      onConfirm: () => {
        void perform('erase', async () => {
          await eraseEverything(repository, user.id);
          await signOut();
          router.replace('/sign-in');
        });
      },
    });
  }, [user, stored, isLocal, repository, perform, signOut, router]);

  const resetPasswordFields = () => {    setCurrentPassword('');
    setNewPassword('');
    setConfirmation('');
  };

  const storageLabel = !ready
    ? 'Connecting'
    : kind !== 'local'
      ? 'Saved to your account'
      : 'Saved on this device';

  /**
   * The label for the handover entry point, or null when the section should not exist.
   *
   * The count is in the label rather than in a badge beside it, because it is the reason to
   * press: "Review 2 cases" is a sentence, and "Review" with a 2 next to it is a puzzle.
   */
  const handoverLabel =
    deviceCases === 'scanning'
      ? null
      : deviceCases === 'unavailable'
        ? 'Look for cases saved on this device'
        : deviceCases.count === 0
          ? null
          : `Review ${deviceCases.count} ${deviceCases.count === 1 ? 'case' : 'cases'}`;

  /**
   * What is stored, in one sentence, as the hint for the data section.
   *
   * Written as prose rather than shown as figures with labels. "3 cases and 41.2 MB of files
   * are saved on this phone" is something a person reads once and understands; the same two
   * numbers in a pair of stat tiles is a dashboard, and a dashboard is what a settings screen
   * puts there when it has nothing to say.
   */
  const storedSentence =
    stored === null
      ? isLocal
        ? 'Everything this app has saved on this phone.'
        : 'Everything this app has saved for your account.'
      : stored.cases === 0 && stored.bytes === 0
        ? 'Nothing is saved yet.'
        : isLocal
          ? `${pluralize(stored.cases, 'case')} and ${formatBytes(stored.bytes)} of files are saved on this phone.`
          : `${pluralize(stored.cases, 'case')} in your account, and ${formatBytes(stored.bytes)} of files on this phone.`;

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScreenScroll
        overline="Settings"
        title="Your account"
        subtitle={isLocal ? 'This device' : user?.email}
        meta={<Chip label={storageLabel} tone="neutral" dot />}
        // The tab bar floats over the scroll view, and `contentStyle` replaces the
        // container's own bottom padding rather than adding to it. `useTabBarInset` is the
        // whole occluded height — float, box and the compose disc's overhang — plus its own
        // breathing room, so nothing is added on top of it. The old sum was short by about
        // 14pt and left the last button partly under the bar.
        contentStyle={{
          paddingBottom: tabBarInset,
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: theme.layout.maxContentWidth,
            alignSelf: 'center',
          }}
        >
          {/* Keys are explicit: `Stagger` reads its children positionally, so a conditional
              child appearing later would otherwise shift every sibling's identity and replay
              the entrance animation partway down the screen. */}
          <Stagger>
            <View key="messages" style={{ gap: theme.spacing.md }}>
              {error || (sessionError && !sessionErrorDismissed) ? (
                <Notice
                  tone="danger"
                  title="That did not go through"
                  message={error ?? sessionError?.message ?? ''}
                  onDismiss={() => {
                    setError(null);
                    setSessionErrorDismissed(true);
                  }}
                />
              ) : null}
              {notice ? (
                <Notice tone="ok" title="Saved" message={notice} onDismiss={() => setNotice(null)} />
              ) : null}
            </View>

            <Surface key="identity" padding="lg" radius="lg" style={{ gap: theme.spacing.lg }}>
              <Row align="center" gap="lg">
                <UserAvatar
                  photoURL={user?.photoURL ?? null}
                  displayName={user?.displayName ?? null}
                  size={56}
                />
                <View style={styles.fill}>
                  <Text variant="heading" numberOfLines={2}>
                    {user?.displayName || 'Unnamed account'}
                  </Text>
                  <Text variant="bodySmall" colorToken="textSecondary" selectable numberOfLines={2}>
                    {isLocal ? 'A device account, with no email address' : user?.email}
                  </Text>
                  {user?.createdAt ? (
                    <Text variant="caption" colorToken="textTertiary">
                      Since{' '}
                      {new Date(user.createdAt).toLocaleDateString(undefined, {
                        month: 'long',
                        year: 'numeric',
                      })}
                    </Text>
                  ) : null}
                </View>
              </Row>

              {editingName ? (
                <>
                  <TextField
                    label="Display name"
                    value={name}
                    onChangeText={setName}
                    maxLength={120}
                    autoComplete="name"
                    editable={!busy}
                    hint="Shown on this account only. It is not attached to any case record."
                  />
                  <Row gap="sm" wrap>
                    <Button
                      label="Save name"
                      loading={busy === 'name'}
                      disabled={Boolean(busy) || !name.trim()}
                      onPress={() =>
                        void perform(
                          'name',
                          async () => {
                            await updateUserProfile(name);
                            setEditingName(false);
                          },
                          'Your display name has been updated.',
                        )
                      }
                    />
                    <Button
                      label="Cancel"
                      variant="ghost"
                      disabled={Boolean(busy)}
                      onPress={() => {
                        setEditingName(false);
                        setName(user?.displayName ?? '');
                      }}
                    />
                  </Row>
                </>
              ) : (
                <Button
                  label="Edit name"
                  icon="pencil-outline"
                  variant="secondary"
                  onPress={() => setEditingName(true)}
                />
              )}
            </Surface>

            {/* Above the preferences, because this is a task and those are settings — and it
                only exists while there is something to do, so it costs nothing when there is
                not. `Stagger` drops nulls, and every sibling carries its own key, so appearing
                here after the scan finishes does not replay the entrances below it. */}
            {handoverLabel ? (
              <Section
                key="handover"
                title="Cases saved on this device"
                hint="Cases you started before signing in are still held on this device only. Moving one into your account keeps it when you sign in somewhere else; the original files come with it."
              >
                <Button
                  label={handoverLabel}
                  icon="folder-move-outline"
                  variant="secondary"
                  onPress={() => router.push('/previous-cases')}
                />
              </Section>
            ) : null}

            <Section
              key="appearance"
              title="Appearance"
              hint="Kept on this device and applied the next time you open the app."
            >
              {/*
                `setPreference` writes through to storage as well as to the theme — the
                provider is handed the persisting setter in `app/_layout.tsx`, so there is
                nothing to save here and nothing that can fall out of step with what is on
                screen.
              */}
              <SegmentedControl
                value={theme.preference}
                onChange={theme.setPreference}
                options={THEME_OPTIONS}
              />
            </Section>

            <Section
              key="ai"
              title="What the app may do"
              hint="AI is optional here, and off until you turn it on."
            >
              <AIKeySection />
            </Section>

            <Section key="security" title="Sign-in and security">
              {isLocal ? (
                <Text variant="bodySmall" colorToken="textSecondary">
                  This device account has no password and no connected provider. Anyone who can unlock
                  this device can open its cases. Signing in with an email account instead gives you a
                  password and a separate workspace.
                </Text>
              ) : (
                <View style={{ gap: theme.spacing.lg }}>
                  <View style={{ gap: theme.spacing.sm }}>
                    <Text variant="label">How you sign in</Text>
                    {user?.providerIds?.length ? (
                      <Row gap="sm" wrap>
                        {user.providerIds.map((provider) => (
                          <Chip key={provider} label={providerLabel(provider)} tone="neutral" />
                        ))}
                      </Row>
                    ) : (
                      <Text variant="bodySmall" colorToken="textSecondary">
                        Your sign-in methods could not be read. Sign in again to refresh them.
                      </Text>
                    )}
                  </View>

                  <Divider />

                  {passwordAccount ? (
                    <View style={{ gap: theme.spacing.md }}>
                      {changingPassword ? (
                        <>
                          <TextField
                            label="Current password"
                            value={currentPassword}
                            onChangeText={setCurrentPassword}
                            secureTextEntry
                            autoComplete="current-password"
                            editable={!busy}
                            hint="Asked for because changing a password re-confirms who you are."
                          />
                          <TextField
                            label="New password"
                            value={newPassword}
                            onChangeText={setNewPassword}
                            secureTextEntry
                            autoComplete="new-password"
                            editable={!busy}
                            hint="At least six characters."
                          />
                          <TextField
                            label="New password again"
                            value={confirmation}
                            onChangeText={setConfirmation}
                            secureTextEntry
                            autoComplete="new-password"
                            editable={!busy}
                            {...(confirmation.length > 0 && confirmation !== newPassword
                              ? { error: 'These two do not match yet.' }
                              : {})}
                          />
                          <Row gap="sm" wrap>
                            <Button
                              label="Change password"
                              loading={busy === 'password'}
                              disabled={
                                Boolean(busy) ||
                                !currentPassword ||
                                newPassword.length < 6 ||
                                newPassword !== confirmation
                              }
                              onPress={() =>
                                void perform(
                                  'password',
                                  async () => {
                                    // Two arguments: the session provider reauthenticates with
                                    // the current password before it sets the new one, because
                                    // Firebase rejects a password change on a stale sign-in.
                                    await updateUserPassword(newPassword, currentPassword);
                                    setChangingPassword(false);
                                    resetPasswordFields();
                                  },
                                  'Your password has been changed.',
                                )
                              }
                            />
                            <Button
                              label="Cancel"
                              variant="ghost"
                              disabled={Boolean(busy)}
                              onPress={() => {
                                setChangingPassword(false);
                                resetPasswordFields();
                              }}
                            />
                          </Row>
                        </>
                      ) : (
                        <Row gap="sm" wrap>
                          <Button
                            label="Change password"
                            variant="secondary"
                            icon="lock-outline"
                            disabled={Boolean(busy)}
                            onPress={() => {
                              setChangingPassword(true);
                              resetPasswordFields();
                            }}
                          />
                          <Button
                            label="Email me a reset link"
                            variant="ghost"
                            loading={busy === 'reset'}
                            disabled={Boolean(busy)}
                            onPress={() =>
                              void perform(
                                'reset',
                                () => sendPasswordReset(user?.email),
                                'A reset link is on its way. Check your inbox.',
                              )
                            }
                          />
                        </Row>
                      )}
                    </View>
                  ) : (
                    <View style={{ gap: theme.spacing.md }}>
                      <Text variant="bodySmall" colorToken="textSecondary">
                        Your password belongs to the provider you sign in with, so it is changed there
                        rather than here.
                      </Text>
                      {user?.providerIds?.includes('google.com') ? (
                        <Button
                          label="Open Google account security"
                          icon="open-in-new"
                          variant="secondary"
                          disabled={Boolean(busy)}
                          onPress={() =>
                            void perform('provider', async () => {
                              // `openURL` rejects when no browser handles the link, so this has
                              // to be awaited inside `perform` to surface as a message rather
                              // than an unhandled rejection.
                              await Linking.openURL('https://myaccount.google.com/security');
                            })
                          }
                        />
                      ) : null}
                    </View>
                  )}
                </View>
              )}
            </Section>

            <Section
              key="privacy"
              title="Searches"
              hint="Recent searches never leave this device and are never attached to a case."
            >
              {rememberUnread ? (
                <Notice
                  tone="warn"
                  title="This setting could not be read"
                  message="The switch below has been left off, which is the safer of the two guesses — it is not necessarily the choice you made before. Setting it now fixes it either way."
                  style={{ marginBottom: theme.spacing.md }}
                />
              ) : null}
              <SettingToggle
                label="Remember recent searches"
                hint="For this account on this device. Turning it off also clears what is saved."
                value={remember ?? false}
                disabled={!user || remember === null || Boolean(busy)}
                onValueChange={(enabled) => {
                  if (!user) return;
                  void perform('privacy', async () => {
                    await setRememberSearches(user.id, enabled);
                    setRemember(enabled);
                    // A successful write settles the question: what is on screen is now what
                    // is stored, whatever the read at mount did or did not manage to say.
                    setRememberUnread(false);
                  });
                }}
              />
              {rememberUnread ? (
                <Button
                  label="Check this setting again"
                  variant="ghost"
                  icon="refresh"
                  disabled={Boolean(busy)}
                  onPress={() => setRememberAttempt((attempt) => attempt + 1)}
                />
              ) : null}
              <Divider spacing="md" />
              <Button
                label="Clear saved searches"
                variant="secondary"
                icon="broom"
                loading={busy === 'history'}
                disabled={!user || Boolean(busy)}
                onPress={() =>
                  user &&
                  void perform(
                    'history',
                    () => clearSearchHistory(user.id),
                    'Saved searches for this account have been cleared.',
                  )
                }
              />
            </Section>

            <Section key="data" title="Your data" hint={storedSentence}>
              <Button
                label="Delete everything"
                variant="danger"
                icon="trash-can-outline"
                loading={busy === 'erase'}
                disabled={!user || Boolean(busy)}
                onPress={eraseAll}
              />
            </Section>

            <Section key="exit" title="This app">
              <View style={{ gap: theme.spacing.md }}>
                <Button
                  label="What this app does, and does not do"
                  icon="information-outline"
                  variant="secondary"
                  onPress={() => router.push('/about')}
                />
                <Button
                  label="Sign out"
                  icon="logout-variant"
                  variant="ghost"
                  loading={busy === 'signout'}
                  disabled={Boolean(busy)}
                  onPress={leave}
                />
              </View>
            </Section>
          </Stagger>
        </View>
      </ScreenScroll>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
