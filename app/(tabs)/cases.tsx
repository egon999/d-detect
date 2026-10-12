import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { listCases, readableError, type CaseSummary } from '@api';
import { useTranslation } from '@i18n';
import {
  Chip,
  EmptyState,
  ErrorState,
  formatRelativeTime,
  GlassSurface,
  Icon,
  IconTile,
  Pressable,
  ProgressChip,
  Row,
  ScreenList,
  SegmentedControl,
  SkeletonList,
  SlideUpIn,
  SpotlightCard,
  Text,
  useTheme,
  type IconName,
  type ScreenAction,
} from '@ui';

import { caseProgress, type CaseProgressState } from '../case/_logic';

const POLL_MS = 2500;

const STATE_ICON: Record<CaseProgressState, IconName> = {
  reading: 'text-search',
  nothing_added: 'folder-open-outline',
  nothing_of_yours: 'account-outline',
  ready_to_compare: 'scale-balance',
  out_of_date: 'alert-outline',
  compared: 'scale-balance',
};

function CaseRow({ item, onPress }: { item: CaseSummary; onPress: () => void }) {
  const theme = useTheme();
  const progress = caseProgress(item);
  const resolved = item.status === 'resolved';
  const subtitle =
    (item.question ?? '').trim() ||
    (item.myClaim ?? '').trim() ||
    (item.theirClaim ?? '').trim();
  const title = (item.title ?? '').trim() || 'Untitled Case';
  const mineCount = item.counts?.mine ?? 0;
  const theirsCount = item.counts?.theirs ?? 0;

  return (
    <Pressable
      onPress={onPress}
      dimOnPress
      pressScale={0.98}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${progress.label}.`}
    >
      <SpotlightCard
        glowColor="rgba(43, 95, 217, 0.35)"
        borderRadius={18}
        style={{ padding: theme.spacing.lg }}
      >
        <Row gap="md" align="flex-start">
          <IconTile
            icon={resolved ? 'check-decagram-outline' : STATE_ICON[progress.state]}
            tone={resolved ? 'ok' : progress.tone}
            size="md"
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Row gap="sm" align="center">
              <Text variant="bodyMedium" numberOfLines={1} style={{ flex: 1 }}>
                {title}
              </Text>
              {resolved ? <Chip label="Settled" tone="ok" /> : null}
            </Row>

            {subtitle ? (
              <Text variant="caption" colorToken="textSecondary" numberOfLines={2} style={{ marginTop: 2 }}>
                {subtitle}
              </Text>
            ) : null}

            <Row gap="sm" align="center" wrap style={{ marginTop: theme.spacing.sm }}>
              <Row gap="xs" align="center">
                <Icon name="account-outline" size={13} color={theme.colors.textTertiary} />
                <Text variant="caption" colorToken="textTertiary">
                  {mineCount > 0 ? `${mineCount} from you` : 'Nothing from you yet'}
                </Text>
              </Row>
              <Row gap="xs" align="center">
                <Icon name="account-multiple-outline" size={13} color={theme.colors.textTertiary} />
                <Text variant="caption" colorToken="textTertiary">
                  {theirsCount > 0 ? `${theirsCount} from them` : 'Nothing from them yet'}
                </Text>
              </Row>
              {progress.busy ? (
                <ProgressChip label={progress.label} tone={progress.tone} />
              ) : (
                <Chip label={progress.label} tone={progress.tone} />
              )}
            </Row>

            <Text variant="caption" colorToken="textTertiary" style={{ marginTop: theme.spacing.xs }}>
              Last change {item.updatedAt ? formatRelativeTime(item.updatedAt, Date.now()) : 'recently'}
            </Text>
          </View>
          <Icon name="chevron-right" size={18} color={theme.colors.textTertiary} />
        </Row>
      </SpotlightCard>
    </Pressable>
  );
}

export default function CasesScreen() {
  const theme = useTheme();
  const { t } = useTranslation();

  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);

  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await listCases();
      setCases(next);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const anyReading = cases?.some((item) => (item.counts?.pending ?? 0) > 0) ?? false;
  useEffect(() => {
    if (!anyReading) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyReading, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const retry = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);

  type CaseFilter = 'all' | 'active' | 'settled';
  const [filter, setFilter] = useState<CaseFilter>('all');

  const startCase = useCallback(() => router.push('/case/new'), []);

  const activeCount = useMemo(() => (cases ?? []).filter((c) => c.status !== 'resolved').length, [cases]);
  const settledCount = useMemo(() => (cases ?? []).filter((c) => c.status === 'resolved').length, [cases]);

  const data = useMemo(() => {
    const sorted = [...(cases ?? [])].sort((left, right) => right.updatedAt - left.updatedAt);
    if (filter === 'active') return sorted.filter((c) => c.status !== 'resolved');
    if (filter === 'settled') return sorted.filter((c) => c.status === 'resolved');
    return sorted;
  }, [cases, filter]);

  const hasError = !!error && !cases;

  const empty = hasError ? (
    <ErrorState message={readableError(error, 'Your cases could not be loaded just now.')} onRetry={retry} />
  ) : loading && !cases ? (
    <SkeletonList count={3} />
  ) : filter !== 'all' && (cases?.length ?? 0) > 0 ? (
    <EmptyState
      icon="scale-balance"
      title={filter === 'settled' ? 'No settled cases' : 'No active disputes'}
      message={
        filter === 'settled'
          ? 'Cases that have been resolved or settled will appear here.'
          : 'All of your saved cases are currently marked as settled.'
      }
      action={{ label: 'Show all cases', onPress: () => setFilter('all') }}
    />
  ) : (
    <EmptyState
      icon="scale-balance"
      title="Nothing in dispute yet"
      message="A case is for when someone remembers the same thing differently to you: you put in what you have, they get their own side, and the two are set against each other."
      action={{ label: 'Start one', onPress: startCase, icon: 'plus' }}
    />
  );

  const actions: ScreenAction[] = [
    { icon: 'checkbox-marked-circle-outline', label: 'Tasks', onPress: () => router.push('/(tabs)/tasks') },
    { icon: 'plus', label: 'Start a case', onPress: startCase },
  ];

  const listHeader =
    cases && cases.length > 0 ? (
      <View style={{ marginBottom: theme.spacing.lg }}>
        <SegmentedControl<CaseFilter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `${t('cases.allCases') || 'All'} (${cases.length})` },
            { value: 'active', label: `${t('cases.activeCases') || 'In dispute'} (${activeCount})` },
            { value: 'settled', label: `${t('cases.settledCases') || 'Settled'} (${settledCount})` },
          ]}
        />
      </View>
    ) : null;

  return (
    <ScreenList<CaseSummary>
      title={t('cases.title') || 'Cases'}
      subtitle={t('cases.subtitle') || 'Two sides, and what your own material supports'}
      actions={actions}
      listHeader={listHeader}
      data={data}
      keyExtractor={(item) => item.id}
      renderItem={(item, index) => (
        <SlideUpIn delay={Math.min(index * 45, 300)} style={{ marginBottom: theme.spacing.md }}>
          <CaseRow item={item} onPress={() => router.push(`/case/${item.id}`)} />
        </SlideUpIn>
      )}
      empty={empty}
      onRefresh={onRefresh}
      refreshing={refreshing}
    />
  );
}
