import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AttentionItem, AttentionKind } from '@domain/analysis/attention';
import { caseWorklist } from '@domain/analysis/worklist';
import type { Workspace } from '@domain/models';
import { caseActivity, type CaseActivity } from '@features/cases/activity';
import { useRepository, useSession } from '@services';
import { mapWithConcurrency } from '@services/search-index';
import {
  Button,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  Icon,
  IconTile,
  Pressable,
  Row,
  ScreenList,
  SEVERITY_TONE,
  SkeletonList,
  Surface,
  Text,
  formatTimestamp,
  useTheme,
  type IconName,
} from '@ui';

/** How many entries are mounted at once, and how many more arrive per tap. */
const PAGE_SIZE = 40;

/** Per-case reads run in parallel, bounded so a large workspace does not saturate the device. */
const READ_CONCURRENCY = 4;

/**
 * How many outstanding items are shown before the list is collapsed behind a count.
 *
 * Small on purpose. The block sits above the activity log, and a worklist that pushes the
 * rest of the screen off the bottom stops being a summary. Five is about what reads as a
 * list rather than as a wall.
 */
const WORKLIST_PREVIEW = 5;

/**
 * Which glyph leads an outstanding row.
 *
 * Keyed on `kind` — what sort of record is unresolved — because that is what a reader is
 * scanning for, with the tone beside it carrying the urgency. `Record` rather than a
 * function with a default, so a new `AttentionKind` is a type error here instead of
 * silently rendering as a folder.
 */
const WORK_ICON: Record<AttentionKind, IconName> = {
  finding: 'alert-circle-outline',
  evidence: 'file-question-outline',
  claim: 'scale-balance',
  case: 'chart-timeline-variant',
};

/**
 * A filing deadline is the one row whose icon comes from where it goes rather than from what
 * it is. Its `kind` is `case`, because a window belongs to the case as a whole — but a clock
 * face is the only thing on this screen that says "this expires", and that is the single most
 * important distinction the list draws.
 */
function workIcon(item: AttentionItem): IconName {
  return item.target.route === 'letter' ? 'calendar-clock' : WORK_ICON[item.kind];
}

/**
 * Flatten per-case workspaces into one.
 *
 * Records are keyed by id and the *last* one wins. Order matters here: the same record can
 * appear in two loaded workspaces — a relationship spanning two cases, or a case row read
 * once in a list and again with its contents — and the later read is the fresher one. A
 * first-wins merge would silently pin the older copy and show activity that has since been
 * superseded.
 */
function mergeWorkspaces(workspaces: readonly Workspace[]): Workspace {
  const unique = <T extends { id: string }>(items: T[]): T[] => [
    ...new Map(items.map((item) => [item.id, item])).values(),
  ];

  return {
    cases: unique(workspaces.flatMap((item) => item.cases)),
    claims: unique(workspaces.flatMap((item) => item.claims)),
    events: unique(workspaces.flatMap((item) => item.events)),
    evidence: unique(workspaces.flatMap((item) => item.evidence)),
    relationships: unique(workspaces.flatMap((item) => item.relationships)),
    analysisResults: unique(workspaces.flatMap((item) => item.analysisResults)),
    caseAnalyses: unique(workspaces.flatMap((item) => item.caseAnalyses)),
    auditLogs: unique(workspaces.flatMap((item) => item.auditLogs)),
    processingJobs: unique(workspaces.flatMap((item) => item.processingJobs)),
    aiSuggestions: unique(workspaces.flatMap((item) => item.aiSuggestions)),
    seals: unique(workspaces.flatMap((item) => item.seals)),
  };
}

/**
 * What needs doing, and what has happened.
 *
 * ## Two lists, and why they are not one list
 *
 * The block at the top is forward-looking: everything still outstanding across every case,
 * with anything whose filing window is closing at the top of it. Below it is the backward-
 * looking log — records that were saved, jobs that finished or failed.
 *
 * They are kept visibly apart rather than interleaved because they answer different
 * questions, and a single stream would answer neither. "Your scan finished" and "you have
 * fifty-five days left to approach the Ombudsman" are not two entries of the same kind, and
 * sorting them together by time would bury the second under the first — which is precisely
 * what happened while this screen was only a log.
 *
 * ## Why the top block is not a notification feed either
 *
 * Nothing is pushed, and nothing is marked read. Both lists are derived on each visit from
 * what is already in the repository. A badge counting unread items would imply the app is
 * watching on the user's behalf between visits, which it is not — the work runs on the
 * device, and when the app is not open, it is not running.
 *
 * The count shown beside the heading is therefore a count of what is *outstanding right
 * now*, not of what is new since last time, and it goes down when the work is done rather
 * than when the screen is opened.
 *
 * The deadline rows are the one thing here that can change without any record changing, so
 * `caseWorklist` takes the clock as an argument and is passed `Date.now()` at load — one
 * reading per load, so two rows in the same list cannot straddle midnight and disagree.
 *
 * ## Why one snapshot feeds both
 *
 * The worklist needs every case's evidence to work out a filing window, and this screen was
 * already loading exactly that for the activity log. Both lists come off the same snapshot,
 * so the forward-looking half costs no additional reads.
 *
 * ## Why a generation counter rather than a cancelled flag
 *
 * A refresh can be tapped while a previous load is still in flight, and the two can finish
 * out of order. Each run claims a number; only a run still holding the current number is
 * allowed to write state. That discards a slow earlier response instead of letting it
 * overwrite the newer one — which a boolean, reset by whichever run finished last, would
 * not catch.
 */
export default function NotificationsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { repository, ready } = useRepository();
  const { user } = useSession();

  const ownerId = user?.id ?? null;
  const generation = useRef(0);

  const [items, setItems] = useState<CaseActivity[]>([]);
  const [work, setWork] = useState<AttentionItem[]>([]);
  const [loadedOwner, setLoadedOwner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [showAllWork, setShowAllWork] = useState(false);

  const load = useCallback(async () => {
    const run = ++generation.current;
    setLoading(true);
    setError(null);

    // Signed out is a real, final answer about what can be shown, and the empty state for
    // it says so truthfully. So this one does stop loading.
    if (!ownerId) {
      setItems([]);
      setWork([]);
      setLoading(false);
      return;
    }

    // Storage is not ready yet, which is *not* an answer about the user's data. `loading`
    // is deliberately left true: reporting it as false alongside an empty list is what made
    // this screen say "No case activity yet" to someone whose activity had never been read.
    // The effect re-runs when `ready` flips, so the load happens as soon as it can.
    if (!ready) {
      setItems([]);
      setWork([]);
      return;
    }

    try {
      let snapshot: Workspace;

      if (repository.loadAllWorkspace) {
        snapshot = await repository.loadAllWorkspace(ownerId);
      } else {
        const cases = await repository.listCases(ownerId);
        const workspaces = await mapWithConcurrency(cases, READ_CONCURRENCY, (record) =>
          repository.loadWorkspace(ownerId, record.id),
        );
        snapshot = mergeWorkspaces(workspaces);
      }

      if (run !== generation.current) return;
      setItems(caseActivity(ownerId, snapshot));
      // One clock reading for the whole list. Taken here rather than inside the domain so
      // the function stays testable without a fake timer.
      setWork(caseWorklist(snapshot, Date.now()));
      setLoadedOwner(ownerId);
    } catch (caught) {
      if (run === generation.current) {
        setItems([]);
        setWork([]);
        setError(caught instanceof Error ? caught.message : 'Activity could not be loaded.');
      }
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, [ownerId, ready, repository]);

  useFocusEffect(
    useCallback(() => {
      setLimit(PAGE_SIZE);
      setShowAllWork(false);
      void load();
      // Leaving the screen invalidates the in-flight run, so a response arriving after
      // the user has navigated away cannot write to unmounted state.
      return () => {
        generation.current++;
      };
    }, [load]),
  );

  // Activity is only shown once it is known to belong to the signed-in account. After a
  // sign-out the previous account's entries are still in state for a frame, and showing
  // them — even briefly — would leak one user's case titles to the next.
  const ownData = loadedOwner === ownerId && !error && !loading;
  const visible = ownData ? items : [];
  const outstanding = ownData ? work : [];

  const open = useCallback(
    (item: CaseActivity) => {
      if (item.evidenceId) {
        router.replace({
          pathname: '/case/[caseId]/evidence/[evidenceId]',
          params: { caseId: item.caseId, evidenceId: item.evidenceId },
        });
      } else {
        router.replace({ pathname: '/case/[caseId]', params: { caseId: item.caseId } });
      }
    },
    [router],
  );

  /**
   * Open an outstanding item.
   *
   * `push`, where the activity log above uses `replace`. The difference is deliberate: this
   * is a triage list, and someone working through three closing deadlines needs the back
   * gesture to return them to it. `replace` would drop them onto the tab bar after the first
   * one and make them find their way here again for each of the rest.
   *
   * The switch is exhaustive over `AttentionTarget` rather than string-building a path, so a
   * new kind of row cannot ship with a route that does not exist — the compiler asks for the
   * case, and the params each route needs come typed with it.
   */
  const openWork = useCallback(
    (target: AttentionItem['target']) => {
      switch (target.route) {
        case 'letter':
          router.push({ pathname: '/case/[caseId]/letter', params: { caseId: target.caseId } });
          return;
        case 'evidence':
          router.push({
            pathname: '/case/[caseId]/evidence/[evidenceId]',
            params: { caseId: target.caseId, evidenceId: target.evidenceId },
          });
          return;
        case 'claim':
          router.push({
            pathname: '/case/[caseId]/claim/[claimId]',
            params: { caseId: target.caseId, claimId: target.claimId },
          });
          return;
        case 'case':
          router.push({ pathname: '/case/[caseId]', params: { caseId: target.caseId } });
          return;
      }
    },
    [router],
  );

  const shownWork = showAllWork ? outstanding : outstanding.slice(0, WORKLIST_PREVIEW);
  const hiddenWork = outstanding.length - shownWork.length;

  return (
    <ScreenList
      title="Needs doing"
      subtitle="Everything still outstanding across your cases, and the log of what has been saved."
      back
      actions={[
        {
          icon: 'refresh',
          label: 'Refresh',
          disabled: loading || !ownerId,
          onPress: () => void load(),
        },
      ]}
      listHeader={
        <View>
          {outstanding.length > 0 ? (
            <View style={{ marginBottom: theme.spacing.xl }}>
              <Row between align="center" style={{ marginBottom: theme.spacing.md }}>
                <Text variant="label" colorToken="textSecondary">
                  Outstanding
                </Text>
                {/*
                  The tone is taken from the most urgent row rather than fixed, so the count
                  and the first tile agree. A permanently amber count would say the same thing
                  whether one window is closing this week or nothing is.
                */}
                <Chip
                  label={`${outstanding.length}`}
                  tone={SEVERITY_TONE[outstanding[0]!.severity]}
                  size="sm"
                />
              </Row>

              <Surface glass glassVariant="panel" radius="lg" padding="lg">
                {shownWork.map((item, index) => (
                  <React.Fragment key={item.id}>
                    {index > 0 ? <Divider spacing="md" /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        item.caseTitle ? `${item.title}, ${item.caseTitle}` : item.title
                      }
                      onPress={() => openWork(item.target)}
                    >
                      <Row gap="md" align="flex-start">
                        <IconTile
                          icon={workIcon(item)}
                          tone={SEVERITY_TONE[item.severity]}
                          size="sm"
                        />

                        <View style={styles.flex}>
                          <Text variant="subheading" numberOfLines={2}>
                            {item.title}
                          </Text>
                          {item.caseTitle ? (
                            <Text
                              variant="caption"
                              colorToken="textSecondary"
                              style={{ marginTop: 4 }}
                            >
                              {item.caseTitle}
                            </Text>
                          ) : null}
                          {/*
                            Clamped rather than scrolled. A deadline row carries its statutory
                            citation, which is long by design, and the row it belongs to opens
                            the screen that prints it in full.
                          */}
                          <Text
                            variant="bodySmall"
                            colorToken="textSecondary"
                            numberOfLines={3}
                            style={{ marginTop: 6 }}
                          >
                            {item.detail}
                          </Text>
                        </View>

                        <Icon name="chevron-right" size={20} color={theme.colors.textTertiary} />
                      </Row>
                    </Pressable>
                  </React.Fragment>
                ))}
              </Surface>

              {hiddenWork > 0 ? (
                <Button
                  label={`Show ${hiddenWork} more`}
                  variant="ghost"
                  size="sm"
                  onPress={() => setShowAllWork(true)}
                />
              ) : null}
            </View>
          ) : null}

          {/*
            The divider between the two halves is a labelled heading rather than a rule,
            because the change is one of kind and not merely of section: above is what to do,
            below is what happened. It is shown even when the log itself is empty, so that
            list is never mistaken for a to-do list — but not while loading, and not over an
            error or a sign-in prompt, where it would be labelling something that is not there.
          */}
          {ownData ? (
            <Text
              variant="label"
              colorToken="textSecondary"
              style={{ marginBottom: theme.spacing.sm }}
            >
              Recent activity
            </Text>
          ) : null}
        </View>
      }
      data={visible.slice(0, limit)}
      keyExtractor={(item) => item.id}
      onRefresh={() => void load()}
      refreshing={loading}
      renderItem={(item) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.title}, ${item.caseTitle}`}
          onPress={() => open(item)}
          style={[
            styles.row,
            { paddingVertical: theme.spacing.lg, borderBottomColor: theme.colors.border },
          ]}
        >
          <Row gap="md" align="flex-start">
            <Icon
              name={item.failed ? 'alert-circle-outline' : 'history'}
              size={22}
              color={item.failed ? theme.colors.tones.danger.fg : theme.colors.textSecondary}
            />

            <View style={styles.flex}>
              <Text variant="subheading">{item.title}</Text>
              {/*
                Two facts, given two positions, instead of `caseTitle · timestamp`.

                A dot-joined meta string reads as one blurred fact and cannot be scanned: a
                reader running down this list for "which case" has to skip past a date each
                time, and one looking for "when" has to skip past a case name. Split, the
                timestamps form a column at the right edge that the eye can run down, and the
                case names form one at the left. The time is in mono because it is a recorded
                system time rather than prose — the same channel every other machine-written
                value in the app uses.
              */}
              <Row between align="center" gap="sm" style={{ marginTop: 4 }}>
                <Text
                  variant="caption"
                  colorToken="textSecondary"
                  numberOfLines={1}
                  style={styles.flex}
                >
                  {item.caseTitle}
                </Text>
                <Text variant="monoSmall" colorToken="textTertiary">
                  {formatTimestamp(item.time)}
                </Text>
              </Row>
              {item.detail ? (
                <Text variant="bodySmall" colorToken="textSecondary" style={{ marginTop: 8 }}>
                  {item.detail}
                </Text>
              ) : null}
            </View>
          </Row>
        </Pressable>
      )}
      empty={
        loading ? (
          <SkeletonList count={4} />
        ) : error ? (
          <ErrorState
            title="Activity could not be loaded"
            message="Check your connection and try again."
            detail={error}
            onRetry={() => void load()}
          />
        ) : !ownerId ? (
          <EmptyState
            icon="account-outline"
            title="Sign in to see activity"
            message="Activity belongs to your account's cases."
            action={{ label: 'Sign in', onPress: () => router.replace('/sign-in') }}
          />
        ) : (
          <EmptyState
            icon="history"
            title="No case activity yet"
            message="Case changes and processing jobs will appear here when they are saved."
            action={{ label: 'Open cases', onPress: () => router.replace('/cases') }}
          />
        )
      }
      listFooter={
        visible.length > limit ? (
          <Button
            label={`Show ${Math.min(PAGE_SIZE, visible.length - limit)} earlier`}
            variant="secondary"
            onPress={() => setLimit((value) => value + PAGE_SIZE)}
          />
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  row: { borderBottomWidth: 1 },
  flex: { flex: 1 },
});