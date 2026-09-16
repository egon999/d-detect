import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSession } from '@services';
import { useCaseList, useWorkspace } from '@services/use-case-store';
import { CaseAnalysisPanel } from '@features/analysis/case-analysis-panel';
import { useTabBarInset } from '@features/navigation/tab-bar';
import {
  BORDER_WIDTH,
  Chip,
  EmptyState,
  ErrorState,
  FadeIn,
  HIT_TARGET,
  LAYOUT,
  Pressable,
  routeParam,
  Row,
  ScreenScroll,
  SkeletonCard,
  SlideUpIn,
  Stagger,
  Surface,
  Text,
  errorDetail,
  readableError,
  useTheme,
} from '@ui';

/**
 * The Analysis tab.
 *
 * ## Why this screen exists separately from the case screen
 *
 * A case screen answers "what is in this case". This one answers what the documents in it
 * actually support, across whichever case the user is currently thinking about. They are
 * different questions, and the second is the one the product exists to answer — so it gets
 * a tab rather than living three taps deep inside a case.
 *
 * ## Which case is shown
 *
 * Three inputs, in priority order: an explicit tap on the case switcher, a `caseId` passed
 * in by whoever navigated here, then the most recent case. The fallback matters — arriving
 * at a tab that asks you to pick something before it shows you anything is a worse first
 * impression than arriving at a reasonable default you can change.
 *
 * ## What it deliberately does not do
 *
 * It does not run an analysis on mount. Analysis reads every source in the case, and doing
 * that because someone tapped a tab spends their time and battery on a question they may
 * not have asked. `CaseAnalysisPanel` owns that decision and requires an explicit action.
 */
export default function InsightsScreen() {
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const router = useRouter();
  const { user } = useSession();
  const params = useLocalSearchParams<{ caseId?: string | string[] }>();
  const linkedCaseId = routeParam(params.caseId);

  const { cases, loading, refreshing, error, reload } = useCaseList(user?.id ?? null);

  // `null` means "nothing chosen yet", which is distinct from "chose the first case" —
  // only the former should defer to the `caseId` parameter.
  const [picked, setPicked] = useState<string | null>(null);

  const activeCase = useMemo(() => {
    const wanted = picked ?? linkedCaseId;
    // A stale id — a case opened from a link and since deleted — falls back rather than
    // leaving the screen blank with no explanation.
    return cases.find((item) => item.id === wanted) ?? cases[0] ?? null;
  }, [cases, picked, linkedCaseId]);

  const state = useWorkspace(user?.id ?? null, activeCase?.id ?? null);

  const refresh = useCallback(() => {
    reload();
    state.reload();
  }, [reload, state]);

  const failure = error ?? state.error;

  /**
   * The case the workspace subscription was last seen loading.
   *
   * `useWorkspace` only begins loading from an effect, so the first render after the
   * selection changes still carries the previous case's `loading: false` next to an already
   * empty workspace. That frame is indistinguishable from "this case has nothing in it", and
   * without this ref, switching between two perfectly good cases would flash an error
   * between them. Written during render because it has to be right on the render it is read
   * on, and a ref rather than state because correcting it must not schedule another pass.
   */
  const loadingSeenFor = useRef<string | null>(null);
  if (activeCase && state.loading) loadingSeenFor.current = activeCase.id;

  /**
   * What belongs where the analysis panel goes.
   *
   * One value decides this, because the three outcomes are genuinely exclusive and the
   * booleans this replaced were not. The workspace loads independently of the case list, so
   * there is a window where the case is known but its evidence is not — rendering the panel
   * then would flash an "insufficient evidence" reading of a case that had simply not
   * finished loading, which is why the skeleton exists at all. But a case the list offers and
   * the workspace never produces is a different thing, and a single `workspaceReady` boolean
   * could not tell the two apart: it stayed false either way, so a case deleted on another
   * device showed a skeleton that never resolved and never said why. `failure` comes first so
   * the error above is the only thing on screen — an error with a skeleton still spinning
   * underneath it reads as though something is still coming.
   */
  const analysis: 'hidden' | 'ready' | 'missing' | 'loading' =
    failure || activeCase === null
      ? 'hidden'
      : state.workspace.cases.some((item) => item.id === activeCase.id)
        ? 'ready'
        : !state.loading && loadingSeenFor.current === activeCase.id
          ? 'missing'
          : 'loading';

  return (
    <ScreenScroll
      title="Analysis"
      subtitle="What your documents agree on, and where they do not"
      onRefresh={refresh}
      /*
        `refreshing`, not `loading`. Both hooks now raise a flag for the span of a reload and
        leave `loading` for the first load only, so driving the spinner from `loading` meant
        the pull gesture let go while its own request was still in flight.
      */
      refreshing={refreshing || state.refreshing}
      // The tab bar floats over the scroll view, and `contentStyle` replaces the container's
      // own bottom padding rather than adding to it. `useTabBarInset` is the whole occluded
      // height — the bar's float, its box and the compose disc's overhang — plus its own
      // breathing room, so the safe area and a spacing token are not added again here.
      contentStyle={{
        paddingBottom: tabBarInset,
      }}
    >
      <View style={[styles.column, { gap: theme.spacing.xl }]}>
        {failure ? (
          <FadeIn>
            {/* `readableError`, not `failure.message`. That put the storage layer's own
                wording on screen — "Missing or insufficient permissions." and worse — where
                a sentence about this screen belongs. The original stays one tap away. */}
            <ErrorState
              title="Your analysis could not be loaded"
              message={readableError(
                failure,
                'This case could not be read just now. Check your connection and try again.',
              )}
              detail={errorDetail(failure)}
              onRetry={refresh}
            />
          </FadeIn>
        ) : null}

        {/* `!failure` matters as much as the rest: the error above is a dead end until the
            retry succeeds, and a placeholder below it promises content that is not coming. */}
        {loading && !failure && cases.length === 0 ? <SkeletonCard lines={4} /> : null}

        {!loading && !failure && cases.length === 0 ? (
          <FadeIn>
            <EmptyState
              icon="scale-balance"
              title="Nothing to analyse yet"
              message="Create a case, write the claim you want to check, and add the documents that bear on it. Analysis compares them and shows what each conclusion rests on."
              action={{ label: 'Create a case', onPress: () => router.push('/new-case') }}
            />
          </FadeIn>
        ) : null}

        {cases.length > 1 ? (
          <SlideUpIn>
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="caption" colorToken="textTertiary">
                Case
              </Text>
              <Row gap="sm" wrap>
                {cases.map((item) => {
                  const selected = activeCase?.id === item.id;
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => setPicked(item.id)}
                      haptic
                      pressScale={0.97}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Analyse ${item.title}`}
                      style={[
                        styles.switch,
                        {
                          paddingVertical: theme.spacing.sm,
                          paddingHorizontal: theme.spacing.lg,
                          borderRadius: theme.radius.pill,
                          borderColor: selected ? theme.colors.accent : theme.colors.border,
                          backgroundColor: selected
                            ? theme.colors.accentSurface
                            : theme.colors.surface,
                        },
                      ]}
                    >
                      <Text
                        variant="bodySmall"
                        colorToken={selected ? 'text' : 'textSecondary'}
                        numberOfLines={1}
                      >
                        {item.title}
                      </Text>
                    </Pressable>
                  );
                })}
              </Row>
            </View>
          </SlideUpIn>
        ) : null}

        {activeCase ? (
          <FadeIn key={activeCase.id}>
            <Stagger gap="lg">
              <Surface glass glassVariant="hero" elevation="medium" radius="xl" padding="xl">
                <Row between align="flex-start" gap="md">
                  <View style={styles.flex}>
                    <Text variant="title" numberOfLines={2}>
                      {activeCase.title}
                    </Text>
                    {activeCase.category ? (
                      <Text
                        variant="caption"
                        colorToken="textSecondary"
                        style={{ marginTop: theme.spacing.xs }}
                      >
                        {activeCase.category}
                      </Text>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() =>
                      router.push({
                        pathname: '/case/[caseId]',
                        params: { caseId: activeCase.id },
                      })
                    }
                    dimOnPress
                    pressScale={0}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${activeCase.title}`}
                    // `minHeight`, not a grown `hitSlop`. The control measured about 36pt and
                    // padded the difference with invisible slop, so the thing the user aims
                    // at and the thing that responds were two different rectangles. The
                    // visible target is now the touchable one.
                    style={styles.inlineAction}
                  >
                    {/* `textAccent`, not `accent`. `colors.accent` is the gold that paints
                        structure — icon tints, focus rings, selection borders — and it is
                        not verified as a text colour on this fill. */}
                    <Text variant="label" colorToken="textAccent">
                      Open case
                    </Text>
                  </Pressable>
                </Row>

                {activeCase.lastAnalyzedAt === null ? (
                  <Chip
                    label="Not analysed yet"
                    tone="neutral"
                    size="sm"
                    style={{ marginTop: theme.spacing.md, alignSelf: 'flex-start' }}
                  />
                ) : null}
              </Surface>

              {analysis === 'ready' ? (
                <CaseAnalysisPanel key={activeCase.id} workspace={state.workspace} caseId={activeCase.id} />
              ) : analysis === 'missing' ? (
                <ErrorState
                  title="This case would not open"
                  message="It is still in your list, but none of its contents came back. It may have been deleted on another device, or the last update may not have finished."
                  onRetry={refresh}
                  compact
                />
              ) : analysis === 'loading' ? (
                <SkeletonCard lines={5} />
              ) : null}
            </Stagger>
          </FadeIn>
        ) : null}
      </View>
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  // `LAYOUT.maxContentWidth`, not a literal 960. Every other screen in the app caps its
  // column at the token, so this one was 240pt wider than the rest on a tablet.
  column: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  // A pill of text is about 37pt tall on its own, which is under the minimum touch target.
  switch: {
    borderWidth: BORDER_WIDTH.hairline,
    maxWidth: LAYOUT.maxContentWidth / 3,
    minHeight: HIT_TARGET,
    justifyContent: 'center',
  },
  inlineAction: { minHeight: HIT_TARGET, justifyContent: 'center' },
  flex: { flex: 1 },
});
