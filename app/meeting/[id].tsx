import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, LayoutAnimation, PanResponder, Platform, Share, StyleSheet, UIManager, View } from 'react-native';

import {
  ApiError,
  canRetryMeeting,
  deleteMeeting,
  formatRecordingClock,
  formatSpokenLength,
  getMeeting,
  languageDisplayName,
  meetingHasNothingToShow,
  meetingInProgress,
  meetingParagraphs,
  meetingPassages,
  meetingPlainText,
  meetingPollDelayMs,
  meetingSourceQuery,
  meetingStartInputs,
  meetingStoppedPartway,
  meetingTroubleMessage,
  meetingWatchExpired,
  parseMeetingStart,
  retryMeeting,
  updateMeeting,
  updateTask,
  useFileSource,
  type MeetingDetail,
  type MeetingEdit,
  type MeetingTask,
} from '@api';
import {
  BORDER_WIDTH,
  BottomSheet,
  Button,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  FadeIn,
  GlassSurface,
  HIT_TARGET,
  Icon,
  IconButton,
  IndeterminateBar,
  LAYOUT,
  Notice,
  Pressable,
  ProgressBar,
  PulseDot,
  Row,
  ScreenScroll,
  Section,
  SkeletonCard,
  Stack,
  Text,
  TextField,
  formatOccurredOn,
  useReducedMotion,
  useTheme,
  useToast,
  type IconName,
  type ScreenAction,
  type Tone,
} from '@ui';

if (Platform.OS === 'android') {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

const GLYPH_CHECK = 24;
const GLYPH_COLUMN = 22;

type MeetingState = 'working' | 'unfinished' | 'failed' | 'empty' | 'ready' | 'gone';

function stateOf(meeting: MeetingDetail): MeetingState {
  if (meetingInProgress(meeting)) return 'working';
  if (meeting.status === 'failed') return 'failed';
  if (meetingStoppedPartway(meeting)) return 'unfinished';
  return meetingHasNothingToShow(meeting) ? 'empty' : 'ready';
}

const STATE_CHIP: Record<MeetingState, { label: string; tone: Tone; icon: IconName } | null> = {
  working: { label: 'Still going', tone: 'info', icon: 'progress-clock' },
  unfinished: { label: 'Not finished', tone: 'warn', icon: 'alert-outline' },
  failed: { label: 'Could not be read', tone: 'danger', icon: 'alert-outline' },
  empty: { label: 'Nothing came back', tone: 'neutral', icon: 'information-outline' },
  ready: null,
  gone: { label: 'No longer saved', tone: 'neutral', icon: 'information-outline' },
};

function stageLabel(meeting: MeetingDetail): string {
  if (meeting.status === 'transcribing') return 'Writing down what was said';
  if (meeting.status === 'transcribed') return 'Reading through what was said';
  return 'Working on it';
}

function troubleWith(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    if (cause.timedOut) return 'That took too long. Try again in a moment.';
    if (cause.isNetwork) return 'Cannot reach the server. Check your connection and try again.';
    if (cause.status === 404) return 'This meeting is no longer saved.';
    if (cause.status >= 500) return 'Something went wrong at our end. Try again in a moment.';
  }
  return fallback;
}

function priorityLabel(priority: string | null): string | null {
  if (priority === 'high') return 'High priority';
  if (priority === 'low') return 'Low priority';
  return null;
}

function metaParts(parts: ReadonlyArray<string | null>): string | null {
  const kept = parts.filter((part): part is string => part !== null && part.trim().length > 0);
  return kept.length > 0 ? kept.join('  ·  ') : null;
}

function easeNext(reduced: boolean | null): void {
  if (!reduced) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
}

function patchTask(meeting: MeetingDetail | null, taskId: string, doneAt: number | null): MeetingDetail | null {
  if (!meeting) return meeting;
  return { ...meeting, tasks: meeting.tasks.map((task) => (task.id === taskId ? { ...task, doneAt } : task)) };
}

function fileNameFor(title: string): string {
  const safe = title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 80);
  return `${safe || 'Meeting'}.txt`;
}

function downloadText(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function SheetHeader({ title }: { title: string }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.md }}>
      <Text variant="heading">{title}</Text>
    </View>
  );
}

function PointRow({ icon, tone, children }: { icon: IconName; tone: Tone; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <Row gap="md" align="flex-start" style={{ marginBottom: theme.spacing.md }}>
      <View style={styles.rowIcon}>
        <Icon name={icon} color={theme.tone(tone).fg} />
      </View>
      <Stack gap="xxs" style={styles.flex}>
        {children}
      </Stack>
    </Row>
  );
}

function PointList({
  items,
  icon,
  tone,
  onSource,
}: {
  items: readonly string[];
  icon: IconName;
  tone: Tone;

  onSource?: (item: string) => (() => void) | null;
}) {
  const theme = useTheme();
  return (
    <GlassSurface padding="xl" contentStyle={{ paddingBottom: theme.spacing.sm }}>
      {items.map((item, index) => {
        const open = onSource?.(item) ?? null;
        return (
          <PointRow key={`${index}-${item}`} icon={icon} tone={tone}>
            {open ? (
              <Pressable
                onPress={open}
                accessibilityRole="button"
                accessibilityLabel={item}
                accessibilityHint="Opens what was said, at the sentence this came from"
                style={{ borderRadius: theme.radius.sm }}
              >
                <Text variant="body">{item}</Text>
                <Row gap="xxs" align="center" style={{ marginTop: theme.spacing.xxs }}>
                  <Icon name="text-search" size={13} color={theme.colors.textTertiary} />
                  <Text variant="caption" colorToken="textTertiary">
                    See what was said
                  </Text>
                </Row>
              </Pressable>
            ) : (
              <Text variant="body" selectable>
                {item}
              </Text>
            )}
          </PointRow>
        );
      })}
    </GlassSurface>
  );
}

function WorkingCard({
  meeting,
  checking,
  gaveUp,
  onCheck,
}: {
  meeting: MeetingDetail;
  checking: boolean;

  gaveUp: boolean;
  onCheck: () => void;
}) {
  const theme = useTheme();
  const stage = stageLabel(meeting);

  return (
    <GlassSurface variant="hero" tone="info" padding="xl">
      <Row gap="sm" align="center">
        {gaveUp ? null : <PulseDot color={theme.tone('info').fg} />}
        <Text variant="overline" tone="info" uppercase>
          Working on it
        </Text>
      </Row>
      <Text variant="subheading" style={{ marginTop: theme.spacing.sm }}>
        {stage}
      </Text>
      <Text variant="bodySmall" colorToken="textSecondary" style={{ marginTop: theme.spacing.xs }}>
        {gaveUp
          ? 'This has been going much longer than it should. Nothing has been lost — the recording is still saved. Check again, or come back later.'
          : 'You can leave this screen. It carries on without you, and a long meeting can take a few minutes.'}
      </Text>
      {gaveUp ? null : (
        <IndeterminateBar tone="info" accessibilityLabel={stage} style={{ marginTop: theme.spacing.lg }} />
      )}
      <Button
        label="Check now"
        icon="refresh"
        onPress={onCheck}
        variant="secondary"
        loading={checking}
        fullWidth
        accessibilityHint="Asks again whether this meeting is ready"
        style={{ marginTop: theme.spacing.lg }}
      />
    </GlassSurface>
  );
}

interface TroubleCardProps {
  meeting: MeetingDetail;
  state: 'unfinished' | 'failed';
  busy: boolean;
  onRetry: () => void;
  onRecordAgain: () => void;
}

function TroubleCard({ meeting, state, busy, onRetry, onRecordAgain }: TroubleCardProps) {
  const theme = useTheme();
  const tone: Tone = state === 'unfinished' ? 'warn' : 'danger';
  const heading = state === 'unfinished' ? 'Not finished' : 'Could not be read';
  const canRetry = canRetryMeeting(meeting) && meeting.fileId !== null;

  const message = meetingTroubleMessage(
    meeting.error,
    state === 'unfinished'
      ? 'Reading this meeting did not finish. What was said is saved below — try reading it again.'
      : 'This recording could not be read. It is still saved, so trying again costs you nothing.',
  );

  return (
    <GlassSurface variant="hero" tone={tone} padding="xl">
      <Row gap="sm" align="center">
        <Icon name="alert-outline" color={theme.tone(tone).fg} />
        <Text variant="overline" tone={tone} uppercase>
          {heading}
        </Text>
      </Row>
      <Text variant="body" colorToken="textSecondary" selectable style={{ marginTop: theme.spacing.sm }}>
        {message}
      </Text>
      {canRetry ? (
        <Button
          label="Try reading it again"
          icon="refresh"
          onPress={onRetry}
          variant="primary"
          loading={busy}
          fullWidth
          style={{ marginTop: theme.spacing.lg }}
        />
      ) : (
        <Button
          label="Record a meeting"
          icon="microphone-outline"
          onPress={onRecordAgain}
          variant="primary"
          fullWidth
          style={{ marginTop: theme.spacing.lg }}
        />
      )}
    </GlassSurface>
  );
}

function NothingCard({ onDescribe, onRecordAgain }: { onDescribe: () => void; onRecordAgain: () => void }) {
  const theme = useTheme();
  return (
    <GlassSurface variant="hero" padding="xl">
      <Row gap="sm" align="center">
        <Icon name="information-outline" color={theme.colors.textSecondary} />
        <Text variant="overline" colorToken="textTertiary" uppercase>
          Nothing came back
        </Text>
      </Row>
      <Text variant="body" colorToken="textSecondary" style={{ marginTop: theme.spacing.sm }}>
        This recording was read and there was nothing in it to pull out — no summary, no
        decisions, nothing anyone was asked to do. The recording itself is still here.
      </Text>
      <Row gap="md" wrap style={{ marginTop: theme.spacing.lg }}>
        <Button label="Say what it was about" icon="note-edit-outline" onPress={onDescribe} variant="primary" />
        <Button label="Record another" icon="microphone-outline" onPress={onRecordAgain} variant="secondary" />
      </Row>
    </GlassSurface>
  );
}

function AboutCard({
  meeting,
  estimated,
  onEdit,
}: {
  meeting: MeetingDetail;
  estimated: boolean;
  onEdit: () => void;
}) {
  const theme = useTheme();
  const note = meeting.note.trim();

  return (
    <GlassSurface padding="lg">
      <Pressable
        onPress={onEdit}
        dimOnPress
        pressScale={1}
        accessibilityRole="button"
        accessibilityLabel={note ? `What this was about: ${note}. Edit.` : 'Say what this meeting was about'}
        style={{ borderRadius: theme.radius.md, paddingVertical: theme.spacing.xs }}
        contentStyle={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.md }}
      >
        <View style={styles.rowIcon}>
          <Icon name="note-text-outline" color={theme.colors.textSecondary} />
        </View>
        <Stack gap="xxs" style={styles.flex}>
          <Text variant="label" colorToken="textTertiary">
            What this was about
          </Text>
          <Text variant="body" colorToken={note ? 'text' : 'textTertiary'}>
            {note || 'Add a line in your own words, so you know what this was next year.'}
          </Text>
        </Stack>
        <Icon name="pencil-outline" color={theme.colors.textTertiary} />
      </Pressable>

      {estimated ? (
        <>
          <Divider spacing="lg" />
          <Stack gap="sm">
            <Text variant="bodySmall" colorToken="textSecondary">
              We worked the time out from when this recording reached us, so it may be wrong. Setting
              the real day and time also lets &ldquo;by Friday&rdquo; mean the right Friday.
            </Text>
            <Button
              label="Set when it happened"
              icon="calendar-edit"
              onPress={onEdit}
              variant="secondary"
              size="sm"
            />
          </Stack>
        </>
      ) : null}
    </GlassSurface>
  );
}

function SummaryCard({ summary }: { summary: string }) {
  const theme = useTheme();
  return (
    <GlassSurface variant="hero" padding="xl">
      <Text variant="overline" colorToken="textTertiary" uppercase>
        The short version
      </Text>
      <Text variant="body" selectable style={{ marginTop: theme.spacing.sm }}>
        {summary}
      </Text>
    </GlassSurface>
  );
}

interface TaskRowProps {
  task: MeetingTask;
  busy: boolean;
  onToggle: () => void;
  onOpen: () => void;
}

function TaskRow({ task, busy, onToggle, onOpen }: TaskRowProps) {
  const theme = useTheme();
  const done = task.doneAt !== null;
  const due = task.dueAt !== null ? `Due ${formatOccurredOn(task.dueAt)}` : null;
  const meta = metaParts([task.owner, priorityLabel(task.priority), due]);

  return (
    <Row gap="xs" align="flex-start">
      <Pressable
        onPress={onToggle}
        disabled={busy}
        pressScale={0.9}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done, disabled: busy }}
        accessibilityLabel={task.text}
        accessibilityHint={done ? 'Marks this as not done' : 'Marks this as done'}
        style={styles.check}
      >
        {busy ? (
          <ActivityIndicator size="small" color={theme.colors.textTertiary} />
        ) : (
          <Icon
            name={done ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'}
            size={GLYPH_CHECK}
            color={done ? theme.tone('ok').solid : theme.colors.textTertiary}
          />
        )}
      </Pressable>

      <Pressable
        onPress={onOpen}
        dimOnPress
        pressScale={1}
        accessibilityRole="button"
        accessibilityLabel={`${task.text}. Open in your to-do list.`}
        style={[
          styles.flex,
          { borderRadius: theme.radius.md, paddingVertical: theme.spacing.md, paddingRight: theme.spacing.xs },
        ]}
        contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}
      >
        <Stack gap="xxs" style={styles.flex}>
          <Text variant="body" colorToken={done ? 'textTertiary' : 'text'} style={done ? styles.strike : undefined}>
            {task.text}
          </Text>
          {meta ? (
            <Text variant="caption" colorToken="textTertiary">
              {meta}
            </Text>
          ) : null}
        </Stack>
        <Icon name="chevron-right" color={theme.colors.textTertiary} />
      </Pressable>
    </Row>
  );
}

function PlayerCard({ fileId, durationMs, onRetry }: { fileId: string; durationMs: number | null; onRetry: () => void }) {
  const theme = useTheme();
  const { source, failed } = useFileSource(fileId);
  const player = useAudioPlayer(source);
  const status = useAudioPlayerStatus(player);
  const readied = useRef(false);

  const totalMs = status.duration > 0 ? status.duration * 1000 : durationMs;
  const elapsedMs = status.currentTime * 1000;
  const seekable = totalMs !== null && totalMs > 0;

  const [scrub, setScrub] = useState<number | null>(null);

  const trackWidth = useRef(0);

  const trackOrigin = useRef(0);

  const fractionAt = useCallback((pageX: number): number => {
    const width = trackWidth.current;
    if (width <= 0) return 0;
    return Math.min(1, Math.max(0, (pageX - trackOrigin.current) / width));
  }, []);

  const seekTo = useCallback(
    (fraction: number) => {
      if (totalMs === null || totalMs <= 0) return;
      void player.seekTo((fraction * totalMs) / 1000).catch(() => {});
    },
    [player, totalMs],
  );

  const scrubber = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => seekable,
        onMoveShouldSetPanResponder: () => seekable,
        onPanResponderGrant: (event) => {
          trackOrigin.current = event.nativeEvent.pageX - event.nativeEvent.locationX;
          setScrub(fractionAt(event.nativeEvent.pageX));
        },
        onPanResponderMove: (_event, gesture) => setScrub(fractionAt(gesture.moveX)),
        onPanResponderRelease: (_event, gesture) => {
          seekTo(fractionAt(gesture.moveX));
          setScrub(null);
        },

        onPanResponderTerminate: () => setScrub(null),
      }),
    [fractionAt, seekTo, seekable],
  );

  const fraction = scrub ?? (seekable ? Math.min(1, elapsedMs / totalMs) : null);

  const shownMs = scrub !== null && totalMs !== null ? scrub * totalMs : elapsedMs;

  const toggle = useCallback(() => {
    if (!readied.current) {
      readied.current = true;

      void setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    }
    if (status.playing) player.pause();
    else player.play();
  }, [player, status.playing]);

  const back = useCallback(() => {
    void player.seekTo(Math.max(0, status.currentTime - 15)).catch(() => {});
  }, [player, status.currentTime]);

  const forward = useCallback(() => {
    const limit = totalMs !== null && totalMs > 0 ? totalMs / 1000 : status.currentTime + 15;
    void player.seekTo(Math.min(limit, status.currentTime + 15)).catch(() => {});
  }, [player, status.currentTime, totalMs]);

  const nudge = useCallback(
    (by: number) => {
      if (totalMs === null || totalMs <= 0) return;
      const next = Math.min(1, Math.max(0, (elapsedMs + by) / totalMs));
      seekTo(next);
    },
    [elapsedMs, seekTo, totalMs],
  );

  if (failed) {
    return (
      <GlassSurface padding="lg">
        <Notice
          tone="warn"
          icon="alert-outline"
          title="The recording would not open"
          message="It is still saved. Try again, or check your connection."
        />
        <Button
          label="Try again"
          icon="refresh"
          onPress={onRetry}
          variant="secondary"
          fullWidth
          style={{ marginTop: theme.spacing.md }}
        />
      </GlassSurface>
    );
  }

  const loading = source === null || (!status.isLoaded && !status.playing);

  return (
    <GlassSurface padding="lg">
      <Row gap="md" align="center">
        <IconButton
          icon={status.playing ? 'pause' : 'play'}
          onPress={toggle}
          accessibilityLabel={status.playing ? 'Pause the recording' : 'Play the recording'}
          tone="accent"
          filled
          size={LAYOUT.tileSizeLarge}
          disabled={source === null}
        />
        <IconButton
          icon="rewind-15"
          onPress={back}
          accessibilityLabel="Back fifteen seconds"
          size={HIT_TARGET}
          disabled={source === null || elapsedMs <= 0}
        />
        <IconButton
          icon="fast-forward-15"
          onPress={forward}
          accessibilityLabel="Forward fifteen seconds"
          size={HIT_TARGET}
          disabled={source === null}
        />
        <Stack gap="xs" style={styles.flex}>
          <Text variant="label" colorToken="textSecondary">
            The recording
          </Text>
          <Row gap="sm" align="center">
            <Text variant="monoSmall" colorToken="textTertiary">
              {formatRecordingClock(shownMs)}
            </Text>
            {seekable ? (
              <>
                <Text variant="caption" colorToken="textTertiary">
                  of
                </Text>
                <Text variant="monoSmall" colorToken="textTertiary">
                  {formatRecordingClock(totalMs)}
                </Text>
              </>
            ) : loading ? (
              <Text variant="caption" colorToken="textTertiary">
                opening
              </Text>
            ) : null}
          </Row>
        </Stack>
      </Row>
      {fraction !== null ? (

        <View
          {...scrubber.panHandlers}
          onLayout={(event) => {
            trackWidth.current = event.nativeEvent.layout.width;
          }}
          style={[styles.scrubStrip, { marginTop: theme.spacing.sm }]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Position in the recording"
          accessibilityValue={{ text: `${formatRecordingClock(shownMs)} of ${formatRecordingClock(totalMs)}` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'increment') nudge(15_000);
            if (event.nativeEvent.actionName === 'decrement') nudge(-15_000);
          }}
        >
          <ProgressBar value={fraction} tone="accent" size="sm" />
        </View>
      ) : null}
    </GlassSurface>
  );
}

function Passage({ text, query }: { text: string; query: string }) {
  const theme = useTheme();
  const needle = query.trim();

  if (needle.length === 0) {
    return (
      <Text variant="body" colorToken="textSecondary" selectable>
        {text}
      </Text>
    );
  }

  const pieces: React.ReactNode[] = [];
  const haystack = text.toLowerCase();
  const lower = needle.toLowerCase();
  let from = 0;
  let at = haystack.indexOf(lower);
  let key = 0;
  while (at !== -1) {
    if (at > from) pieces.push(<Text key={`${key++}`}>{text.slice(from, at)}</Text>);
    pieces.push(
      <Text key={`${key++}`} colorToken="text" style={{ backgroundColor: theme.tone('accent').bg }}>
        {text.slice(at, at + needle.length)}
      </Text>,
    );
    from = at + needle.length;
    at = haystack.indexOf(lower, from);
  }
  if (from < text.length) pieces.push(<Text key={`${key++}`}>{text.slice(from)}</Text>);

  return (
    <Text variant="body" colorToken="textSecondary" selectable>
      {pieces}
    </Text>
  );
}

interface TranscriptCardProps {
  paragraphs: readonly string[];
  expanded: boolean;
  onToggle: () => void;
  query: string;
  onQuery: (next: string) => void;
}

function TranscriptCard({ paragraphs, expanded, onToggle, query, onQuery }: TranscriptCardProps) {
  const theme = useTheme();
  const matches = useMemo(() => meetingPassages(paragraphs, query), [paragraphs, query]);
  const searching = query.trim().length > 0;

  return (
    <GlassSurface padding="lg">
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel="What was said"
        accessibilityHint={expanded ? 'Hides the words' : 'Shows the words, with a way to search them'}
        dimOnPress
        pressScale={1}
        style={{ borderRadius: theme.radius.md, paddingVertical: theme.spacing.xs }}
        contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
      >
        <Icon name="text-long" color={theme.colors.textSecondary} />
        <Stack gap="xxs" style={styles.flex}>
          <Text variant="bodyMedium">What was said</Text>
          <Text variant="caption" colorToken="textTertiary">
            In the language it was spoken in. Nothing is translated.
          </Text>
        </Stack>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} color={theme.colors.textTertiary} />
      </Pressable>

      {expanded ? (
        <View
          style={[
            styles.divided,
            { marginTop: theme.spacing.lg, paddingTop: theme.spacing.lg, borderTopColor: theme.colors.border },
          ]}
        >
          <TextField
            label="Find a word"
            icon="magnify"
            value={query}
            onChangeText={onQuery}
            placeholder="A name, a number, anything said"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            {...(searching
              ? {
                  trailing: (
                    <IconButton
                      icon="close-circle-outline"
                      onPress={() => onQuery('')}
                      accessibilityLabel="Clear what you typed"
                      size={HIT_TARGET}
                    />
                  ),
                }
              : {})}
          />

          {searching ? (
            <Text variant="caption" colorToken="textTertiary" style={{ marginTop: theme.spacing.sm }}>
              {matches.length === 0
                ? 'Nobody said that, in those words.'
                : matches.length === 1
                  ? 'One place it comes up.'
                  : `${matches.length} places it comes up.`}
            </Text>
          ) : null}

          <Stack gap="md" style={{ marginTop: theme.spacing.lg }}>
            {matches.map((piece, index) => (
              <Passage key={`${index}-${piece.slice(0, 24)}`} text={piece} query={query} />
            ))}
          </Stack>
        </View>
      ) : null}
    </GlassSurface>
  );
}

export default function MeetingScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const router = useRouter();
  const theme = useTheme();
  const toast = useToast();
  const reduced = useReducedMotion();

  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [busyTasks, setBusyTasks] = useState<readonly string[]>([]);
  const [focused, setFocused] = useState(true);

  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [playerAttempt, setPlayerAttempt] = useState(0);

  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [draftDate, setDraftDate] = useState('');
  const [draftTime, setDraftTime] = useState('');
  const [whenTouched, setWhenTouched] = useState(false);
  const [whenError, setWhenError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const inFlight = useRef(false);

  const stateRef = useRef<MeetingState | null>(null);

  const reducedRef = useRef(reduced);
  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  const [gone, setGone] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      setLoading(false);
      setFailure('This meeting could not be opened.');
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await getMeeting(id);
      const nextState = stateOf(next);
      if (stateRef.current !== null && stateRef.current !== nextState) easeNext(reducedRef.current);
      stateRef.current = nextState;
      setMeeting(next);
      setFailure(null);
      setGone(false);
    } catch (cause) {

      if (cause instanceof ApiError && cause.isMissing) {
        setMeeting(null);
        stateRef.current = null;
        setGone(true);
        setFailure(null);
      } else {
        setFailure(troubleWith(cause, 'This meeting could not be opened. Please try again.'));
      }
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      void load();
      return () => setFocused(false);
    }, [load]),
  );

  const state: MeetingState | null = gone ? 'gone' : meeting ? stateOf(meeting) : null;
  const working = state === 'working';

  const watchFrom = useRef<number | null>(null);
  const [watchGaveUp, setWatchGaveUp] = useState(false);
  useEffect(() => {
    if (!working || !focused) {
      watchFrom.current = null;
      return;
    }
    if (watchFrom.current === null) {
      watchFrom.current = Date.now();
      setWatchGaveUp(false);
    }

    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const again = () => {
      const waited = Date.now() - (watchFrom.current ?? Date.now());
      if (meetingWatchExpired(waited)) {
        setWatchGaveUp(true);
        return;
      }
      timer = setTimeout(() => {
        if (!live) return;
        void load().finally(() => {
          if (live) again();
        });
      }, meetingPollDelayMs(waited));
    };
    again();

    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [working, focused, load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const checkNow = useCallback(async () => {
    setChecking(true);
    await load();
    setChecking(false);
  }, [load]);

  const retry = useCallback(async () => {
    if (!id || retrying) return;
    setRetrying(true);
    try {
      const next = await retryMeeting(id);
      easeNext(reducedRef.current);
      stateRef.current = null;
      watchFrom.current = null;
      setMeeting((current) => (current ? { ...current, ...next } : current));
    } catch (cause) {
      toast.show({ message: troubleWith(cause, 'That did not start. Please try again.'), tone: 'danger' });
    } finally {
      setRetrying(false);
    }
  }, [id, retrying, toast]);

  const toggleTask = useCallback(
    async (task: MeetingTask) => {
      if (busyTasks.includes(task.id)) return;
      const done = task.doneAt === null;
      const before = task.doneAt;

      easeNext(reducedRef.current);
      setBusyTasks((current) => [...current, task.id]);
      setMeeting((current) => patchTask(current, task.id, done ? Date.now() : null));

      try {
        const updated = await updateTask(task.id, { done });
        setMeeting((current) => patchTask(current, task.id, updated.doneAt));
      } catch (cause) {
        setMeeting((current) => patchTask(current, task.id, before));
        toast.show({ message: troubleWith(cause, 'That did not save. Please try again.'), tone: 'danger' });
      } finally {
        setBusyTasks((current) => current.filter((entry) => entry !== task.id));
      }
    },
    [busyTasks, toast],
  );

  const openEdit = useCallback(() => {
    if (!meeting) return;
    const at = meeting.startedAt ?? meeting.createdAt;
    const prefill = meetingStartInputs(at);
    setDraftTitle(meeting.title);
    setDraftNote(meeting.note);
    setDraftDate(prefill.date);
    setDraftTime(prefill.time);
    setWhenTouched(false);
    setWhenError(null);
    setSaveError(null);
    setEditing(true);
  }, [meeting]);

  const save = useCallback(
    async (includeWhen: boolean) => {
      if (!id || !meeting || saving) return;
      const title = draftTitle.trim();
      if (title.length === 0) return;

      const patch: MeetingEdit = {};
      if (title !== meeting.title) patch.title = title;
      if (draftNote.trim() !== meeting.note.trim()) patch.note = draftNote.trim();

      if (includeWhen) {
        const at = parseMeetingStart(draftDate, draftTime);
        if (at === null) {
          setWhenError('That date did not look right. Try 25/12/2026.');
          return;
        }
        if (at > Date.now()) {
          setWhenError('That is in the future. A meeting has to have happened already.');
          return;
        }
        setWhenError(null);
        patch.startedAt = at;
      }

      if (Object.keys(patch).length === 0) {
        setEditing(false);
        return;
      }

      setSaving(true);
      setSaveError(null);
      try {
        const next = await updateMeeting(id, patch);
        setMeeting(next);
        setEditing(false);
        toast.show({ message: 'Saved.', tone: 'ok' });
      } catch (cause) {
        setSaveError(troubleWith(cause, 'That did not save. Please try again.'));
      } finally {
        setSaving(false);
      }
    },
    [id, meeting, saving, draftTitle, draftNote, draftDate, draftTime, toast],
  );

  const facts = useMemo(() => {
    if (!meeting) return { when: null, length: null, language: null };
    const at = meeting.startedAt ?? meeting.createdAt;
    const written = formatOccurredOn(at, 'minute');
    return {
      when: meeting.startedAtEstimated ? `Around ${written}` : written,
      length: formatSpokenLength(meeting.durationMs),
      language: languageDisplayName(meeting.language),
    };
  }, [meeting]);

  const share = useCallback(async () => {
    if (!meeting) return;
    const text = meetingPlainText(meeting, facts);
    const title = meeting.title.trim() || 'Meeting';
    try {
      if (Platform.OS === 'web') {
        downloadText(text, fileNameFor(title));
        toast.show({ message: 'Saved as a text file.', tone: 'ok' });
      } else {
        await Share.share({ title, message: text });
      }
    } catch {
      toast.show({ message: 'That could not be shared. Please try again.', tone: 'danger' });
    }
  }, [meeting, facts, toast]);

  const remove = useCallback(async () => {
    if (!id || deleting) return;
    setDeleting(true);
    try {
      await deleteMeeting(id);
      toast.show({ message: 'Meeting deleted.' });
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (cause) {
      toast.show({ message: troubleWith(cause, 'That did not delete. Please try again.'), tone: 'danger' });
      setDeleting(false);
    }
  }, [id, deleting, router, toast]);

  const recordAgain = useCallback(() => {
    router.push({ pathname: '/capture', params: { mode: 'meeting' } });
  }, [router]);

  const openTasks = useCallback(() => {
    router.push('/tasks');
  }, [router]);

  const toggleTranscript = useCallback(() => {
    easeNext(reducedRef.current);
    setTranscriptOpen((open) => !open);
  }, []);

  const findInTranscript = useCallback((word: string) => {
    easeNext(reducedRef.current);
    setQuery(word);
    setTranscriptOpen(true);
  }, []);

  const busy = saving || deleting;
  const actions: ScreenAction[] | undefined = meeting
    ? [
        { icon: 'pencil-outline', label: 'Edit the details', onPress: openEdit, disabled: busy },
        { icon: 'share-variant-outline', label: 'Share or save as text', onPress: () => void share(), disabled: busy },
        {
          icon: 'trash-can-outline',
          label: 'Delete this meeting',
          onPress: () => setConfirmingDelete(true),
          disabled: busy,
        },
      ]
    : undefined;

  const stateChip = state ? STATE_CHIP[state] : null;
  const metaRow =
    facts.length !== null || facts.language !== null || stateChip !== null ? (
      <Row wrap gap="sm" align="center">
        {facts.length !== null ? <Chip label={facts.length} icon="clock-outline" size="md" /> : null}
        {facts.language !== null ? <Chip label={facts.language} icon="translate" size="md" /> : null}
        {stateChip ? <Chip label={stateChip.label} icon={stateChip.icon} tone={stateChip.tone} size="md" /> : null}
      </Row>
    ) : null;

  const paragraphs = useMemo(() => meetingParagraphs(meeting?.transcript), [meeting?.transcript]);

  const sources = meeting?.intelligence.sources;
  const sourceOpener = useCallback(
    (item: string): (() => void) | null => {
      const found = meetingSourceQuery(paragraphs, item, sources?.[item]);
      return found === null ? null : () => findInTranscript(found);
    },
    [findInTranscript, paragraphs, sources],
  );

  const topics = meeting?.intelligence.topics ?? [];
  const decisions = meeting?.intelligence.decisions ?? [];
  const keyPoints = meeting?.intelligence.keyPoints ?? [];
  const watchList = meeting?.intelligence.attention ?? [];
  const actionItems = meeting?.intelligence.actionItems ?? [];
  const summary = meeting?.summary?.trim() ?? '';
  const openCount = meeting ? meeting.tasks.filter((task) => task.doneAt === null).length : 0;

  return (
    <>
      <ScreenScroll
        title={meeting?.title.trim() || 'Meeting'}
        overline="Meeting"
        back
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        {...(facts.when ? { subtitle: facts.when } : {})}
        {...(actions ? { actions } : {})}
        {...(metaRow ? { meta: metaRow } : {})}
      >
        {loading && !meeting ? (
          <Stack gap="lg">
            <SkeletonCard lines={3} />
            <SkeletonCard lines={2} />
            <SkeletonCard lines={4} />
          </Stack>
        ) : gone ? (

          <EmptyState
            icon="information-outline"
            title="This meeting is no longer saved"
            message="It was deleted, either here or on another device. Nothing of it is left to open."
            action={{ label: 'Back to meetings', icon: 'arrow-left', onPress: () => router.back() }}
          />
        ) : failure !== null && !meeting ? (
          <ErrorState
            title="This meeting would not open"
            message={failure}
            onRetry={() => {
              setLoading(true);
              void load();
            }}
            retryLabel="Try again"
          />
        ) : meeting && state ? (
          <FadeIn>
            <Stack gap="lg">
              {state === 'working' ? (
                <WorkingCard
                  meeting={meeting}
                  checking={checking}
                  gaveUp={watchGaveUp}
                  onCheck={() => void checkNow()}
                />
              ) : null}
              {state === 'unfinished' || state === 'failed' ? (
                <TroubleCard
                  meeting={meeting}
                  state={state}
                  busy={retrying}
                  onRetry={() => void retry()}
                  onRecordAgain={recordAgain}
                />
              ) : null}
              {state === 'empty' ? <NothingCard onDescribe={openEdit} onRecordAgain={recordAgain} /> : null}

              <AboutCard meeting={meeting} estimated={meeting.startedAtEstimated} onEdit={openEdit} />

              {summary ? <SummaryCard summary={summary} /> : null}
            </Stack>

            {decisions.length > 0 ? (
              <Section title="What was decided" count={decisions.length}>
                <PointList items={decisions} icon="check-decagram-outline" tone="ok" onSource={sourceOpener} />
              </Section>
            ) : null}

            {meeting.tasks.length > 0 ? (
              <Section
                title="To do"
                count={openCount}
                hint="These are in your to-do list too. Tick one here and it is ticked there."
                action={{ label: 'Open the list', onPress: openTasks, icon: 'format-list-checks' }}
              >
                <GlassSurface padding="lg" contentStyle={{ paddingVertical: theme.spacing.xs }}>
                  {meeting.tasks.map((task, index) => (
                    <React.Fragment key={task.id}>
                      {index > 0 ? <Divider /> : null}
                      <TaskRow
                        task={task}
                        busy={busyTasks.includes(task.id)}
                        onToggle={() => void toggleTask(task)}
                        onOpen={openTasks}
                      />
                    </React.Fragment>
                  ))}
                </GlassSurface>
              </Section>
            ) : actionItems.length > 0 ? (
              <Section title="To do" count={actionItems.length}>
                <PointList
                  items={actionItems.map((item) => item.text)}
                  icon="format-list-checks"
                  tone="accent"
                  onSource={sourceOpener}
                />
              </Section>
            ) : null}

            {keyPoints.length > 0 ? (
              <Section title="Worth remembering" count={keyPoints.length}>
                <PointList items={keyPoints} icon="lightbulb-on-outline" tone="info" onSource={sourceOpener} />
              </Section>
            ) : null}

            {watchList.length > 0 ? (
              <Section title="Keep an eye on" count={watchList.length}>
                <PointList items={watchList} icon="alert-outline" tone="warn" onSource={sourceOpener} />
              </Section>
            ) : null}

            {topics.length > 0 ? (
              <Section
                title="What came up"
                {...(paragraphs.length > 0 ? { hint: 'Tap one to find where it was said.' } : {})}
              >
                {paragraphs.length > 0 ? (
                  <Row wrap gap="sm">
                    {topics.map((topic, index) => (
                      <Pressable
                        key={`${index}-${topic}`}
                        onPress={() => findInTranscript(topic)}
                        accessibilityRole="button"
                        accessibilityLabel={`Find where ${topic} was said`}
                        style={{ borderRadius: theme.radius.pill }}
                      >
                        <Chip label={topic} icon="magnify" size="md" emphasis="outline" />
                      </Pressable>
                    ))}
                  </Row>
                ) : (
                  <GlassSurface padding="lg">
                    <Text variant="body" colorToken="textSecondary" selectable>
                      {topics.join(' · ')}
                    </Text>
                  </GlassSurface>
                )}
              </Section>
            ) : null}

            {meeting.fileId !== null ? (
              <Section title="Listen back">
                <PlayerCard
                  key={`${meeting.fileId}-${playerAttempt}`}
                  fileId={meeting.fileId}
                  durationMs={meeting.durationMs}
                  onRetry={() => setPlayerAttempt((attempt) => attempt + 1)}
                />
              </Section>
            ) : null}

            {paragraphs.length > 0 ? (
              <View style={{ marginTop: theme.spacing.huge }}>
                <TranscriptCard
                  paragraphs={paragraphs}
                  expanded={transcriptOpen}
                  onToggle={toggleTranscript}
                  query={query}
                  onQuery={setQuery}
                />
              </View>
            ) : null}

            {failure !== null ? (
              <View style={{ marginTop: theme.spacing.lg }}>
                <Notice
                  tone="warn"
                  icon="alert-outline"
                  message={failure}
                  onDismiss={() => setFailure(null)}
                />
              </View>
            ) : null}
          </FadeIn>
        ) : null}
      </ScreenScroll>

      <BottomSheet
        visible={editing}
        onDismiss={() => {
          if (!saving) setEditing(false);
        }}
        header={<SheetHeader title="Edit this meeting" />}
      >
        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: theme.spacing.xl,
            gap: theme.spacing.lg,
          }}
        >
          <TextField
            label="Name"
            value={draftTitle}
            onChangeText={setDraftTitle}
            placeholder="What to call this meeting"
            editable={!saving}
            maxLength={120}
            returnKeyType="next"
          />
          <TextField
            label="What this was about"
            labelHint="optional"
            hint="Your own words. This is shown instead of the file it came from."
            value={draftNote}
            onChangeText={setDraftNote}
            placeholder="Rent renegotiation with the landlord"
            editable={!saving}
            multiline
            maxLength={2000}
          />

          <Stack gap="sm">
            <Row gap="md">
              <View style={styles.flex}>
                <TextField
                  label="Day it happened"
                  value={draftDate}
                  onChangeText={(next) => {
                    setDraftDate(next);
                    setWhenTouched(true);
                    setWhenError(null);
                  }}
                  placeholder="25/12/2026"
                  mono
                  editable={!saving}
                  keyboardType="numbers-and-punctuation"
                  {...(whenError ? { error: whenError } : {})}
                />
              </View>
              <View style={styles.flex}>
                <TextField
                  label="Time"
                  value={draftTime}
                  onChangeText={(next) => {
                    setDraftTime(next);
                    setWhenTouched(true);
                    setWhenError(null);
                  }}
                  placeholder="15:30"
                  mono
                  editable={!saving}
                />
              </View>
            </Row>
            {meeting?.startedAtEstimated ? (
              <>
                <Text variant="caption" colorToken="textTertiary">
                  We worked this out from when the recording reached us. Correct it, or say it is right.
                </Text>
                <Button
                  label="That time is right"
                  icon="check-circle-outline"
                  onPress={() => void save(true)}
                  variant="ghost"
                  size="sm"
                  disabled={saving || draftTitle.trim().length === 0}
                />
              </>
            ) : null}
          </Stack>

          {saveError !== null ? <Notice tone="danger" icon="alert-outline" message={saveError} /> : null}

          <Button
            label="Save"
            onPress={() => void save(whenTouched)}
            variant="primary"
            loading={saving}
            disabled={draftTitle.trim().length === 0}
            fullWidth
          />
        </View>
      </BottomSheet>

      <BottomSheet
        visible={confirmingDelete}
        onDismiss={() => {
          if (!deleting) setConfirmingDelete(false);
        }}
        header={<SheetHeader title="Delete this meeting?" />}
      >
        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: theme.spacing.xl,
            gap: theme.spacing.lg,
          }}
        >
          <Text variant="body" colorToken="textSecondary">
            This removes the recording, everything that was said, the summary and its to-dos. It
            cannot be undone.
          </Text>
          <Row gap="md">
            <View style={styles.flex}>
              <Button
                label="Keep it"
                onPress={() => setConfirmingDelete(false)}
                variant="secondary"
                disabled={deleting}
                fullWidth
              />
            </View>
            <View style={styles.flex}>
              <Button label="Delete" onPress={() => void remove()} variant="danger" loading={deleting} fullWidth />
            </View>
          </Row>
        </View>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },

  rowIcon: { width: GLYPH_COLUMN, alignItems: 'center', paddingTop: BORDER_WIDTH.thick },

  check: { width: HIT_TARGET, height: HIT_TARGET, alignItems: 'center', justifyContent: 'center' },
  strike: { textDecorationLine: 'line-through' },
  divided: { borderTopWidth: BORDER_WIDTH.hairline },

  scrubStrip: { height: HIT_TARGET, justifyContent: 'center' },
});
