/**
 * The case list.
 *
 * ## Why this screen is a `ScreenList` and not its own `FlatList`
 *
 * It used to build its own list, which meant it was the one tab that did not animate its
 * title into the pinned bar on scroll. Two tabs doing the large-title handover and two not
 * doing it does not read as two designs — it reads as one design that is broken, because
 * the user cannot tell which behaviour is the intended one. `ScreenList` is the primitive
 * that owns that chrome, so the screen adopts it and stops re-deciding what a header is.
 *
 * ## Why the controls are no longer a panel
 *
 * They were: search, five wrapping status chips, a rule and a full-width primary button, all
 * inside one `padding="xl"` glass hero. Measured on a 360×640 device that stack put the
 * first case card at roughly y=440 — below the fold on the screen whose entire job is to
 * show the cases. Every element in it was defensible on its own and the total was not, which
 * is the usual shape of this mistake.
 *
 * So the controls are now the thinnest thing that still does the job: a search field, and one
 * *scrolling* line of status chips under it. Horizontal rather than wrapped, because five
 * labels wrap to two rows at any realistic width and the second row costs 44pt to show three
 * filters nobody was looking for. The strip bleeds to both screen edges so the cut-off chip at
 * the right says it scrolls without a hint line having to.
 *
 * ## Where the primary action went
 *
 * Into the pinned bar, next to the title. It cannot go in `ScreenList`'s `footer` slot on a
 * tab screen — that renders at `bottom: 0`, which is underneath the floating tab bar — and
 * leaving it in the scroll body is what buried the list. `folder-plus-outline` rather than a
 * bare `plus`, because the tab bar's compose button is a plus disc 40pt below it and two
 * identical glyphs on one screen read as one control drawn twice.
 *
 * The rows below the controls stay flat cards. A list where every row is glass has no
 * hierarchy left to spend — depth stops meaning "this one matters" the moment everything has
 * it — so `CaseCard` keeps the default treatment it already carries.
 */

import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { CASE_STATUS_LABELS, type CaseStatus } from '@domain/enums';
import type { Case } from '@domain/models';
import { CaseCard } from '@features/cases/case-card';
import { useTabBarInset } from '@features/navigation/tab-bar';
import { useSession } from '@services';
import { useCaseList } from '@services/use-case-store';
import {
  Chip,
  EmptyState,
  ErrorState,
  FadeIn,
  Notice,
  Pressable,
  ScreenList,
  SkeletonList,
  SlideUpIn,
  TextField,
  errorDetail,
  useTheme,
} from '@ui';

type StatusFilter = 'ALL' | CaseStatus;

/**
 * The filter strip, in order.
 *
 * Labels come from `CASE_STATUS_LABELS`, not from literals written here. The chip used to
 * read "In Review" while the map — and so the badge on every case card — said "In review",
 * which is the same status spelled two ways on one screen. Reading from the map also means a
 * future status cannot be added to the enum and silently miss its filter label.
 */
const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'OPEN', label: CASE_STATUS_LABELS.OPEN },
  { value: 'IN_REVIEW', label: CASE_STATUS_LABELS.IN_REVIEW },
  { value: 'CLOSED', label: CASE_STATUS_LABELS.CLOSED },
  { value: 'ARCHIVED', label: CASE_STATUS_LABELS.ARCHIVED },
];

/**
 * How many rows take part in the entrance cascade.
 *
 * Roughly one screenful of case cards. Past that the cascade would be timing the arrival of
 * rows nobody can see, which costs frames during the busiest moment of the screen's life and
 * buys nothing — the same reasoning behind `MOTION.staggerCap`.
 */
const CASCADE_ROWS = 6;

export default function CasesScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { user } = useSession();
  const { cases, loading, refreshing, error, reload } = useCaseList(user?.id ?? null);
  const tabBarInset = useTabBarInset();

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  /**
   * Ids that have already played their entrance.
   *
   * Lazily initialised so the set is allocated once and keeps its identity for the life of
   * the screen — see `CaseListRow` for what it is guarding against.
   */
  const [seen] = useState(() => new Set<string>());

  const filteredCases = useMemo(() => {
    return cases.filter((item) => {
      if (item.ownerId !== user?.id || item.deletedAt !== null) return false;
      const matchesStatus = statusFilter === 'ALL' || item.status === statusFilter;
      const q = query.trim().toLowerCase();
      const matchesQuery =
        !q ||
        item.title.toLowerCase().includes(q) ||
        (item.description && item.description.toLowerCase().includes(q)) ||
        (item.category && item.category.toLowerCase().includes(q)) ||
        item.participants.some((person) => `${person.name} ${person.role}`.toLowerCase().includes(q));
      return matchesStatus && matchesQuery;
    });
  }, [cases, statusFilter, query, user?.id]);

  const filtering = query !== '' || statusFilter !== 'ALL';

  /**
   * What the list renders, and the one thing a refresh must not change.
   *
   * Gated on `loading` alone. `loading` is true only before the list has ever arrived for
   * this account, so the skeletons below play once; `refreshing` — which is what a
   * pull-to-refresh raises — is deliberately absent from this expression, because emptying
   * `data` while the user is holding the screen they were reading is how the refresh gesture
   * came to wipe this screen. An `error` is not in it either: a failed background refresh
   * over a list that is already on screen is reported by the notice in the header, and
   * throwing away the last known good list to say so would lose more than it explains.
   */
  const rows = loading ? [] : filteredCases;
  const staleContent = Boolean(error) && rows.length > 0;

  return (
    <ScreenList
      title="Your cases"
      actions={[
        {
          icon: 'folder-plus-outline',
          label: 'Create a case',
          onPress: () => router.push('/new-case'),
        },
      ]}
      data={rows}
      keyExtractor={(item) => item.id}
      onRefresh={reload}
      refreshing={refreshing}
      renderItem={(item, index) => <CaseListRow record={item} index={index} seen={seen} />}
      listHeader={
        <View style={{ marginBottom: theme.spacing.xl }}>
          <TextField
            icon="magnify"
            value={query}
            onChangeText={setQuery}
            placeholder="Search cases, people or notes"
            accessibilityLabel="Search your cases by title, category, description or participant"
          />

          {/* The strip bleeds past the screen padding and pays it back as content inset, so
              the first chip still lines up with the search field above it while the last one
              runs off the edge instead of stopping short of it. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={{
              marginTop: theme.spacing.md,
              marginHorizontal: -theme.layout.screenPadding,
            }}
            contentContainerStyle={{
              gap: theme.spacing.sm,
              paddingHorizontal: theme.layout.screenPadding,
              alignItems: 'center',
            }}
          >
            {STATUS_FILTERS.map((filter) => (
              <FilterChip
                key={filter.value}
                label={filter.label}
                active={statusFilter === filter.value}
                onPress={() => setStatusFilter(filter.value)}
              />
            ))}
          </ScrollView>

          {/* Only when there is content to contradict. With an empty list the full
              `ErrorState` below carries the retry, and both at once would say it twice. */}
          {staleContent ? (
            <Notice
              tone="warn"
              icon="cloud-off-outline"
              title="Showing the last list that loaded"
              message="Your cases could not be refreshed just now. Pull down to try again."
              style={{ marginTop: theme.spacing.lg }}
            />
          ) : null}
        </View>
      }
      empty={
        loading ? (
          <SkeletonList count={3} />
        ) : error ? (
          <ErrorState
            title="Your cases could not be loaded"
            message="Check your connection and try again."
            detail={errorDetail(error)}
            onRetry={reload}
          />
        ) : (
          <FadeIn>
            {/*
              `EmptyState`, not a hand-built card. This was a bordered `Surface` holding a
              48pt glyph, a 28pt title and a second copy of the create button — a nested box
              inside a screen that already has its own edges, restating the action that now
              sits in the bar above it. The primitive centres itself, so the state reads as a
              considered page rather than a card stranded under the filters.
            */}
            <EmptyState
              icon={filtering ? 'filter-remove-outline' : 'folder-open-outline'}
              title={filtering ? 'No cases match' : 'No cases yet'}
              message={
                filtering
                  ? 'Change the search text or the status filter to see other cases.'
                  : 'A case is where one dispute lives: the claim you are making, the documents you have, and what they do and do not agree on.'
              }
              action={
                filtering
                  ? {
                      label: 'Clear filters',
                      onPress: () => {
                        setQuery('');
                        setStatusFilter('ALL');
                      },
                    }
                  : {
                      label: 'Create a case',
                      icon: 'plus',
                      onPress: () => router.push('/new-case'),
                    }
              }
            />
          </FadeIn>
        )
      }
      // `ScreenList` reserves the home indicator but knows nothing about the tab bar, which
      // the tab layout draws over the list. `useTabBarInset` is the whole occluded height —
      // the bar's float, its box and the compose disc's overhang — measured where that
      // geometry is declared. `layout.tabBarHeight` alone was the middle part of three, and
      // reserving only that left the last card partly under the bar.
      listFooter={<View style={{ height: tabBarInset }} />}
    />
  );
}

/**
 * One row of the list, with a first-appearance entrance.
 *
 * ## Why the entrance is gated on a set of ids and not on the row index alone
 *
 * A `FlatList` unmounts rows as they leave the render window and mounts them again on the
 * way back. An entrance tied to mount therefore replays every time the user scrolls up, so
 * content the reader has already seen keeps re-arriving — which reads as a rendering fault,
 * not as polish. The index does not rescue it: row 3 is still row 3 on its second mount.
 *
 * `seen` is owned by the screen and holds the ids that have had their entrance. A row
 * animates only while it is near the top of the list *and* its id is absent from that set,
 * so the cascade plays once, over the first screenful, and never again while the screen
 * lives. It is also what keeps a pull-to-refresh calm: the list re-renders with the same
 * ids, every one of them already in the set, so nothing replays its arrival.
 *
 * The decision is frozen in state on first render rather than recomputed, because a row
 * that changed its mind halfway would unmount its own animation and restart it.
 */
function CaseListRow({
  record,
  index,
  seen,
}: {
  record: Case;
  index: number;
  seen: Set<string>;
}) {
  const theme = useTheme();
  const [animate] = useState(() => index < CASCADE_ROWS && !seen.has(record.id));

  // Recorded after the decision above has been taken, so this row's own entrance is never
  // the thing that cancels it.
  useEffect(() => {
    seen.add(record.id);
  }, [seen, record.id]);

  if (!animate) return <CaseCard record={record} />;

  return (
    <SlideUpIn delay={Math.min(index * theme.motion.stagger, theme.motion.staggerCap)}>
      <CaseCard record={record} />
    </SlideUpIn>
  );
}

/**
 * A status filter.
 *
 * Selected chips take the accent fill and unselected ones an outline: two soft fills would
 * leave the two states reading as the same chip at slightly different brightness, and an
 * outline is also the quieter of the two on a canvas this strip now sits directly on.
 */
function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      haptic
      pressScale={0.96}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Show ${label.toLowerCase()} cases`}
      accessibilityState={{ selected: active }}
    >
      <Chip
        label={label}
        tone={active ? 'accent' : 'neutral'}
        emphasis={active ? 'soft' : 'outline'}
        size="md"
      />
    </Pressable>
  );
}
