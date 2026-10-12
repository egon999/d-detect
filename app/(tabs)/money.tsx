import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import {
  alertLook,
  alertsHeading,
  budgetAmountText,
  clearBudget,
  currencyDecimals,
  drillDownLoadProblem,
  excludedReasonSheet,
  fallbackPeriodKey,
  getAdvice,
  getInsights,
  hiddenEntryCount,
  monthKeyOf,
  monthLabelOf,
  orderedCategories,
  periodChoices,
  readBudgetAmount,
  readableError,
  setBudget,
  showableAlerts,
  spendingGuidance,
  getRecord,
  retryRecord,
  type AdviceResponse,
  type BudgetAmount,
  type BudgetGuidanceKind,
  type DaybookRecord,
  type ExclusionReason,
  type Insights,
  type PeriodChoice,
  type RecurringSummary,
} from '@api';
import {
  AudioWaveformVisualizer,
  BentoCard,
  BottomSheet,
  Button,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  Figure,
  formatAbsoluteDate,
  formatMoneyCompact,
  GlassSurface,
  Disclosure,
  Icon,
  IconButton,
  IconTile,
  Notice,
  Pressable,
  ProgressBar,
  Row,
  ScreenScroll,
  SegmentedControl,
  ShinyText,
  Skeleton,
  SkeletonCard,
  SPACING,
  SpotlightCard,
  Stack,
  Surface,
  Text,
  TextField,
  useTheme,
  useToast,
  type IconName,
} from '@ui';
import { useTranslation } from '@i18n';

const MOVE_GLYPH = 20;

function factLine(...parts: Array<string | null | false>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

const DRILL_DOWN_FETCH_LIMIT = 10;

type DrillDownSheet = {
  title: string;

  reason: string | null;
  recordIds: string[];

  count: number;
  moreCount: number;
};

const GUIDANCE_LOOK: Record<BudgetGuidanceKind, { icon: IconName; label: string }> = {
  over: { icon: 'alert-circle-outline', label: 'Over your budget' },
  pace: { icon: 'speedometer', label: 'How the month is going' },
  committed: { icon: 'calendar-clock', label: 'Still to go out' },
  concentration: { icon: 'chart-donut', label: 'Where most of it went' },
  trend: { icon: 'chart-timeline-variant', label: 'Against last month' },
  incomplete: { icon: 'information-outline', label: 'Not everything is counted' },
};

const GUIDANCE_FALLBACK = { icon: 'information-outline' as IconName, label: 'Worth knowing' };

function guidanceLook(kind: BudgetGuidanceKind): { icon: IconName; label: string } {
  return GUIDANCE_LOOK[kind] ?? GUIDANCE_FALLBACK;
}

const CADENCE_LOOK: Record<RecurringSummary['cadence'], { icon: IconName; label: string }> = {
  weekly: { icon: 'calendar-sync', label: 'Every week' },
  monthly: { icon: 'calendar-refresh', label: 'Every month' },
};

const CADENCE_FALLBACK = { icon: 'calendar-refresh' as IconName, label: 'Regularly' };

function cadenceLook(cadence: RecurringSummary['cadence']): { icon: IconName; label: string } {
  return CADENCE_LOOK[cadence] ?? CADENCE_FALLBACK;
}

function amountProblem(amount: BudgetAmount, decimals: number): string | null {
  switch (amount.status) {
    case 'ok':
      return null;
    case 'empty':
      return 'Enter the amount you want to keep to each month.';
    case 'unreadable':
      return 'Enter the amount in digits, with nothing else in it.';
    case 'tooPrecise':
      return decimals === 0
        ? 'Enter a whole amount, with no decimal point.'
        : `Enter at most ${decimals} ${plural(decimals, 'decimal place', 'decimal places')}.`;
    case 'notPositive':
      return 'A budget has to be more than zero.';
    case 'tooLarge':
      return 'That is larger than a monthly budget can be. Check the figure.';
  }
}

function MonthSwitcher({
  choices,
  selected,
  onSelect,
}: {
  choices: PeriodChoice[];
  selected: string;
  onSelect: (key: string) => void;
}) {
  const theme = useTheme();

  if (choices.length < 2) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: theme.spacing.sm, paddingVertical: theme.spacing.xxs }}
      accessibilityLabel="Choose a month"
    >
      {choices.map((choice) => {
        const active = choice.key === selected;
        return (
          <Pressable
            key={choice.key}
            onPress={() => onSelect(choice.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}

            accessibilityLabel={choice.hasData ? choice.label : `${choice.label}, nothing saved yet`}
          >
            <Chip
              label={choice.label}
              tone={active ? 'accent' : 'neutral'}
              emphasis={active ? 'solid' : 'outline'}
              size="md"
            />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function PlanPlaceholder() {
  const theme = useTheme();
  return (
    <Stack gap="md" accessible accessibilityLabel="Working out a plan for the rest of the month">
      <Skeleton height={theme.type.heading.lineHeight} width="72%" />
      <Skeleton height={theme.type.bodySmall.lineHeight} />
      <Skeleton height={theme.type.bodySmall.lineHeight} width="86%" />
      {[0, 1].map((index) => (
        <Row key={index} gap="md" align="flex-start">
          <Skeleton width={MOVE_GLYPH} height={MOVE_GLYPH} radius="pill" />
          <Stack gap="xs" style={{ flex: 1 }}>
            <Skeleton height={theme.type.bodyMedium.lineHeight} width="64%" />
            <Skeleton height={theme.type.caption.lineHeight} width="82%" />
          </Stack>
        </Row>
      ))}
    </Stack>
  );
}

function DrillDownSheet({
  sheet,
  records,
  error,
  busy,
  onClose,
  onOpenRecord,
  onRetryRecord,
  onSeeAll,
}: {
  sheet: DrillDownSheet;
  records: DaybookRecord[] | null;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onOpenRecord: (id: string) => void;
  onRetryRecord: (id: string) => void;
  onSeeAll: () => void;
}) {
  const theme = useTheme();

  const hidden = hiddenEntryCount(sheet.count, records === null ? null : records.length);

  return (
    <BottomSheet
      visible
      onDismiss={onClose}
      header={
        <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.md }}>
          <Row between align="center">
            <Text variant="heading" numberOfLines={1} style={{ flex: 1 }}>
              {sheet.title}
            </Text>
            <IconButton icon="close" accessibilityLabel="Close" onPress={onClose} />
          </Row>
          <Text variant="caption" colorToken="textTertiary">
            {sheet.reason ??
              `${sheet.count} ${plural(sheet.count, 'entry', 'entries')} added up to this.`}
          </Text>
        </View>
      }
    >
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xl,
          gap: theme.spacing.md,
        }}
      >
        {error ? <Notice tone="warn" icon="alert-circle-outline" message={error} /> : null}

        {records === null ? (
          <Stack gap="md">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} height={theme.type.bodyMedium.lineHeight} />
            ))}
          </Stack>
        ) : records.length === 0 && !error ? (
          <Text variant="body" colorToken="textSecondary">
            These entries are no longer here. They may have been deleted since the month was
            added up.
          </Text>
        ) : (
          records.map((record) => (
            <DrillDownRow
              key={record.id}
              record={record}
              busy={busy}
              onOpen={() => onOpenRecord(record.id)}
              onRetry={() => onRetryRecord(record.id)}
            />
          ))
        )}

        {hidden > 0 ? (
          <Text variant="caption" colorToken="textTertiary">
            {`and ${hidden} more not shown here`}
          </Text>
        ) : null}

        <Divider />
        <Button
          label="See every entry in this month"
          variant="ghost"
          size="sm"
          icon="arrow-right"
          iconTrailing
          onPress={onSeeAll}
        />
      </ScrollView>
    </BottomSheet>
  );
}

function DrillDownRow({
  record,
  busy,
  onOpen,
  onRetry,
}: {
  record: DaybookRecord;
  busy: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const theme = useTheme();
  const when = record.occurredAt ?? record.createdAt;
  const name = record.counterparty || record.title || 'Untitled entry';
  const needsCurrency = record.amountMinor !== null && !record.currency;

  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${record.amountLabel ?? 'no currency saved'}${needsCurrency ? ', needs a currency' : ''}`}
      dimOnPress
    >
      <Row between gap="md">
        <Stack gap="xxs" style={{ flex: 1 }}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="caption" colorToken="textTertiary">
            {formatAbsoluteDate(when)}
            {needsCurrency ? ' · no currency saved yet' : ''}
            {record.status === 'unreadable' ? ' · nothing could be read from it' : ''}
          </Text>
        </Stack>
        <Stack gap="xxs" align="flex-end">
          <Text variant="monoValue">{record.amountLabel ?? '—'}</Text>
        </Stack>
      </Row>
      {record.status === 'unreadable' ? (
        <Row gap="sm" style={{ marginTop: theme.spacing.sm }}>
          <Button
            label="Try reading it again"
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy || !record.fileId}
            onPress={onRetry}
          />
        </Row>
      ) : null}
    </Pressable>
  );
}

function ExcludedRow({
  count,
  text,
  onPress,
}: {
  count: number;
  text: (count: number) => string;
  onPress: () => void;
}) {
  const theme = useTheme();
  if (count === 0) return null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${text(count)} Show them.`}
      dimOnPress
      pressScale={1}
    >
      <Row gap="sm" align="flex-start">
        <Icon name="information-outline" color={theme.colors.textTertiary} size={14} />
        <Text variant="caption" colorToken="textSecondary" style={{ flex: 1 }}>
          {text(count)}
        </Text>
      </Row>
    </Pressable>
  );
}

export default function MoneyScreen() {
  const theme = useTheme();
  const toast = useToast();
  const { width } = useWindowDimensions();
  const { t } = useTranslation();

  const [chosen, setChosen] = useState<string | null>(null);
  const [openedElsewhere, setOpenedElsewhere] = useState(false);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intelView, setIntelView] = useState<'signals' | 'finances'>('signals');

  const [budgetOpen, setBudgetOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const [advice, setAdvice] = useState<AdviceResponse | null>(null);
  const [adviceError, setAdviceError] = useState<string | null>(null);
  const [advising, setAdvising] = useState(false);

  const [drill, setDrill] = useState<DrillDownSheet | null>(null);
  const [drillRecords, setDrillRecords] = useState<DaybookRecord[] | null>(null);
  const [drillError, setDrillError] = useState<string | null>(null);
  const [drillBusy, setDrillBusy] = useState(false);

  const generation = useRef(0);
  const adviceGeneration = useRef(0);
  const savingLock = useRef(false);

  const currentKey = monthKeyOf(new Date());

  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await getInsights(chosen ?? undefined);
      if (request !== generation.current) return;

      const instead = chosen === null ? fallbackPeriodKey(next.period, next.availablePeriods) : null;
      if (instead) {
        generation.current += 1;
        setOpenedElsewhere(true);
        setChosen(instead);
        return;
      }

      setInsights(next);
      setError(null);
    } catch (err) {
      if (request === generation.current) {
        setError(readableError(err, 'Your spending could not be loaded. Please try again.'));
      }
    } finally {
      if (request === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [chosen]);

  useFocusEffect(
    useCallback(() => {
      setAdvice(null);
      void load();
      return () => {
        generation.current += 1;
        adviceGeneration.current += 1;
        setAdvising(false);
      };
    }, [load]),
  );

  function selectMonth(key: string) {
    if (key === (insights?.period.key ?? chosen)) return;
    adviceGeneration.current += 1;
    setChosen(key);
    setOpenedElsewhere(false);
    setInsights(null);
    setAdvice(null);
    setAdviceError(null);
    setError(null);
    setAdvising(false);
    setLoading(true);
  }

  const refresh = () => {
    setRefreshing(true);
    setAdvice(null);
    void load();
  };

  const openDrill = useCallback(
    (sheet: DrillDownSheet) => {
      setDrill(sheet);
      setDrillRecords(null);
      setDrillError(null);
      if (sheet.recordIds.length === 0) {
        setDrillRecords([]);
        return;
      }
      const wanted = sheet.recordIds.slice(0, DRILL_DOWN_FETCH_LIMIT);
      void Promise.allSettled(wanted.map((id) => getRecord(id))).then((results) => {
        const found = results
          .filter((result): result is PromiseFulfilledResult<DaybookRecord> => result.status === 'fulfilled')
          .map((result) => result.value);

        setDrillRecords(found);
        setDrillError(drillDownLoadProblem(results.length, results.length - found.length));
      });
    },
    [],
  );

  const closeDrill = () => {
    setDrill(null);
    setDrillRecords(null);
    setDrillError(null);
    setDrillBusy(false);
  };

  const openExcluded = useCallback(
    (reason: ExclusionReason) => {
      const bucket = insights?.excluded[reason];
      if (!bucket) return;
      const copy = excludedReasonSheet(reason, bucket.count);
      openDrill({
        title: copy.title,
        reason: copy.reason,
        recordIds: bucket.recordIds,
        count: bucket.count,
        moreCount: bucket.moreCount,
      });
    },
    [insights, openDrill],
  );

  const retryDrillRecord = useCallback(
    async (id: string) => {
      if (drillBusy) return;
      setDrillBusy(true);
      try {
        await retryRecord(id);
        closeDrill();
        toast.show({ message: 'Reading it again. It will update on your timeline.', tone: 'neutral' });
        void load();
      } catch (err) {
        setDrillError(readableError(err, 'That entry could not be read again just now.'));
      } finally {
        setDrillBusy(false);
      }
    },
    [drillBusy, load, toast],
  );

  const currency = insights?.currency ?? null;
  const decimals = useMemo(() => currencyDecimals(currency), [currency]);
  const amount = useMemo(() => readBudgetAmount(typed, decimals), [typed, decimals]);
  const budget = insights?.budget ?? null;
  const problem = attempted || amount.status !== 'empty' ? amountProblem(amount, decimals) : null;

  function openBudget() {
    setTyped(budget ? budgetAmountText(budget.amountMinor, decimals) : '');
    setAttempted(false);
    setConfirmRemove(false);
    setSaveError(null);
    setBudgetOpen(true);
  }

  function closeBudget() {
    if (saving) return;
    setBudgetOpen(false);
    setConfirmRemove(false);
  }

  function editAmount(next: string) {
    setTyped(next);
    if (saveError) setSaveError(null);
    if (confirmRemove) setConfirmRemove(false);
  }

  async function saveBudget() {
    if (savingLock.current) return;
    setAttempted(true);
    if (amount.status !== 'ok') return;

    savingLock.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await setBudget(amount.decimal, currency);
      setBudgetOpen(false);
      setConfirmRemove(false);
      setAdvice(null);
      toast.show({ message: 'Monthly budget saved.', tone: 'ok' });
      await load();
    } catch (err) {
      setSaveError(readableError(err, 'Your budget could not be saved. Please try again.'));
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  }

  async function removeBudget() {
    if (savingLock.current) return;

    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    savingLock.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await clearBudget();
      setBudgetOpen(false);
      setConfirmRemove(false);
      setAdvice(null);
      toast.show({ message: 'Budget removed.', tone: 'neutral' });
      await load();
    } catch (err) {
      setSaveError(readableError(err, 'Your budget could not be removed. Please try again.'));
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  }

  async function planSpending() {
    const request = ++adviceGeneration.current;
    setAdvising(true);
    setAdviceError(null);
    try {
      const result = await getAdvice(insights?.period.key);
      if (request === adviceGeneration.current) setAdvice(result);
    } catch (err) {
      if (request === adviceGeneration.current) {
        setAdviceError(
          readableError(err, 'Your plan could not be prepared right now. Please try again.'),
        );
      }
    } finally {
      if (request === adviceGeneration.current) setAdvising(false);
    }
  }

  const period = insights?.period ?? null;
  const choices = insights
    ? periodChoices(insights.period, insights.availablePeriods, currentKey)
    : [];
  const guidance = insights ? spendingGuidance(insights.guidance) : [];

  const alerts = insights ? showableAlerts(insights.alerts) : null;
  const categories = insights ? orderedCategories(insights.categories) : [];
  const recurring = insights?.recurring ?? [];

  const nothingAnywhere = Boolean(insights && !insights.period.hasData && choices.length < 2);
  const fallbackChoice = choices.find((choice) => choice.hasData && choice.key !== period?.key);
  const savedAmount = amount.status === 'ok' && currency
    ? formatMoneyCompact(amount.minorUnits, currency)
    : amount.status === 'ok'
      ? amount.text
      : null;

  return (
    <>
      <ScreenScroll
        title={t('insights.title')}
        subtitle={t('insights.subtitle')}
        onRefresh={refresh}
        refreshing={refreshing}
        actions={[{ icon: 'refresh', label: t('common.refresh'), onPress: refresh }]}
      >
        <Stack gap="xl">
          <SegmentedControl<'signals' | 'finances'>
            options={[
              { value: 'signals', label: t('insights.scannerTab') },
              { value: 'finances', label: t('insights.financesTab') },
            ]}
            value={intelView}
            onChange={setIntelView}
            fill
          />

          {intelView === 'signals' ? (
            <Stack gap="xl">
              {}
              <SpotlightCard
                onPress={() => router.push({ pathname: '/capture', params: { mode: 'meeting' } })}
                glowColor="rgba(37, 99, 235, 0.35)"
                edgeColor="rgba(56, 189, 248, 0.25)"
                borderRadius={24}
                style={{ padding: SPACING.xl, borderColor: 'rgba(56, 189, 248, 0.25)', borderWidth: 1 }}
                accessibilityLabel="Record a meeting card"
              >
                <Stack gap="md" style={{ width: '100%' }}>
                  <Row between align="center" style={{ width: '100%' }}>
                    <Row gap="sm" align="center" style={{ flex: 1, flexShrink: 1, marginRight: SPACING.sm }}>
                      <IconTile icon="microphone" tone="accent" size="md" />
                      <Stack gap="none" style={{ flex: 1, flexShrink: 1 }}>
                        <ShinyText
                          text={t('insights.recordMeetingTitle') || 'Record a Meeting'}
                          style={{ fontSize: 17, fontWeight: '700' }}
                        />
                        <Text variant="caption" colorToken="textTertiary" numberOfLines={1}>
                          Live transcription, decisions & action items
                        </Text>
                      </Stack>
                    </Row>
                    <AudioWaveformVisualizer isActive barCount={10} maxHeight={22} tone="accent" />
                  </Row>
                  <Text variant="bodySmall" colorToken="textSecondary">
                    {t('insights.recordMeetingSubtitle')}
                  </Text>
                  <Row wrap gap="sm">
                    <Button
                      label="Record Meeting"
                      icon="microphone"
                      variant="primary"
                      onPress={() => router.push({ pathname: '/capture', params: { mode: 'meeting' } })}
                    />
                    <Button
                      label="Import Audio"
                      icon="upload-outline"
                      variant="secondary"
                      onPress={() => router.push({ pathname: '/capture', params: { mode: 'audio' } })}
                    />
                  </Row>
                </Stack>
              </SpotlightCard>

              {}
              <SpotlightCard
                onPress={() => router.push('/capture')}
                glowColor="rgba(37, 99, 235, 0.25)"
                edgeColor="rgba(56, 189, 248, 0.18)"
                borderRadius={20}
                style={{ padding: SPACING.xl, borderColor: 'rgba(56, 189, 248, 0.18)', borderWidth: 1 }}
                accessibilityLabel="Document and file scanner card"
              >
                <Stack gap="md" style={{ width: '100%' }}>
                  <Row between align="center" style={{ width: '100%' }}>
                    <Row gap="sm" align="center" style={{ flex: 1, flexShrink: 1 }}>
                      <IconTile icon="crop-free" tone="accent" size="md" />
                      <Stack gap="none" style={{ flex: 1, flexShrink: 1 }}>
                        <Text variant="subheading">
                          Document & Evidence Scanner
                        </Text>
                        <Text variant="caption" colorToken="textTertiary" numberOfLines={1}>
                          Bills, receipts, invoices & proofs
                        </Text>
                      </Stack>
                    </Row>
                  </Row>
                  <Text variant="bodySmall" colorToken="textSecondary">
                    Scan documents, photos, or message proofs to automatically extract verified dates, amounts, and detect contradictions.
                  </Text>
                  <Row wrap gap="sm">
                    <Button
                      label="Scan or Upload"
                      icon="crop-free"
                      variant="secondary"
                      onPress={() => router.push('/capture')}
                    />
                    <Button
                      label="Ask Assistant"
                      icon="star-four-points-outline"
                      variant="ghost"
                      onPress={() => router.push('/ask')}
                    />
                  </Row>
                </Stack>
              </SpotlightCard>

              <SpotlightCard
                glowColor="rgba(59, 130, 246, 0.2)"
                edgeColor="rgba(96, 165, 250, 0.15)"
                borderRadius={20}
                style={{ padding: SPACING.xl, borderColor: 'rgba(59, 130, 246, 0.18)', borderWidth: 1 }}
              >
                <Stack gap="md" style={{ width: '100%' }}>
                  <Row between align="center" style={{ width: '100%' }}>
                    <Text variant="subheading">Discrepancy Radar</Text>
                    <Chip label="Automated" tone="accent" />
                  </Row>
                  <Text variant="bodySmall" colorToken="textSecondary">
                    Contradiction checks across amounts, dates, and counterparties from saved entries.
                  </Text>
                  <Stack gap="sm">
                    <Row gap="md" align="flex-start">
                      <IconTile icon="shield-check-outline" tone="ok" size="sm" />
                      <Stack gap="xxs" style={{ flex: 1 }}>
                        <Text variant="bodyMedium">Provenance & Timestamps</Text>
                        <Text variant="caption" colorToken="textTertiary">
                          Original files remain cryptographically preserved with tamper-evident audit logs.
                        </Text>
                      </Stack>
                    </Row>
                    <Divider />
                    <Row gap="md" align="flex-start">
                      <IconTile icon="scale-balance" tone="accent" size="sm" />
                      <Stack gap="xxs" style={{ flex: 1 }}>
                        <Text variant="bodyMedium">Case Correlations</Text>
                        <Text variant="caption" colorToken="textTertiary">
                          Link discovered receipts and statements directly into active disputes.
                        </Text>
                      </Stack>
                      <Button
                        label="View cases"
                        size="sm"
                        variant="ghost"
                        onPress={() => router.push('/(tabs)/cases')}
                      />
                    </Row>
                  </Stack>
                </Stack>
              </SpotlightCard>

              {guidance.length > 0 ? (
                <GlassSurface padding="xl">
                  <Stack gap="md">
                    <Text variant="subheading">Extracted Findings</Text>
                    {guidance.slice(0, 3).map((item, index) => {
                      const look = guidanceLook(item.kind);
                      return (
                        <Row key={`sig-guide-${index}`} gap="md" align="flex-start">
                          <IconTile icon={look.icon} tone={item.tone} size="sm" />
                          <Text variant="bodySmall" colorToken="textSecondary" style={{ flex: 1 }}>
                            {item.text}
                          </Text>
                        </Row>
                      );
                    })}
                    <Button
                      label="Open full financial ledger"
                      variant="ghost"
                      size="sm"
                      icon="arrow-right"
                      iconTrailing
                      onPress={() => setIntelView('finances')}
                    />
                  </Stack>
                </GlassSurface>
              ) : null}
            </Stack>
          ) : (
            <Stack gap="xl">
              <MonthSwitcher
                choices={choices}
                selected={period?.key ?? currentKey}
                onSelect={selectMonth}
              />

          {error ? <ErrorState message={error} onRetry={refresh} compact /> : null}

          {loading && !insights ? (
            <Stack gap="lg">
              <SkeletonCard lines={4} />
              <SkeletonCard lines={3} />
            </Stack>
          ) : null}

          {insights && period ? (
            <>
              {openedElsewhere || (!period.isCurrent && chosen === null) ? (
                <Notice
                  tone="info"
                  icon="calendar-arrow-left"
                  message={`Nothing is saved for ${monthLabelOf(currentKey)} yet, so this is ${period.label} — your most recent month.`}
                />
              ) : null}

              {!period.hasData ? (
                nothingAnywhere ? (
                  <EmptyState
                    icon="wallet-outline"
                    title="Nothing here yet"
                    message="Add a payment screenshot, a bill or a receipt. The amount and who it went to are read off it, and counted into your month."
                    action={{
                      label: 'Add a payment',
                      icon: 'plus',
                      onPress: () => router.push('/capture'),
                    }}
                  />
                ) : (
                  <EmptyState
                    icon="calendar-blank-outline"
                    title={`Nothing saved for ${period.label}`}
                    message={
                      period.isCurrent
                        ? 'Nothing has been added to this month yet, so there is nothing to add up. Anything you add dated this month shows up here.'
                        : 'No amounts were saved in this month.'
                    }
                    action={{
                      label: 'Add a payment',
                      icon: 'plus',
                      onPress: () => router.push('/capture'),
                    }}
                    {...(fallbackChoice
                      ? {
                          secondaryAction: {
                            label: `Show ${fallbackChoice.label}`,
                            icon: 'arrow-right',
                            onPress: () => selectMonth(fallbackChoice.key),
                          },
                        }
                      : {})}
                  />
                )
              ) : (
                <>
                  <View
                    style={{ flexDirection: width >= 1050 ? 'row' : 'column', gap: theme.spacing.lg }}
                  >
                    <GlassSurface variant="hero" padding="xl" style={{ flex: 1 }}>
                      <Stack gap="lg">
                        <Row between>
                          <Text variant="overline" colorToken="textTertiary">
                            {`Spent in ${period.label}`}
                          </Text>
                          <Icon name="wallet-outline" color={theme.colors.accent} size={24} />
                        </Row>
                        {insights.spent.amountLabel ? (
                          <Figure variant="statValue" fit>
                            {insights.spent.amountLabel}
                          </Figure>
                        ) : (
                          <Text variant="body" colorToken="textSecondary">
                            Amounts are saved here, but none of them say which currency they are
                            in, so they are not added up.
                          </Text>
                        )}
                        <Text variant="caption" colorToken="textTertiary">
                          {factLine(
                            `From ${insights.recordCount} saved ${plural(insights.recordCount, 'entry', 'entries')}`,
                            period.isCurrent && `Day ${period.dayOfPeriod} of ${period.daysInPeriod}`,
                            period.isCurrent &&
                              insights.pace.perDaySoFarLabel &&
                              `${insights.pace.perDaySoFarLabel} a day so far`,
                          )}
                        </Text>
                        {insights.currency ? (
                          <>
                            <Divider />
                            <Row between>
                              <Stack gap="xxs">
                                <Text variant="caption" colorToken="textTertiary">
                                  Money in
                                </Text>
                                <Text variant="monoValue" tone="ok">
                                  {insights.received.amountLabel}
                                </Text>
                              </Stack>
                              <Stack gap="xxs" align="flex-end">
                                <Text variant="caption" colorToken="textTertiary">
                                  The month before
                                </Text>
                                <Text variant="monoValue">
                                  {insights.comparison.previousMonthLabel}
                                </Text>
                              </Stack>
                            </Row>
                          </>
                        ) : null}
                      </Stack>
                    </GlassSurface>

                    <GlassSurface padding="xl" style={{ flex: 1 }}>
                      <Stack gap="lg">
                        <Row between>
                          <Text variant="overline" colorToken="textTertiary">
                            {period.isCurrent ? 'Monthly budget' : 'Against your budget'}
                          </Text>
                          {period.isCurrent && (insights.currency || budget) ? (
                            <Button
                              label={budget ? 'Edit' : 'Set budget'}
                              size="sm"
                              variant="ghost"
                              onPress={openBudget}
                            />
                          ) : null}
                        </Row>
                        {budget ? (
                          <>
                            <Text variant="heading" tone={budget.overspent ? 'warn' : 'neutral'}>
                              {budget.remainingLabel}
                            </Text>
                            <Text variant="caption" colorToken="textTertiary">
                              {budget.overspent
                                ? `over your ${budget.amountLabel} limit`
                                : `left of ${budget.amountLabel}`}
                            </Text>
                            <ProgressBar
                              value={budget.usedPercent / 100}
                              tone={budget.overspent ? 'warn' : 'accent'}
                              size="lg"
                              accessibilityLabel={`${Math.round(budget.usedPercent)} percent of your ${budget.amountLabel} budget used, ${insights.spent.amountLabel ?? 'nothing'} spent`}
                            />
                            <Row between wrap gap="sm">
                              <Text variant="caption" colorToken="textSecondary">
                                {factLine(
                                  `${Math.round(budget.usedPercent)}% used`,
                                  period.isCurrent &&
                                    `day ${period.dayOfPeriod} of ${period.daysInPeriod}`,
                                )}
                              </Text>
                              {period.isCurrent && !budget.overspent && period.daysLeft > 0 ? (
                                <Text variant="caption" tone="accent">
                                  {`${budget.perDayLeftLabel} a day for the ${period.daysLeft} ${plural(period.daysLeft, 'day', 'days')} left`}
                                </Text>
                              ) : null}
                            </Row>
                          </>
                        ) : (
                          <>
                            <Text variant="heading">No budget set</Text>
                            {!period.isCurrent ? (
                              <Text variant="caption" colorToken="textTertiary">
                                There was no budget to measure this month against.
                              </Text>
                            ) : insights.currency ? (
                              <>
                                <Text variant="caption" colorToken="textTertiary">
                                  Set one and this card tells you what is left and what a day
                                  you have to work with.
                                </Text>
                                <Button
                                  label="Set a monthly budget"
                                  icon="plus"
                                  variant="secondary"
                                  onPress={openBudget}
                                />
                              </>
                            ) : (
                              <Text variant="caption" colorToken="textTertiary">
                                Save a payment first, so a budget has a currency to follow.
                              </Text>
                            )}
                          </>
                        )}
                      </Stack>
                    </GlassSurface>
                  </View>

                  {guidance.length ? (

                    <GlassSurface padding="xl">
                      <Stack gap="md">
                        {guidance.map((item, index) => {
                          const look = guidanceLook(item.kind);
                          return (
                            <Row
                              key={`${item.kind}-${index}`}
                              gap="md"
                              align="flex-start"
                              accessible
                              accessibilityLabel={`${look.label}. ${item.text}`}
                            >
                              <IconTile icon={look.icon} tone={item.tone} size="sm" />
                              <Text
                                variant={index === 0 ? 'bodyMedium' : 'bodySmall'}
                                colorToken={index === 0 ? undefined : 'textSecondary'}
                                style={{ flex: 1 }}
                              >
                                {item.text}
                              </Text>
                            </Row>
                          );
                        })}
                      </Stack>
                    </GlassSurface>
                  ) : null}

                  {alerts ? (

                    <GlassSurface padding="xl">
                      <Stack gap="lg">
                        <Stack gap="xxs">
                          <Text variant="subheading">{alertsHeading(alerts.length)}</Text>
                          <Text variant="caption" colorToken="textTertiary">
                            Tap one to see the entries it is about.
                          </Text>
                        </Stack>

                        {alerts.map((alert) => {
                          const look = alertLook(alert.kind);
                          return (
                            <Pressable
                              key={`${alert.kind}-${alert.at}-${alert.recordIds[0] ?? ''}`}
                              onPress={() =>
                                openDrill({
                                  title: alertsHeading(1),
                                  reason: alert.text,
                                  recordIds: alert.recordIds,
                                  count: alert.recordIds.length,

                                  moreCount: 0,
                                })
                              }
                              accessibilityRole="button"
                              accessibilityLabel={alert.text}
                              accessibilityHint={`${look.verb}: opens the entries this is about`}
                            >
                              <Row gap="md" align="flex-start">
                                {}
                                <IconTile icon={look.icon as IconName} tone={look.tone} size="sm" />
                                <Stack gap="xxs" style={{ flex: 1 }}>
                                  <Text variant="bodySmall">{alert.text}</Text>
                                  <Text variant="caption" tone="accent">
                                    {look.verb}
                                  </Text>
                                </Stack>
                                <Disclosure />
                              </Row>
                            </Pressable>
                          );
                        })}
                      </Stack>
                    </GlassSurface>
                  ) : null}

                  {insights.needsContextCount > 0 ? (
                    <Stack gap="sm">
                      <Notice
                        tone="accent"
                        icon="help-circle-outline"
                        message={`${insights.needsContextCount} ${plural(insights.needsContextCount, 'entry is', 'entries are')} waiting on one detail, so this total can still change.`}
                      />
                      <Button
                        label={`Fill ${plural(insights.needsContextCount, 'it', 'them')} in`}
                        variant="secondary"
                        size="sm"
                        icon="arrow-right"
                        iconTrailing
                        onPress={() =>
                          router.push({ pathname: '/(tabs)', params: { filter: 'needs' } })
                        }
                      />
                    </Stack>
                  ) : null}

                  <GlassSurface padding="xl">
                    <Stack gap="lg">
                      <Stack gap="xxs">
                        <Text variant="subheading">Evidence breakdown</Text>
                        <Text variant="caption" colorToken="textTertiary">
                          Document verification across your records for this period.
                        </Text>
                      </Stack>
                      <Row gap="md" wrap>
                        <Surface radius="md" padding="md" style={{ flex: 1, minWidth: 140 }}>
                          <Stack gap="xs">
                            <Row between align="center">
                              <Text variant="caption" colorToken="textSecondary">
                                Receipts & Bills
                              </Text>
                              <Icon name="receipt-text-outline" color={theme.colors.accent} size={18} />
                            </Row>
                            <Text variant="heading" mono>
                              {String(insights.recordCount)}
                            </Text>
                            <Text variant="caption" colorToken="textTertiary">
                              {insights.spent.amountLabel ?? 'Verified records'}
                            </Text>
                          </Stack>
                        </Surface>

                        <Surface radius="md" padding="md" style={{ flex: 1, minWidth: 140 }}>
                          <Stack gap="xs">
                            <Row between align="center">
                              <Text variant="caption" colorToken="textSecondary">
                                Contracts & Commitments
                              </Text>
                              <Icon name="file-document-outline" color={theme.colors.accent} size={18} />
                            </Row>
                            <Text variant="heading" mono>
                              {String(recurring.length)}
                            </Text>
                            <Text variant="caption" colorToken="textTertiary">
                              Active recurring schedules
                            </Text>
                          </Stack>
                        </Surface>
                      </Row>

                      <Row gap="md" wrap>
                        <Surface radius="md" padding="md" style={{ flex: 1, minWidth: 140 }}>
                          <Stack gap="xs">
                            <Row between align="center">
                              <Text variant="caption" colorToken="textSecondary">
                                Signals & Flags
                              </Text>
                              <Icon name="alert-decagram-outline" color={alerts && alerts.length > 0 ? theme.tone('warn').fg : theme.colors.textTertiary} size={18} />
                            </Row>
                            <Text variant="heading" mono tone={alerts && alerts.length > 0 ? 'warn' : 'neutral'}>
                              {String(alerts?.length ?? 0)}
                            </Text>
                            <Text variant="caption" colorToken="textTertiary">
                              {alerts && alerts.length > 0 ? 'Discrepancies detected' : 'Clear reconciliation'}
                            </Text>
                          </Stack>
                        </Surface>

                        <Surface radius="md" padding="md" style={{ flex: 1, minWidth: 140 }}>
                          <Stack gap="xs">
                            <Row between align="center">
                              <Text variant="caption" colorToken="textSecondary">
                                Verification Status
                              </Text>
                              <Icon name="shield-check-outline" color={theme.tone('ok').fg} size={18} />
                            </Row>
                            <Text variant="heading" mono tone="ok">
                              {insights.needsContextCount === 0 ? '100%' : `${Math.max(0, Math.round(((insights.recordCount - insights.needsContextCount) / Math.max(1, insights.recordCount)) * 100))}%`}
                            </Text>
                            <Text variant="caption" colorToken="textTertiary">
                              {insights.needsContextCount > 0 ? `${insights.needsContextCount} awaiting detail` : 'Fully grounded'}
                            </Text>
                          </Stack>
                        </Surface>
                      </Row>
                    </Stack>
                  </GlassSurface>

                  {categories.length ? (
                    <GlassSurface padding="xl">
                      <Stack gap="lg">
                        <Stack gap="xxs">
                          <Text variant="subheading">Where it went</Text>
                          <Text variant="caption" colorToken="textTertiary">
                            {`${period.label}, biggest first.`}
                          </Text>
                        </Stack>
                        {categories.map((row) => (

                          <Pressable
                            key={row.name}
                            onPress={() =>
                              openDrill({
                                title: row.displayName,
                                reason: `${row.count} ${plural(row.count, 'entry', 'entries')} added up to ${row.amountLabel}.`,
                                recordIds: row.recordIds,
                                count: row.count,
                                moreCount: row.moreCount,
                              })
                            }
                            accessibilityRole="button"
                            accessibilityLabel={`${row.displayName}: ${row.amountLabel}, ${Math.round(row.sharePercent)} percent of the month. Show the ${row.count} ${plural(row.count, 'entry', 'entries')} behind it.`}
                            dimOnPress
                            pressScale={1}
                          >
                            <Stack gap="sm">
                              <Row between gap="md">
                                <Text variant="bodySmall" numberOfLines={1} style={{ flex: 1 }}>
                                  {row.displayName}
                                </Text>
                                <Text variant="monoValue">{row.amountLabel}</Text>
                              </Row>
                              <ProgressBar
                                value={row.sharePercent / 100}
                                tone={row.unlabelled ? 'neutral' : 'accent'}
                                accessibilityLabel={`${row.displayName}: ${row.amountLabel}, ${Math.round(row.sharePercent)} percent of the month`}
                              />
                              <Text variant="caption" colorToken="textTertiary">
                                {row.unlabelled
                                  ? `${Math.round(row.sharePercent)}% · ${row.count} ${plural(row.count, 'payment', 'payments')} with nothing written down about what for`
                                  : `${Math.round(row.sharePercent)}% · ${row.count} ${plural(row.count, 'payment', 'payments')}`}
                              </Text>
                            </Stack>
                          </Pressable>
                        ))}
                        <Divider />
                        <Button
                          label="See every payment"
                          variant="ghost"
                          size="sm"
                          icon="arrow-right"
                          iconTrailing
                          onPress={() =>
                            router.push({ pathname: '/(tabs)', params: { filter: 'money' } })
                          }
                        />
                      </Stack>
                    </GlassSurface>
                  ) : null}

                  {insights.counterparties.length ? (
                    <GlassSurface padding="xl">
                      <Stack gap="lg">
                        <Text variant="subheading">Who you paid</Text>
                        {insights.counterparties.slice(0, 8).map((party, index) => (
                          <View key={party.name}>
                            {index > 0 ? <Divider spacing="md" /> : null}
                            <Pressable
                              onPress={() =>
                                openDrill({
                                  title: party.name,
                                  reason: `${party.count} ${plural(party.count, 'payment', 'payments')} to ${party.name} added up to ${party.amountLabel}.`,
                                  recordIds: party.recordIds,
                                  count: party.count,
                                  moreCount: party.moreCount,
                                })
                              }
                              accessibilityRole="button"
                              accessibilityLabel={`${party.name}: ${party.amountLabel} across ${party.count} ${plural(party.count, 'payment', 'payments')}. Show them.`}
                              dimOnPress
                              pressScale={1}
                            >
                              <Row between gap="lg">
                                <Stack gap="xxs" style={{ flex: 1 }}>
                                  <Text variant="bodyMedium" numberOfLines={1}>
                                    {party.name}
                                  </Text>
                                  <Text variant="caption" colorToken="textTertiary">
                                    {`${party.count} ${plural(party.count, 'payment', 'payments')}`}
                                  </Text>
                                </Stack>
                                <Text variant="monoValue">{party.amountLabel}</Text>
                              </Row>
                            </Pressable>
                          </View>
                        ))}
                      </Stack>
                    </GlassSurface>
                  ) : null}

                  {recurring.length ? (
                    <GlassSurface padding="xl">
                      <Stack gap="lg">
                        <Stack gap="xxs">
                          <Text variant="subheading">Regular payments</Text>
                          <Text variant="caption" colorToken="textTertiary">
                            Worked out from what has gone out before, so the amounts are
                            approximate.
                          </Text>
                        </Stack>
                        {recurring.map((item, index) => {
                          const look = cadenceLook(item.cadence);
                          return (
                            <View key={`${item.counterparty}-${item.cadence}`}>
                              {index > 0 ? <Divider spacing="md" /> : null}
                              <Row between gap="lg">
                                <Row gap="md" style={{ flex: 1 }}>
                                  <IconTile icon={look.icon} size="md" tone="accent" />
                                  <Stack gap="xxs" style={{ flex: 1 }}>
                                    <Text variant="bodyMedium" numberOfLines={1}>
                                      {item.counterparty}
                                    </Text>
                                    <Text variant="caption" colorToken="textTertiary">
                                      {`${look.label} · seen ${item.occurrences} ${plural(item.occurrences, 'time', 'times')}`}
                                    </Text>
                                  </Stack>
                                </Row>
                                <Text variant="monoValue">
                                  {item.estimated ? `About ${item.amountLabel}` : item.amountLabel}
                                </Text>
                              </Row>
                            </View>
                          );
                        })}
                      </Stack>
                    </GlassSurface>
                  ) : null}

                  {period.isCurrent && (insights.recordCount > 0 || budget) ? (
                    <GlassSurface padding="xl">
                      <Stack gap="lg">
                        <Row between wrap gap="md">
                          <Stack gap="xxs" style={{ flex: 1 }}>
                            <Text variant="subheading">Plan the rest of the month</Text>
                            <Text variant="caption" colorToken="textTertiary">
                              A short plan, written from the figures on this screen.
                            </Text>
                          </Stack>
                          <Button
                            label={advice ? 'Again' : 'Help me plan'}
                            icon="creation"
                            loading={advising}
                            disabled={advising}
                            onPress={() => void planSpending()}
                            size="sm"
                          />
                        </Row>
                        {advising ? (
                          <PlanPlaceholder />
                        ) : adviceError ? (
                          <ErrorState
                            compact
                            title="The plan did not come through"
                            message={adviceError}
                            onRetry={() => void planSpending()}
                          />
                        ) : advice ? (
                          <>
                            <Text variant="heading">{advice.advice.headline}</Text>
                            {advice.advice.reasons.map((reason, index) => (
                              <Text
                                key={`reason-${index}`}
                                variant="bodySmall"
                                colorToken="textSecondary"
                              >
                                {reason}
                              </Text>
                            ))}
                            {advice.advice.moves.map((move, index) => (
                              <Row key={`move-${index}`} gap="md" align="flex-start">
                                <Icon
                                  name="arrow-right-circle-outline"
                                  color={theme.colors.accent}
                                  size={MOVE_GLYPH}
                                />
                                <Stack gap="xs" style={{ flex: 1 }}>
                                  <Text variant="bodyMedium">{move.action}</Text>
                                  <Text variant="caption" colorToken="textSecondary">
                                    {move.impact}
                                  </Text>
                                </Stack>
                              </Row>
                            ))}
                            {advice.advice.watch.length ? (
                              <>
                                <Divider />
                                {advice.advice.watch.map((item, index) => (
                                  <Text key={`watch-${index}`} variant="caption" tone="warn">
                                    {item}
                                  </Text>
                                ))}
                              </>
                            ) : null}
                            <Text variant="caption" colorToken="textTertiary">
                              {`From your saved entries · ${new Date(advice.generatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`}
                            </Text>
                          </>
                        ) : null}
                      </Stack>
                    </GlassSurface>
                  ) : null}

                  <Stack gap="md">
                    <Button
                      label="Look back on a whole week or month"
                      variant="ghost"
                      size="sm"
                      icon="calendar-text"
                      onPress={() => router.push('/recap')}
                    />
                    {}
                    <Stack gap="sm">
                      <Text variant="caption" colorToken="textTertiary">
                        Every figure here comes from your own saved entries
                      </Text>
                      <ExcludedRow
                        count={insights.excluded.missingCurrency.count}
                        text={(count) =>
                          `${count} ${plural(count, 'amount', 'amounts')} had no currency saved with ${plural(count, 'it', 'them')}, so ${plural(count, 'it', 'they')} could not be added in. Open ${plural(count, 'it', 'them')} and set the currency.`
                        }
                        onPress={() => openExcluded('missingCurrency')}
                      />
                      <ExcludedRow
                        count={insights.excluded.otherCurrency.count}
                        text={(count) =>
                          `${count} ${plural(count, 'entry', 'entries')} ${plural(count, 'is', 'are')} in another currency this month's total cannot state. Nothing is wrong with ${plural(count, 'it', 'them')} — it is simply not part of this figure.`
                        }
                        onPress={() => openExcluded('otherCurrency')}
                      />
                      <ExcludedRow
                        count={insights.excluded.unreadable.count}
                        text={(count) =>
                          `${count} ${plural(count, 'entry', 'entries')} could not be read, so nothing on ${plural(count, 'it', 'them')} is counted yet. Open ${plural(count, 'it', 'them')} to try reading ${plural(count, 'it', 'them')} again.`
                        }
                        onPress={() => openExcluded('unreadable')}
                      />
                    </Stack>
                  </Stack>
                </>
              )}
            </>
          ) : null}
        </Stack>
      )}
    </Stack>
  </ScreenScroll>

      {}
      {drill ? (
        <DrillDownSheet
          sheet={drill}
          records={drillRecords}
          error={drillError}
          busy={drillBusy}
          onClose={closeDrill}
          onOpenRecord={(id) => {
            closeDrill();
            router.push({ pathname: '/record/[id]', params: { id } });
          }}
          onRetryRecord={(id) => void retryDrillRecord(id)}
          onSeeAll={() => {
            closeDrill();
            router.push({ pathname: '/(tabs)', params: { filter: 'money' } });
          }}
        />
      ) : null}

      <BottomSheet
        visible={budgetOpen}
        onDismiss={closeBudget}
        header={
          <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.lg }}>
            <Row between>
              <Text variant="heading">Monthly budget</Text>
              <IconButton
                icon="close"
                accessibilityLabel="Close budget"
                disabled={saving}
                onPress={closeBudget}
              />
            </Row>
          </View>
        }
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            padding: theme.spacing.xl,
            gap: theme.spacing.lg,
            width: '100%',
            maxWidth: 620,
            alignSelf: 'center',
          }}
        >
          <TextField
            label="How much a month"
            {...(currency ? { labelHint: currency } : {})}
            value={amount.text}
            onChangeText={editAmount}

            keyboardType={decimals > 0 ? 'decimal-pad' : 'number-pad'}
            error={problem ?? saveError ?? undefined}
            editable={!saving}
            autoFocus
          />
          <Text variant="caption" colorToken="textTertiary">
            {savedAmount
              ? `Saving ${savedAmount} a month. It stays in place until you change it.`
              : 'This limit stays in place until you change it.'}
          </Text>
          <Button
            label={savedAmount ? `Save ${savedAmount}` : 'Save budget'}
            variant="primary"
            loading={saving}
            onPress={() => void saveBudget()}
            fullWidth
          />
          {budget ? (
            <Button
              label={confirmRemove ? 'Tap again to remove it' : 'Remove this budget'}
              variant={confirmRemove ? 'danger' : 'ghost'}
              disabled={saving}
              onPress={() => void removeBudget()}
              fullWidth
            />
          ) : null}
        </ScrollView>
      </BottomSheet>
    </>
  );
}
