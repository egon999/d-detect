import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  View,
  type SectionListProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  answerRecord,
  ApiError,
  buildTimeline,
  dayHeading,
  entryTime,
  getAttention,
  getDigest,
  getRecord,
  inProgressKey,
  inProgressRecordIds,
  isMeetingInProgress,
  jumpSummary,
  listMeetings,
  listRecordPage,
  meetingTime,
  meetingsUnchanged,
  monthLabel,
  pollDelayMs,
  readableError,
  recentMonths,
  recordsUnchanged,
  retryMeeting,
  retryRecord,
  skipQuestion,
  startOfMonthKey,
  useFileSource,
  type Attention,
  type DaybookRecord,
  type Digest,
  type Meeting,
  type MonthSelection,
  type TimelineEntry,
} from '@api';
import {
  BORDER_WIDTH,
  Button,
  Chip,
  CountBadge,
  EmptyState,
  ErrorState,
  GlassSurface,
  Icon,
  IconTile,
  IndeterminateBar,
  LAYOUT,
  Notice,
  Pressable,
  PulseDot,
  Row,
  Screen,
  ScreenHeaderBar,
  SegmentedControl,
  ShinyText,
  Skeleton,
  SPACING,
  SpotlightCard,
  Stack,
  Text,
  TextField,
  TYPE,
  useTheme,
  useToast,
  type IconName,
  type Tone,
} from '@ui';
import { useSession } from '@services';
import { useTranslation } from '@i18n';

const PAGE_SIZE = 30;

const REFRESH_MAX = 200;

const MEETING_WINDOW = 30;
const MEETING_WINDOW_MAX = 300;

const MONTHS_OFFERED = 24;

const POLL_FANOUT = 6;

const HANDOVER_START = 18;
const HANDOVER_END = 62;

const KIND_ICONS: Record<string, IconName> = {
  payment: 'cash',
  purchase: 'cart-outline',
  bill: 'receipt-text-outline',
  receipt: 'receipt',
  ticket: 'ticket-confirmation-outline',
  travel: 'airplane',
  document: 'file-document-outline',
  message: 'message-text-outline',
  note: 'note-text-outline',
  photo: 'image-outline',
};

const MONEY_KINDS = new Set(['payment', 'purchase', 'bill', 'receipt', 'travel']);

const PAPER_KINDS = new Set(['document', 'ticket', 'note', 'message', 'photo']);

type Facet = 'all' | 'money' | 'meetings' | 'papers';

const FACETS: ReadonlyArray<{ value: Facet; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'money', label: 'Money' },
  { value: 'meetings', label: 'Meetings' },
  { value: 'papers', label: 'Papers' },
];

function greeting(now: number, name: string | null): string {
  const hour = new Date(now).getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = name?.trim().split(/\s+/)[0] ?? '';
  return first ? `${part}, ${first}` : part;
}

function timeOfDay(at: number, precision: string | null): string | null {
  if (precision === 'month' || precision === 'year') return null;
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

type ListRow = TimelineEntry;

type DaySection = { key: string; at: number; heading: string };
type DaySectionData = DaySection & { data: ListRow[] };

const AnimatedSectionList = Animated.createAnimatedComponent(SectionList) as unknown as <
  ItemT,
  SectionT,
>(
  props: SectionListProps<ItemT, SectionT> & { onScroll?: ReturnType<typeof Animated.event> },
) => React.ReactElement;

function EntryThumb({ fileId, icon, tone }: { fileId: string | null; icon: IconName; tone: Tone }) {
  const theme = useTheme();
  const [broken, setBroken] = useState(false);
  const file = useFileSource(broken ? null : fileId);
  const showImage = fileId !== null && !broken && !file.failed && file.source !== null;

  return (
    <View style={[styles.thumb, { borderRadius: theme.radius.md }]}>
      <IconTile icon={icon} tone={tone} size="lg" />
      {showImage && file.source ? (
        <Image
          source={file.source}
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceSunken },
          ]}
          contentFit="cover"
          transition={theme.motion.duration.normal}
          onError={() => setBroken(true)}
          accessibilityLabel="The original"
        />
      ) : null}
    </View>
  );
}

function AnswerBlock({
  record,
  onUpdated,
}: {
  record: DaybookRecord;
  onUpdated: (next: DaybookRecord) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const question = record.question;

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      if (!text || busy) return;
      setBusy(true);
      try {
        const next = await answerRecord(record.id, text);
        onUpdated(next);
        setDraft('');
        setTyping(false);
        toast.show({ message: 'Saved. Thank you.', tone: 'ok' });
      } catch (error) {
        toast.show({ message: readableError(error), tone: 'danger' });
      } finally {
        setBusy(false);
      }
    },
    [busy, onUpdated, record.id, toast],
  );

  const skip = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await skipQuestion(record.id);
      onUpdated(next);
      toast.show({ message: 'Kept without it.', tone: 'ok' });
    } catch (error) {
      toast.show({ message: readableError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }, [busy, onUpdated, record.id, toast]);

  if (!question) {
    return (
      <Text variant="bodySmall" tone="accent">
        One detail is still missing. Open this to fill it in.
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      <Text variant="bodySmall" tone="accent">
        {question.prompt}
      </Text>

      {typing ? (
        <Stack gap="sm">
          <TextField
            value={draft}
            onChangeText={setDraft}
            placeholder="Your answer"
            accessibilityLabel={question.prompt}
            editable={!busy}
            onSubmitEditing={() => void submit(draft)}
            returnKeyType="done"
            autoFocus
          />
          <Row gap="sm">
            <Button
              label="Save"
              size="sm"
              onPress={() => void submit(draft)}
              loading={busy}
              disabled={draft.trim().length === 0}
            />
            <Button
              label="Cancel"
              size="sm"
              variant="ghost"
              onPress={() => {
                setTyping(false);
                setDraft('');
              }}
            />
          </Row>
        </Stack>
      ) : (
        <Row gap="sm" wrap>
          {question.options.map((option) => (
            <Pressable
              key={option}
              onPress={() => void submit(option)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`${question.prompt} ${option}`}
              pressScale={0.97}
            >
              <Chip label={option} tone="accent" emphasis="outline" />
            </Pressable>
          ))}
          <Pressable
            onPress={() => setTyping(true)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Type a different answer"
            pressScale={0.97}
          >
            <Chip label="Something else" icon="pencil-outline" />
          </Pressable>
          <Pressable
            onPress={() => void skip()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Keep this without answering"
            accessibilityHint="Keeps the entry and stops asking"
            pressScale={0.97}
          >
            <Chip label="I don't know" />
          </Pressable>
        </Row>
      )}
    </Stack>
  );
}

function WorkingLine({ sentence }: { sentence: string }) {
  const theme = useTheme();

  return (
    <Row gap="sm" align="center">
      <PulseDot color={theme.tone('info').solid} />
      <Text variant="bodySmall" tone="info" style={styles.grow}>
        {sentence}
      </Text>
    </Row>
  );
}

function FailedBlock({
  message,
  hint,
  onRetry,
  busy,
  retryLabel = 'Try again',
}: {
  message: string;
  hint?: string;
  onRetry?: () => void;
  busy?: boolean;
  retryLabel?: string;
}) {
  return (
    <Stack gap="sm" align="flex-start">
      <Text variant="bodySmall" tone="warn">
        {message}
      </Text>
      {hint ? (
        <Text variant="caption" colorToken="textTertiary">
          {hint}
        </Text>
      ) : null}
      {onRetry ? (
        <Button
          label={retryLabel}
          size="sm"
          variant="secondary"
          icon="refresh"
          onPress={onRetry}
          loading={busy}
        />
      ) : null}
    </Stack>
  );
}

function RowCard({
  icon,
  tone,
  fileId,
  title,
  subtitle,
  trailing,
  openLabel,
  onOpen,
  children,
}: {
  icon: IconName;
  tone: Tone;
  fileId: string | null;
  title: string;
  subtitle: string | null;
  trailing?: React.ReactNode;
  openLabel: string;
  onOpen: () => void;
  children?: React.ReactNode;
}) {
  const theme = useTheme();

  return (
    <GlassSurface padding="lg" radius="lg">
      <Stack gap="md">
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={openLabel}
          dimOnPress
          pressScale={1}
          contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
        >
          <EntryThumb fileId={fileId} icon={icon} tone={tone} />

          <Stack gap="xxs" style={styles.grow}>
            <Row between gap="sm" align="flex-start">
              <Text variant="bodyMedium" numberOfLines={2} style={styles.grow}>
                {title}
              </Text>
              {trailing}
            </Row>
            {subtitle ? (
              <Text variant="caption" colorToken="textTertiary" numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </Stack>

          <Icon name="chevron-right" size={18} color={theme.colors.textTertiary} />
        </Pressable>

        {children}
      </Stack>
    </GlassSurface>
  );
}

const EntryRow = memo(function EntryRow({
  record,
  slow,
  onUpdated,
}: {
  record: DaybookRecord;
  slow: boolean;
  onUpdated: (next: DaybookRecord) => void;
}) {
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);

  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const next = await retryRecord(record.id);
      onUpdated(next);
      toast.show({ message: 'Reading this again.', tone: 'ok' });
    } catch (error) {
      toast.show({ message: readableError(error), tone: 'danger' });
    } finally {
      setRetrying(false);
    }
  }, [onUpdated, record.id, retrying, toast]);

  const tone: Tone =
    record.status === 'failed'
      ? 'danger'
      : record.status === 'unreadable'
        ? 'warn'
        : record.status === 'needs_context'
          ? 'accent'
          : record.status === 'processing'
            ? 'info'
            : record.direction === 'in'
              ? 'ok'
              : 'neutral';

  const at = entryTime(record);
  const subtitle =
    [record.counterparty, record.category, timeOfDay(at, record.occurredPrecision)]
      .filter((part): part is string => Boolean(part))
      .join(' · ') || null;

  const title = record.title || (record.status === 'processing' ? 'Just added' : 'No title yet');

  return (
    <RowCard
      icon={KIND_ICONS[record.kind] ?? 'shape-outline'}
      tone={tone}
      fileId={record.fileId}
      title={title}
      subtitle={subtitle}
      openLabel={`Open ${title}`}
      onOpen={() => router.push({ pathname: '/record/[id]', params: { id: record.id } })}
      trailing={
        record.amountLabel ? (
          <Text variant="bodyMedium" mono tone={record.direction === 'in' ? 'ok' : 'neutral'}>
            {record.direction === 'in' ? `+${record.amountLabel}` : record.amountLabel}
          </Text>
        ) : null
      }
    >
      {record.status === 'processing' ? (
        <Stack gap="sm" align="flex-start">
          {}
          <WorkingLine sentence={record.progress ?? 'Reading this now.'} />
          {slow ? (
            <Stack gap="sm" align="flex-start">
              <Text variant="caption" colorToken="textTertiary">
                This is taking longer than it should.
              </Text>
              <Button
                label="Start again"
                size="sm"
                variant="secondary"
                icon="refresh"
                onPress={() => void retry()}
                loading={retrying}
              />
            </Stack>
          ) : null}
        </Stack>
      ) : null}

      {record.status === 'needs_context' ? (
        <AnswerBlock record={record} onUpdated={onUpdated} />
      ) : null}

      {record.status === 'unreadable' ? (
        <FailedBlock
          message="This one was too unclear to read."
          hint="A brighter photo usually works. You can also open it and type the details yourself."
          onRetry={record.fileId ? () => void retry() : undefined}
          busy={retrying}
        />
      ) : null}

      {record.status === 'failed' ? (
        <FailedBlock
          message="This didn't finish."
          hint={record.fileId ? undefined : 'Open it to type the details yourself.'}
          onRetry={record.fileId ? () => void retry() : undefined}
          busy={retrying}
        />
      ) : null}
    </RowCard>
  );
});

const MeetingRow = memo(function MeetingRow({
  meeting,
  slow,
  onUpdated,
}: {
  meeting: Meeting;
  slow: boolean;
  onUpdated: (next: Meeting) => void;
}) {
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);

  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const next = await retryMeeting(meeting.id);
      onUpdated(next);
      toast.show({ message: 'Writing this up again.', tone: 'ok' });
    } catch (error) {
      toast.show({ message: readableError(error), tone: 'danger' });
    } finally {
      setRetrying(false);
    }
  }, [meeting.id, onUpdated, retrying, toast]);

  const working = isMeetingInProgress(meeting);
  const openTasks = meeting.tasks.filter((task) => task.doneAt === null).length;
  const title = meeting.title || 'Recording';
  const subtitle =
    [
      meeting.durationMs ? `${Math.max(1, Math.round(meeting.durationMs / 60000))} min` : null,
      openTasks > 0 ? `${openTasks} ${openTasks === 1 ? 'thing to do' : 'things to do'}` : null,
      timeOfDay(meetingTime(meeting), null),
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · ') || null;

  return (
    <RowCard
      icon="microphone-outline"
      tone={meeting.status === 'failed' ? 'danger' : working ? 'info' : 'neutral'}
      fileId={null}
      title={title}
      subtitle={subtitle}
      openLabel={`Open ${title}`}
      onOpen={() => router.push({ pathname: '/meeting/[id]', params: { id: meeting.id } })}
    >
      {meeting.summary && !working ? (
        <Text variant="bodySmall" colorToken="textSecondary" numberOfLines={2}>
          {meeting.summary}
        </Text>
      ) : null}

      {}
      {working ? (
        <Stack gap="sm">
          <IndeterminateBar tone="info" accessibilityLabel="Writing up your notes" />
          <Text variant="caption" tone="info">
            {slow ? 'Still writing up your notes. Pull down to check.' : 'Writing up your notes'}
          </Text>
        </Stack>
      ) : null}

      {meeting.status === 'failed' ? (
        <FailedBlock
          message="This recording didn't come through."
          onRetry={() => void retry()}
          busy={retrying}
        />
      ) : null}
    </RowCard>
  );
});

function DayHeading({ heading }: { heading: string }) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.dayBand,
        { backgroundColor: theme.colors.backdrop.barFill, borderBottomColor: theme.colors.border },
      ]}
    >
      <Text variant="overline" uppercase colorToken="textSecondary" accessibilityRole="header">
        {heading}
      </Text>
    </View>
  );
}

function TodayBand({
  digest,
  onMoney,
  onWaiting,
}: {
  digest: Digest;
  onMoney: () => void;
  onWaiting: () => void;
}) {
  const theme = useTheme();
  const facts: Array<{
    key: string;
    icon: IconName;
    value: string;
    caption: string;
    tone?: Tone;
    onPress?: () => void;
    label?: string;
  }> = [];

  if (digest.today.spentLabel && digest.today.spentMinor > 0) {
    facts.push({
      key: 'spent',
      icon: 'cash',
      value: digest.today.spentLabel,
      caption: 'spent today',
      onPress: onMoney,
      label: `${digest.today.spentLabel} spent today. See your money.`,
    });
  }
  if (digest.today.recordCount > 0) {
    facts.push({
      key: 'saved',
      icon: 'check-circle-outline',
      value: String(digest.today.recordCount),
      caption: 'saved today',
    });
  }
  if (digest.needsContext > 0) {
    facts.push({
      key: 'waiting',
      icon: 'alert-circle-outline',
      value: String(digest.needsContext),
      caption: 'waiting on you',
      tone: 'accent',
      onPress: onWaiting,
      label: `${digest.needsContext} waiting on you. Show only these.`,
    });
  }

  if (facts.length === 0) return null;

  return (
    <SpotlightCard
      glowColor="rgba(43, 95, 217, 0.4)"
      edgeColor="rgba(56, 189, 248, 0.25)"
      borderRadius={20}
      style={{ padding: SPACING.lg, borderColor: 'rgba(56, 189, 248, 0.2)', borderWidth: 1 }}
    >
      <Stack gap="md" style={{ width: '100%' }}>
        <Row between align="center" style={{ width: '100%' }}>
          <Row gap="xs" align="center">
            <Icon name="clock-outline" size={14} color={theme.colors.accent} />
            <Text variant="overline" uppercase colorToken="textTertiary">
              Today's Overview
            </Text>
          </Row>
          <Text variant="caption" colorToken="textTertiary">
            Live updates
          </Text>
        </Row>
        <Row gap="md" align="stretch" style={{ width: '100%' }}>
          {facts.map((fact) => {
            const body = (
              <View
                style={{
                  flex: 1,
                  padding: SPACING.sm,
                  borderRadius: theme.radius.md,
                  backgroundColor: 'rgba(255, 255, 255, 0.04)',
                  borderWidth: 1,
                  borderColor: fact.tone === 'accent' ? 'rgba(56, 189, 248, 0.35)' : 'rgba(255, 255, 255, 0.06)',
                }}
              >
                <Stack gap="xxs">
                  <Row gap="xs" align="center">
                    <Icon name={fact.icon} size={14} color={fact.tone === 'accent' ? theme.colors.accent : theme.colors.textSecondary} />
                    <Text variant="statValue" mono tone={fact.tone}>
                      {fact.value}
                    </Text>
                  </Row>
                  <Text variant="caption" colorToken="textSecondary" numberOfLines={1}>
                    {fact.caption}
                  </Text>
                </Stack>
              </View>
            );

            return fact.onPress ? (
              <Pressable
                key={fact.key}
                onPress={fact.onPress}
                accessibilityRole="button"
                accessibilityLabel={fact.label ?? fact.caption}
                style={styles.grow}
                dimOnPress
                pressScale={0.97}
              >
                {body}
              </Pressable>
            ) : (
              <View key={fact.key} style={styles.grow}>
                {body}
              </View>
            );
          })}
        </Row>
      </Stack>
    </SpotlightCard>
  );
}

/**
 * The four other places in the app, as one quiet row.
 *
 * One entry each, with the server's own counts on the two that have them. The screen this
 * replaced offered three separate ways to reach the to-do list and no way at all to reach two
 * of these, which is the same mistake twice: a link repeated is a decision not made, and a
 * screen only reachable from a card that has gone is a screen nobody will find again.
 */
function QuickRow({ digest, attention }: { digest: Digest | null; attention: Attention | null }) {
  const theme = useTheme();

  const destinations: Array<{
    key: string;
    icon: IconName;
    label: string;
    hint: string;
    count?: number;
    onPress: () => void;
  }> = [
    {
      key: 'ask',
      icon: 'star-four-points-outline',
      label: 'Assistant',
      hint: 'Ask questions about your meetings, records, and expenses',
      onPress: () => router.push('/ask'),
    },
    {
      key: 'tasks',
      icon: 'checkbox-marked-circle-outline',
      label: 'To-Dos',
      hint: 'Everything you still have to do',
      ...(digest && digest.openTasks > 0 ? { count: digest.openTasks } : {}),
      onPress: () => router.push('/tasks'),
    },
    {
      key: 'attention',
      icon: 'bell-outline',
      label: 'Attention',
      hint: 'Dates running out, charges worth checking, action items',
      ...(attention && attention.total > 0 ? { count: attention.total } : {}),
      onPress: () => router.push('/attention'),
    },
    {
      key: 'recap',
      icon: 'calendar-text-outline',
      label: 'Recap',
      hint: 'Your week and your month, added up',
      onPress: () => router.push('/recap'),
    },
  ];

  return (
    <GlassSurface padding="sm" radius="lg">
      <Row gap="xs" align="stretch" style={{ width: '100%' }}>
        {destinations.map((destination) => (
          <Pressable
            key={destination.key}
            onPress={destination.onPress}
            accessibilityRole="button"
            accessibilityLabel={destination.label}
            accessibilityHint={destination.hint}
            style={styles.grow}
            pressScale={0.96}
            dimOnPress
            contentStyle={{
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: theme.spacing.sm,
              paddingHorizontal: theme.spacing.xs,
              borderRadius: theme.radius.md,
              gap: 4,
            }}
          >
            <Row gap="xs" align="center" justify="center">
              <Icon name={destination.icon} size={18} color={theme.colors.accent} />
              {typeof destination.count === 'number' ? (
                <CountBadge count={destination.count} tone="accent" />
              ) : null}
            </Row>
            <Text variant="caption" colorToken="text" numberOfLines={1} style={{ fontWeight: '500' }}>
              {destination.label}
            </Text>
          </Pressable>
        ))}
      </Row>
    </GlassSurface>
  );
}

function MonthStrip({
  months,
  selected,
  onSelect,
}: {
  months: ReadonlyArray<{ key: string; label: string }>;
  selected: MonthSelection;
  onSelect: (next: MonthSelection) => void;
}) {
  const theme = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}

      contentContainerStyle={[
        styles.monthStrip,
        { gap: theme.spacing.sm, paddingHorizontal: LAYOUT.screenPadding },
      ]}
    >
      {[{ key: 'newest' as const, label: 'Newest' }, ...months].map((month) => {
        const active = month.key === selected;
        return (
          <Pressable
            key={month.key}
            onPress={() => onSelect(month.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={
              month.key === 'newest' ? 'Show the newest first' : `Show ${month.label}`
            }
            pressScale={0.96}
          >
            <Chip
              label={month.label}
              tone={active ? 'accent' : 'neutral'}
              emphasis={active ? 'solid' : 'outline'}
            />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function RowSkeleton() {
  return (
    <GlassSurface padding="lg" radius="lg">
      <Row gap="md">
        <Skeleton width={LAYOUT.tileSizeLarge} height={LAYOUT.tileSizeLarge} radius="md" />
        <Stack gap="xs" style={styles.grow}>
          <Skeleton width="70%" height={TYPE.bodyMedium.lineHeight} />
          <Skeleton width="40%" height={TYPE.caption.lineHeight} />
        </Stack>
      </Row>
    </GlassSurface>
  );
}

function TimelineSkeleton() {
  const theme = useTheme();

  return (
    <View>
      <View
        style={[
          styles.dayBand,
          {
            backgroundColor: theme.colors.backdrop.barFill,
            borderBottomColor: theme.colors.border,
          },
        ]}
      >
        <Skeleton width={72} height={TYPE.overline.lineHeight} />
      </View>

      <Stack gap="md" style={styles.skeletonBody}>
        {[0, 1, 2].map((index) => (
          <RowSkeleton key={index} />
        ))}
      </Stack>
    </View>
  );
}

export default function HomeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ filter?: string }>();

  const [records, setRecords] = useState<DaybookRecord[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const recordsRef = useRef<DaybookRecord[]>([]);
  const meetingsRef = useRef<Meeting[]>([]);
  const cursorRef = useRef<number | null>(null);
  const meetingWindowRef = useRef(MEETING_WINDOW);

  const [exhausted, setExhausted] = useState(false);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [attention, setAttention] = useState<Attention | null>(null);

  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [sideError, setSideError] = useState(false);

  const anchorRef = useRef<number | null>(null);

  const [facet, setFacet] = useState<Facet>('all');
  const [onlyWaiting, setOnlyWaiting] = useState(false);

  const [selection, setSelection] = useState<MonthSelection>('newest');
  const [focused, setFocused] = useState(false);
  const [pollTicks, setPollTicks] = useState(0);
  const [pollStalled, setPollStalled] = useState(false);
  const pollAttempt = useRef(0);
  const pollWatching = useRef('');

  const setRecordList = useCallback((next: DaybookRecord[]) => {
    recordsRef.current = next;
    setRecords(next);
  }, []);

  const setMeetingList = useCallback((next: Meeting[]) => {
    meetingsRef.current = next;
    setMeetings(next);
  }, []);

  const loadSummary = useCallback(async () => {
    const [digestResult, attentionResult] = await Promise.allSettled([getDigest(), getAttention()]);
    if (digestResult.status === 'fulfilled') setDigest(digestResult.value);
    if (attentionResult.status === 'fulfilled') setAttention(attentionResult.value);
    setSideError(digestResult.status === 'rejected' || attentionResult.status === 'rejected');
  }, []);

  const load = useCallback(
    async (mode: 'first' | 'refresh') => {
      const limit =
        mode === 'first'
          ? PAGE_SIZE
          : Math.min(Math.max(PAGE_SIZE, recordsRef.current.length), REFRESH_MAX);
      const anchor = anchorRef.current;

      const [pageResult] = await Promise.allSettled([
        listRecordPage({ limit, before: anchor }),
        listMeetings(meetingWindowRef.current).then(
          (list) => {
            if (!meetingsUnchanged(meetingsRef.current, list)) setMeetingList(list);
          },
          () => setSideError(true),
        ),
        loadSummary(),
      ]);

      if (pageResult.status === 'fulfilled') {
        cursorRef.current = pageResult.value.nextCursor;
        setExhausted(pageResult.value.nextCursor === null);
        if (!recordsUnchanged(recordsRef.current, pageResult.value.records)) {
          setRecordList(pageResult.value.records);
        }
        setTimelineError(null);
      } else {
        setTimelineError(readableError(pageResult.reason, t('home.errorTitle')));
      }

      setPhase('ready');
    },
    [loadSummary, setMeetingList, setRecordList],
  );

  const loadMore = useCallback(async () => {
    const before = cursorRef.current;
    if (loadingMoreRef.current || before === null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await listRecordPage({ limit: PAGE_SIZE, before });
      const seen = new Set(recordsRef.current.map((record) => record.id));
      setRecordList([...recordsRef.current, ...page.records.filter((row) => !seen.has(row.id))]);
      cursorRef.current = page.nextCursor;
      setExhausted(page.nextCursor === null);
      setTimelineError(null);

      const widened = Math.min(meetingWindowRef.current + MEETING_WINDOW, MEETING_WINDOW_MAX);
      if (widened !== meetingWindowRef.current) {
        meetingWindowRef.current = widened;
        try {
          setMeetingList(await listMeetings(widened));
        } catch {

          setSideError(true);
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        cursorRef.current = null;
        anchorRef.current = null;
        setSelection('newest');
        loadingMoreRef.current = false;
        setLoadingMore(false);
        await load('refresh');
        return;
      }
      setTimelineError(readableError(error, 'The rest of your timeline could not be loaded.'));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [load, setMeetingList, setRecordList]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setPollStalled(false);
    pollAttempt.current = 0;
    setSelection('newest');
    anchorRef.current = null;
    try {
      await load('refresh');
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const jumpTo = useCallback(
    (next: MonthSelection) => {
      const at = next === 'newest' ? null : startOfMonthKey(next);

      if (next !== 'newest' && at === null) return;

      setSelection(next);
      anchorRef.current = at;
      setPhase('loading');
      setPollStalled(false);
      pollAttempt.current = 0;

      setRecordList([]);
      cursorRef.current = null;
      setExhausted(false);
      void load('first');
    },
    [load, setRecordList],
  );

  const jumped = useMemo(() => {
    if (selection === 'newest') return null;
    const at = startOfMonthKey(selection);
    if (at === null) return null;
    return { key: selection, label: monthLabel(at, Date.now()) };
  }, [selection]);

  const months = useMemo(() => recentMonths(Date.now(), MONTHS_OFFERED), []);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      void load('refresh');
      return () => setFocused(false);
    }, [load]),
  );

  const onRecordUpdated = useCallback(
    (next: DaybookRecord) => {
      setRecordList(recordsRef.current.map((row) => (row.id === next.id ? next : row)));
      void loadSummary();
    },
    [loadSummary, setRecordList],
  );

  const onMeetingUpdated = useCallback(
    (next: Meeting) => {
      setMeetingList(meetingsRef.current.map((row) => (row.id === next.id ? next : row)));
    },
    [setMeetingList],
  );

  const check = useCallback(async () => {
    const pending = inProgressRecordIds(recordsRef.current).slice(0, POLL_FANOUT);
    const meetingPending = meetingsRef.current.some(isMeetingInProgress);
    if (pending.length === 0 && !meetingPending) return;

    const [recordResults, meetingList] = await Promise.all([
      Promise.allSettled(pending.map((id) => getRecord(id))),
      meetingPending
        ? listMeetings(meetingWindowRef.current).then(
            (list) => list,
            () => null,
          )
        : Promise.resolve(null),
    ]);

    let settled = false;

    const updates = new Map<string, DaybookRecord>();
    for (const result of recordResults) {
      if (result.status === 'fulfilled') updates.set(result.value.id, result.value);
    }
    if (updates.size > 0) {
      const next = recordsRef.current.map((row) => {
        const update = updates.get(row.id);
        if (!update) return row;
        if (update.status !== row.status) settled = true;
        return update.updatedAt === row.updatedAt &&
          update.status === row.status &&
          update.progress === row.progress
          ? row
          : update;
      });
      if (!recordsUnchanged(recordsRef.current, next)) setRecordList(next);
    }

    if (meetingList && !meetingsUnchanged(meetingsRef.current, meetingList)) {
      setMeetingList(meetingList);
      settled = true;
    }

    if (settled) void loadSummary();
  }, [loadSummary, setMeetingList, setRecordList]);

  const pending = useMemo(() => inProgressKey(records, meetings), [records, meetings]);

  useEffect(() => {
    if (!focused || pending === '') {
      pollAttempt.current = 0;
      pollWatching.current = '';
      return;
    }

    if (pollWatching.current !== pending) {
      pollWatching.current = pending;
      pollAttempt.current = 0;
      setPollStalled(false);
    }

    const delay = pollDelayMs(pollAttempt.current);
    if (delay === null) {
      setPollStalled(true);
      return;
    }

    const timer = setTimeout(() => {
      pollAttempt.current += 1;
      setPollTicks((count) => count + 1);
      void check();
    }, delay);

    return () => clearTimeout(timer);
  }, [check, focused, pending, pollTicks]);

  useEffect(() => {
    const incoming = params.filter;
    if (!incoming) return;
    if (incoming === 'waiting' || incoming === 'needs') {
      setOnlyWaiting(true);
      return;
    }
    const match = FACETS.find((option) => option.value === incoming);
    if (match) setFacet(match.value);
  }, [params.filter]);

  const facetOptions = useMemo<ReadonlyArray<{ value: Facet; label: string }>>(() => [
    { value: 'all', label: t('common.all') || 'All' },
    { value: 'money', label: t('home.filterMoney') || 'Money' },
    { value: 'meetings', label: t('home.filterMeetings') || 'Meetings' },
    { value: 'papers', label: t('home.filterNotes') || 'Papers' },
  ], [t]);

  const visibleRecords = useMemo(() => {
    if (facet === 'meetings') return [];
    if (facet === 'all' && !onlyWaiting) return records;
    return records.filter((record) => {
      if (onlyWaiting && record.status !== 'needs_context') return false;
      if (facet === 'money') return MONEY_KINDS.has(record.kind) || record.amountMinor !== null;
      if (facet === 'papers') return PAPER_KINDS.has(record.kind);
      return true;
    });
  }, [facet, onlyWaiting, records]);

  const visibleMeetings = useMemo(() => {
    if (onlyWaiting) return [];
    if (facet === 'money' || facet === 'papers') return [];
    return meetings;
  }, [facet, meetings, onlyWaiting]);

  const filtered = facet !== 'all' || onlyWaiting;

  const sections = useMemo<DaySectionData[]>(() => {
    const now = Date.now();

    return buildTimeline({
      records: visibleRecords,
      meetings: visibleMeetings,

      recordsExhausted: exhausted || filtered,
    }).map((day) => ({
      key: day.key,
      at: day.at,
      heading: dayHeading(day.at, now),
      data: day.data,
    }));
  }, [exhausted, filtered, visibleMeetings, visibleRecords]);

  const scrollY = useRef(new Animated.Value(0)).current;
  const handover = useMemo(() => {
    const compactIn = scrollY.interpolate({
      inputRange: [HANDOVER_START, HANDOVER_END],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    });
    return {
      onScroll: Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: true,
      }),
      compactOpacity: compactIn,
      compactOffset: scrollY.interpolate({
        inputRange: [HANDOVER_START, HANDOVER_END],
        outputRange: [7, 0],
        extrapolate: 'clamp',
      }),
      ruleOpacity: scrollY.interpolate({
        inputRange: [4, HANDOVER_START],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
      mastheadOpacity: scrollY.interpolate({
        inputRange: [0, HANDOVER_END * 0.78],
        outputRange: [1, 0],
        extrapolate: 'clamp',
      }),
    };
  }, [scrollY]);

  const keyExtractor = useCallback((item: ListRow) => item.key, []);

  const renderItem = useCallback(
    ({ item }: { item: ListRow }) => (
      <View style={styles.gutter}>
        {item.kind === 'entry' ? (
          <EntryRow record={item.record} slow={pollStalled} onUpdated={onRecordUpdated} />
        ) : (
          <MeetingRow meeting={item.meeting} slow={pollStalled} onUpdated={onMeetingUpdated} />
        )}
      </View>
    ),
    [onMeetingUpdated, onRecordUpdated, pollStalled],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: DaySection }) => <DayHeading heading={section.heading} />,
    [],
  );

  const onEndReached = useCallback(() => {
    void loadMore();
  }, [loadMore]);

  const openAdd = useCallback(() => router.push('/capture'), []);
  const openSearch = useCallback(() => router.push('/search'), []);
  const openTasks = useCallback(() => router.push('/(tabs)/tasks'), []);

  const actions = useMemo(
    () => [
      {
        icon: 'checkbox-marked-circle-outline' as IconName,
        label: 'Tasks',
        onPress: openTasks,
      },
      {
        icon: 'magnify' as IconName,
        label: 'Search everything you have saved',
        onPress: openSearch,
      },
      { icon: 'plus' as IconName, label: 'Add something', onPress: openAdd },
    ],
    [openAdd, openSearch, openTasks],
  );

  const todayLabel = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
    [],
  );

  const listHeader = (
    <View style={styles.gutter}>
      <Animated.View style={[styles.masthead, { opacity: handover.mastheadOpacity }]}>
        <Text variant="monoOverline" tone="accent" uppercase style={styles.overline}>
          {todayLabel}
        </Text>
        <Text variant="display" accessibilityRole="header">
          {t('home.title')}
        </Text>
        <Text variant="body" colorToken="textSecondary" style={styles.greeting}>
          {greeting(Date.now(), session.user?.displayName ?? null)}
        </Text>
      </Animated.View>

      <Stack gap="md" style={styles.headerBlocks}>
        {sideError ? (
          <Notice
            tone="warn"
            message="Some of this is out of date. Pull down to try again."
            onDismiss={() => setSideError(false)}
          />
        ) : null}

        {digest ? (
          <TodayBand
            digest={digest}
            onMoney={() => router.push('/money')}
            onWaiting={() => {
              setOnlyWaiting(true);
              setFacet('all');
            }}
          />
        ) : null}

        <QuickRow digest={digest} attention={attention} />

        {}
        <Stack gap="sm">
          {jumped ? <Notice tone="info" message={jumpSummary(jumped) ?? ''} /> : null}
          <MonthStrip months={months} selected={selection} onSelect={jumpTo} />
        </Stack>

        <Stack gap="sm">
          <SegmentedControl options={facetOptions} value={facet} onChange={setFacet} />
          {digest && digest.needsContext > 0 ? (
            <Row gap="sm">
              <Pressable
                onPress={() => setOnlyWaiting((on) => !on)}
                accessibilityRole="button"
                accessibilityState={{ selected: onlyWaiting }}
                accessibilityLabel={
                  onlyWaiting
                    ? 'Show everything again'
                    : `Show only the ${digest.needsContext} waiting on you`
                }
                pressScale={0.97}
              >
                <Chip
                  label={`Waiting on you (${digest.needsContext})`}
                  tone="accent"
                  emphasis={onlyWaiting ? 'solid' : 'outline'}
                  icon={onlyWaiting ? 'check' : 'account-question-outline'}
                />
              </Pressable>
            </Row>
          ) : null}
        </Stack>
      </Stack>
    </View>
  );

  const listFooter = (
    <View style={[styles.gutter, styles.footerBlock]}>
      {loadingMore ? <RowSkeleton /> : null}

      {!loadingMore && exhausted && sections.length > 0 ? (
        <Text variant="caption" colorToken="textTertiary" center>
          {jumped ? `That is everything from ${jumped.label} backwards.` : 'That is everything you have saved.'}
        </Text>
      ) : null}

      {timelineError && sections.length > 0 ? (
        <Notice tone="warn" message={timelineError} />
      ) : null}
    </View>
  );

  const listEmpty = (
    <View>
      {phase === 'loading' ? (
        <TimelineSkeleton />
      ) : timelineError ? (
        <ErrorState
          title={t('home.errorTitle')}
          message={timelineError}
          onRetry={() => void load(jumped ? 'first' : 'refresh')}
        />
      ) : jumped ? (
        <EmptyState
          icon="calendar-blank-outline"
          title={`Nothing in ${jumped.label}`}
          message="Nothing you have saved is dated in that month. Your newer things are still there."
          action={{ label: 'Back to newest', onPress: () => jumpTo('newest') }}
        />
      ) : filtered ? (
        <EmptyState
          icon="filter-variant"
          title="Nothing here"
          message="Nothing you have saved matches what you asked for."
          action={{
            label: 'Show everything',
            onPress: () => {
              setFacet('all');
              setOnlyWaiting(false);
            },
          }}
        />
      ) : (
        <EmptyState
          icon="notebook-outline"
          title={t('home.emptyTitle')}
          message={t('home.emptySubtitle')}
          action={{ label: 'Add something', onPress: openAdd, icon: 'plus' }}
        />
      )}
    </View>
  );

  return (
    <Screen bleed>
      {}
      <View style={[styles.grow, { marginTop: insets.top + theme.layout.headerHeight }]}>
        <AnimatedSectionList<ListRow, DaySection>
          sections={sections}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          stickySectionHeadersEnabled
          SectionSeparatorComponent={SectionGap}
          ItemSeparatorComponent={ItemGap}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          ListEmptyComponent={listEmpty}
          onScroll={handover.onScroll}
          scrollEventThrottle={16}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.6}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              tintColor={theme.colors.accent}
              colors={[theme.colors.accent]}
              progressBackgroundColor={theme.colors.surface}
            />
          }
          contentContainerStyle={[
            styles.reading,
            { paddingBottom: insets.bottom + theme.layout.tabBarHeight + theme.spacing.giant },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          initialNumToRender={10}
          maxToRenderPerBatch={8}
          windowSize={9}
        />
      </View>

      <ScreenHeaderBar
        title={t('home.title')}
        titleOpacity={handover.compactOpacity}
        titleOffset={handover.compactOffset}
        ruleOpacity={handover.ruleOpacity}
        actions={actions}
      />
    </Screen>
  );
}

function ItemGap() {
  return <View style={styles.itemGap} />;
}

function SectionGap() {
  return <View style={styles.sectionGap} />;
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  gutter: { paddingHorizontal: LAYOUT.screenPadding },
  reading: { width: '100%', maxWidth: LAYOUT.maxContentWidth, alignSelf: 'center' },
  masthead: { paddingTop: SPACING.xl, paddingBottom: SPACING.xxxl },
  overline: { marginBottom: SPACING.sm },
  greeting: { marginTop: SPACING.sm },
  headerBlocks: { paddingBottom: SPACING.xl },
  footerBlock: { paddingTop: SPACING.lg, gap: SPACING.md },
  itemGap: { height: SPACING.md },
  sectionGap: { height: SPACING.xl },
  dayBand: {
    paddingHorizontal: LAYOUT.screenPadding,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.sm,
    borderBottomWidth: BORDER_WIDTH.hairline,
    marginTop: SPACING.xs,
  },
  skeletonBody: { padding: LAYOUT.screenPadding },

  monthStrip: { marginHorizontal: -LAYOUT.screenPadding, alignItems: 'center' },
  thumb: { width: LAYOUT.tileSizeLarge, height: LAYOUT.tileSizeLarge, overflow: 'hidden' },
  factBox: { paddingTop: SPACING.sm },
});
