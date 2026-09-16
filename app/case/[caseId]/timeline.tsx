import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { createEvent } from '@data/mutations';
import { latestCaseAnalysis, reportIsStale } from '@domain/analysis/case-report';
import {
  buildTimeline,
  findTimelineGaps,
  type TimelineEntry,
} from '@domain/analysis/timeline';
import { CitationList } from '@features/analysis/case-analysis-panel';
import { CaseComposerSheet, type ComposerDraft } from '@features/case/composer-sheet';
import { useSession } from '@services';
import { mutationContext, useCaseRecord, useMutator, useWorkspace } from '@services/use-case-store';
import {
  BORDER_WIDTH,
  Button,
  Chip,
  DATE_PRECISION_LABELS,
  Disclosure,
  Divider,
  EmptyState,
  ErrorState,
  errorDetail,
  HIT_TARGET,
  LAYOUT,
  Notice,
  Pressable,
  readableError,
  Row,
  ScreenScroll,
  SkeletonList,
  SPACING,
  Stack,
  Surface,
  Text,
  useTheme,
} from '@ui';

/**
 * The case timeline.
 *
 * ## Why this draws a spine
 *
 * The previous version of this screen was a flat column of cards with a date printed at the
 * top of each one. Every fact was on it and none of the *shape* was: you could not see that
 * four things happened on one afternoon and then nothing happened for two months, which is
 * the observation a timeline exists to make. A person disputing a charge is usually arguing
 * about exactly that shape — the order things happened in, and the silence in between.
 *
 * So the screen renders a real rail. Three columns: a date gutter, the spine with a node on
 * it, and the content. The spine is one continuous rule because it is drawn *per row* and
 * every row's rail spans that row's full height — the vertical breathing room lives in the
 * content column's `paddingBottom`, never as a gap between rows, or the line would break at
 * every entry. It stops at the first and last node rather than running off both ends.
 *
 * ## What the geometry is derived from, and what it is not
 *
 * Nothing here is simulated or measured. `buildTimeline` already returns month bands with
 * human labels (`groups`), and `findTimelineGaps` already returns the long silences; both
 * were computed on every render of the old screen and both went unused. The rail is those
 * two results laid out with `flexDirection: 'row'` and one absolutely-positioned rule, which
 * costs a mid-range phone nothing and is identical on every re-render.
 *
 * Three row shapes share the grid. A **band header** and a **gap marker** have no node, so
 * the spine runs straight through them; a **day cluster** has one node, and when more than
 * one record carries the same date they become rows inside a single card under a single
 * ringed node. That is the honest reading of the data: one date, several records — not
 * several dates.
 *
 * ## Two sequences, kept apart
 *
 * The screen shows two lists that are never merged, because they have different standing:
 *
 *   - **Events identified in the evidence.** Produced by an assessment, each one carrying
 *     the passage it was read from. These are interpretations of a document.
 *   - **Recorded events and dated evidence.** Dates the user entered, plus dates the
 *     extractor read off a document. These are entries in the case.
 *
 * Interleaving them would produce a single confident-looking chronology whose rows have
 * quietly different bases — a date someone typed sitting beside a date inferred from a
 * sentence, with nothing to tell them apart. Where a date is unknown it is left unresolved
 * rather than guessed at, for the same reason, and the undated band sits at the end of the
 * rail instead of being dropped.
 *
 * ## No motion
 *
 * Deliberately none, so there is nothing for reduced motion to switch off. The rail is the
 * one thing on this screen a reader scans vertically at speed, and staggered entrances on a
 * list of forty rows fight that scan on the hardware this is built for.
 *
 * ## Why the list is paged
 *
 * A case with many sources produces many dated rows, and a mounted list of several hundred
 * cards is slow on the mid-range Android hardware this is built for. Forty is enough to
 * fill several screens; the rest arrive on request.
 */
const PAGE_SIZE = 40;

/**
 * Rail geometry, all of it derived from the spacing scale.
 *
 * The gutter is sized for a two-digit day at `label`, not for a full date — the month band
 * above already carries the month and the year, so repeating them on every row would be the
 * widest column on the screen saying the same thing forty times. On a 360pt phone the rail
 * and gutter together take 60pt, which leaves the content column wider than the old
 * full-width cards were once their own padding was counted.
 */
const DATE_GUTTER = SPACING.huge;
const RAIL_WIDTH = SPACING.xl;
/** The height the gutter label and the node are both centred in, so the two always align. */
const MARKER_BAND = SPACING.huge;
const MARKER_CENTRE = MARKER_BAND / 2;
const NODE_SIZE = SPACING.md;
/** The ring that marks a date carrying more than one record. */
const NODE_RING = SPACING.xl;

type TimelineFilter = 'all' | 'event' | 'evidence';

const FILTERS: ReadonlyArray<{ value: TimelineFilter; label: string; empty: string }> = [
  { value: 'all', label: 'All records', empty: 'dated records or events' },
  { value: 'event', label: 'Events', empty: 'events' },
  { value: 'evidence', label: 'Evidence', empty: 'dated evidence' },
];

/**
 * A date on the rail, and everything recorded against it.
 *
 * Keyed by `displayDate` rather than by the ISO string, because the gutter labels what the
 * reader can see: two records the app can only place in "May 2024" are one point on the rail,
 * and so are two records whose stated date it could not parse at all.
 */
interface DayCluster {
  /** `entry.displayDate`, shared by every entry in the cluster. */
  key: string;
  /** `YYYY-MM`, `YYYY`, or `undated` — the band this date belongs to. */
  band: string;
  /** Day of the month, when the date is known to the day. Null for anything coarser. */
  day: string | null;
  entries: TimelineEntry[];
}

/** The day number for the gutter, or null when the date is not known to the day. */
function gutterDay(entry: TimelineEntry): string | null {
  const iso = entry.date?.iso;
  if (!iso || entry.date?.precision !== 'DAY') return null;
  const day = Number(iso.split('-')[2]);
  return Number.isFinite(day) && day > 0 ? String(day) : null;
}

export default function TimelineScreen() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { user } = useSession();

  const { workspace, loading, refreshing, error, reload } = useWorkspace(
    user?.id ?? null,
    caseId ?? null,
  );
  const caseRecord = useCaseRecord(workspace, caseId ?? null);
  const mutator = useMutator(user?.id ?? null, caseId ?? null, workspace);
  const report = latestCaseAnalysis(workspace, caseId ?? '');

  const timeline = useMemo(
    () => (caseRecord ? buildTimeline(workspace, caseId) : null),
    [workspace, caseId, caseRecord],
  );

  const [adding, setAdding] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; detail: string | null } | null>(null);
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const entries = useMemo(
    () => (timeline?.entries ?? []).filter((entry) => filter === 'all' || entry.kind === filter),
    [timeline, filter],
  );

  /**
   * Month labels, taken from the domain rather than re-derived.
   *
   * `buildTimeline` already names every band ("May 2024", "No date recorded"). Filtering only
   * removes entries, so every band a visible entry belongs to is still in this map.
   */
  const bandLabels = useMemo(
    () => new Map((timeline?.groups ?? []).map((group) => [group.key, group.label] as const)),
    [timeline],
  );
  const undatedLabel = bandLabels.get('undated');

  const clusters = useMemo<DayCluster[]>(() => {
    const out: DayCluster[] = [];
    // `entries` arrives sorted by the domain: chronological, undated last.
    for (const entry of entries) {
      const iso = entry.date?.iso ?? null;
      const band = iso ? iso.slice(0, 7) : 'undated';
      const last = out[out.length - 1];
      if (last && last.band === band && last.key === entry.displayDate) {
        last.entries.push(entry);
        continue;
      }
      out.push({ key: entry.displayDate, band, day: gutterDay(entry), entries: [entry] });
    }
    return out;
  }, [entries]);

  /**
   * Long silences, keyed by the pair of dates they sit between.
   *
   * Computed from the *filtered* entries, so the marker always describes the rail the reader
   * is looking at: a gap measured across rows the filter has hidden is not a gap they can
   * see either end of. `findTimelineGaps` reads nothing but `entries`.
   */
  const gapDays = useMemo(() => {
    const map = new Map<string, number>();
    for (const gap of findTimelineGaps({ entries, groups: [], undatedCount: 0, range: null })) {
      map.set(`${gap.from}|${gap.to}`, gap.days);
    }
    return map;
  }, [entries]);

  const visible = clusters.slice(0, visibleCount);
  const hiddenClusters = clusters.length - visible.length;
  const citedEvents = report?.timeline ?? [];
  const activeFilter = FILTERS.find((item) => item.value === filter) ?? FILTERS[0]!;
  const claims = useMemo(() => workspace.claims.filter((item) => !item.deletedAt), [workspace]);

  const openComposer = useCallback(() => {
    setSaveError(null);
    setAdding(true);
  }, []);

  const saveEvent = useCallback(
    async (draft: ComposerDraft) => {
      if (!user || !caseId) return;
      setSaveError(null);

      const result = await mutator.mutate((current) =>
        createEvent(current, mutationContext(user.id), caseId, {
          title: draft.statement.trim(),
          description: draft.detail,
          occurredAt: draft.date.trim() || null,
          claimIds: draft.claimId ? [draft.claimId] : [],
        }),
      );

      // A form that closes on a failed save loses the user's words, so the sheet stays open
      // with the text still in it and the failure printed inside it.
      if (result.ok) setAdding(false);
      else {
        setSaveError({
          message: readableError(
            result.error,
            'The event could not be saved. Check your connection and try again.',
          ),
          detail: errorDetail(result.error) ?? null,
        });
      }
    },
    [user, caseId, mutator],
  );

  const openEntry = useCallback(
    (entry: TimelineEntry) => {
      router.push(
        entry.kind === 'event'
          ? { pathname: '/case/[caseId]/event/[eventId]', params: { caseId, eventId: entry.id } }
          : {
              pathname: '/case/[caseId]/evidence/[evidenceId]',
              params: { caseId, evidenceId: entry.id },
            },
      );
    },
    [router, caseId],
  );

  return (
    <>
      <ScreenScroll
        title="Timeline"
        back
        refreshing={refreshing}
        onRefresh={reload}
        {...(caseRecord?.title ? { subtitle: caseRecord.title } : {})}
      >
        <Stack gap="xxl" style={styles.content}>
          {error && !caseRecord ? (
            <ErrorState
              title="This case could not be opened"
              message="The timeline is built from the case itself, so there is nothing to show until it loads."
              onRetry={reload}
              detail={errorDetail(error) ?? null}
            />
          ) : (
            <>
              {error ? (
                <Notice
                  tone="danger"
                  title="Part of this case could not be loaded"
                  message={readableError(
                    error,
                    'The timeline below may be incomplete. Pull down to try again.',
                  )}
                  detail={errorDetail(error) ?? null}
                />
              ) : null}

              <Text colorToken="textSecondary">
                The sequence the documents describe, alongside the events recorded in the case.
                Where a date is not recorded it is left blank rather than estimated.
              </Text>

              <Row gap="sm" wrap>
                <Button
                  label="Add event"
                  variant="primary"
                  icon="plus"
                  onPress={openComposer}
                  disabled={!caseRecord}
                  {...(caseRecord
                    ? {}
                    : { accessibilityHint: 'Available once this case has opened.' })}
                />
                <Button
                  label="Add evidence"
                  variant="secondary"
                  onPress={() =>
                    router.push({ pathname: '/case/[caseId]/upload', params: { caseId } })
                  }
                />
              </Row>

              {loading && !caseRecord ? (
                // Replaces the two empty states this screen used to assert while it was still
                // loading. "No events have been read from the evidence yet" is a finding about
                // a case, and until the case is open we have not made it.
                <SkeletonList count={3} />
              ) : !caseRecord ? (
                <EmptyState
                  icon="folder-alert-outline"
                  title="This case is not available"
                  message="It may have been deleted, or it may belong to another account. Nothing can be shown on the timeline until it opens."
                />
              ) : (
                <>
                  {report && reportIsStale(workspace, report) ? (
                    <Notice
                      title="This timeline is from an earlier version of the case"
                      message="The documents have changed since the assessment that produced it. Run a new assessment to take them into account."
                      tone="warn"
                    />
                  ) : null}

                  <Stack gap="md">
                    <Text variant="heading">Events identified in the evidence</Text>

                    {report && citedEvents.length ? (
                      <>
                        <Text variant="bodySmall" colorToken="textSecondary">
                          Each of these was read from the passage quoted beneath it. Where two
                          documents give different times, both are kept.
                        </Text>
                        {citedEvents.map((event, index) => (
                          <Surface
                            key={`${report.id}:${index}`}
                            padding="lg"
                            radius="lg"
                            style={{ gap: theme.spacing.md }}
                          >
                            <Text variant="caption" colorToken="textSecondary">
                              {event.occurredAt || 'No date recorded'}
                            </Text>
                            <Text variant="subheading">{event.description}</Text>
                            <CitationList
                              citations={event.citations}
                              workspace={workspace}
                              caseId={caseId}
                            />
                          </Surface>
                        ))}
                      </>
                    ) : (
                      <EmptyState
                        compact
                        icon="text-search"
                        title="Nothing has been read from the evidence yet"
                        message="An assessment reads dates out of your documents and lists them here, each with the passage it came from."
                        action={{
                          label: 'Back to the case',
                          icon: 'arrow-left',
                          onPress: () => router.back(),
                        }}
                      />
                    )}
                  </Stack>

                  <Stack gap="md">
                    <Text variant="heading">Recorded events and dated evidence</Text>

                    <Row gap="sm" wrap>
                      {FILTERS.map((item) => {
                        const selected = filter === item.value;
                        return (
                          <Pressable
                            key={item.value}
                            haptic
                            pressScale={0.97}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            accessibilityLabel={`Show ${item.label.toLowerCase()}`}
                            onPress={() => {
                              setFilter(item.value);
                              setVisibleCount(PAGE_SIZE);
                            }}
                            style={[
                              styles.filter,
                              {
                                paddingHorizontal: theme.spacing.lg,
                                borderRadius: theme.radius.pill,
                                // Gold paints selection and structure; the blue CTA is kept
                                // for the one primary action on the screen.
                                borderColor: selected ? theme.colors.accent : theme.colors.border,
                                backgroundColor: selected
                                  ? theme.colors.accentSurface
                                  : theme.colors.surface,
                              },
                            ]}
                          >
                            <Text
                              variant="label"
                              colorToken={selected ? 'text' : 'textSecondary'}
                              numberOfLines={1}
                            >
                              {item.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </Row>

                    {clusters.length === 0 ? (
                      <EmptyState
                        compact
                        icon="calendar-blank-outline"
                        title={`No ${activeFilter.empty} yet`}
                        message="Add an event you know happened, or add a document and let the extractor read its dates."
                        action={{ label: 'Add event', icon: 'plus', onPress: openComposer }}
                      />
                    ) : null}

                    {visible.map((cluster, index) => {
                      const previous = visible[index - 1];
                      const bandLabel =
                        !previous || previous.band !== cluster.band
                          ? (bandLabels.get(cluster.band) ?? cluster.key)
                          : null;
                      const gap = previous
                        ? gapDays.get(`${previous.key}|${cluster.key}`)
                        : undefined;
                      const lastCluster = index === visible.length - 1;
                      const grouped = cluster.entries.length > 1;
                      const stated =
                        cluster.band === 'undated' && cluster.key !== undatedLabel
                          ? cluster.key
                          : null;

                      return (
                        <View key={`${cluster.band}:${cluster.key}`}>
                          {bandLabel ? (
                            <SpineRow above={index > 0 || gap !== undefined} below>
                              <Text
                                variant="label"
                                colorToken="textSecondary"
                                style={{ paddingBottom: theme.spacing.md }}
                              >
                                {bandLabel}
                              </Text>
                            </SpineRow>
                          ) : null}

                          {gap !== undefined ? (
                            <SpineRow above below>
                              <Text
                                variant="caption"
                                colorToken="textTertiary"
                                style={{ paddingBottom: theme.spacing.md }}
                              >
                                {gap} days with nothing recorded
                              </Text>
                            </SpineRow>
                          ) : null}

                          <SpineRow
                            above={index > 0 || bandLabel !== null || gap !== undefined}
                            below={!lastCluster}
                            gutter={
                              cluster.day ? (
                                <Text variant="label" colorToken="textSecondary">
                                  {cluster.day}
                                </Text>
                              ) : null
                            }
                            node={
                              <>
                                {grouped ? (
                                  <View
                                    style={[
                                      styles.ring,
                                      { borderColor: theme.colors.accent },
                                    ]}
                                  />
                                ) : null}
                                <View
                                  style={[
                                    styles.node,
                                    {
                                      backgroundColor:
                                        cluster.band === 'undated'
                                          ? theme.colors.borderStrong
                                          : theme.colors.accent,
                                    },
                                  ]}
                                />
                              </>
                            }
                          >
                            <Stack gap="sm" style={{ paddingBottom: theme.spacing.lg }}>
                              {stated ? (
                                <Text variant="monoSmall" colorToken="textTertiary" numberOfLines={1}>
                                  Stated as “{stated}”
                                </Text>
                              ) : null}

                              {grouped ? (
                                <Text variant="caption" colorToken="textTertiary">
                                  {cluster.band === 'undated'
                                    ? `${cluster.entries.length} records without a date`
                                    : `${cluster.entries.length} records on this date`}
                                </Text>
                              ) : null}

                              {/*
                                One card per date, not one per record. Several rows under one
                                ringed node is the whole point of the cluster: the reader sees
                                a single moment carrying several documents, which is what the
                                data says, rather than several moments that happen to share a
                                printed date.
                              */}
                              <Surface padding="none" radius="lg" style={styles.clip}>
                                {cluster.entries.map((entry, entryIndex) => (
                                  <React.Fragment key={`${entry.kind}:${entry.id}`}>
                                    {entryIndex > 0 ? <Divider /> : null}
                                    <Pressable
                                      dimOnPress
                                      pressScale={0}
                                      accessibilityRole="button"
                                      accessibilityLabel={`${
                                        entry.kind === 'event' ? 'Event' : 'Document'
                                      }: ${entry.title}, ${entry.displayDate}`}
                                      onPress={() => openEntry(entry)}
                                      style={[styles.entry, { padding: theme.spacing.lg }]}
                                    >
                                      {/*
                                        An inner row, because `Pressable` wraps its children in
                                        the transparent view that carries the press animation —
                                        a `flexDirection` on the pressable itself would lay that
                                        wrapper out rather than the text and the chevron, and the
                                        chevron would end up under the title instead of beside it.
                                      */}
                                      <View
                                        style={[styles.entryInner, { gap: theme.spacing.md }]}
                                      >
                                        <Stack gap="xs" style={styles.flex}>
                                          <Text variant="subheading" numberOfLines={2}>
                                            {entry.title}
                                          </Text>
                                          {entry.description ? (
                                            <Text
                                              variant="bodySmall"
                                              colorToken="textSecondary"
                                              numberOfLines={2}
                                            >
                                              {entry.description}
                                            </Text>
                                          ) : null}
                                          <Row
                                            gap="xs"
                                            wrap
                                            style={{ marginTop: theme.spacing.xxs }}
                                          >
                                            <Chip
                                              label={
                                                entry.kind === 'event'
                                                  ? 'Recorded event'
                                                  : 'Read from a document'
                                              }
                                              tone="neutral"
                                              size="sm"
                                            />
                                            {entry.precision === 'MONTH' ||
                                            entry.precision === 'YEAR' ? (
                                              <Chip
                                                label={DATE_PRECISION_LABELS[entry.precision]}
                                                tone="neutral"
                                                size="sm"
                                              />
                                            ) : null}
                                            {entry.ambiguous ? (
                                              <Chip
                                                label="Date needs review"
                                                tone="warn"
                                                size="sm"
                                              />
                                            ) : null}
                                            {entry.hasConflict ? (
                                              <Chip label="In a conflict" tone="danger" size="sm" />
                                            ) : null}
                                          </Row>
                                        </Stack>
                                        <Disclosure />
                                      </View>
                                    </Pressable>
                                  </React.Fragment>
                                ))}
                              </Surface>
                            </Stack>
                          </SpineRow>
                        </View>
                      );
                    })}

                    {hiddenClusters > 0 ? (
                      <Button
                        label={`Show ${Math.min(PAGE_SIZE, hiddenClusters)} more dates`}
                        variant="secondary"
                        onPress={() => setVisibleCount((value) => value + PAGE_SIZE)}
                      />
                    ) : null}
                  </Stack>
                </>
              )}
            </>
          )}
        </Stack>
      </ScreenScroll>

      <CaseComposerSheet
        visible={adding}
        kind="event"
        claims={claims}
        busy={mutator.busy}
        error={saveError}
        onDismiss={() => setAdding(false)}
        onSubmit={(draft) => void saveEvent(draft)}
      />
    </>
  );
}

/**
 * One row of the rail: date gutter, spine, content.
 *
 * The spine is drawn as two segments meeting at the marker's centre rather than as one rule
 * behind it, so `above={false}` on the first row and `below={false}` on the last row end the
 * line *at* a node instead of letting it run off into the padding. The node itself covers the
 * join. Rows carry no vertical gap between them — the content is what has the padding — which
 * is what keeps the two segments of adjacent rows touching.
 */
function SpineRow({
  above,
  below,
  gutter = null,
  node = null,
  children,
}: {
  /** Draw the spine from the top edge down to the marker. False only on the first row. */
  above: boolean;
  /** Draw it from the marker down to the bottom edge. False only on the last row. */
  below: boolean;
  gutter?: React.ReactNode;
  /** The marker on the rail. Band headers and gap markers have none, so the line runs on. */
  node?: React.ReactNode;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={styles.spineRow}>
      <View style={styles.gutter}>{gutter}</View>
      <View style={styles.rail}>
        {above ? (
          <View
            style={[
              styles.spine,
              { top: 0, height: MARKER_CENTRE, backgroundColor: theme.colors.border },
            ]}
          />
        ) : null}
        {below ? (
          <View
            style={[
              styles.spine,
              { top: MARKER_CENTRE, bottom: 0, backgroundColor: theme.colors.border },
            ]}
          />
        ) : null}
        {node}
      </View>
      <View style={styles.column}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  flex: { flex: 1 },
  clip: { overflow: 'hidden' },

  spineRow: { flexDirection: 'row' },
  gutter: {
    width: DATE_GUTTER,
    height: MARKER_BAND,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: SPACING.sm,
  },
  rail: { width: RAIL_WIDTH },
  // `left` is stated rather than left to the rail's `alignItems`: an absolutely-positioned
  // child with auto insets is aligned by its parent in Yoga, which is true but is exactly the
  // kind of implicit behaviour that breaks silently. Every offset here is the rail's own width
  // minus the element's, so the three layers cannot drift out of line with one another.
  spine: {
    position: 'absolute',
    left: (RAIL_WIDTH - BORDER_WIDTH.thick) / 2,
    width: BORDER_WIDTH.thick,
  },
  node: {
    position: 'absolute',
    top: MARKER_CENTRE - NODE_SIZE / 2,
    left: (RAIL_WIDTH - NODE_SIZE) / 2,
    width: NODE_SIZE,
    height: NODE_SIZE,
    borderRadius: NODE_SIZE / 2,
  },
  ring: {
    position: 'absolute',
    top: MARKER_CENTRE - NODE_RING / 2,
    left: (RAIL_WIDTH - NODE_RING) / 2,
    width: NODE_RING,
    height: NODE_RING,
    borderRadius: NODE_RING / 2,
    borderWidth: BORDER_WIDTH.thick,
  },
  column: { flex: 1 },
  entry: { minHeight: HIT_TARGET },
  entryInner: { flexDirection: 'row', alignItems: 'center' },
  filter: {
    borderWidth: BORDER_WIDTH.hairline,
    minHeight: HIT_TARGET,
    justifyContent: 'center',
  },
});
