import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Share, View } from 'react-native';

import {
  getRecap,
  getUpcoming,
  orderedCategories,
  readableError,
  type DaybookRecap,
  type RecapCounterparty,
  type RecapHighlight,
  type RecapPeriod,
  type UpcomingItem,
} from '@api';
import {
  Button,
  Divider,
  EmptyState,
  ErrorState,
  GlassSurface,
  Icon,
  IconTile,
  Notice,
  Pressable,
  ProgressBar,
  Row,
  ScreenScroll,
  SegmentedControl,
  SkeletonList,
  Stack,
  Text,
  useTheme,
  useToast,
  type IconName,
} from '@ui';

const PERIODS: { value: RecapPeriod; label: string }[] = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
];

function spanWord(period: RecapPeriod): string {
  return period === 'week' ? 'week' : 'month';
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function rangeLabel(from: number, to: number): string {
  const start = new Date(from);
  const end = new Date(to);
  const base = { day: 'numeric', month: 'short' } as const;
  const sameYear = start.getFullYear() === end.getFullYear();
  return `${start.toLocaleDateString(undefined, base)} – ${end.toLocaleDateString(
    undefined,
    sameYear ? base : { ...base, year: 'numeric' },
  )}`;
}

function dayLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const UPCOMING_LOOK: Record<UpcomingItem['type'], { icon: IconName; label: string }> = {
  record: { icon: 'receipt-text-outline', label: 'Saved entry' },
  task: { icon: 'checkbox-marked-circle-outline', label: 'Task' },
  recurring: { icon: 'calendar-refresh', label: 'Regular payment' },
};

const UPCOMING_FALLBACK = { icon: 'bell-outline' as IconName, label: 'Coming up' };

const INLINE_GLYPH = 16;

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <Stack gap="xs">
      <Text variant="statValue">{String(value)}</Text>
      <Text variant="caption" colorToken="textTertiary">
        {label}
      </Text>
    </Stack>
  );
}

function CategoryRow({
  displayName,
  label,
  percent,
  unlabelled,
}: {
  displayName: string;
  label: string | null;
  percent: number;
  unlabelled: boolean;
}) {
  return (
    <Stack gap="xs">
      <Row between gap="sm" align="center">
        <Text variant="bodySmall" numberOfLines={1} style={{ flex: 1 }}>
          {displayName}
        </Text>
        {label ? <Text variant="monoValue">{label}</Text> : null}
      </Row>
      <ProgressBar
        value={percent / 100}
        tone={unlabelled ? 'neutral' : 'accent'}
        accessibilityLabel={`${displayName}: ${label ?? 'no amount'}, ${percent} percent of what you spent`}
      />
      <Text variant="caption" colorToken="textTertiary">
        {`${percent}%`}
      </Text>
    </Stack>
  );
}

function CounterpartyRow({ row }: { row: RecapCounterparty }) {
  return (
    <Row between gap="md" align="center">
      <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
        <Text variant="bodyMedium" numberOfLines={1}>
          {row.name}
        </Text>
        <Text variant="caption" colorToken="textTertiary">
          {`${row.count} ${plural(row.count, 'entry', 'entries')}`}
        </Text>
      </Stack>
      {row.label ? <Text variant="monoValue">{row.label}</Text> : null}
    </Row>
  );
}

function UpcomingRow({ item }: { item: UpcomingItem }) {
  const look = UPCOMING_LOOK[item.type] ?? UPCOMING_FALLBACK;
  const figure = item.estimated ? item.estimatedAmountLabel ?? item.amountLabel : item.amountLabel;

  const amount = figure ? (item.estimated ? `About ${figure}` : figure) : null;
  const when = item.overdue ? `Was due ${dayLabel(item.at)}` : `Due ${dayLabel(item.at)}`;
  const recordId = item.recordId;
  const target = recordId
    ? () => router.push({ pathname: '/record/[id]', params: { id: recordId } })
    : item.taskId
      ? () => router.push('/tasks')
      : null;

  const body = (
    <Row between gap="md">
      <Row gap="md" style={{ flex: 1 }}>
        <IconTile icon={look.icon} size="md" tone={item.overdue ? 'warn' : 'accent'} />
        <Stack gap="xxs" style={{ flex: 1 }}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {item.title}
          </Text>
          <Text variant="caption" colorToken={item.overdue ? 'textAccent' : 'textTertiary'}>
            {`${look.label} · ${when}`}
          </Text>
        </Stack>
      </Row>
      {amount ? <Text variant="monoValue">{amount}</Text> : null}
    </Row>
  );

  if (!target) return body;
  return (
    <Pressable
      onPress={target}
      accessibilityRole="button"
      accessibilityLabel={`${look.label}. ${item.title}. ${when}.${amount ? ` ${amount}.` : ''} Open it`}
    >
      {body}
    </Pressable>
  );
}

function highlightText(highlight: RecapHighlight, period: RecapPeriod): string | null {
  const span = spanWord(period);
  switch (highlight.kind) {
    case 'spent':
      return highlight.amountLabel ? `You spent ${highlight.amountLabel}.` : null;
    case 'top_category':
      return highlight.amountLabel
        ? `Most went on ${highlight.category} — ${highlight.amountLabel}.`
        : null;
    case 'biggest_payment':
      if (!highlight.amountLabel) return null;
      return highlight.counterparty
        ? `Your biggest single payment was ${highlight.amountLabel}, to ${highlight.counterparty}.`
        : `Your biggest single payment was ${highlight.amountLabel}.`;
    case 'tasks_overdue':
      return `${highlight.count} ${highlight.count === 1 ? 'task is' : 'tasks are'} overdue.`;
    case 'spend_change':
      if (!highlight.amountLabel) return null;
      return `You spent ${highlight.amountLabel} ${highlight.direction} than last ${span}.`;
    case 'received':
      return highlight.amountLabel ? `You received ${highlight.amountLabel}.` : null;
    case 'tasks_done':
      return `You finished ${highlight.count} ${highlight.count === 1 ? 'task' : 'tasks'}.`;
    case 'meetings_recorded':
      return `You recorded ${highlight.count} ${highlight.count === 1 ? 'meeting' : 'meetings'}.`;
  }
}

const RESTATED: ReadonlySet<RecapHighlight['kind']> = new Set<RecapHighlight['kind']>([
  'spent',
  'received',
  'spend_change',
  'top_category',
  'tasks_done',
  'tasks_overdue',
  'meetings_recorded',
]);

function summaryText(recap: DaybookRecap, range: string): string {
  const span = spanWord(recap.period);
  const lines: string[] = [`D-Detect — your ${span}, ${range}`];

  if (recap.spentLabel) lines.push(`Spent: ${recap.spentLabel}`);
  if (recap.receivedLabel && recap.receivedMinor > 0) lines.push(`Money in: ${recap.receivedLabel}`);
  if (recap.previous?.deltaLabel) {
    const direction = recap.previous.deltaMinor > 0 ? 'more' : 'less';
    lines.push(`${recap.previous.deltaLabel} ${direction} than the ${span} before`);
  }

  const categories = orderedCategories(
    recap.byCategory.map((row) => ({ name: row.category, amountMinor: row.minor, label: row.label })),
  ).slice(0, 3);
  for (const row of categories) {
    if (row.label) lines.push(`${row.displayName}: ${row.label}`);
  }

  const top = recap.topCounterparties[0];
  if (top?.label) lines.push(`Paid most to ${top.name}: ${top.label}`);
  lines.push(`${recap.records} ${plural(recap.records, 'entry', 'entries')} saved`);

  return lines.join('\n');
}

export default function RecapScreen() {
  const theme = useTheme();
  const toast = useToast();
  const [period, setPeriod] = useState<RecapPeriod>('week');
  const [recap, setRecap] = useState<DaybookRecap | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (which: RecapPeriod) => {
    const request = ++generation.current;
    try {

      const [next, ahead] = await Promise.all([
        getRecap(which),
        getUpcoming().catch((): UpcomingItem[] => []),
      ]);
      if (request !== generation.current) return;
      setRecap(next);
      setUpcoming(ahead);
      setError(null);
    } catch (err) {
      if (request === generation.current) setError(err);
    } finally {
      if (request === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(period);
      return () => {
        generation.current += 1;
      };
    }, [load, period]),
  );

  function selectPeriod(next: RecapPeriod) {
    if (next === period) return;
    generation.current += 1;
    setPeriod(next);
    setRecap(null);
    setUpcoming([]);
    setError(null);
    setLoading(true);
  }

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load(period);
  }, [load, period]);

  async function shareSummary(current: DaybookRecap) {
    try {
      await Share.share({ message: summaryText(current, rangeLabel(current.from, current.to)) });
    } catch {
      toast.show({ message: 'This summary could not be shared from here.', tone: 'warn' });
    }
  }

  const span = spanWord(period);
  const previous = recap?.previous ?? null;
  const categories = recap
    ? orderedCategories(
        recap.byCategory.map((row) => ({
          name: row.category,
          amountMinor: row.minor,
          label: row.label,
          percent: Math.round(Math.max(0, Math.min(1, row.share)) * 100),
        })),
      )
    : [];
  const notes = recap
    ? recap.highlights.flatMap((highlight) => {
        if (RESTATED.has(highlight.kind)) return [];
        const text = highlightText(highlight, recap.period);
        return text ? [{ kind: highlight.kind, text }] : [];
      })
    : [];
  const counts = recap
    ? [
        { value: recap.records, label: plural(recap.records, 'entry saved', 'entries saved') },
        { value: recap.meetings, label: plural(recap.meetings, 'meeting', 'meetings') },
        { value: recap.tasksDone, label: plural(recap.tasksDone, 'thing done', 'things done') },
      ].filter((stat) => stat.value > 0)
    : [];

  const nothingSaved = Boolean(
    recap && recap.records === 0 && recap.meetings === 0 && recap.tasksDone === 0,
  );
  const deltaTone = !previous
    ? theme.colors.textTertiary
    : previous.deltaMinor > 0
      ? theme.tone('danger').fg
      : previous.deltaMinor < 0
        ? theme.tone('ok').fg
        : theme.colors.textTertiary;

  return (
    <ScreenScroll
      title="Recap"
      overline="Looking back"
      back
      onRefresh={onRefresh}
      refreshing={refreshing}
      {...(recap && !nothingSaved
        ? {
            actions: [
              {
                icon: 'share-variant' as IconName,
                label: 'Share this summary',
                onPress: () => void shareSummary(recap),
              },
            ],
          }
        : {})}
    >
      <Stack gap="lg">
        <SegmentedControl options={PERIODS} value={period} onChange={selectPeriod} />

        {recap ? (
          <Text variant="caption" colorToken="textTertiary">
            {rangeLabel(recap.from, recap.to)}
          </Text>
        ) : null}

        {error && recap ? (

          <ErrorState
            compact
            title="These figures may be out of date"
            message={readableError(error, 'Your recap could not be loaded right now. Please try again.')}
            onRetry={onRefresh}
          />
        ) : null}

        {loading && !recap ? (
          <SkeletonList count={4} />
        ) : error && !recap ? (
          <ErrorState
            message={readableError(error, 'Your recap could not be loaded right now. Please try again.')}
            onRetry={onRefresh}
          />
        ) : recap ? (
          nothingSaved ? (

            <Stack gap="lg">
              {recap.tasksOverdue > 0 ? (
                <Stack gap="sm">
                  <Notice
                    tone="warn"
                    icon="clock-alert-outline"
                    message={`${recap.tasksOverdue} ${plural(recap.tasksOverdue, 'thing you meant to do is', 'things you meant to do are')} past their date.`}
                  />
                  <Button
                    label="Open your list"
                    variant="secondary"
                    size="sm"
                    icon="arrow-right"
                    iconTrailing
                    onPress={() => router.push('/tasks')}
                  />
                </Stack>
              ) : null}
              <EmptyState
                icon="calendar-blank-outline"
                title="Nothing to look back on yet"
                message={`Nothing was saved in this ${span}. Add a payment, a bill or a receipt and your recap fills itself in.`}
                action={{
                  label: 'Add a payment',
                  icon: 'plus',
                  onPress: () => router.push('/capture'),
                }}
                {...(period === 'week'
                  ? {
                      secondaryAction: {
                        label: 'Look at the month instead',
                        icon: 'calendar-month-outline',
                        onPress: () => selectPeriod('month'),
                      },
                    }
                  : {})}
              />
            </Stack>
          ) : (
            <Stack gap="lg">
              <GlassSurface variant="hero" padding="xl">
                <Stack gap="lg">
                  {recap.spentLabel ? (
                    <>
                      <Row between gap="lg" align="flex-start">
                        <Stack gap="xs">
                          <Text variant="overline" colorToken="textTertiary">
                            Spent
                          </Text>
                          <Text variant="statValue">{recap.spentLabel}</Text>
                        </Stack>
                        {recap.receivedLabel && recap.receivedMinor > 0 ? (
                          <Stack gap="xs" align="flex-end">
                            <Text variant="overline" colorToken="textTertiary">
                              Money in
                            </Text>
                            <Text variant="statValue" tone="ok">
                              {recap.receivedLabel}
                            </Text>
                          </Stack>
                        ) : null}
                      </Row>
                      {previous ? (

                        <Row gap="xs" align="center">
                          <Icon
                            name={
                              previous.deltaMinor > 0
                                ? 'arrow-up'
                                : previous.deltaMinor < 0
                                  ? 'arrow-down'
                                  : 'minus'
                            }
                            size={INLINE_GLYPH}
                            color={deltaTone}
                          />
                          <Text variant="bodySmall" style={{ color: deltaTone, flex: 1 }}>
                            {previous.deltaLabel
                              ? `${previous.deltaLabel} ${previous.deltaMinor > 0 ? 'more' : 'less'} than the ${span} before`
                              : `The same as the ${span} before`}
                          </Text>
                        </Row>
                      ) : null}
                    </>
                  ) : (
                    <Text variant="body" colorToken="textSecondary">
                      {`Nothing with an amount on it was saved this ${span}.`}
                    </Text>
                  )}
                  <Divider />
                  <Button
                    label="See the entries behind this"
                    variant="ghost"
                    size="sm"
                    icon="arrow-right"
                    iconTrailing
                    onPress={() => router.push({ pathname: '/(tabs)', params: { filter: 'money' } })}
                  />
                </Stack>
              </GlassSurface>

              {counts.length || recap.tasksOverdue > 0 ? (
                <GlassSurface padding="xl">
                  <Stack gap="lg">
                    {counts.length ? (
                      <Row between gap="md" wrap>
                        {counts.map((stat) => (
                          <Stat key={stat.label} value={stat.value} label={stat.label} />
                        ))}
                      </Row>
                    ) : null}
                    {recap.tasksOverdue > 0 ? (
                      <Pressable
                        onPress={() => router.push('/tasks')}
                        accessibilityRole="button"
                        accessibilityLabel={`${recap.tasksOverdue} ${plural(recap.tasksOverdue, 'thing is', 'things are')} past their date. Open your list`}
                      >
                        <Row gap="xs" align="center">
                          <Text variant="caption" tone="warn" style={{ flex: 1 }}>
                            {`${recap.tasksOverdue} ${plural(recap.tasksOverdue, 'thing you meant to do is', 'things you meant to do are')} past their date`}
                          </Text>
                          <Icon name="arrow-right" size={INLINE_GLYPH} color={theme.tone('warn').fg} />
                        </Row>
                      </Pressable>
                    ) : null}
                  </Stack>
                </GlassSurface>
              ) : null}

              {categories.length ? (
                <GlassSurface padding="xl">
                  <Stack gap="lg">
                    <Stack gap="xxs">
                      <Text variant="subheading">{`What this ${span} went on`}</Text>
                      <Text variant="caption" colorToken="textTertiary">
                        Biggest first.
                      </Text>
                    </Stack>
                    <Stack gap="md">
                      {categories.map((row) => (
                        <CategoryRow
                          key={row.name}
                          displayName={row.displayName}
                          label={row.label}
                          percent={row.percent}
                          unlabelled={row.unlabelled}
                        />
                      ))}
                    </Stack>
                  </Stack>
                </GlassSurface>
              ) : null}

              {recap.topCounterparties.length ? (
                <GlassSurface padding="xl">
                  <Stack gap="lg">
                    <Text variant="subheading">Who you paid most</Text>
                    <Stack gap="none">
                      {recap.topCounterparties.map((row, index) => (
                        <View key={row.name}>
                          {index > 0 ? <Divider spacing="md" /> : null}
                          <CounterpartyRow row={row} />
                        </View>
                      ))}
                    </Stack>
                  </Stack>
                </GlassSurface>
              ) : null}

              {upcoming.length ? (
                <GlassSurface padding="xl">
                  <Stack gap="lg">
                    <Stack gap="xxs">
                      <Text variant="subheading">What is coming up</Text>
                      <Text variant="caption" colorToken="textTertiary">
                        Tap anything here to open it.
                      </Text>
                    </Stack>
                    <Stack gap="none">
                      {upcoming.slice(0, 4).map((item, index) => (
                        <View key={item.id}>
                          {index > 0 ? <Divider spacing="md" /> : null}
                          <UpcomingRow item={item} />
                        </View>
                      ))}
                    </Stack>
                  </Stack>
                </GlassSurface>
              ) : null}

              {notes.length ? (
                <GlassSurface padding="xl">
                  <Stack gap="md">
                    <Text variant="subheading">Worth noting</Text>
                    {}
                    {notes.map((note, index) => (
                      <Text key={`${note.kind}-${index}`} variant="body" colorToken="textSecondary">
                        {note.text}
                      </Text>
                    ))}
                  </Stack>
                </GlassSurface>
              ) : null}

              <Stack gap="md">
                <Button
                  label="See this month as it stands"
                  variant="ghost"
                  size="sm"
                  icon="wallet-outline"
                  onPress={() => router.push('/money')}
                />
                <Text variant="caption" colorToken="textTertiary">
                  Counted from the entries you saved between those two dates.
                </Text>
              </Stack>
            </Stack>
          )
        ) : null}
      </Stack>
    </ScreenScroll>
  );
}
