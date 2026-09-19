import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { calculateRecoveryLedger } from '@domain/analysis/recovery-ledger';
import { deriveDeadlineSentinel } from '@domain/analysis/deadline-sentinel';
import { CaseAnalysisPanel } from '@features/analysis/case-analysis-panel';
import { useTabBarInset } from '@features/navigation/tab-bar';
import { useSession } from '@services';
import { useCaseList, useWorkspace } from '@services/use-case-store';
import {
  BORDER_WIDTH,
  Button,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  FadeIn,
  HIT_TARGET,
  IconTile,
  LAYOUT,
  Notice,
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

export default function InsightsScreen() {
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const router = useRouter();
  const { user } = useSession();
  const params = useLocalSearchParams<{ caseId?: string | string[] }>();
  const linkedCaseId = routeParam(params.caseId);

  const { cases, loading, refreshing, error, reload } = useCaseList(user?.id ?? null);

  const [picked, setPicked] = useState<string | null>(null);

  const activeCase = useMemo(() => {
    const wanted = picked ?? linkedCaseId;
    return cases.find((item) => item.id === wanted) ?? cases[0] ?? null;
  }, [cases, picked, linkedCaseId]);

  const state = useWorkspace(user?.id ?? null, activeCase?.id ?? null);

  const refresh = useCallback(() => {
    reload();
    state.reload();
  }, [reload, state]);

  const failure = error ?? state.error;

  const loadingSeenFor = useRef<string | null>(null);
  if (activeCase && state.loading) loadingSeenFor.current = activeCase.id;

  const analysis: 'hidden' | 'ready' | 'missing' | 'loading' =
    failure || activeCase === null
      ? 'hidden'
      : state.workspace.cases.some((item) => item.id === activeCase.id)
        ? 'ready'
        : !state.loading && loadingSeenFor.current === activeCase.id
          ? 'missing'
          : 'loading';

  // Compute Financial Portfolio & Deadlines for the active case workspace
  const activeLedger = useMemo(() => {
    if (!activeCase) return null;
    return calculateRecoveryLedger(state.workspace, activeCase.id);
  }, [state.workspace, activeCase]);

  const activeSentinel = useMemo(() => {
    if (!activeCase) return null;
    return deriveDeadlineSentinel(state.workspace, activeCase.id);
  }, [state.workspace, activeCase]);

  return (
    <ScreenScroll
      title="Analysis"
      subtitle="Case overview, financial recovery, and contradiction findings"
      onRefresh={refresh}
      refreshing={refreshing || state.refreshing}
      contentStyle={{
        paddingBottom: tabBarInset,
      }}
    >
      <View style={[styles.column, { gap: theme.spacing.xl }]}>
        {failure ? (
          <FadeIn>
            <ErrorState
              title="Your analysis data could not be loaded"
              message={readableError(
                failure,
                'This case could not be read just now. Check your connection and try again.',
              )}
              detail={errorDetail(failure)}
              onRetry={refresh}
            />
          </FadeIn>
        ) : null}

        {loading && !failure && cases.length === 0 ? <SkeletonCard lines={4} /> : null}

        {!loading && !failure && cases.length === 0 ? (
          <FadeIn>
            <EmptyState
              icon="scale-balance"
              title="No active cases to analyze"
              message="Create a case and add relevant documents. Analysis will automatically detect contradictions and verify claims."
              action={{ label: 'Create a case', onPress: () => router.push('/new-case') }}
            />
          </FadeIn>
        ) : null}

        {/* Global Financial Exposure & Sentinel Overview */}
        {activeLedger && activeCase ? (
          <SlideUpIn>
            <Surface glass glassVariant="hero" elevation="medium" radius="xl" padding="lg">
              <Row between align="center">
                <Row align="center" gap="sm">
                  <IconTile icon="finance" tone="accent" size="sm" />
                  <View>
                    <Text variant="subheading">Financial Recovery Status</Text>
                    <Text variant="caption" colorToken="textTertiary">
                      {activeCase.title}
                    </Text>
                  </View>
                </Row>
                <Chip label={activeLedger.formattedTotalClaimable} tone="accent" size="sm" />
              </Row>

              <Row gap="sm" style={{ marginTop: theme.spacing.md }}>
                <View style={[styles.statBox, { backgroundColor: theme.colors.surfaceSunken }]}>
                  <Text variant="caption" colorToken="textTertiary">
                    Principal Owed
                  </Text>
                  <Text variant="subheading" style={{ marginTop: 2 }}>
                    ${(activeLedger.totalPrincipalMinor / 100).toFixed(2)}
                  </Text>
                </View>

                <View style={[styles.statBox, { backgroundColor: theme.colors.surfaceSunken }]}>
                  <Text variant="caption" colorToken="textTertiary">
                    Accrued Interest
                  </Text>
                  <Text variant="subheading" tone="accent" style={{ marginTop: 2 }}>
                    +${(activeLedger.totalInterestMinor / 100).toFixed(2)}
                  </Text>
                </View>

                <View style={[styles.statBox, { backgroundColor: theme.colors.surfaceSunken }]}>
                  <Text variant="caption" colorToken="textTertiary">
                    Statutory Penalties
                  </Text>
                  <Text variant="subheading" tone="accent" style={{ marginTop: 2 }}>
                    +${(activeLedger.totalPenaltiesMinor / 100).toFixed(2)}
                  </Text>
                </View>
              </Row>

              {activeSentinel?.mostUrgentClock ? (
                <View style={[styles.sentinelAlert, { backgroundColor: theme.colors.surfaceSunken, marginTop: theme.spacing.md }]}>
                  <Row between align="center">
                    <Row align="center" gap="xs">
                      <IconTile
                        icon="clock-alert-outline"
                        tone={activeSentinel.mostUrgentClock.urgency === 'CRITICAL' || activeSentinel.mostUrgentClock.urgency === 'EXPIRED' ? 'danger' : 'warn'}
                        size="sm"
                      />
                      <View style={styles.flex}>
                        <Text variant="bodySmall" numberOfLines={1}>
                          {activeSentinel.mostUrgentClock.title}
                        </Text>
                        <Text variant="caption" colorToken="textTertiary">
                          {activeSentinel.mostUrgentClock.remedyAction}
                        </Text>
                      </View>
                    </Row>
                    <Chip
                      label={activeSentinel.mostUrgentClock.daysRemaining <= 0 ? 'Due Now' : `${activeSentinel.mostUrgentClock.daysRemaining}d left`}
                      tone={activeSentinel.mostUrgentClock.urgency === 'CRITICAL' || activeSentinel.mostUrgentClock.urgency === 'EXPIRED' ? 'danger' : 'warn'}
                      size="sm"
                    />
                  </Row>
                </View>
              ) : null}
            </Surface>
          </SlideUpIn>
        ) : null}

        {/* Case Switcher Chips */}
        {cases.length > 1 ? (
          <SlideUpIn>
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="label" colorToken="textSecondary">
                Select Case
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

        {/* Case Detail Banner & Contradiction Analysis */}
        {activeCase ? (
          <FadeIn key={activeCase.id}>
            <Stagger gap="lg">
              <Surface glass elevation="low" radius="lg" padding="lg">
                <Row between align="center" gap="md">
                  <View style={styles.flex}>
                    <Text variant="title" numberOfLines={1}>
                      {activeCase.title}
                    </Text>
                    {activeCase.category ? (
                      <Text
                        variant="caption"
                        colorToken="textSecondary"
                        style={{ marginTop: 2 }}
                      >
                        {activeCase.category}
                      </Text>
                    ) : null}
                  </View>
                  <Button
                    label="Open Case"
                    icon="arrow-right"
                    variant="secondary"
                    size="sm"
                    onPress={() =>
                      router.push({
                        pathname: '/case/[caseId]',
                        params: { caseId: activeCase.id },
                      })
                    }
                  />
                </Row>
              </Surface>

              {analysis === 'ready' ? (
                <CaseAnalysisPanel key={activeCase.id} workspace={state.workspace} caseId={activeCase.id} />
              ) : analysis === 'missing' ? (
                <ErrorState
                  title="This case could not be opened"
                  message="Case data could not be retrieved from local or remote store."
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
  column: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  switch: {
    borderWidth: BORDER_WIDTH.hairline,
    maxWidth: LAYOUT.maxContentWidth / 3,
    minHeight: HIT_TARGET,
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  statBox: {
    flex: 1,
    padding: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  sentinelAlert: {
    padding: 10,
    borderRadius: 8,
  },
});
