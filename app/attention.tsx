import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import {
  ATTENTION_LOOK_CEILING_MS,
  attentionIsCitable,
  attentionPollDelayMs,
  getAttention,
  readableError,
  refreshAttention,
  resolveAttentionItem,
  type Attention,
  type AttentionItem,
  type AttentionKind,
  type AttentionSource,
  type AttentionState,
} from '@api';
import {
  BORDER_WIDTH,
  Button,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  GlassSurface,
  IconButton,
  IconTile,
  Pressable,
  PulseDot,
  Row,
  ScreenList,
  SegmentedControl,
  SkeletonList,
  Stack,
  Text,
  useTheme,
  useToast,
  type IconName,
  type Tone,
} from '@ui';

type Filter = 'all' | AttentionKind;

const KINDS: Record<AttentionKind, { label: string; icon: IconName; tone: Tone }> = {
  commitment: { label: 'Promises', icon: 'handshake-outline', tone: 'accent' },
  renewal: { label: 'Expiring', icon: 'calendar-clock', tone: 'warn' },
  anomaly: { label: 'Worth checking', icon: 'alert-decagram-outline', tone: 'danger' },
};

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'commitment', label: KINDS.commitment.label },
  { value: 'renewal', label: KINDS.renewal.label },
  { value: 'anomaly', label: KINDS.anomaly.label },
];

const STATES: ReadonlyArray<{ value: AttentionState; label: string }> = [
  { value: 'open', label: 'To do' },
  { value: 'handled', label: 'Done' },
  { value: 'dismissed', label: 'Set aside' },
];

function whenLabel(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'today';
  if (date.toDateString() === tomorrow.toDateString()) return 'tomorrow';
  if (date.toDateString() === yesterday.toDateString()) return 'yesterday';
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

function dueChipLabel(dueAt: number, overdue: boolean): string {
  return `${overdue ? 'Was due' : 'Due'} ${whenLabel(dueAt)}`;
}

function openSource(source: AttentionSource) {
  if (source.kind === 'meeting') {
    router.push({ pathname: '/meeting/[id]', params: { id: source.id } });
  } else {
    router.push({ pathname: '/record/[id]', params: { id: source.id } });
  }
}

function subtitleFor(state: AttentionState, total: number): string {
  if (state === 'handled') {
    return total === 0 ? 'Nothing here yet.' : `${total} you have dealt with.`;
  }
  if (state === 'dismissed') {
    return total === 0 ? 'Nothing here yet.' : `${total} you set aside.`;
  }
  if (total === 0) return 'Nothing is waiting on you.';
  return total === 1 ? '1 thing to look at.' : `${total} things to look at.`;
}

function Quote({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderLeftWidth: BORDER_WIDTH.thick,
        borderLeftColor: theme.colors.borderStrong,
        paddingLeft: theme.spacing.md,
      }}
    >
      <Text variant="bodySmall" colorToken="textSecondary" selectable>
        {`“${text}”`}
      </Text>
    </View>
  );
}

interface UndoneAction {
  item: AttentionItem;
  moved: 'done' | 'dismissed';
}

function UndoBar({ action, busy, onUndo, onClose }: {
  action: UndoneAction;
  busy: boolean;
  onUndo: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const where = action.moved === 'done' ? 'Done' : 'Set aside';

  return (
    <GlassSurface padding="md" tone="neutral">
      <Row gap="sm" align="center">
        <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
          <Text variant="bodySmall">{`Moved to ${where}.`}</Text>
          <Text variant="caption" colorToken="textTertiary" numberOfLines={1}>
            {action.item.title}
          </Text>
        </Stack>
        <Button
          label="Undo"
          icon="undo-variant"
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={busy}
          onPress={onUndo}
          accessibilityHint="Puts this back on your list"
        />
        <IconButton
          icon="close"
          accessibilityLabel="Hide this"
          onPress={onClose}
          size={18}
          style={{ marginRight: -theme.spacing.sm }}
        />
      </Row>
    </GlassSurface>
  );
}

export default function AttentionScreen() {
  const theme = useTheme();
  const toast = useToast();
  const [state, setState] = useState<AttentionState>('open');
  const [data, setData] = useState<Attention | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [undone, setUndone] = useState<UndoneAction | null>(null);
  const [undoing, setUndoing] = useState(false);

  const generation = useRef(0);
  const mutationLock = useRef(new Set<string>());
  const refreshLock = useRef(false);

  const lookStart = useRef<number | null>(null);

  const watching = useRef(false);

  const load = useCallback(async (target: AttentionState, quiet = false) => {
    const request = ++generation.current;
    try {
      const result = await getAttention({ state: target });
      if (request !== generation.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (request === generation.current) {
        setError(readableError(err, 'This list could not be loaded right now. Please try again.'));
      }
    } finally {
      if (request === generation.current && !quiet) setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(state);
      return () => {
        generation.current += 1;
      };
    }, [load, state]),
  );

  useEffect(() => {
    if (!data?.looking) {
      lookStart.current = null;
      return;
    }
    if (lookStart.current === null) lookStart.current = Date.now();
    const watched = Date.now() - lookStart.current;
    if (watched > ATTENTION_LOOK_CEILING_MS) return;
    const timer = setTimeout(() => void load(state, true), attentionPollDelayMs(watched));
    return () => clearTimeout(timer);
  }, [data, load, state]);

  useEffect(() => {
    if (!data) return;
    if (data.looking) {
      watching.current = true;
      return;
    }
    if (!watching.current) return;
    watching.current = false;
    const look = data.lastLook;
    if (!look) return;
    if (!look.completed) {
      toast.show({
        message: 'That look stopped early. Everything found before it is still here.',
        tone: 'warn',
      });
      return;
    }
    toast.show({
      message:
        look.found > 0
          ? look.found === 1
            ? '1 new thing to look at.'
            : `${look.found} new things to look at.`
          : 'Nothing new needs you.',
      tone: look.found > 0 ? 'accent' : 'neutral',
    });
  }, [data, toast]);

  const refresh = useCallback(() => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    void (async () => {
      try {
        const look = await refreshAttention();
        lookStart.current = Date.now();
        if (look.looking) watching.current = true;
      } catch (err) {
        toast.show({
          message: readableError(
            err,
            'A fresh look could not be started right now. Please try again.',
          ),
          tone: 'danger',
        });
      } finally {
        refreshLock.current = false;
        await load(state, true);
        setRefreshing(false);
      }
    })();
  }, [load, state, toast]);

  const retryLoad = useCallback(() => {
    setRefreshing(true);
    void load(state);
  }, [load, state]);

  const switchState = useCallback(
    (next: AttentionState) => {
      if (next === state) return;
      generation.current += 1;
      setState(next);
      setData(null);
      setFilter('all');
      setError(null);
      setUndone(null);
      void load(next, true);
    },
    [load, state],
  );

  const resolve = useCallback(
    async (item: AttentionItem, status: 'done' | 'dismissed') => {
      if (mutationLock.current.has(item.id)) return;
      mutationLock.current.add(item.id);
      setPending((current) => new Set(current).add(item.id));
      try {
        await resolveAttentionItem(item.id, status);
        setData((current) =>
          current
            ? {
                ...current,
                signals: current.signals.filter((signal) => signal.id !== item.id),
                counts: { ...current.counts, [item.kind]: Math.max(0, current.counts[item.kind] - 1) },
                total: Math.max(0, current.total - 1),
              }
            : current,
        );
        setUndone({ item, moved: status === 'done' ? 'done' : 'dismissed' });
      } catch (err) {
        toast.show({
          message: readableError(err, 'That could not be updated. Please try again.'),
          tone: 'danger',
        });
      } finally {
        mutationLock.current.delete(item.id);
        setPending((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      }
    },
    [toast],
  );

  const putBack = useCallback(
    async (item: AttentionItem, fromBar: boolean) => {
      if (mutationLock.current.has(item.id)) return;
      mutationLock.current.add(item.id);
      if (fromBar) setUndoing(true);
      else setPending((current) => new Set(current).add(item.id));
      try {
        await resolveAttentionItem(item.id, 'open');
        if (fromBar) setUndone(null);
        await load(state, true);
        toast.show({ message: 'Back on your list.', tone: 'ok' });
      } catch (err) {
        toast.show({
          message: readableError(err, 'That could not be put back. Please try again.'),
          tone: 'danger',
        });
      } finally {
        mutationLock.current.delete(item.id);
        if (fromBar) setUndoing(false);
        else
          setPending((current) => {
            const next = new Set(current);
            next.delete(item.id);
            return next;
          });
      }
    },
    [load, state, toast],
  );

  const visible = useMemo(
    () =>
      (data?.signals ?? [])
        .filter(attentionIsCitable)
        .filter((item) => filter === 'all' || item.kind === filter),
    [data, filter],
  );
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const looking = data?.looking === true;

  return (
    <ScreenList<AttentionItem>
      title="Needs attention"
      overline="Activity Timeline"
      subtitle={data ? subtitleFor(state, data.total) : undefined}
      back
      actions={[
        {
          icon: 'refresh',
          label: 'Look again for anything new',
          onPress: refresh,
          disabled: refreshing || looking,
        },
      ]}
      data={visible}
      keyExtractor={(item) => item.id}
      onRefresh={refresh}
      refreshing={refreshing}
      listHeader={
        data || error ? (
          <Stack gap="lg" style={{ marginBottom: theme.spacing.lg }}>
            <SegmentedControl<AttentionState>
              options={STATES}
              value={state}
              onChange={switchState}
              fill
            />

            {looking ? (
              <Row gap="sm" align="center">
                <PulseDot color={theme.tone('info').fg} />
                <Text variant="bodySmall" colorToken="textSecondary" style={{ flex: 1 }}>
                  Looking through your entries. This list updates as it goes.
                </Text>
              </Row>
            ) : null}

            {undone ? (
              <UndoBar
                action={undone}
                busy={undoing}
                onUndo={() => void putBack(undone.item, true)}
                onClose={() => setUndone(null)}
              />
            ) : null}

            {data && data.total > 0 ? (
              <Row gap="sm" wrap>
                {FILTERS.map((option) => {
                  const count = option.value === 'all' ? data.total : data.counts[option.value];
                  if (option.value !== 'all' && count === 0) return null;
                  const active = option.value === filter;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setFilter(option.value)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`${option.label}, ${count}`}
                    >
                      <Chip
                        label={`${option.label} · ${count}`}
                        tone={active ? 'accent' : 'neutral'}
                        emphasis={active ? 'solid' : 'outline'}
                        size="md"
                      />
                    </Pressable>
                  );
                })}
              </Row>
            ) : null}

            {error && data ? (

              <ErrorState
                compact
                title="This list may be out of date"
                message={error}
                onRetry={retryLoad}
                retryLabel="Try again"
              />
            ) : null}
          </Stack>
        ) : null
      }
      empty={
        error && !data ? (
          <ErrorState message={error} onRetry={retryLoad} />
        ) : !data ? (
          <SkeletonList count={3} />
        ) : filter !== 'all' ? (
          <EmptyState
            icon={KINDS[filter].icon}
            title={`Nothing under ${KINDS[filter].label.toLocaleLowerCase()}`}
            message="Switch back to everything to see the rest of this list."
            action={{ label: 'Show everything', onPress: () => setFilter('all') }}
          />
        ) : state === 'handled' ? (
          <EmptyState
            icon="check-circle-outline"
            title="Nothing marked done yet"
            message="Anything you deal with moves here. You can always put it back on your list."
            action={{ label: 'Back to your list', onPress: () => switchState('open') }}
          />
        ) : state === 'dismissed' ? (
          <EmptyState
            icon="eye-off-outline"
            title="Nothing set aside"
            message="Anything you decide is not worth raising moves here. You can bring it back whenever you want."
            action={{ label: 'Back to your list', onPress: () => switchState('open') }}
          />
        ) : (
          <EmptyState
            icon="shield-check-outline"
            title="Nothing needs you"

            message={
              looking
                ? 'A look is running right now. Anything it turns up appears here on its own.'
                : 'Promises made to you, papers about to expire and a charge that went out twice all turn up here on their own. Nothing you have saved looks like that right now.'
            }
            {...(looking
              ? {}
              : { action: { label: 'Look again', icon: 'refresh' as IconName, onPress: refresh } })}
            secondaryAction={{ label: 'What you have dealt with', onPress: () => switchState('handled') }}
          />
        )
      }
      renderItem={(item) => {
        const kind = KINDS[item.kind];
        const overdue = item.dueAt !== null && item.dueAt < todayStart;
        const busy = pending.has(item.id);
        return (
          <GlassSurface padding="lg" style={{ marginBottom: theme.spacing.sm }}>
            <Stack gap="md">
              <Row gap="md" align="flex-start">
                <IconTile icon={kind.icon} tone={kind.tone} size="md" />
                <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="bodyMedium">{item.title}</Text>
                  {item.detail ? (
                    <Text variant="bodySmall" colorToken="textSecondary">
                      {item.detail}
                    </Text>
                  ) : null}
                </Stack>
              </Row>

              {}
              {item.amountLabel || item.dueAt !== null ? (
                <Row gap="sm" wrap>
                  {item.amountLabel ? (
                    <Chip label={item.amountLabel} icon="cash" tone="neutral" />
                  ) : null}
                  {item.dueAt !== null ? (
                    <Chip
                      label={dueChipLabel(item.dueAt, overdue)}
                      icon="calendar-blank-outline"
                      tone={overdue ? 'danger' : 'warn'}
                    />
                  ) : null}
                </Row>
              ) : null}

              {item.quote ? <Quote text={item.quote} /> : null}

              <Stack gap="sm">
                <Text variant="overline" colorToken="textTertiary" uppercase>
                  {item.sources.length === 1 ? 'From' : 'From these'}
                </Text>
                <Row gap="sm" wrap>
                  {item.sources.map((source) => (
                    <Pressable
                      key={`${source.kind}:${source.id}`}
                      onPress={() => openSource(source)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${source.title}`}
                      accessibilityHint="Opens the entry this came from"
                    >
                      <Chip
                        label={source.title}
                        icon={source.kind === 'meeting' ? 'microphone-outline' : 'file-document-outline'}
                        tone="accent"
                        emphasis="outline"
                        shrink
                      />
                    </Pressable>
                  ))}
                </Row>
              </Stack>

              <Divider />
              {state === 'open' ? (
                <Row gap="sm">
                  <Button
                    label="Dealt with it"
                    icon="check"
                    variant="secondary"
                    size="sm"
                    loading={busy}
                    disabled={busy}
                    onPress={() => void resolve(item, 'done')}
                    accessibilityHint="Moves this to Done. You can put it back."
                  />
                  <Button
                    label="Not worth it"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onPress={() => void resolve(item, 'dismissed')}
                    accessibilityHint="Moves this to Set aside. You can put it back."
                  />
                </Row>
              ) : (
                <Row gap="sm">
                  <Button
                    label="Put back on my list"
                    icon="undo-variant"
                    variant="secondary"
                    size="sm"
                    loading={busy}
                    disabled={busy}
                    onPress={() => void putBack(item, false)}
                    accessibilityHint="Moves this back to the things to look at"
                  />
                </Row>
              )}
            </Stack>
          </GlassSurface>
        );
      }}
    />
  );
}
