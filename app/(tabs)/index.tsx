import { useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { closingDeadlines } from '@domain/analysis/worklist';
import type { Case } from '@domain/models';
import { CaseCard } from '@features/cases/case-card';
import { summarizeCase } from '@features/cases/home-summary';
import { useTabBarInset } from '@features/navigation/tab-bar';
import { useSession } from '@services';
import { useCaseData, useCaseList, useWorkspace } from '@services/use-case-store';
import {
  Button,
  CASE_STATUS_LABELS,
  CASE_STATUS_TONE,
  Chip,
  Disclosure,
  Divider,
  ErrorState,
  IconButton,
  IconTile,
  LAYOUT,
  Notice,
  SPACING,
  Pressable,
  SEVERITY_TONE,
  Skeleton,
  SkeletonList,
  Row,
  SlideUpIn,
  Stack,
  Stagger,
  Surface,
  Text,
  UserAvatar,
  errorDetail,
  useTheme,
} from '@ui';

const OTHER_CASES_SHOWN = 3;

/**
 * What using this product actually consists of, in order.
 *
 * Three lines on the first-run screen, and the reason they are there rather than a feature
 * list: a person who has just installed this has one question — "what happens after I tap
 * that button" — and a sentence about multi-source consistency analysis does not answer it.
 * Each line is a thing *they* do, in the order they will do it.
 */
const FIRST_RUN_STEPS: readonly string[] = [
  'Say what you are disputing, in your own words.',
  'Add the documents, screenshots, recordings or notes you already have.',
  'Read what they agree on, what they contradict, and what is still missing.',
];

export default function HomeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const router = useRouter();
  const { user } = useSession();
  const {
    cases: allCases,
    loading: casesLoading,
    refreshing: casesRefreshing,
    error: casesError,
    reload: reloadCases,
  } = useCaseList(user?.id ?? null);

  /**
   * This account's live cases, most recently changed first.
   *
   * The sort is what makes the panel below able to call itself the most recent case. It used
   * to take `cases[0]` in whatever order the repository happened to emit and label it "Where
   * you left off", which is a promise the screen had no way to keep — on an account with
   * four cases it was as likely to be the oldest as the newest.
   */
  const cases = useMemo(
    () =>
      allCases
        .filter((record) => record.ownerId === user?.id && record.deletedAt === null)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [allCases, user?.id],
  );

  const activeCase = cases[0] ?? null;
  const { workspace, loading: workspaceLoading, error: workspaceError, reload: reloadWorkspace } = useWorkspace(
    user?.id ?? null,
    activeCase?.id ?? null,
  );
  const caseData = useCaseData(workspace, activeCase?.id ?? null);

  const onRefresh = useCallback(() => {
    reloadCases();
    reloadWorkspace();
  }, [reloadCases, reloadWorkspace]);

  const summary = activeCase ? summarizeCase(activeCase, workspace) : null;

  /**
   * Whether this case's workspace has actually arrived.
   *
   * Not `!workspaceLoading`. `useWorkspace` starts its load from an effect, so the first
   * render after `activeCase` changes still carries the *previous* case's `loading: false`
   * beside a workspace that does not contain the new case — and the summary sentence built
   * from that is a statement about the wrong case, which is the one mistake this product
   * cannot make. Nor is it `!refreshing`: a pull-to-refresh must not replace the one thing
   * this screen exists to say with a placeholder.
   *
   * So it asks the workspace rather than a flag. The hook reports an empty workspace until
   * the case is found in it, and does not clear what it has already emitted when a reload
   * starts — false exactly once, before the first emission, when the skeleton below is
   * honest, and true from then on.
   */
  const workspaceArrived = Boolean(
    activeCase && workspace.cases.some((record) => record.id === activeCase.id),
  );

  /**
   * The active case's filing window, when it is closing or has closed.
   *
   * This is the only thing on the home screen that gets worse while the user does nothing, so
   * it is the one thing worth saying before they have tapped anything. The bell carries the
   * same rows for every case; this says it about the case they are already looking at.
   *
   * Memoised because `closingDeadlines` re-derives a filing draft — every extraction in the
   * case with its confirmed corrections applied — and this screen re-renders on scroll.
   * `Date.now()` is read inside the memo rather than passed in: recomputing on a re-render
   * cannot change the answer within a day, and a pull-to-refresh replaces the workspace, which
   * is what invalidates it. Only the active case's shard is loaded here, so this yields at
   * most one row and never claims anything about the user's other cases.
   */
  const deadline = React.useMemo(
    () => (activeCase ? (closingDeadlines(workspace, Date.now())[0] ?? null) : null),
    [activeCase, workspace],
  );

  const otherCases = cases.slice(1, 1 + OTHER_CASES_SHOWN);

  const firstName = user?.displayName?.trim().split(/\s+/)[0];

  /**
   * The line under the greeting.
   *
   * Null on a new account on purpose: the composed first-run block below is already saying
   * what to do, and a subtitle above it reading "Your case workspace" — the domain
   * aggregate's name, which is nobody's word for anything — said less than nothing. The count
   * appears here and nowhere else on the screen; the route to the full list is a button
   * labelled with what it does rather than with the same number again.
   */
  const countLine = casesLoading
    ? 'Loading your cases…'
    : cases.length === 0
      ? null
      : cases.length === 1
        ? 'One saved case'
        : `${cases.length} saved cases`;

  /** A failed refresh over a list that is still on screen. Reported, never destructive. */
  const staleList = Boolean(casesError) && cases.length > 0;

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.canvas }]}>
      <ScrollView
        /*
          These values are `ScreenScroll`'s, not this screen's own. See the note above the
          header row for why this screen cannot use that component directly — but the
          geometry must still agree with it, or Home starts its content at a different
          height from every other screen in the app.

            - `paddingHorizontal`  exactly `ScreenScroll`'s.
            - `paddingTop`         `ScreenScroll` pads by `insets.top + headerHeight`
                                   because its header bar is pinned *over* the content.
                                   This screen's header scrolls with the content, so the
                                   inset is paid here and the `headerHeight` half is paid
                                   by the header row's own `minHeight` below. The screen's
                                   content region therefore opens at the same offset as a
                                   `ScreenScroll` screen's masthead does.
            - `paddingBottom`      `useTabBarInset()`, and nothing added to it. The tab bar
                                   floats over the scroll view, and the height it occludes is
                                   three parts — the wrapper's float below the box, the box
                                   itself, and the compose disc lifted above its top edge —
                                   only the middle of which is a token a screen can see. This
                                   screen used to add `insets.bottom + tabBarHeight + giant`
                                   from the one term it had, which over-reserved by about
                                   40pt and left a band of dead canvas taller than a card.
                                   The hook already carries the safe-area part and the
                                   breathing room, so adding either again is the same bug.
            - `flexGrow`           so a short body can be given the leftover height instead
                                   of stranding it below the fold. Only the first-run block
                                   claims it; see `styles.centred`.
        */
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: theme.layout.screenPadding,
          paddingTop: insets.top,
          paddingBottom: tabBarInset,
        }}
        refreshControl={
          <RefreshControl
            /*
              `refreshing`, never `loading`. The two flags mean different things and this
              screen had them crossed: `loading` is true only before the list has ever
              arrived — when the skeletons below are already saying so — and false during
              the reload a pull actually starts, so the gesture spun for a frame and let
              go while the request was still in flight. `refreshing` is the flag the store
              raises for exactly the span of that reload.

              `workspaceLoading` is deliberately not in here either. It is the other half
              of the same bug: it would put the spinner back on screen whenever the active
              case's workspace re-subscribed, including on navigating back to this tab.
            */
            refreshing={casesRefreshing}
            onRefresh={onRefresh}
            // The same three props `ScreenScroll`'s `useRefreshControl` passes, so the
            // spinner is the app's spinner here too rather than the platform default.
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
            progressBackgroundColor={theme.colors.surface}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {/*
          Why this is a hand-built row and not `ScreenScroll`.

          `ScreenScroll` owns the app's header treatment — the large title that fades into a
          compact pinned one — and everything in this screen's masthead now maps onto it
          cleanly: the greeting is `title`, the case count is `subtitle`, and the search and
          bell are `actions`. The avatar is what does not. `ScreenAction` is
          `{ icon: IconName }`, which renders an `IconButton`, so a photo cannot go in it;
          and the two slots that take arbitrary nodes are both wrong for a navigation
          control. `meta` sits in the masthead, which *fades out on scroll* — the route to
          Profile would become invisible while staying tappable, which is worse than not
          having it. `headerAccessory` sits inside the pinned bar below the title row, which
          adds height the content padding does not know about, so the bar would overlap the
          content beneath it.

          The row is therefore kept, and pinned to `ScreenScroll`'s geometry instead: it
          occupies exactly the `headerHeight` band a pinned bar would, and the scroll
          padding above pays the safe-area inset the bar would have paid. See the report
          note — a leading slot on `ScreenHeaderBar` is what would close this gap.

          What the row no longer holds is the greeting. It sat in here at `title` (28pt)
          because that is the largest thing that fits beside two icon buttons, which left
          Home as the one screen in the app whose name was a rank smaller than every other
          screen's. The greeting moved below into a real masthead at `display`, and the row
          went back to being what it is: three navigation controls.
        */}
        <Row
          between
          align="center"
          style={{ minHeight: theme.layout.headerHeight }}
        >
          <Pressable
            onPress={() => router.push('/(tabs)/profile')}
            accessibilityLabel="Open your profile and settings"
          >
            {/* No explicit size: the component's own default is the 44pt hit target. */}
            <UserAvatar photoURL={user?.photoURL} displayName={user?.displayName} />
          </Pressable>

          <Row align="center">
            <IconButton
              icon="magnify"
              accessibilityLabel="Search cases, claims and evidence"
              onPress={() => router.push('/search')}
            />
            <IconButton
              icon="bell-outline"
              accessibilityLabel="What needs doing, and recent case activity"
              onPress={() => router.push('/notifications')}
            />
          </Row>
        </Row>

        {/*
          The masthead, matching `Masthead` in `Screen.tsx` rank for rank and gap for gap —
          `display` title, `body` secondary subtitle at `spacing.sm`, `spacing.xl` above and
          `spacing.xxxl` below. The fallback greeting is not the wordmark: a person who has
          not set a display name was being greeted by the app's own brand name, which reads
          as a placeholder that shipped.
        */}
        <View style={styles.masthead}>
          <Text variant="display" numberOfLines={1} accessibilityRole="header">
            {firstName ? `Hello, ${firstName}` : 'Hello'}
          </Text>
          {countLine ? (
            <Text
              variant="body"
              colorToken="textSecondary"
              numberOfLines={1}
              style={{ marginTop: theme.spacing.sm }}
            >
              {countLine}
            </Text>
          ) : null}
        </View>

        {casesError && cases.length === 0 ? (
          <ErrorState
            title="Your cases could not be loaded"
            message="Check your connection and try again."
            detail={errorDetail(casesError)}
            onRetry={reloadCases}
          />
        ) : casesLoading ? (
          <SkeletonList count={3} />
        ) : activeCase ? (
          <Stagger gap="xl">
            {staleList ? (
              <Notice
                key="stale"
                tone="warn"
                icon="cloud-off-outline"
                title="Showing the last cases that loaded"
                message="Your cases could not be refreshed just now. Pull down to try again."
              />
            ) : null}

            {/*
              The hero, and the only glass panel on this screen. `glassVariant="hero"` is
              the stronger sheen and the fully-lit top edge; `elevation="medium"` lifts it
              off the canvas far enough that the `CaseCard`s below — which stay flat, and
              are not ours to change — read as the second tier rather than as peers.
            */}
            <Surface key="resume" glass glassVariant="hero" elevation="medium" padding="lg" radius="lg">
              <Row between align="center" gap="md" style={{ marginBottom: theme.spacing.sm }}>
                {/* Says what the panel is, and can now say it truthfully — the list above
                    is sorted by when each case last changed. Sentence case at `label` rank:
                    a section header is a header, and the uppercase tracked overline this was
                    is chrome that appeared over every section on every screen. */}
                <Text variant="label" colorToken="textSecondary" style={styles.flex}>
                  Most recent case
                </Text>
                {/*
                  The tone comes from `CASE_STATUS_TONE`, not from a conditional written
                  here. This read `tone={status === 'OPEN' ? 'ok' : 'neutral'}`, and `ok` is
                  the app's one settled tone: it painted an open, unresolved dispute the
                  same green as a finished one.
                */}
                <Chip
                  label={CASE_STATUS_LABELS[activeCase.status]}
                  tone={CASE_STATUS_TONE[activeCase.status]}
                  size="sm"
                />
              </Row>

              {/*
                The case's name, at `subheading`. It is a label for the thing the sentence
                below describes, so it is deliberately outranked by it — see the note there.
              */}
              <Text variant="subheading" numberOfLines={2}>
                {activeCase.title}
              </Text>

              {/*
                The one sentence this screen exists to say. `heading` weight, because it
                outranks everything around it — including the case title, which is only a
                name for the thing this sentence describes.

                Ordered so that what is already on screen stays on screen: once the
                workspace has arrived the summary is rendered and a later error or a reload
                cannot take it away. The skeleton is the pre-first-emission state only, and
                is shaped like the two lines it stands in for rather than being a sentence
                about loading.
              */}
              {workspaceArrived && summary ? (
                <View style={{ marginTop: theme.spacing.md }}>
                  <Text variant="heading" colorToken="text">
                    {summary.message}
                  </Text>
                  {summary.detail ? (
                    <Text
                      variant="bodySmall"
                      colorToken="textSecondary"
                      style={{ marginTop: theme.spacing.sm }}
                    >
                      {summary.detail}
                    </Text>
                  ) : null}
                </View>
              ) : workspaceError ? (
                <ErrorState
                  compact
                  title="This case could not be opened"
                  message="Refresh before relying on anything it says."
                  detail={errorDetail(workspaceError)}
                  onRetry={reloadWorkspace}
                />
              ) : (
                <Stack gap="sm" style={{ marginTop: theme.spacing.md }}>
                  <Skeleton width="88%" />
                  <Skeleton width="62%" />
                </Stack>
              )}

              {/*
                The deadline line, and the only thing in this panel that is a route rather than
                a statement. It sits below the summary sentence and above the buttons because it
                is a consequence of that sentence — "nobody has replied in 340 days" and "you
                have 55 days left to take it further" are one thought — and because a person who
                reads only the sentence and stops has still been told the part that expires.

                Deliberately one line and no explanation. The full account, the citation and the
                caveat about schemes being amended all live on the screen this opens, and
                repeating them here would put a paragraph of statute in the middle of a home
                screen.
              */}
              {deadline ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${deadline.title}. Opens the escalation letter.`}
                  onPress={() =>
                    router.push({
                      pathname: '/case/[caseId]/letter',
                      params: { caseId: deadline.caseId },
                    })
                  }
                  style={{ marginTop: theme.spacing.lg }}
                >
                  <Row gap="sm" align="center">
                    <IconTile
                      icon="calendar-clock"
                      tone={SEVERITY_TONE[deadline.severity]}
                      size="sm"
                    />
                    <Text variant="bodySmall" numberOfLines={2} style={styles.flex}>
                      {deadline.title}
                    </Text>
                    {/* The app's one chevron, so this row cannot drift a point away from
                        every other tappable row. */}
                    <Disclosure />
                  </Row>
                </Pressable>
              ) : null}

              <Divider spacing="lg" />

              <Row gap="sm" wrap>
                <View style={styles.flex}>
                  <Button
                    label="Add evidence"
                    icon="plus"
                    variant={caseData.evidence.length === 0 ? 'primary' : 'secondary'}
                    onPress={() =>
                      router.push({
                        pathname: '/case/[caseId]/upload',
                        params: { caseId: activeCase.id },
                      })
                    }
                  />
                </View>
                <View style={styles.flex}>
                  <Button
                    label="Open case"
                    icon="arrow-right"
                    variant={caseData.evidence.length === 0 ? 'secondary' : 'primary'}
                    onPress={() =>
                      router.push({ pathname: '/case/[caseId]', params: { caseId: activeCase.id } })
                    }
                  />
                </View>
              </Row>
            </Surface>

            {/*
              Keys are explicit because `Stagger` reads its children positionally: when this
              block is absent on a single-case account, an index-derived key would hand the
              footer button this one's identity and replay its entrance.

              The header here stays a `Row` + ghost `Button` rather than becoming a
              `SectionHeader`. `SectionHeader`'s `action` renders as bare pressable `label`
              text — an 18pt-tall target — where the `sm` Button is 36pt. Losing half the
              tap target of the route to the full case list is not worth the consistency.
            */}
            {otherCases.length > 0 ? (
              <View key="others">
                <Row between align="center" style={{ marginBottom: theme.spacing.md }}>
                  <Text variant="label" colorToken="textSecondary">
                    Your other cases
                  </Text>
                  {/* Not `All ${cases.length}`: the count is stated in the masthead, and a
                      button that repeats it is the same fact twice on one screen. */}
                  <Button
                    label="All cases"
                    variant="ghost"
                    size="sm"
                    onPress={() => router.push('/(tabs)/cases')}
                  />
                </Row>
                {otherCases.map((record: Case) => (
                  <CaseCard key={record.id} record={record} />
                ))}
              </View>
            ) : null}

            {/*
              One name for this action, everywhere in the app: "Create a case". This button
              said "Start another case" while the same action was called "Create your first
              case" on the empty state below it, "Create a case" on the case list, "Start a
              case" in the tab sheet and "Start a case" again on the form it opens. Five
              names for one destination is an interface a person has to learn five times.
            */}
            <Button
              key="new-case"
              label="Create a case"
              icon="plus"
              variant="ghost"
              onPress={() => router.push('/new-case')}
            />
          </Stagger>
        ) : (
          /*
            The first-run screen.

            It was one glass card holding an icon, two lines and a button, sitting at the top
            of an otherwise empty viewport with about 400pt of nothing under it — the first
            thing anyone sees of this product, and it read as a screen whose content had
            failed to load. It is now composed for the space it has: `styles.centred` claims
            the leftover height from the scroll container and centres the block in it, so the
            balance holds on a 640pt phone and on a tablet without either one being measured.

            The card is gone with it. A panel exists to separate its contents from
            everything around them, and here there is nothing around them — an edge drawn
            round the only thing on the screen is the bordered-box texture this release is
            removing, not hierarchy.
          */
          <View style={styles.centred}>
            <SlideUpIn>
              <Stack align="center" gap="none" style={styles.firstRun}>
                {/* `IconTile`, so the glyph is the app's tile at the app's `lg` size
                    rather than a bare 36pt icon sized by hand. */}
                <IconTile icon="scale-balance" tone="accent" size="lg" />

                <Text variant="title" center style={{ marginTop: theme.spacing.lg }}>
                  Start with the claim you want to check
                </Text>

                <Text
                  variant="body"
                  colorToken="textSecondary"
                  center
                  style={{ marginTop: theme.spacing.sm }}
                >
                  A case holds one dispute — a charge you did not authorise, an invoice
                  someone says you never paid — and everything you have that bears on it.
                </Text>

                <Stack gap="md" style={styles.steps}>
                  {FIRST_RUN_STEPS.map((step, index) => (
                    <Row key={step} gap="md" align="flex-start">
                      {/*
                        Sans, not mono. The numbering is the app's own, and monospace in
                        this product means a value was lifted off a document.
                      */}
                      <Text variant="label" tone="accent" style={styles.stepNumber}>
                        {index + 1}
                      </Text>
                      <Text variant="bodySmall" colorToken="textSecondary" style={styles.flex}>
                        {step}
                      </Text>
                    </Row>
                  ))}
                </Stack>

                <Button
                  label="Create a case"
                  icon="plus"
                  variant="primary"
                  size="lg"
                  style={{ marginTop: theme.spacing.xxl }}
                  onPress={() => router.push('/new-case')}
                />
              </Stack>
            </SlideUpIn>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  /** `Masthead`'s own vertical rhythm, since this screen builds its header by hand. */
  masthead: { paddingTop: SPACING.xl, paddingBottom: SPACING.xxxl },
  /*
    `flexGrow`, not `flex`. It takes the height the content container has left over — which
    is how the block below ends up optically centred without anything measuring the viewport
    — while `flexBasis: auto` keeps the block's own height as the floor, so at a large
    accessibility text size it grows and scrolls instead of shrinking and clipping.
  */
  centred: { flexGrow: 1, justifyContent: 'center' },
  /*
    Half the app's reading measure. A centred paragraph set to the full content width is
    uncomfortable to read at any screen size, and the 340 that was here before was a number
    somebody liked rather than one derived from anything.
  */
  firstRun: { maxWidth: LAYOUT.maxContentWidth / 2, alignSelf: 'center' },
  steps: { alignSelf: 'stretch', marginTop: SPACING.xxl },
  /* The digits are right-aligned against a fixed column so the three lines of text start
     at the same x, and the column is a spacing token rather than a width somebody eyeballed. */
  stepNumber: { minWidth: SPACING.lg, textAlign: 'right' },
});
