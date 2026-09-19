/**
 * Cases saved on this device.
 *
 * ## What this screen is for
 *
 * The app works before anyone signs in — that is a deliberate property, not a fallback. Case
 * data created then is written to device storage under a device-generated owner id, and the
 * moment a user signs in the app starts reading their account instead. Their earlier work is
 * still on the phone but no longer anywhere they can see it.
 *
 * This screen is where they get it back. It lists what is in device storage, shows exactly
 * what a move would carry across, and moves one case at a time into the signed-in account.
 *
 * ## Why the move is two steps and not one
 *
 * Reviewing before writing is not ceremony here. A user with several anonymous cases needs to
 * see which one this is, and the counts under the review panel are the plan's own numbers —
 * so what the screen promises and what the commit does cannot drift apart.
 *
 * Removing the device copy is a third, separate action, taken only after the account copy is
 * confirmed on screen. Folding it into the move would mean one tap that both writes and
 * deletes, and a failure anywhere in between would be indistinguishable from data loss.
 */

import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import type { Workspace } from '@domain/models';
import { useRepository, useSession } from '@services';
import {
  handOverDeviceCase,
  listDeviceCases,
  loadDeviceCase,
  previewHandover,
  type DeviceCase,
  type HandoverOutcome,
} from '@services/migration';
import { useCaseList } from '@services/use-case-store';
import {
  Button,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  LAYOUT,
  Notice,
  Pressable,
  Row,
  ScreenScroll,
  SkeletonList,
  Stack,
  Stagger,
  Surface,
  Text,
  errorDetail,
  formatRelativeTime,
  readableError,
  useTheme,
} from '@ui';

export default function DeviceCasesScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { user, isLocal } = useSession();
  const { repository } = useRepository();
  const accountId = isLocal ? null : (user?.id ?? null);
  const current = useCaseList(accountId);

  const [devices, setDevices] = useState<DeviceCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * The clock reading the list was taken at.
   *
   * `formatRelativeTime` takes `now` explicitly rather than calling `Date.now()` itself, which
   * is what makes it testable. Reading the clock once per load — instead of once per row —
   * keeps every "3 days ago" on screen measured from the same instant, and keeps the render
   * pure so a re-render cannot silently shift the labels.
   */
  const [listedAt, setListedAt] = useState(() => Date.now());

  const [selected, setSelected] = useState<{ entry: DeviceCase; workspace: Workspace } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  /**
   * The last action that failed, and what to call it.
   *
   * A title is stored with the message because the one this screen used — "This needs your
   * attention" — named nothing: reading a device copy, moving a case and deleting a device
   * copy all failed under it, and the message underneath was the raw exception. The detail
   * is kept apart from the sentence so the provider's own text stays reachable without
   * being the explanation.
   */
  const [actionFailure, setActionFailure] = useState<{
    title: string;
    message: string;
    detail: string | null;
  } | null>(null);

  const [moving, setMoving] = useState(false);
  const [outcome, setOutcome] = useState<HandoverOutcome | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [openSource, setOpenSource] = useState<string | null>(null);

  // Two independent generation counters: a slow case read must not deliver into a screen
  // that has since selected a different case, and neither must land after a blur.
  const listRun = useRef(0);
  const readRun = useRef(0);

  const inAccount = useMemo(
    () => new Set(current.cases.map((item) => item.id)),
    [current.cases],
  );

  const load = useCallback(async () => {
    const run = ++listRun.current;
    setLoading(true);
    setError(null);
    setDevices([]);
    if (!accountId) {
      setLoading(false);
      return;
    }
    try {
      const found = await listDeviceCases(accountId);
      if (run === listRun.current) {
        setDevices(found);
        setListedAt(Date.now());
      }
    } catch (caught) {
      if (run === listRun.current) {
        setError(errorDetail(caught) ?? 'Device storage could not be read.');
      }
    } finally {
      if (run === listRun.current) setLoading(false);
    }
  }, [accountId]);

  useFocusEffect(
    useCallback(() => {
      setSelected(null);
      setSelectedId(null);
      setOutcome(null);
      setCleared(false);
      void load();
      return () => {
        listRun.current++;
        readRun.current++;
      };
    }, [load]),
  );

  const inspect = async (entry: DeviceCase) => {
    if (moving) return;
    const run = ++readRun.current;
    setSelectedId(entry.record.id);
    setSelected(null);
    setActionFailure(null);
    setOutcome(null);
    setCleared(false);
    setOpenSource(null);
    setReading(true);
    try {
      const workspace = await loadDeviceCase(entry.deviceOwnerId, entry.record.id);
      if (run === readRun.current) setSelected({ entry, workspace });
    } catch (caught) {
      if (run === readRun.current) {
        setActionFailure({
          title: 'This case could not be read',
          message: readableError(
            caught,
            'The copy saved on this device could not be opened. Nothing has been changed.',
          ),
          detail: errorDetail(caught) ?? null,
        });
      }
    } finally {
      if (run === readRun.current) setReading(false);
    }
  };

  /**
   * The plan, computed for display only.
   *
   * Deliberately the same function the move calls, so the counts shown are the counts
   * committed. It can throw — an oversized case is refused by the planner — and that
   * refusal is worth showing, because the case is still readable here even when it cannot
   * be moved in one step.
   */
  const plan = useMemo(() => {
    if (!selected || !accountId) return null;
    try {
      return {
        value: previewHandover({
          toOwnerId: accountId,
          deviceOwnerId: selected.entry.deviceOwnerId,
          caseId: selected.entry.record.id,
          workspace: selected.workspace,
        }),
        error: null as string | null,
      };
    } catch (caught) {
      return {
        value: null,
        error: readableError(caught, 'This case cannot be moved as it stands.'),
      };
    }
  }, [selected, accountId]);

  const move = async () => {
    if (!selected || !accountId || !plan?.value || moving) return;
    setMoving(true);
    setActionFailure(null);
    try {
      const result = await handOverDeviceCase({
        repository,
        toOwnerId: accountId,
        deviceOwnerId: selected.entry.deviceOwnerId,
        caseId: selected.entry.record.id,
        workspace: selected.workspace,
      });
      setOutcome(result);
      current.reload();
    } catch (caught) {
      setActionFailure({
        title: 'The case was not moved',
        message: readableError(
          caught,
          'The case could not be moved. Nothing was written to your account, and it is still on this device.',
        ),
        detail: errorDetail(caught) ?? null,
      });
    } finally {
      setMoving(false);
    }
  };

  const clearDeviceCopy = async () => {
    if (!selected || !outcome || clearing) return;
    setClearing(true);
    setActionFailure(null);
    try {
      // Imported here rather than at module load: this is the one destructive action on the
      // screen, and keeping it next to its use makes that obvious when reading the file.
      //
      // Scoped to the case id, not just the owner id. This called `clearDeviceCases`, which
      // deletes the whole device owner prefix — every anonymous case on the phone, including
      // ones never moved and held nowhere else — from a button that names one case.
      const { clearDeviceCase } = await import('@services/migration');
      await clearDeviceCase(selected.entry.deviceOwnerId, selected.entry.record.id);
      setCleared(true);
      void load();
    } catch (caught) {
      setActionFailure({
        title: 'The device copy was not removed',
        message: readableError(
          caught,
          'The copy of this case on this device could not be removed. It is still here, and the copy in your account is untouched.',
        ),
        detail: errorDetail(caught) ?? null,
      });
    } finally {
      setClearing(false);
    }
  };

  const record = selected?.workspace.cases.find((item) => item.id === selectedId);
  const sources = selected?.workspace.evidence.filter((item) => !item.deletedAt) ?? [];
  const claims = selected?.workspace.claims.filter((item) => !item.deletedAt) ?? [];

  return (
    <ScreenScroll
      title="Cases on this device"
      overline="Recover work"
      back
      subtitle="Work saved before you signed in stays on the device. Move it into your account here."
      onRefresh={() => void load()}
      refreshing={loading}
    >
      <Stack gap="lg" style={styles.column}>
        {!accountId ? (
          <EmptyState
            icon="account-outline"
            title="Sign in to move a case"
            message="A case can only be moved into an account, so this needs you signed in first. Your work on this device stays where it is either way."
            action={{ label: 'Sign in', icon: 'login', onPress: () => router.push('/sign-in') }}
          />
        ) : loading ? (
          <SkeletonList count={3} />
        ) : error ? (
          <ErrorState
            title="Device storage could not be read"
            message="Nothing has been changed. Your cases are still where they were saved."
            detail={error}
            onRetry={() => void load()}
          />
        ) : !devices.length ? (
          <EmptyState
            icon="cellphone-check"
            title="Nothing left on this device"
            message="Every case saved on this device is already in your account."
          />
        ) : (
          <Stack gap="sm">
            <Text variant="subheading">
              {devices.length} {devices.length === 1 ? 'case' : 'cases'} found
            </Text>
            <Stagger gap="xs">
              {devices.map((entry) => {
                const already = inAccount.has(entry.record.id);
                return (
                  <Pressable
                    key={`${entry.deviceOwnerId}:${entry.record.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Review ${entry.record.title}`}
                    accessibilityState={{ selected: selectedId === entry.record.id }}
                    disabled={moving}
                    onPress={() => void inspect(entry)}
                  >
                    <Surface
                      padding="md"
                      radius="md"
                      variant={selectedId === entry.record.id ? 'raised' : 'surface'}
                    >
                      <Stack gap="xs">
                        <Text variant="subheading" numberOfLines={2}>
                          {entry.record.title}
                        </Text>
                        <Row gap="xs" wrap>
                          <Chip
                            label={already ? 'Already in your account' : 'On this device only'}
                            tone={already ? 'ok' : 'warn'}
                            size="sm"
                            dot
                          />
                          <Text variant="caption" colorToken="textSecondary">
                            Last worked on {formatRelativeTime(entry.record.updatedAt, listedAt)}
                          </Text>
                        </Row>
                      </Stack>
                    </Surface>
                  </Pressable>
                );
              })}
            </Stagger>
          </Stack>
        )}

        {reading && <SkeletonList count={2} />}
        {actionFailure && (
          <Notice
            tone="danger"
            title={actionFailure.title}
            message={actionFailure.message}
            detail={actionFailure.detail}
            onDismiss={() => setActionFailure(null)}
          />
        )}

        {record && selected && (
          <Surface glass glassVariant="hero" padding="lg" radius="lg">
            <Stack gap="md">
              <Text variant="title">{record.title}</Text>
              {!!record.description && (
                <Text colorToken="textSecondary" selectable>
                  {record.description}
                </Text>
              )}

              {plan?.value && (
                <Row gap="xs" wrap>
                  <Chip label={`${plan.value.claimCount} claims`} size="sm" />
                  <Chip label={`${plan.value.eventCount} events`} size="sm" />
                  <Chip label={`${plan.value.evidenceCount} documents`} size="sm" />
                  <Chip
                    label={`${plan.value.fileMoves.length} original files`}
                    tone={plan.value.fileMoves.length ? 'ok' : 'neutral'}
                    size="sm"
                  />
                </Row>
              )}

              <Divider spacing="xs" />

              <Text variant="subheading">Claims</Text>
              {!claims.length ? (
                <Text colorToken="textSecondary">No claims were recorded in this case.</Text>
              ) : (
                claims.map((item) => (
                  <Text key={item.id} selectable>
                    {item.statement}
                  </Text>
                ))
              )}

              <Text variant="subheading">Evidence</Text>
              {!sources.length ? (
                <Text colorToken="textSecondary">No documents were added to this case.</Text>
              ) : (
                sources.map((item) => (
                  <Stack key={item.id} gap="xs">
                    <Text variant="subheading">{item.title}</Text>
                    {item.fileName && (
                      <Text variant="caption" colorToken="textSecondary">
                        {item.fileName}
                      </Text>
                    )}
                    <Button
                      label={openSource === item.id ? 'Hide extracted text' : 'Show extracted text'}
                      variant="ghost"
                      onPress={() => setOpenSource(openSource === item.id ? null : item.id)}
                    />
                    {openSource === item.id && (
                      <Text selectable colorToken="textSecondary">
                        {[item.note, item.extraction?.sourceText].filter(Boolean).join('\n\n') ||
                          'No text was read from this document.'}
                      </Text>
                    )}
                  </Stack>
                ))
              )}

              <Divider spacing="xs" />

              {plan?.error && (
                <Notice tone="warn" title="This case cannot be moved yet" message={plan.error} />
              )}

              {outcome ? (
                <Stack gap="md">
                  <Notice tone="ok" title="Moved into your account" message={handoverSummary(outcome)} />
                  <Button
                    label="Open the case"
                    onPress={() =>
                      router.push({
                        pathname: '/case/[caseId]',
                        params: { caseId: outcome.caseId },
                      })
                    }
                  />
                  {cleared ? (
                    <Notice
                      tone="info"
                      title="Device copy removed"
                      message="Device storage no longer has this case. The record is in your account, and its original files are still on this phone, where this app keeps them."
                    />
                  ) : (
                    <Stack gap="xs">
                      <Text variant="caption" colorToken="textSecondary">
                        A copy of this case is still in device storage, taking up space. Removing
                        it takes this case and nothing else, cannot be undone, and leaves the
                        original files on this phone.
                      </Text>
                      <Button
                        label="Remove the device copy of this case"
                        variant="secondary"
                        loading={clearing}
                        disabled={clearing}
                        onPress={() => void clearDeviceCopy()}
                      />
                    </Stack>
                  )}
                </Stack>
              ) : (
                <Stack gap="sm">
                  <Notice
                    tone="info"
                    title="What moving does"
                    message="Claims, events, documents, findings and the history move across as they are. Nothing is re-analysed and nothing is discarded. The original files stay on this phone — this app keeps originals on the device — and are refiled under your account so the case can still open them. The copy in device storage is left alone until you remove it."
                  />
                  {inAccount.has(record.id) && (
                    <Notice
                      tone="warn"
                      title="Your account already has this case"
                      message="Moving will overwrite it with the version stored on this device."
                    />
                  )}
                  {current.error && (
                    <Text tone="danger">
                      Your account could not be checked. Reconnect before moving anything.
                    </Text>
                  )}
                  <Button
                    label="Move into my account"
                    icon="cloud-upload-outline"
                    loading={moving}
                    disabled={moving || !plan?.value || current.loading || Boolean(current.error)}
                    onPress={() => void move()}
                  />
                </Stack>
              )}
            </Stack>
          </Surface>
        )}

        {/* Nothing selected, but something is available: say what to do rather than
            leaving the lower half of the screen empty. */}
        {!record && !reading && devices.length > 0 && (
          <Text variant="caption" colorToken="textSecondary" style={{ paddingTop: theme.spacing.xs }}>
            Pick a case to see what moving it would carry across.
          </Text>
        )}
      </Stack>
    </ScreenScroll>
  );
}

/**
 * What a finished handover actually did, in the two halves that did different things.
 *
 * The record crossed into the account. The original bytes did not, and there is nowhere for
 * them to go: this build has no remote file store — `src/services/storage/evidence-storage.ts`
 * sets out why, the Firebase project being on Spark where Storage is unavailable — so
 * `moveEvidenceFile` moves each original from the device owner's folder to the account's,
 * both of them inside this phone's own private app directory.
 *
 * This said the files "are now in your account", which is the one sentence here a user could
 * act on to their cost: it is the reassurance someone reads before wiping the handset. Said as
 * a function rather than inline because the true version has to state where the originals are
 * in the same breath as the count, and there are four combinations of moved and missing.
 */
function handoverSummary(outcome: HandoverOutcome): string {
  const originals = (count: number) => `${count} original ${count === 1 ? 'file' : 'files'}`;
  const parts = ['The case record is in your account.'];

  if (outcome.filesMoved) {
    parts.push(
      `Its ${originals(outcome.filesMoved)} stay on this phone, where this app keeps originals — ` +
        'they did not go to your account with the record.',
    );
  }
  // Unchanged wording: a missing original is the one thing on this screen the user has to do
  // something about, and it reads the same whether or not anything else came across.
  if (outcome.filesMissing) {
    parts.push(`${outcome.filesMissing} could not be found on this device and need adding again.`);
  }

  return parts.join(' ');
}

const styles = StyleSheet.create({
  // The app's reading measure, not the 820 this screen had picked for itself.
  column: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
});
