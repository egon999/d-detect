import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import {
  DAYS_IN_WEEK,
  WEEK_STARTS_ON,
  calendarGrid,
  createTask,
  daysUntil,
  deleteTask,
  groupTasks,
  isTaskLate,
  listTasks,
  matchesTaskQuery,
  parseDueDay,
  readableError,
  resolveDueChoice,
  shiftMonth,
  taskSource,
  toDueDay,
  updateTask,
  type DueChoice,
  type Task,
  type TaskGroupKey,
  type TaskPriority,
} from '@api';
import {
  BORDER_WIDTH,
  BottomSheet,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  GlassSurface,
  HIT_TARGET,
  Icon,
  IconButton,
  Notice,
  Pressable,
  Row,
  SPACING,
  ScreenList,
  SectionHeader,
  SegmentedControl,
  SkeletonList,
  Stack,
  Surface,
  Text,
  TextField,
  formatAbsoluteDate,
  useTheme,
  useToast,
} from '@ui';

const UNDO_WINDOW_MS = 6_000;

const LONG_PRESS_MS = 400;

const SEARCH_WORTH_IT = 6;

const DAY_CELL_WIDTH = `${100 / DAYS_IN_WEEK}%` as `${number}%`;

const DAY_MARK_SIZE = 36;

const TICK_ICON_SIZE = 26;

const META_ICON_SIZE = 14;

const WORDING_MIN_HEIGHT = 96;

const GROUP_TITLE: Record<TaskGroupKey, string> = {
  late: 'Overdue',
  today: 'Today',
  soon: 'The week ahead',
  later: 'Later',
  undated: 'No date yet',
  done: 'Finished',
};

const DUE_SHORTCUTS: ReadonlyArray<{ choice: DueChoice; label: string }> = [
  { choice: 'today', label: 'Today' },
  { choice: 'tomorrow', label: 'Tomorrow' },
  { choice: 'weekend', label: 'This weekend' },
  { choice: 'next-week', label: 'Next week' },
];

const PRIORITY_OPTIONS: ReadonlyArray<{ value: TaskPriority; label: string }> = [
  { value: 'low', label: 'Whenever' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'Important' },
];

function dueWords(at: number | null | undefined, now: number): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return 'No date';
  const days = daysUntil(at, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return formatAbsoluteDate(at, now);
}

function weekdayNames(now: number): string[] {
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() - WEEK_STARTS_ON + DAYS_IN_WEEK) % DAYS_IN_WEEK));
  return Array.from({ length: DAYS_IN_WEEK }, (_, offset) => {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    return day.toLocaleDateString(undefined, { weekday: 'short' });
  });
}

type ListRow =
  | { kind: 'heading'; key: string; group: TaskGroupKey; count: number; first: boolean }
  | { kind: 'task'; key: string; task: Task };

type Reversible =
  | { kind: 'completed'; task: Task }
  | { kind: 'reopened'; task: Task }
  | { kind: 'removed'; task: Task };

const UNDO_MESSAGE: Record<Reversible['kind'], string> = {
  completed: 'Ticked off.',
  reopened: 'Back on your list.',
  removed: 'Task removed.',
};

function MonthGrid({
  year,
  monthIndex,
  selected,
  now,
  onPick,
  onShift,
}: {
  year: number;
  monthIndex: number;

  selected: string | null;
  now: number;
  onPick: (day: string) => void;
  onShift: (by: number) => void;
}) {
  const theme = useTheme();
  const names = useMemo(() => weekdayNames(now), [now]);
  const cells = useMemo(() => calendarGrid(year, monthIndex), [year, monthIndex]);
  const monthName = new Date(year, monthIndex, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <Surface variant="sunken" bordered radius="md" padding="md">
      <Stack gap="sm">
        <Row between>
          <IconButton
            icon="chevron-left"
            accessibilityLabel="Previous month"
            onPress={() => onShift(-1)}
          />
          <Text variant="bodyMedium" accessibilityRole="header">
            {monthName}
          </Text>
          <IconButton
            icon="chevron-right"
            accessibilityLabel="Next month"
            onPress={() => onShift(1)}
          />
        </Row>

        <Row gap="none">
          {names.map((name) => (
            <Text
              key={name}
              variant="caption"
              colorToken="textTertiary"
              center
              numberOfLines={1}
              style={{ width: DAY_CELL_WIDTH }}
            >
              {name}
            </Text>
          ))}
        </Row>

        <Row gap="none" wrap>
          {cells.map((day, index) => {
            if (day === null) {

              return <View key={`blank-${index}`} style={styles.dayCell} />;
            }
            const at = new Date(year, monthIndex, day).getTime();
            const value = toDueDay(at);
            const isSelected = value === selected;
            const isToday = daysUntil(at, now) === 0;
            return (
              <Pressable
                key={value}
                style={styles.dayCell}
                contentStyle={styles.dayCellContent}
                onPress={() => onPick(value)}
                accessibilityRole="button"
                accessibilityLabel={formatAbsoluteDate(at, now)}
                accessibilityState={{ selected: isSelected }}
              >
                <View
                  style={[
                    styles.dayMark,
                    {
                      borderRadius: theme.radius.pill,
                      backgroundColor: isSelected ? theme.colors.accent : 'transparent',
                      borderColor: isToday && !isSelected ? theme.colors.borderStrong : 'transparent',
                    },
                  ]}
                >
                  <Text
                    variant="bodySmall"
                    style={isSelected ? { color: theme.colors.onAccent } : undefined}
                    colorToken={isSelected ? undefined : 'text'}
                  >
                    {String(day)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </Row>
      </Stack>
    </Surface>
  );
}

export default function TasksScreen() {
  const theme = useTheme();
  const toast = useToast();
  const params = useLocalSearchParams<{ focus?: string }>();
  const focusParam = typeof params.focus === 'string' && params.focus.trim() ? params.focus : null;

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [shelf, setShelf] = useState<'open' | 'done'>('open');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const [withdrawn, setWithdrawn] = useState<ReadonlySet<string>>(new Set());
  const [undo, setUndo] = useState<Reversible | null>(null);

  const [spotlight, setSpotlight] = useState<string | null>(null);

  const [spotlightGone, setSpotlightGone] = useState(false);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [text, setText] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState<string | null>(null);
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [calendar, setCalendar] = useState<{ year: number; monthIndex: number } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const generation = useRef(0);
  const mutating = useRef(new Set<string>());
  const savingLock = useRef(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const waitingRemoval = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const placed = useRef<string | null>(null);

  const loadSeq = useRef(0);

  const spotlightSeq = useRef(0);

  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await listTasks({ state: 'all' });
      if (request !== generation.current) return;
      setTasks(result);
      setNow(Date.now());
      setError(null);
      loadSeq.current += 1;
    } catch (err) {
      if (request === generation.current) {
        setError(readableError(err, 'Your tasks could not be loaded. Please try again.'));
      }
    } finally {
      if (request === generation.current) setRefreshing(false);
    }
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const sendRemoval = useCallback(
    async (id: string) => {
      try {
        await deleteTask(id);
      } catch (err) {

        setWithdrawn((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        toast.show({
          message: readableError(err, 'That task could not be removed. Please try again.'),
          tone: 'danger',
        });
      }
    },
    [toast],
  );

  const commitRemoval = useCallback(() => {
    const waiting = waitingRemoval.current;
    if (!waiting) return;
    clearTimeout(waiting.timer);
    waitingRemoval.current = null;
    void sendRemoval(waiting.id);
  }, [sendRemoval]);

  const clearUndo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    setUndo(null);
  }, []);

  const offerUndo = useCallback((reversible: Reversible) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(reversible);
    undoTimer.current = setTimeout(() => {
      undoTimer.current = null;
      setUndo(null);
    }, UNDO_WINDOW_MS);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        generation.current += 1;

        commitRemoval();
        if (undoTimer.current) clearTimeout(undoTimer.current);
        undoTimer.current = null;
        setUndo(null);

        placed.current = null;
        setSpotlight(null);
        setSpotlightGone(false);
      };
    }, [load, commitRemoval]),
  );

  useEffect(() => commitRemoval, [commitRemoval]);

  useEffect(() => {
    if (!focusParam) return;
    placed.current = null;
    spotlightSeq.current = loadSeq.current;
    setSpotlight(focusParam);
    setSpotlightGone(false);

    router.setParams({ focus: '' });
  }, [focusParam]);

  useEffect(() => {
    if (!spotlight || !tasks || placed.current === spotlight) return;
    const task = tasks.find((item) => item.id === spotlight);
    if (!task) {

      if (loadSeq.current <= spotlightSeq.current) return;
      placed.current = spotlight;

      setSpotlight(null);
      setSpotlightGone(true);
      return;
    }
    placed.current = spotlight;

    const belongs = task.doneAt === null ? 'open' : 'done';
    if (belongs !== shelf) setShelf(belongs);
    if (!matchesTaskQuery(task, query)) setQuery('');
  }, [spotlight, tasks, shelf, query]);

  const pinned = useMemo(() => {
    if (!spotlight) return null;
    return (tasks ?? []).find((task) => task.id === spotlight && !withdrawn.has(task.id)) ?? null;
  }, [spotlight, tasks, withdrawn]);

  const groups = useMemo(() => {
    const shown = (tasks ?? []).filter(
      (task) =>
        !withdrawn.has(task.id) &&
        task.id !== pinned?.id &&
        (shelf === 'done' ? task.doneAt !== null : task.doneAt === null) &&
        matchesTaskQuery(task, query),
    );
    return groupTasks(shown, now);
  }, [tasks, withdrawn, pinned, shelf, query, now]);

  const rows = useMemo<ListRow[]>(
    () =>
      groups.flatMap((group, index) => [
        {
          kind: 'heading' as const,
          key: `heading-${group.key}`,
          group: group.key,
          count: group.tasks.length,
          first: index === 0,
        },
        ...group.tasks.map((task) => ({ kind: 'task' as const, key: task.id, task })),
      ]),
    [groups],
  );

  const openCount = (tasks ?? []).filter(
    (task) => task.doneAt === null && !withdrawn.has(task.id),
  ).length;
  const total = (tasks ?? []).filter((task) => !withdrawn.has(task.id)).length;

  function openEditor(task: Task | null) {
    setNow(Date.now());
    setEditing(task);
    setText(task?.text ?? '');
    setOwner(task?.owner ?? '');
    setDue(task?.dueAt === undefined || task?.dueAt === null ? null : toDueDay(task.dueAt));
    setPriority(task?.priority ?? 'normal');
    setCalendar(null);
    setFieldError(null);
    setSheetOpen(true);
  }

  function editWording(next: string) {
    setText(next);
    if (fieldError) setFieldError(null);
  }

  async function setDone(task: Task, done: boolean, offer: boolean) {
    if (mutating.current.has(task.id)) return;
    mutating.current.add(task.id);
    setBusy(new Set(mutating.current));
    generation.current += 1;
    try {
      const next = await updateTask(task.id, { done });
      setTasks((all) => all?.map((item) => (item.id === next.id ? next : item)) ?? null);
      if (offer) offerUndo({ kind: done ? 'completed' : 'reopened', task: next });
    } catch (err) {
      toast.show({
        message: readableError(err, 'That task could not be updated. Please try again.'),
        tone: 'danger',
      });
    } finally {
      mutating.current.delete(task.id);
      setBusy(new Set(mutating.current));
    }
  }

  function withdraw(task: Task) {

    commitRemoval();
    setWithdrawn((current) => new Set(current).add(task.id));
    const timer = setTimeout(() => {
      waitingRemoval.current = null;
      void sendRemoval(task.id);
    }, UNDO_WINDOW_MS);
    waitingRemoval.current = { id: task.id, timer };
    offerUndo({ kind: 'removed', task });
  }

  function reverse() {
    const pending = undo;
    if (!pending) return;
    clearUndo();

    if (pending.kind === 'removed') {
      const waiting = waitingRemoval.current;
      if (waiting && waiting.id === pending.task.id) {
        clearTimeout(waiting.timer);
        waitingRemoval.current = null;
      }
      setWithdrawn((current) => {
        const next = new Set(current);
        next.delete(pending.task.id);
        return next;
      });
      return;
    }

    void setDone(pending.task, pending.kind === 'reopened', false);
  }

  async function save() {
    if (savingLock.current) return;
    const wording = text.trim();
    if (!wording) {
      setFieldError('Write what needs doing.');
      return;
    }
    savingLock.current = true;
    setSaving(true);
    setFieldError(null);
    generation.current += 1;
    const named = owner.trim();
    try {
      if (editing) {
        await updateTask(editing.id, {
          text: wording,
          priority,
          due,
          owner: named ? named : null,
        });
      } else {
        await createTask({
          text: wording,
          priority,
          due,
          owner: named ? named : null,
        });
      }
      setSheetOpen(false);
      clearUndo();
      toast.show({ message: editing ? 'Task updated.' : 'Task added.', tone: 'ok' });

      setRefreshing(true);
      await load();
    } catch (err) {
      setFieldError(readableError(err, 'Your task could not be saved. Please try again.'));
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  }

  function sourceLine(task: Task) {
    const source = taskSource(task);
    if (!source) return null;
    const label =
      source.title ?? (source.kind === 'meeting' ? 'From a meeting' : 'From a saved entry');
    return (
      <Pressable
        onPress={() =>
          router.push(
            source.kind === 'meeting'
              ? { pathname: '/meeting/[id]', params: { id: source.id } }
              : { pathname: '/record/[id]', params: { id: source.id } },
          )
        }
        style={styles.sourceTarget}
        contentStyle={styles.sourceRow}
        accessibilityRole="link"
        accessibilityLabel={
          source.kind === 'meeting' ? `Open the meeting: ${label}` : `Open the entry: ${label}`
        }
      >
        <Icon
          name={source.kind === 'meeting' ? 'microphone-outline' : 'file-document-outline'}
          size={META_ICON_SIZE}
          color={theme.colors.accent}
        />
        <Text variant="caption" tone="accent" numberOfLines={1} style={styles.flexText}>
          {label}
        </Text>
      </Pressable>
    );
  }

  function taskCard(task: Task, marked = false) {
    const done = task.doneAt !== null;
    const late = isTaskLate(task, now);
    const working = busy.has(task.id);
    const hasDue = typeof task.dueAt === 'number' && Number.isFinite(task.dueAt);
    return (
      <Pressable
        style={styles.card}

        pressScale={0}
        dimOnPress
        disabled={working}
        onPress={() => openEditor(task)}
        onLongPress={() => withdraw(task)}
        delayLongPress={LONG_PRESS_MS}
        accessibilityRole="button"
        accessibilityLabel={task.text}
        accessibilityHint="Opens this task. Press and hold to remove it."
        accessibilityActions={[{ name: 'longpress', label: 'Remove this task' }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'longpress') withdraw(task);
        }}
      >
        <GlassSurface padding="lg" tone={marked ? 'accent' : undefined}>
          <Row gap="md" align="flex-start">
            {}
            <Pressable
              disabled={working}
              onPress={() => void setDone(task, !done, true)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: done, disabled: working, busy: working }}
              accessibilityLabel={
                working
                  ? 'Saving this change'
                  : done
                    ? 'Put this back on the list'
                    : 'Tick this off'
              }
              style={styles.tickTarget}
              contentStyle={styles.tickContent}
            >
              <Icon
                name={
                  working
                    ? 'dots-horizontal'
                    : done
                      ? 'checkbox-marked-circle'
                      : 'checkbox-blank-circle-outline'
                }
                size={TICK_ICON_SIZE}
                color={done && !working ? theme.tone('ok').fg : theme.colors.textTertiary}
              />
            </Pressable>

            <Stack gap="sm" style={styles.cardBody}>
              <Text
                variant="bodyMedium"
                colorToken={done ? 'textTertiary' : 'text'}
                style={done ? styles.struck : undefined}
              >
                {task.text}
              </Text>

              {hasDue || (task.priority === 'high' && !done) || task.owner ? (
                <Row wrap gap="sm">
                  {hasDue ? (
                    <Chip
                      label={dueWords(task.dueAt, now)}
                      icon="calendar-blank-outline"
                      tone={late ? 'warn' : 'neutral'}
                    />
                  ) : null}
                  {task.priority === 'high' && !done ? (
                    <Chip label="Important" icon="flag-outline" tone="accent" />
                  ) : null}
                  {task.owner ? (
                    <Row gap="xs">
                      <Icon
                        name="account-outline"
                        size={META_ICON_SIZE}
                        color={theme.colors.textTertiary}
                      />
                      <Text variant="caption" colorToken="textTertiary">
                        {task.owner}
                      </Text>
                    </Row>
                  ) : null}
                </Row>
              ) : null}

              {sourceLine(task)}
            </Stack>
          </Row>
        </GlassSurface>
      </Pressable>
    );
  }

  const emptyState = () => {
    if (error && !tasks) return <ErrorState message={error} onRetry={refresh} />;
    if (!tasks) return <SkeletonList count={4} />;

    if (pinned) return null;
    if (query.trim()) {
      return (
        <EmptyState
          icon="magnify"
          title="Nothing matches"
          message="Try another word from the task, the person on it, or where it came from."
          action={{ label: 'Clear search', onPress: () => setQuery('') }}
        />
      );
    }
    if (shelf === 'done') {
      return (
        <EmptyState
          icon="check-all"
          title="Nothing finished yet"
          message="Everything you tick off moves here, so you can see what you have already dealt with."
          action={{ label: 'See what is left', onPress: () => setShelf('open') }}
        />
      );
    }
    return (
      <EmptyState
        icon="checkbox-marked-circle-outline"
        title="Nothing to do"
        message="Tasks turn up here on their own after you save a meeting — whatever was agreed, with the meeting's name on it. You can also write one down yourself."
        action={{ label: 'Add a task', icon: 'plus', onPress: () => openEditor(null) }}
      />
    );
  };

  const dueAt = due === null ? null : parseDueDay(due);

  return (
    <>
      <ScreenList<ListRow>
        title="Tasks"
        subtitle={
          openCount > 0
            ? `${openCount} ${openCount === 1 ? 'thing' : 'things'} to follow through on.`
            : 'Nothing to follow through on right now.'
        }
        actions={[
          {
            icon: 'shield-check-outline',
            label: 'Cases',
            onPress: () => router.push('/(tabs)/cases'),
          },
          {
            icon: 'magnify',
            label: 'Search everything',

            onPress: () => router.push('/search' as Href),
          },
          { icon: 'refresh', label: 'Check for new tasks', onPress: refresh },
          { icon: 'plus', label: 'Add a task', onPress: () => openEditor(null) },
        ]}
        data={rows}
        keyExtractor={(row) => row.key}
        onRefresh={refresh}
        refreshing={refreshing}
        listHeader={
          <Stack gap="lg" style={{ marginBottom: theme.spacing.lg }}>
            <SegmentedControl
              options={[
                { value: 'open', label: 'To do' },
                { value: 'done', label: 'Finished' },
              ]}
              value={shelf}
              onChange={setShelf}
              fill
            />
            {total >= SEARCH_WORTH_IT ? (
              <TextField
                icon="magnify"
                placeholder="Find a task"
                accessibilityLabel="Find a task"
                value={query}
                onChangeText={setQuery}
                autoCorrect={false}
                {...(query ? { trailing: <IconButton icon="close" accessibilityLabel="Clear search" onPress={() => setQuery('')} /> } : {})}
              />
            ) : null}
            {error && tasks ? (

              <ErrorState
                compact
                title="This list may be out of date"
                message={error}
                onRetry={refresh}
                retryLabel="Check again"
              />
            ) : null}
            {spotlightGone ? (
              <Notice
                tone="info"
                message="The task you picked is not on this list any more."
                onDismiss={() => setSpotlightGone(false)}
              />
            ) : null}
            {pinned ? (
              <Stack gap="sm">
                <Row between>
                  <Text variant="overline" colorToken="textTertiary">
                    The one you picked
                  </Text>
                  <IconButton
                    icon="close"
                    accessibilityLabel="Put this back in the list"
                    onPress={() => setSpotlight(null)}
                  />
                </Row>
                {taskCard(pinned, true)}
              </Stack>
            ) : null}
          </Stack>
        }
        empty={emptyState()}
        renderItem={(row) =>
          row.kind === 'heading' ? (
            <View style={row.first ? undefined : { marginTop: theme.spacing.xxl }}>
              <SectionHeader title={GROUP_TITLE[row.group]} count={row.count} />
            </View>
          ) : (
            taskCard(row.task)
          )
        }
        {...(undo
          ? {
              footer: (
                <Row gap="md">
                  <Text variant="bodySmall" colorToken="textSecondary" style={styles.flexText}>
                    {UNDO_MESSAGE[undo.kind]}
                  </Text>
                  <Button label="Undo" variant="secondary" size="sm" onPress={reverse} />
                </Row>
              ),
            }
          : {})}
      />

      <BottomSheet
        visible={sheetOpen}
        onDismiss={() => {
          if (!saving) setSheetOpen(false);
        }}
        header={
          <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.md }}>
            <Row between>
              <Text variant="heading">{editing ? 'Edit task' : 'New task'}</Text>
              <IconButton
                icon="close"
                accessibilityLabel="Close without saving"
                disabled={saving}
                onPress={() => setSheetOpen(false)}
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
            maxWidth: theme.layout.maxContentWidth,
            alignSelf: 'center',
          }}
        >
          <TextField
            label="What needs doing?"
            value={text}
            onChangeText={editWording}
            maxLength={500}
            multiline
            minHeight={WORDING_MIN_HEIGHT}
            autoFocus
            editable={!saving}
          />

          <Stack gap="sm">
            <Text variant="label">When is it due?</Text>
            <Row wrap gap="sm">
              {DUE_SHORTCUTS.map((shortcut) => {
                const day = resolveDueChoice(shortcut.choice, now);
                return (
                  <Button
                    key={shortcut.choice}
                    label={shortcut.label}
                    size="sm"
                    variant={due === day ? 'secondary' : 'ghost'}
                    disabled={saving}
                    onPress={() => {
                      setDue(day);
                      setCalendar(null);
                    }}
                  />
                );
              })}
              <Button
                label="Pick a date"
                icon="calendar-blank-outline"
                size="sm"
                variant={calendar ? 'secondary' : 'ghost'}
                disabled={saving}
                onPress={() => {
                  if (calendar) {
                    setCalendar(null);
                    return;
                  }
                  const anchor = new Date(dueAt ?? now);
                  setCalendar({ year: anchor.getFullYear(), monthIndex: anchor.getMonth() });
                }}
              />
            </Row>

            <Row gap="sm">
              <Icon
                name="calendar-blank-outline"
                size={META_ICON_SIZE}
                color={due ? theme.colors.textSecondary : theme.colors.textTertiary}
              />
              <Text variant="bodySmall" colorToken={due ? 'textSecondary' : 'textTertiary'}>
                {dueAt === null ? 'No date — this will sit under “No date yet”.' : dueWords(dueAt, now)}
              </Text>
              {due ? (
                <Button
                  label="Remove date"
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onPress={() => {
                    setDue(null);
                    setCalendar(null);
                  }}
                />
              ) : null}
            </Row>

            {calendar ? (
              <MonthGrid
                year={calendar.year}
                monthIndex={calendar.monthIndex}
                selected={due}
                now={now}
                onPick={(day) => setDue(day)}
                onShift={(by) =>
                  setCalendar((current) =>
                    current ? shiftMonth(current.year, current.monthIndex, by) : current,
                  )
                }
              />
            ) : null}
          </Stack>

          <TextField
            label="Who is doing this?"
            labelHint="Optional"
            value={owner}
            onChangeText={setOwner}
            maxLength={120}
            editable={!saving}
            autoCapitalize="words"
            autoCorrect={false}
            hint="Leave this empty if it is yours."
          />

          <Stack gap="sm">
            <Text variant="label">How much does it matter?</Text>
            <SegmentedControl
              options={PRIORITY_OPTIONS}
              value={priority}
              onChange={setPriority}
              fill
            />
          </Stack>

          {fieldError ? <Notice tone="danger" message={fieldError} /> : null}

          <Button
            label={editing ? 'Save changes' : 'Add task'}
            variant="primary"
            loading={saving}
            onPress={() => void save()}
            fullWidth
          />

          {editing ? (
            <Button
              label="Remove task"
              variant="ghost"
              icon="trash-can-outline"
              disabled={saving}
              onPress={() => {
                const task = editing;
                setSheetOpen(false);
                withdraw(task);
              }}
              fullWidth
            />
          ) : null}
        </ScrollView>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: SPACING.sm },
  cardBody: { flex: 1, minWidth: 0 },
  struck: { textDecorationLine: 'line-through' },
  flexText: { flex: 1 },
  tickTarget: { minWidth: HIT_TARGET },
  tickContent: { alignItems: 'center' },
  sourceTarget: { minHeight: HIT_TARGET },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  dayCell: { width: DAY_CELL_WIDTH, height: HIT_TARGET },
  dayCellContent: { alignItems: 'center' },
  dayMark: {
    width: DAY_MARK_SIZE,
    height: DAY_MARK_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: BORDER_WIDTH.hairline,
  },
});
