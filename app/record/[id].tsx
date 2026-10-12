import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Modal, PanResponder, Platform, ScrollView, Share, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  answerRecord,
  ApiError,
  apiPatch,
  createCaseFromRecord,
  createTask,
  currentAuthHeaders,
  deleteRecord,
  fileEndpoint,
  getRecord,
  listRecords,
  listTasks,
  pollDelayMs,
  readableError,
  retryRecord,
  skipQuestion,
  updateRecord,
  updateTask,
  useFileSource,
  worthRetrying,
  type DaybookDirection,
  type DaybookRecord,
  type FileSource,
  type RecordPatch,
  type Task,
} from '@api';
import { resolveCurrency } from '@services/preferences';
import {
  BORDER_WIDTH,
  BottomSheet,
  Button,
  Chip,
  currencyInUserAmount,
  currencySymbol,
  Divider,
  EmptyState,
  ErrorState,
  exportFileName,
  formatAbsoluteDate,
  formatOccurredOn,
  formatRelativeTime,
  GlassSurface,
  HIT_TARGET,
  Icon,
  IconButton,
  IconTile,
  isoDateOf,
  MOTION,
  normalizeTypedDate,
  normalizeUserAmount,
  Notice,
  Pressable,
  ProgressChip,
  readHasContent,
  readRecordDetails,
  recordKindFamily,
  recordKindLabel,
  recordShareText,
  recordStatusWords,
  relatedLink,
  relatedLinkHint,
  relatedLinkTitle,
  relatedRecords,
  Row,
  ScreenScroll,
  SectionHeader,
  SegmentedControl,
  Skeleton,
  SkeletonList,
  SlideUpIn,
  Stack,
  Text,
  TextField,
  useTheme,
  useToast,
  type IconName,
  type RecordKindFamily,
  type ScreenAction,
} from '@ui';

const PREVIEW_RATIO = 3 / 4;

const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 280;

const UNDO_WINDOW_MS = 6_000;

const SAVED_FLASH_MS = 2_400;

const PATIENCE_MS = 60_000;

const RELATED_SHOWN = 4;
const RELATED_SCAN = 200;

const EXAMPLE_SIGN = currencySymbol(resolveCurrency(null));

const FAMILY_ICON: Record<RecordKindFamily, IconName> = {
  payment: 'cash',
  purchase: 'cart-outline',
  bill: 'receipt-text-outline',
  receipt: 'receipt',
  ticket: 'ticket-confirmation-outline',
  travel: 'airplane',
  document: 'file-document-outline',
  message: 'message-text-outline',
  note: 'note-text-outline',
  other: 'shape-outline',
};

function kindIcon(kind: string | null | undefined): IconName {
  return FAMILY_ICON[recordKindFamily(kind)];
}

const STATUS_CHIP: Record<string, { tone: 'info' | 'accent' | 'ok' | 'warn' | 'danger'; icon: IconName }> = {
  processing: { tone: 'info', icon: 'auto-fix' },
  needs_context: { tone: 'accent', icon: 'help-circle-outline' },
  complete: { tone: 'ok', icon: 'check-circle-outline' },
  unreadable: { tone: 'warn', icon: 'alert-outline' },
  failed: { tone: 'danger', icon: 'alert-octagon-outline' },
};

function StatusPill({ status }: { status: string }) {
  const words = recordStatusWords(status);
  const look = STATUS_CHIP[status] ?? { tone: 'neutral' as const, icon: 'bookmark-outline' as const };
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={`${words.label}. ${words.meaning}`}>
      {status === 'processing' ? (
        <ProgressChip label={words.label} tone="info" />
      ) : (
        <Chip label={words.label} tone={look.tone} icon={look.icon} />
      )}
    </View>
  );
}

type Zoom = { scale: number; x: number; y: number };
const UNZOOMED: Zoom = { scale: 1, x: 0, y: 0 };

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function OriginalViewer({
  visible,
  source,
  label,
  onClose,
}: {
  visible: boolean;
  source: FileSource | null;
  label: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const scale = useRef(new Animated.Value(1)).current;
  const offsetX = useRef(new Animated.Value(0)).current;
  const offsetY = useRef(new Animated.Value(0)).current;

  const live = useRef<Zoom>(UNZOOMED);
  const committed = useRef<Zoom>(UNZOOMED);
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const lastTap = useRef(0);
  const [zoomed, setZoomed] = useState(false);

  const apply = useCallback(
    (next: Zoom) => {
      live.current = next;
      scale.setValue(next.scale);
      offsetX.setValue(next.x);
      offsetY.setValue(next.y);
    },
    [scale, offsetX, offsetY],
  );

  const settle = useCallback(
    (next: Zoom) => {
      apply(next);
      committed.current = next;
      setZoomed(next.scale > 1);
    },
    [apply],
  );

  const reset = useCallback(() => settle(UNZOOMED), [settle]);

  useEffect(() => {
    if (!visible) reset();
  }, [visible, reset]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          pinch.current = null;
          if (event.nativeEvent.touches.length >= 2) return;
          const now = Date.now();
          if (now - lastTap.current < DOUBLE_TAP_MS) {
            lastTap.current = 0;
            settle(committed.current.scale > 1 ? UNZOOMED : { scale: DOUBLE_TAP_ZOOM, x: 0, y: 0 });
            return;
          }
          lastTap.current = now;
        },
        onPanResponderMove: (event, gesture) => {
          const touches = event.nativeEvent.touches;
          const first = touches[0];
          const second = touches[1];
          if (first && second) {
            const distance = Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY);
            if (!pinch.current) {
              pinch.current = { distance, scale: committed.current.scale };
              return;
            }
            if (pinch.current.distance <= 0) return;
            apply({
              scale: clamp((pinch.current.scale * distance) / pinch.current.distance, 1, MAX_ZOOM),
              x: committed.current.x,
              y: committed.current.y,
            });
            return;
          }
          if (committed.current.scale <= 1) return;
          apply({
            scale: committed.current.scale,
            x: committed.current.x + gesture.dx,
            y: committed.current.y + gesture.dy,
          });
        },
        onPanResponderRelease: () => {
          settle(live.current.scale <= 1 ? UNZOOMED : live.current);
        },
        onPanResponderTerminate: () => {
          settle(live.current.scale <= 1 ? UNZOOMED : live.current);
        },
      }),
    [apply, settle],
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: theme.colors.overlay }}>
        <Animated.View
          {...responder.panHandlers}
          style={{
            flex: 1,
            transform: [{ translateX: offsetX }, { translateY: offsetY }, { scale }],
          }}
        >
          {source ? (
            <Image source={source} style={{ flex: 1 }} contentFit="contain" accessibilityLabel={label} />
          ) : null}
        </Animated.View>

        <Row
          between
          style={{
            position: 'absolute',
            left: theme.layout.screenPadding,
            right: theme.layout.screenPadding,
            top: insets.top + theme.spacing.md,
          }}
        >
          <IconButton icon="close" accessibilityLabel="Close this picture" onPress={onClose} filled />
          {zoomed ? <Button label="Fit on screen" size="sm" variant="secondary" onPress={reset} /> : null}
        </Row>

        {zoomed ? null : (
          <Text
            variant="caption"
            colorToken="textSecondary"
            center
            style={{
              position: 'absolute',
              left: theme.layout.screenPadding,
              right: theme.layout.screenPadding,
              bottom: insets.bottom + theme.spacing.xxl,
            }}
          >
            Pinch to zoom in, or tap twice.
          </Text>
        )}
      </View>
    </Modal>
  );
}

interface LineProps {
  icon: IconName;
  label: string;

  value: string | null;

  blank: string;
  mono?: boolean;
  saved?: boolean;
  onEdit?: () => void;
}

function Line({ icon, label, value, blank, mono = false, saved = false, onEdit }: LineProps) {
  const theme = useTheme();

  const body = (
    <>
      <IconTile icon={icon} size="sm" tone="neutral" />
      <View style={{ flex: 1 }}>
        <Text variant="overline" colorToken="textTertiary">
          {label}
        </Text>
        {value ? (
          <Text variant="body" mono={mono}>
            {value}
          </Text>
        ) : (
          <Text variant="body" colorToken="textTertiary">
            {blank}
          </Text>
        )}
      </View>
      {saved ? (
        <Chip label="Saved" tone="ok" icon="check" size="sm" />
      ) : onEdit ? (
        <Icon name="pencil-outline" size={16} color={theme.colors.textTertiary} />
      ) : null}
    </>
  );

  if (!onEdit) {
    return (
      <Row gap="md" align="center" style={{ minHeight: HIT_TARGET }}>
        {body}
      </Row>
    );
  }

  return (
    <Pressable
      onPress={onEdit}
      dimOnPress
      pressScale={1}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value ?? blank}`}
      accessibilityHint="Opens this line so you can change it"
      style={{ minHeight: HIT_TARGET, borderRadius: theme.radius.md, justifyContent: 'center' }}
      contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
    >
      {body}
    </Pressable>
  );
}

interface EditorProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  icon: IconName;
  placeholder: string;
  hint?: string;
  mono?: boolean;
  multiline?: boolean;
  numeric?: boolean;

  shortcuts?: Array<{ label: string; value: string }>;
  children?: React.ReactNode;
}

function Editor({
  label,
  value,
  onChange,
  onSave,
  onCancel,
  saving,
  error,
  icon,
  placeholder,
  hint,
  mono = false,
  multiline = false,
  numeric = false,
  shortcuts,
  children,
}: EditorProps) {
  const theme = useTheme();

  return (
    <Stack gap="md">
      <TextField
        label={label}
        value={value}
        onChangeText={onChange}
        icon={icon}
        placeholder={placeholder}
        hint={hint}
        error={error ?? undefined}
        mono={mono}
        multiline={multiline}
        autoFocus
        editable={!saving}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        returnKeyType={multiline ? 'default' : 'done'}
        onSubmitEditing={multiline ? undefined : onSave}
      />
      {shortcuts?.length ? (
        <Row wrap gap="sm">
          {shortcuts.map((shortcut) => (
            <Pressable
              key={shortcut.label}
              onPress={() => onChange(shortcut.value)}
              haptic
              accessibilityRole="button"
              accessibilityLabel={shortcut.label}
              style={{ minHeight: HIT_TARGET, justifyContent: 'center' }}
            >
              <Chip label={shortcut.label} tone="neutral" emphasis="outline" size="md" />
            </Pressable>
          ))}
        </Row>
      ) : null}
      {children}
      <Row gap="md" style={{ marginTop: theme.spacing.xs }}>
        <View style={{ flex: 1 }}>
          <Button label="Cancel" variant="ghost" onPress={onCancel} disabled={saving} fullWidth />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Save" variant="primary" onPress={onSave} loading={saving} fullWidth />
        </View>
      </Row>
    </Stack>
  );
}

function Quoted({ words }: { words: string }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <Stack gap="sm">
      <Pressable
        onPress={() => setOpen((shown) => !shown)}
        dimOnPress
        pressScale={1}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? 'Hide the words on the file' : 'Show the words on the file'}
        style={{ minHeight: HIT_TARGET, justifyContent: 'center' }}
        contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}
      >
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={theme.colors.accent} />
        <Text variant="label" tone="accent">
          {open ? 'Hide what it says' : 'Show what it says'}
        </Text>
      </Pressable>
      {open ? (
        <View
          style={{
            backgroundColor: theme.colors.paper.fill,
            borderColor: theme.colors.paper.border,
            borderWidth: BORDER_WIDTH.hairline,
            borderRadius: theme.radius.md,
            padding: theme.spacing.lg,
            gap: theme.spacing.sm,
          }}
        >
          <Text variant="mono" style={{ color: theme.colors.paper.text }}>
            {words}
          </Text>
          <Text variant="caption" style={{ color: theme.colors.paper.meta }}>
            Copied off the file word for word, including anything it got wrong.
          </Text>
        </View>
      ) : null}
    </Stack>
  );
}

function LinkRow({
  icon,
  tone,
  title,
  detail,
  trailing,
  onPress,
  accessibilityLabel,
}: {
  icon: IconName;
  tone?: 'neutral' | 'accent' | 'ok';
  title: string;
  detail: string | null;
  trailing?: string | null;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      dimOnPress
      pressScale={1}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{ minHeight: HIT_TARGET, borderRadius: theme.radius.md, justifyContent: 'center' }}
      contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
    >
      <IconTile icon={icon} size="sm" tone={tone ?? 'neutral'} />
      <View style={{ flex: 1 }}>
        <Text variant="bodyMedium" numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text variant="caption" colorToken="textTertiary" numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {trailing ? (
        <Text variant="monoSmall" colorToken="textSecondary">
          {trailing}
        </Text>
      ) : null}
      <Icon name="chevron-right" size={18} color={theme.colors.textTertiary} />
    </Pressable>
  );
}

function TaskRow({
  task,
  busy,
  onToggle,
}: {
  task: Task;
  busy: boolean;
  onToggle: () => void;
}) {
  const theme = useTheme();
  const doneAt = task.doneAt;
  const done = doneAt !== null;
  const detail = done
    ? `Done ${formatRelativeTime(doneAt, Date.now())}`
    : task.dueAt !== null
      ? `Due ${formatAbsoluteDate(task.dueAt)}`
      : null;

  return (
    <Pressable
      onPress={onToggle}
      disabled={busy}
      dimOnPress
      pressScale={1}
      haptic
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done, disabled: busy }}
      accessibilityLabel={detail ? `${task.text}. ${detail}` : task.text}
      accessibilityHint={done ? 'Puts this back on your list' : 'Ticks this off'}
      style={{ minHeight: HIT_TARGET, borderRadius: theme.radius.md, justifyContent: 'center' }}
      contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
    >
      <Icon
        name={done ? 'check-circle' : 'checkbox-blank-circle-outline'}
        size={24}
        color={done ? theme.tone('ok').fg : theme.colors.textTertiary}
      />
      <View style={{ flex: 1 }}>
        <Text
          variant="bodyMedium"
          colorToken={done ? 'textTertiary' : 'text'}
          style={done ? { textDecorationLine: 'line-through' } : undefined}
        >
          {task.text}
        </Text>
        {detail ? (
          <Text variant="caption" colorToken="textTertiary" numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {!done && task.overdue ? <Chip label="Late" tone="accent" size="sm" /> : null}
    </Pressable>
  );
}

function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const theme = useTheme();
  return (
    <Row between align="center" style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.md }}>
      <Text variant="heading">{title}</Text>
      <IconButton icon="close" accessibilityLabel="Close" onPress={onClose} />
    </Row>
  );
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

type FieldKey = 'title' | 'counterparty' | 'amount' | 'date' | 'category' | 'note';

const SAVED_WORDS: Record<FieldKey, string> = {
  title: 'Name saved.',
  counterparty: 'Saved who it was with.',
  amount: 'Amount saved.',
  date: 'Date saved.',
  category: 'Saved what it was for.',
  note: 'Note saved.',
};

export default function RecordDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] ?? '' : params.id ?? '';
  const theme = useTheme();
  const toast = useToast();

  const [record, setRecord] = useState<DaybookRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const [field, setField] = useState<FieldKey | null>(null);
  const [draft, setDraft] = useState('');
  const [draftDirection, setDraftDirection] = useState<DaybookDirection>('out');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [savingField, setSavingField] = useState(false);
  const [savedField, setSavedField] = useState<FieldKey | null>(null);

  const [answer, setAnswer] = useState('');
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);

  const [retrying, setRetrying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);

  const [viewing, setViewing] = useState(false);
  const [pictureFailed, setPictureFailed] = useState(false);

  const [related, setRelated] = useState<DaybookRecord[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [addingTask, setAddingTask] = useState(false);
  const [taskDraft, setTaskDraft] = useState('');
  const [savingTask, setSavingTask] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);

  const [ticking, setTicking] = useState<string | null>(null);

  const file = useFileSource(record?.fileId ?? null);
  const details = useMemo(() => readRecordDetails(record?.extraction), [record?.extraction]);

  const load = useCallback(async () => {
    if (!id) {
      setLoading(false);
      return;
    }
    try {
      const next = await getRecord(id);

      setRecord((before) =>
        before &&
        before.updatedAt === next.updatedAt &&
        before.status === next.status &&
        before.progress === next.progress
          ? before
          : next,
      );
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    setAttempt(0);
    void load();
  }, [load]);

  const pollDelay = record?.status === 'processing' ? pollDelayMs(attempt) : null;
  const pollingStopped = record?.status === 'processing' && pollDelay === null;

  useEffect(() => {
    if (pollDelay === null) return;
    const timer = setTimeout(() => {
      setAttempt((count) => count + 1);
      void load();
    }, pollDelay);
    return () => clearTimeout(timer);
  }, [pollDelay, attempt, load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setAttempt(0);
    setPictureFailed(false);
    await load();
    setRefreshing(false);
  }, [load]);

  const link = useMemo(
    () => relatedLink({ counterparty: record?.counterparty ?? null, category: record?.category ?? null }),

    [record?.counterparty, record?.category],
  );

  useEffect(() => {
    const self = record?.id;
    if (!link || !self) {
      setRelated([]);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const page = await listRecords(RELATED_SCAN);
        if (!active) return;
        setRelated(relatedRecords(self, link, page, RELATED_SHOWN));
      } catch {

        if (active) setRelated([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [link, record?.id]);

  useEffect(() => {
    const self = record?.id;
    if (!self) {
      setTasks([]);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const found = await listTasks({ state: 'all', recordId: self });
        if (active) setTasks(found);
      } catch {
        if (active) setTasks([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [record?.id]);

  useEffect(() => {
    if (!savedField) return;
    const timer = setTimeout(() => setSavedField(null), SAVED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [savedField]);

  useEffect(() => {
    setPictureFailed(false);
  }, [record?.fileId]);

  const openField = useCallback(
    (key: FieldKey) => {
      if (!record) return;
      setFieldError(null);
      setField(key);
      setDraftDirection(record.direction ?? 'out');
      switch (key) {
        case 'title':
          setDraft(record.title ?? '');
          break;
        case 'counterparty':
          setDraft(record.counterparty ?? '');
          break;
        case 'category':
          setDraft(record.category ?? '');
          break;
        case 'note':
          setDraft(record.note ?? '');
          break;
        case 'amount':

          setDraft(record.amountLabel ?? '');
          break;
        case 'date':

          setDraft(
            record.occurredAt !== null &&
              (record.occurredPrecision === 'day' || record.occurredPrecision === 'minute')
              ? typedDate(record.occurredAt)
              : '',
          );
          break;
        default:
          setDraft('');
      }
    },
    [record],
  );

  const closeField = useCallback(() => {
    setField(null);
    setFieldError(null);
    setDraft('');
  }, []);

  const saveDate = useCallback(
    async (date: string | null): Promise<DaybookRecord> => {
      const body = await apiPatch<{ record: DaybookRecord }>(`/api/daybook/records/${id}`, {
        occurredAt: date,
      });
      return body.record;
    },
    [id],
  );

  const saveField = useCallback(async () => {
    if (!record || !field || savingField) return;
    const text = draft.trim();
    const patch: RecordPatch = {};

    if (field === 'title') {
      if (!text) {
        setFieldError('Give it a short name, so you can find it again.');
        return;
      }
      patch.title = text;
    } else if (field === 'counterparty') {
      patch.counterparty = text || null;
    } else if (field === 'category') {
      patch.category = text || null;
    } else if (field === 'note') {
      patch.note = text || null;
    } else if (field === 'amount') {
      if (text) {
        const amount = normalizeUserAmount(text);
        if (!amount) {
          setFieldError('Write it in digits, like 450 or 1,250.50.');
          return;
        }

        const currency = currencyInUserAmount(text) ?? record.currency;
        if (!currency) {
          setFieldError(`Write the currency with it, like ${EXAMPLE_SIGN}450.`);
          return;
        }
        patch.amount = amount;
        patch.currency = currency;
        patch.direction = draftDirection;
      } else {
        patch.amount = null;
      }
    }

    let date: string | null = null;
    if (field === 'date' && text) {
      date = normalizeTypedDate(text);
      if (!date) {
        setFieldError('Write it as day/month/year, like 12/08/2025.');
        return;
      }
    }

    setSavingField(true);
    setFieldError(null);
    try {
      const next = field === 'date' ? await saveDate(date) : await updateRecord(record.id, patch);
      setRecord(next);
      setSavedField(field);
      closeField();
      toast.show({ message: SAVED_WORDS[field], tone: 'ok' });
    } catch (caught) {

      setFieldError(readableError(caught, 'That could not be saved just now. Please try again.'));
    } finally {
      setSavingField(false);
    }
  }, [record, field, draft, draftDirection, savingField, saveDate, closeField, toast]);

  const sendAnswer = useCallback(
    async (value: string) => {
      const text = value.trim();
      if (!record || !text || answering) return;
      setAnswering(true);
      setAnswerError(null);
      try {
        const next = await answerRecord(record.id, text);
        setRecord(next);
        setAnswer('');
        toast.show({ message: 'Thanks — added.', tone: 'ok' });
      } catch (caught) {
        setAnswerError(readableError(caught, 'That answer could not be saved just now.'));
      } finally {
        setAnswering(false);
      }
    },
    [record, answering, toast],
  );

  const skipTheQuestion = useCallback(async () => {
    if (!record || answering) return;
    setAnswering(true);
    setAnswerError(null);
    try {
      setRecord(await skipQuestion(record.id));
      setAnswer('');
      toast.show({ message: 'No problem — we won’t ask again.' });
    } catch (caught) {
      setAnswerError(readableError(caught, 'That answer could not be saved just now.'));
    } finally {
      setAnswering(false);
    }
  }, [record, answering, toast]);

  const readAgain = useCallback(async () => {
    if (!record || retrying) return;
    setRetrying(true);
    try {
      const next = await retryRecord(record.id);
      setRecord(next);
      setAttempt(0);
      toast.show({ message: 'Having another go at it.', tone: 'info' });
    } catch (caught) {
      toast.show({ message: readableError(caught, 'It couldn’t be read again just now.'), tone: 'danger' });
    } finally {
      setRetrying(false);
    }
  }, [record, retrying, toast]);

  const closeNewTask = useCallback(() => {
    setAddingTask(false);
    setTaskDraft('');
    setTaskError(null);
  }, []);

  const saveNewTask = useCallback(async () => {
    if (!record || savingTask) return;
    const text = taskDraft.trim();
    if (!text) {
      setTaskError('Write what needs doing, in a few words.');
      return;
    }
    setSavingTask(true);
    setTaskError(null);
    try {

      const created = await createTask({ text, recordId: record.id });
      setTasks((before) => [...before, created]);
      closeNewTask();
      toast.show({ message: 'Added to your list.', tone: 'ok' });
    } catch (caught) {

      setTaskError(readableError(caught, 'That couldn’t be added just now.'));
    } finally {
      setSavingTask(false);
    }
  }, [record, savingTask, taskDraft, closeNewTask, toast]);

  const toggleTask = useCallback(
    async (task: Task) => {
      if (ticking) return;
      const done = task.doneAt === null;
      setTicking(task.id);
      setTasks((before) =>
        before.map((entry) =>
          entry.id === task.id ? { ...entry, doneAt: done ? Date.now() : null } : entry,
        ),
      );
      try {
        const next = await updateTask(task.id, { done });
        setTasks((before) => before.map((entry) => (entry.id === task.id ? next : entry)));
      } catch (caught) {
        setTasks((before) => before.map((entry) => (entry.id === task.id ? task : entry)));
        toast.show({
          message: readableError(
            caught,
            done ? 'That couldn’t be ticked off just now.' : 'That couldn’t be put back just now.',
          ),
          tone: 'danger',
        });
      } finally {
        setTicking(null);
      }
    },
    [ticking, toast],
  );

  const shareThis = useCallback(async () => {
    if (!record || sharing) return;
    setSharing(true);
    try {
      const title = record.title?.trim() || recordKindLabel(record.kind);
      const text = recordShareText(record, details.reference);
      if (Platform.OS === 'web') {
        const web = navigator as Navigator & { share?: (data: { title?: string; text?: string }) => Promise<void> };
        if (web.share) await web.share({ title, text });
        else {
          await navigator.clipboard.writeText(text);
          toast.show({ message: 'Copied, ready to paste.', tone: 'ok' });
        }
      } else {
        await Share.share({ title, message: text });
      }
    } catch {
      toast.show({ message: 'That couldn’t be shared just now.', tone: 'danger' });
    } finally {
      setSharing(false);
    }
  }, [record, sharing, details.reference, toast]);

  const openOriginal = useCallback(async () => {
    const fileId = record?.fileId;
    if (!record || !fileId || opening) return;
    setOpening(true);
    try {
      const endpoint = fileEndpoint(fileId);
      const headers = await currentAuthHeaders();
      const name = exportFileName(record.title, recordKindLabel(record.kind));
      if (Platform.OS === 'web') {
        const response = await fetch(endpoint, { headers });
        if (!response.ok) throw new Error('unavailable');
        downloadBlob(await response.blob(), name);
      } else {
        const directory = FileSystem.cacheDirectory;
        if (!directory || !(await Sharing.isAvailableAsync())) {
          toast.show({ message: 'There’s nothing on this phone that can open it.', tone: 'warn' });
          return;
        }
        const destination = `${directory}${fileId}-${name}`;
        try {
          const result = await FileSystem.downloadAsync(endpoint, destination, { headers });
          if (result.status !== 200) throw new Error('unavailable');
          await Sharing.shareAsync(result.uri);
        } finally {
          await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
        }
      }
    } catch {
      toast.show({ message: 'The original couldn’t be opened just now.', tone: 'danger' });
    } finally {
      setOpening(false);
    }
  }, [record, opening, toast]);

  const useAsProof = useCallback(async () => {
    if (!record || evidence || record.status === 'processing') return;
    setEvidence(true);
    try {
      const { case: opened, existing } = await createCaseFromRecord(record.id);
      if (existing) toast.show({ message: 'You already started one — here it is.' });
      router.push({ pathname: '/case/[id]', params: { id: opened.id } });
    } catch (caught) {
      toast.show({ message: readableError(caught, 'A dispute couldn’t be started just now.'), tone: 'danger' });
    } finally {
      setEvidence(false);
    }
  }, [record, evidence, toast]);

  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  const commitDelete = useCallback(async () => {
    if (!pending.current) return;
    pending.current = false;
    try {
      await deleteRecord(id);
    } catch (caught) {
      setDeleted(false);

      toast.show({
        message: readableError(caught, 'This couldn’t be deleted just now — it’s still on your timeline.'),
        tone: 'danger',
      });
      return;
    }
    leave();
  }, [id, leave, toast]);

  const startDelete = useCallback(() => {
    setConfirmingDelete(false);
    setDeleted(true);
    pending.current = true;
    timer.current = setTimeout(() => void commitDelete(), UNDO_WINDOW_MS);
  }, [commitDelete]);

  const undoDelete = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = false;
    setDeleted(false);
    toast.show({ message: 'Kept it.' });
  }, [toast]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) {
        pending.current = false;
        void deleteRecord(id).catch(() => {});
      }
    },
    [id],
  );

  const stuck = record?.status === 'failed' || record?.status === 'unreadable';
  const slow = record?.status === 'processing' && Date.now() - record.updatedAt > PATIENCE_MS;
  const canReadAgain = Boolean(record?.fileId) && (stuck || slow || pollingStopped);

  const gone = error instanceof ApiError && error.isMissing;

  const actions: ScreenAction[] | undefined =
    record && !deleted
      ? [
          ...(canReadAgain
            ? [
                {
                  icon: 'refresh' as const,
                  label: 'Read it again',
                  onPress: () => void readAgain(),
                  disabled: retrying,
                },
              ]
            : []),
          { icon: 'share-variant' as const, label: 'Share the details', onPress: () => void shareThis(), disabled: sharing },
          {
            icon: 'trash-can-outline' as const,
            label: 'Delete this',
            onPress: () => setConfirmingDelete(true),
          },
        ]
      : undefined;

  const heading = record?.title?.trim() || (record ? recordKindLabel(record.kind) : 'One saved thing');
  const amountTone = record?.direction === 'in' ? theme.tone('ok').fg : theme.colors.text;
  const showsPicture =
    Boolean(record?.fileId) && !pictureFailed && !details.isDocument;

  const frame: ViewStyle = {
    width: '100%',
    aspectRatio: PREVIEW_RATIO,
    borderRadius: theme.radius.lg,
    overflow: 'hidden',
    borderWidth: BORDER_WIDTH.hairline,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSunken,
  };

  const question = record?.question ?? null;
  const askedAbout = question?.field?.toLowerCase() ?? '';

  return (
    <>
      <ScreenScroll
        title={deleted ? 'Deleted' : heading}
        back
        onRefresh={refresh}
        refreshing={refreshing}
        {...(record && !deleted ? { overline: recordKindLabel(record.kind) } : {})}
        {...(actions ? { actions } : {})}
        {...(record && !deleted ? { meta: <StatusPill status={record.status} /> } : {})}
      >
        {deleted ? (
          <GlassSurface padding="xl">
            <Stack gap="lg">
              <Row gap="md" align="center">
                <IconTile icon="trash-can-outline" size="md" tone="danger" />
                <View style={{ flex: 1 }}>
                  <Text variant="subheading">It’s gone from your timeline</Text>
                  <Text variant="bodySmall" colorToken="textSecondary">
                    Changed your mind? Put it back now — in a moment it won’t be possible.
                  </Text>
                </View>
              </Row>
              <Button label="Put it back" icon="undo" variant="secondary" onPress={undoDelete} fullWidth />
            </Stack>
          </GlassSurface>
        ) : loading && !record ? (
          <Stack gap="lg">
            <View style={frame}>
              <Skeleton radius="none" style={{ flex: 1 }} />
            </View>
            <SkeletonList count={2} />
          </Stack>
        ) : error && !record ? (
          gone ? (

            <EmptyState
              icon="trash-can-outline"
              title="This isn’t here any more"
              message="It looks like this was deleted. Nothing else has changed."
              action={{ label: 'Back to your timeline', icon: 'arrow-left', onPress: () => router.replace('/') }}
            />
          ) : (
            <ErrorState
              title="This wouldn’t open"
              message={readableError(error, 'This could not be opened just now.')}
              {...(worthRetrying(error)
                ? {
                    onRetry: () => {
                      setLoading(true);
                      void load();
                    },
                  }
                : {})}
            />
          )
        ) : record ? (
          <SlideUpIn>
            <Stack gap="lg">
              {}
              {}
              {}
              {record.status === 'processing' ? (
                <GlassSurface variant="hero" tone="info" padding="xl">
                  <Stack gap="md">
                    <Row gap="sm" align="center">
                      <Icon name="auto-fix" size={18} color={theme.tone('info').fg} />
                      <Text variant="overline" tone="info">
                        Reading it now
                      </Text>
                    </Row>
                    {}
                    <Text variant="subheading">{record.progress ?? 'Reading the file.'}</Text>
                    {pollingStopped ? (
                      <Text variant="bodySmall" colorToken="textSecondary">
                        This is taking much longer than it should. Check again, or have another go at it.
                      </Text>
                    ) : (
                      <Text variant="bodySmall" colorToken="textSecondary">
                        You can leave this page — it carries on without you.
                      </Text>
                    )}
                    <Row gap="md">
                      <View style={{ flex: 1 }}>
                        <Button
                          label="Check now"
                          icon="refresh"
                          variant="secondary"
                          size="sm"
                          onPress={() => {
                            setAttempt(0);
                            void load();
                          }}
                          fullWidth
                        />
                      </View>
                      {canReadAgain ? (
                        <View style={{ flex: 1 }}>
                          <Button
                            label="Read it again"
                            icon="restart"
                            variant="ghost"
                            size="sm"
                            loading={retrying}
                            onPress={() => void readAgain()}
                            fullWidth
                          />
                        </View>
                      ) : null}
                    </Row>
                  </Stack>
                </GlassSurface>
              ) : null}

              {}
              {}
              {}
              {question ? (
                <GlassSurface variant="hero" tone="accent" padding="xl">
                  <Stack gap="md">
                    <Row gap="sm" align="center">
                      <Icon name="help-circle-outline" size={18} color={theme.tone('accent').fg} />
                      <Text variant="overline" tone="accent">
                        One thing to check
                      </Text>
                    </Row>
                    <Text variant="subheading">{question.prompt}</Text>
                    {question.options.length ? (
                      <Row wrap gap="sm">
                        {question.options.map((option) => (
                          <Pressable
                            key={option}
                            onPress={() => void sendAnswer(option)}
                            disabled={answering}
                            haptic
                            pressScale={0.96}
                            accessibilityRole="button"
                            accessibilityLabel={option}
                            accessibilityHint="Answers with this"
                            style={{ minHeight: HIT_TARGET, justifyContent: 'center' }}
                          >
                            <Chip label={option} tone="accent" emphasis="outline" size="md" />
                          </Pressable>
                        ))}
                      </Row>
                    ) : null}
                    <TextField
                      label={question.options.length ? 'Or say it in your own words' : 'Your answer'}
                      value={answer}
                      onChangeText={(next) => {
                        setAnswer(next);
                        setAnswerError(null);
                      }}
                      placeholder={
                        askedAbout === 'amount'
                          ? 'How much, with the currency'
                          : askedAbout === 'date'
                            ? '12/08/2025'
                            : askedAbout === 'counterparty'
                              ? 'Who it was with'
                              : 'A few words is plenty'
                      }
                      icon={
                        askedAbout === 'amount'
                          ? 'cash'
                          : askedAbout === 'date'
                            ? 'calendar-blank-outline'
                            : askedAbout === 'counterparty'
                              ? 'account-outline'
                              : 'text-short'
                      }
                      mono={askedAbout === 'amount'}
                      error={answerError ?? undefined}
                      editable={!answering}
                      returnKeyType="done"
                      onSubmitEditing={() => void sendAnswer(answer)}
                    />
                    <Row gap="md">
                      <View style={{ flex: 1 }}>
                        <Button
                          label="I’m not sure"
                          variant="ghost"
                          onPress={() => void skipTheQuestion()}
                          disabled={answering}
                          accessibilityHint="Closes the question without answering it"
                          fullWidth
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Button
                          label="Save this"
                          variant="primary"
                          onPress={() => void sendAnswer(answer)}
                          loading={answering}
                          disabled={!answer.trim()}
                          fullWidth
                        />
                      </View>
                    </Row>
                  </Stack>
                </GlassSurface>
              ) : null}

              {}
              {}
              {}
              {details.unread || stuck ? (
                <Stack gap="sm">
                  <Notice
                    tone={record.status === 'failed' ? 'danger' : 'warn'}
                    icon="eye-off-outline"
                    title={
                      record.status === 'failed'
                        ? 'Reading this stopped partway'
                        : 'We couldn’t read this one'
                    }
                    message={details.note ?? 'Nothing could be read from it.'}
                    detail="You can type in whatever matters — tap any line below."
                  />
                  {record.fileId ? (
                    <Button
                      label="Have another go at reading it"
                      icon="restart"
                      variant="secondary"
                      size="sm"
                      loading={retrying}
                      onPress={() => void readAgain()}
                      fullWidth
                    />
                  ) : null}
                </Stack>
              ) : details.note ? (

                <Notice tone="warn" icon="eye-check-outline" title="Worth a second look" message={details.note} />
              ) : null}

              {}
              {}
              {}
              <GlassSurface variant="hero" padding="xl">
                <Stack gap="lg">
                  {field === 'amount' ? (
                    <Editor
                      label="How much"
                      value={draft}
                      onChange={setDraft}
                      onSave={() => void saveField()}
                      onCancel={closeField}
                      saving={savingField}
                      error={fieldError}
                      icon="cash"
                      placeholder={record.currency ? '1,250.50' : `like ${EXAMPLE_SIGN}450`}
                      hint={
                        record.currency
                          ? 'Leave it empty to take the amount off this altogether.'
                          : 'Write the currency with it, so nothing has to be guessed.'
                      }
                      mono
                      numeric={Boolean(record.currency)}
                    >
                      <SegmentedControl<DaybookDirection>
                        options={[
                          { value: 'out', label: 'I paid', icon: 'arrow-up-right' },
                          { value: 'in', label: 'I was paid', icon: 'arrow-down-left' },
                        ]}
                        value={draftDirection}
                        onChange={setDraftDirection}
                      />
                    </Editor>
                  ) : (
                    <Pressable
                      onPress={() => openField('amount')}
                      dimOnPress
                      pressScale={1}
                      accessibilityRole="button"
                      accessibilityLabel={
                        record.amountLabel
                          ? `${record.direction === 'in' ? 'Received' : record.direction === 'out' ? 'Paid' : 'Amount'} ${record.amountLabel}`
                          : 'No amount on this yet'
                      }
                      accessibilityHint="Opens the amount so you can change it"
                      style={{ minHeight: HIT_TARGET, borderRadius: theme.radius.md }}
                    >
                      <Row between align="flex-start">
                        <View style={{ flex: 1 }}>
                          <Row gap="xs" align="center">
                            <Icon
                              name={record.direction === 'in' ? 'arrow-down-left' : 'arrow-up-right'}
                              size={14}
                              color={amountTone}
                            />
                            <Text variant="overline" colorToken="textTertiary">
                              {record.direction === 'in' ? 'Received' : record.direction === 'out' ? 'Paid' : 'Amount'}
                            </Text>
                          </Row>
                          {record.amountLabel ? (
                            <Text
                              variant="statValue"
                              mono
                              style={{ color: amountTone, marginTop: theme.spacing.xs }}
                            >
                              {record.amountLabel}
                            </Text>
                          ) : (
                            <Text variant="subheading" colorToken="textTertiary" style={{ marginTop: theme.spacing.xs }}>
                              Add how much it was
                            </Text>
                          )}
                        </View>
                        {savedField === 'amount' ? (
                          <Chip label="Saved" tone="ok" icon="check" size="sm" />
                        ) : (
                          <Icon name="pencil-outline" size={16} color={theme.colors.textTertiary} />
                        )}
                      </Row>
                    </Pressable>
                  )}

                  <Divider />

                  {field === 'counterparty' ? (
                    <Editor
                      label="Who it was with"
                      value={draft}
                      onChange={setDraft}
                      onSave={() => void saveField()}
                      onCancel={closeField}
                      saving={savingField}
                      error={fieldError}
                      icon="account-outline"
                      placeholder="A person or a shop"
                    />
                  ) : (
                    <Line
                      icon="account-outline"
                      label="Who it was with"
                      value={record.counterparty}
                      blank="Add who it was with"
                      saved={savedField === 'counterparty'}
                      onEdit={() => openField('counterparty')}
                    />
                  )}

                  {field === 'date' ? (
                    <Editor
                      label="When it happened"
                      value={draft}
                      onChange={setDraft}
                      onSave={() => void saveField()}
                      onCancel={closeField}
                      saving={savingField}
                      error={fieldError}
                      icon="calendar-blank-outline"
                      placeholder="12/08/2025"
                      hint="Day, month, year. Leave it empty to take the date off."
                      mono
                      shortcuts={[
                        { label: 'Today', value: typedDate(Date.now()) },
                        { label: 'Yesterday', value: typedDate(Date.now() - DAY_MS) },
                      ]}
                    />
                  ) : (
                    <Line
                      icon="calendar-blank-outline"
                      label="When it happened"
                      value={
                        record.occurredAt === null
                          ? null
                          : formatOccurredOn(record.occurredAt, record.occurredPrecision)
                      }
                      blank="Add the date"
                      mono
                      saved={savedField === 'date'}
                      onEdit={() => openField('date')}
                    />
                  )}
                </Stack>
              </GlassSurface>

              {}
              {}
              {}
              {record.fileId ? (
                showsPicture && file.source ? (
                  <Stack gap="sm">
                    <Pressable
                      onPress={() => setViewing(true)}
                      dimOnPress
                      pressScale={1}
                      accessibilityRole="imagebutton"
                      accessibilityLabel="The picture you saved"
                      accessibilityHint="Opens it full screen, where you can zoom in"
                      style={frame}
                      contentStyle={{ flex: 1 }}
                    >
                      <Image
                        source={file.source}
                        style={{ flex: 1 }}
                        contentFit="contain"
                        transition={MOTION.duration.normal}
                        onError={() => setPictureFailed(true)}
                        accessibilityLabel="The picture you saved"
                      />
                    </Pressable>
                    <Row gap="xs" align="center" justify="center">
                      <Icon name="magnify-plus-outline" size={14} color={theme.colors.textTertiary} />
                      <Text variant="caption" colorToken="textTertiary">
                        Tap the picture to see it properly
                      </Text>
                    </Row>
                  </Stack>
                ) : showsPicture && !file.failed ? (
                  <View style={frame}>
                    <Skeleton radius="none" style={{ flex: 1 }} />
                  </View>
                ) : (
                  <GlassSurface padding="xl">
                    <Stack gap="lg">
                      <Row gap="md" align="center">
                        <IconTile
                          icon={file.failed || pictureFailed ? 'image-off-outline' : 'file-document-outline'}
                          size="md"
                          tone={file.failed || pictureFailed ? 'warn' : 'info'}
                        />
                        <View style={{ flex: 1 }}>
                          <Text variant="subheading">
                            {file.failed || pictureFailed ? 'We can’t show it here' : 'You saved a document'}
                          </Text>
                          <Text variant="bodySmall" colorToken="textSecondary">
                            {}
                            {file.failed || pictureFailed
                              ? 'It wouldn’t load just now. Try opening it, or pull down to have another go.'
                              : 'It isn’t a picture, so there’s nothing to show — but it’s here, and you can open it.'}
                          </Text>
                        </View>
                      </Row>
                      <Row gap="md">
                        {file.failed || pictureFailed ? (
                          <View style={{ flex: 1 }}>
                            <Button
                              label="Try again"
                              icon="refresh"
                              variant="ghost"
                              onPress={() => void refresh()}
                              fullWidth
                            />
                          </View>
                        ) : null}
                        <View style={{ flex: 1 }}>
                          <Button
                            label="Open the original"
                            icon="open-in-new"
                            variant="secondary"
                            loading={opening}
                            onPress={() => void openOriginal()}
                            fullWidth
                          />
                        </View>
                      </Row>
                    </Stack>
                  </GlassSurface>
                )
              ) : null}

              {}
              {}
              {}
              <View>
                <SectionHeader title="The details" hint="Tap any line to change it." />
                <GlassSurface padding="xl">
                  <Stack gap="lg">
                    {field === 'title' ? (
                      <Editor
                        label="What this is"
                        value={draft}
                        onChange={setDraft}
                        onSave={() => void saveField()}
                        onCancel={closeField}
                        saving={savingField}
                        error={fieldError}
                        icon="text-short"
                        placeholder="A few words you’ll recognise"
                      />
                    ) : (
                      <Line
                        icon="text-short"
                        label="What this is"
                        value={record.title?.trim() ? record.title : null}
                        blank="Give it a name"
                        saved={savedField === 'title'}
                        onEdit={() => openField('title')}
                      />
                    )}

                    {field === 'category' ? (
                      <Editor
                        label="What it was for"
                        value={draft}
                        onChange={setDraft}
                        onSave={() => void saveField()}
                        onCancel={closeField}
                        saving={savingField}
                        error={fieldError}
                        icon="tag-outline"
                        placeholder="Groceries, rent, medicines…"
                        hint="One or two words. Your spending gets grouped by this."
                      />
                    ) : (
                      <Line
                        icon="tag-outline"
                        label="What it was for"
                        value={record.category}
                        blank="Add what it was for"
                        saved={savedField === 'category'}
                        onEdit={() => openField('category')}
                      />
                    )}

                    {field === 'note' ? (
                      <Editor
                        label="Your note"
                        value={draft}
                        onChange={setDraft}
                        onSave={() => void saveField()}
                        onCancel={closeField}
                        saving={savingField}
                        error={fieldError}
                        icon="note-text-outline"
                        placeholder="Anything you’ll want to remember about this"
                        multiline
                      />
                    ) : (
                      <Line
                        icon="note-text-outline"
                        label="Your note"
                        value={record.note}
                        blank="Add a note"
                        saved={savedField === 'note'}
                        onEdit={() => openField('note')}
                      />
                    )}
                  </Stack>
                </GlassSurface>
              </View>

              {}
              {}
              {}
              {readHasContent(details) ? (
                <View>
                  <SectionHeader title="What we read on it" />
                  <GlassSurface padding="xl">
                    <Stack gap="lg">
                      {details.summary ? <Text variant="body">{details.summary}</Text> : null}
                      {details.reference ? (
                        <Line
                          icon="pound"
                          label="Reference on it"
                          value={details.reference}
                          blank="None on it"
                          mono
                        />
                      ) : null}
                      {details.marked ? (
                        <Line
                          icon="check-decagram-outline"
                          label="Marked as"
                          value={details.marked}
                          blank="Nothing"
                        />
                      ) : null}
                      {details.scene ? (
                        <Stack gap="xs">
                          <Text variant="overline" colorToken="textTertiary">
                            What’s in the picture
                          </Text>
                          <Text variant="body" colorToken="textSecondary">
                            {details.scene}
                          </Text>
                          <Text variant="caption" colorToken="textTertiary">
                            Described from the picture, not copied off it — so check it.
                          </Text>
                        </Stack>
                      ) : null}
                      {details.words ? <Quoted words={details.words} /> : null}
                    </Stack>
                  </GlassSurface>
                </View>
              ) : null}

              {}
              {}
              {}
              <View>
                <SectionHeader title="Do something with it" />
                <GlassSurface padding="xl">
                  <Stack gap="md">
                    {record.fileId && showsPicture && file.source ? (
                      <Button
                        label="Open the original"
                        icon="open-in-new"
                        variant="secondary"
                        loading={opening}
                        onPress={() => void openOriginal()}
                        accessibilityHint="Opens the file you saved outside this app"
                        fullWidth
                      />
                    ) : null}
                    <Button
                      label="Share the details"
                      icon="share-variant"
                      variant="secondary"
                      loading={sharing}
                      onPress={() => void shareThis()}
                      accessibilityHint="Sends what this says as text"
                      fullWidth
                    />
                    <Button
                      label={record.note ? 'Change your note' : 'Add a note'}
                      icon="note-plus-outline"
                      variant="secondary"
                      onPress={() => openField('note')}
                      fullWidth
                    />
                    <Stack gap="xs">
                      <Button
                        label="Use this as proof"
                        icon="gavel"
                        variant="secondary"
                        loading={evidence}
                        disabled={record.status === 'processing'}
                        onPress={() => void useAsProof()}
                        accessibilityHint="Starts a dispute about this, with this as the first piece of proof"
                        fullWidth
                      />
                      <Text variant="caption" colorToken="textTertiary" center>
                        Starts a dispute about this, with this as the first piece of proof. Nothing here changes, and
                        if you’ve already started one this opens it again.
                      </Text>
                    </Stack>
                  </Stack>
                </GlassSurface>
              </View>

              {}
              {}
              {}
              {link && related.length > 0 ? (
                <View>
                  <SectionHeader
                    title={relatedLinkTitle(link)}
                    count={related.length}
                    hint={relatedLinkHint(link)}
                  />
                  <GlassSurface padding="xl">
                    <Stack gap="sm">
                      {related.map((entry) => (
                        <LinkRow
                          key={entry.id}
                          icon={kindIcon(entry.kind)}
                          title={entry.title?.trim() || recordKindLabel(entry.kind)}
                          detail={formatAbsoluteDate(entry.occurredAt ?? entry.createdAt)}
                          trailing={entry.amountLabel}
                          onPress={() => router.push({ pathname: '/record/[id]', params: { id: entry.id } })}
                          accessibilityLabel={`${entry.title?.trim() || recordKindLabel(entry.kind)}. ${
                            entry.amountLabel ?? 'No amount'
                          }. Opens it.`}
                        />
                      ))}
                    </Stack>
                  </GlassSurface>
                </View>
              ) : null}

              <View>
                <SectionHeader
                  title="To do about this"
                  {...(tasks.length ? { count: tasks.length } : {})}
                  hint="Only the things that came out of this one."
                />
                <GlassSurface padding="xl">
                  <Stack gap="md">
                    {tasks.length ? (
                      <Stack gap="xs">
                        {tasks.map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            busy={ticking === task.id}
                            onToggle={() => void toggleTask(task)}
                          />
                        ))}
                      </Stack>
                    ) : addingTask ? null : (
                      <EmptyState
                        compact
                        icon="checkbox-marked-circle-outline"
                        title="Nothing to do about this"
                        message="If this leaves you something to chase up, write it down here."
                      />
                    )}
                    {addingTask ? (
                      <Stack gap="md">
                        <TextField
                          label="What needs doing"
                          value={taskDraft}
                          onChangeText={setTaskDraft}
                          icon="checkbox-marked-circle-outline"
                          placeholder="Ask the shop for a proper bill"
                          hint="A few words. You can give it a date from your list of things to do."
                          error={taskError ?? undefined}
                          autoFocus
                          editable={!savingTask}
                          returnKeyType="done"
                          onSubmitEditing={() => void saveNewTask()}
                        />
                        <Row gap="md">
                          <View style={{ flex: 1 }}>
                            <Button
                              label="Cancel"
                              variant="ghost"
                              onPress={closeNewTask}
                              disabled={savingTask}
                              fullWidth
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Button
                              label="Add it"
                              variant="primary"
                              onPress={() => void saveNewTask()}
                              loading={savingTask}
                              fullWidth
                            />
                          </View>
                        </Row>
                      </Stack>
                    ) : (
                      <Button
                        label="Add something to do"
                        icon="plus"
                        variant="secondary"
                        onPress={() => {
                          setTaskError(null);
                          setAddingTask(true);
                        }}
                        fullWidth
                      />
                    )}
                  </Stack>
                </GlassSurface>
              </View>

              <Text variant="caption" colorToken="textTertiary" center>
                Saved {formatRelativeTime(record.createdAt, Date.now())}
                {record.updatedAt > record.createdAt
                  ? ` · changed ${formatRelativeTime(record.updatedAt, Date.now())}`
                  : ''}
              </Text>
            </Stack>
          </SlideUpIn>
        ) : null}
      </ScreenScroll>

      <OriginalViewer
        visible={viewing}
        source={file.source}
        label="The picture you saved"
        onClose={() => setViewing(false)}
      />

      <BottomSheet
        visible={confirmingDelete}
        onDismiss={() => setConfirmingDelete(false)}
        header={<SheetHeader title="Delete this?" onClose={() => setConfirmingDelete(false)} />}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: theme.spacing.xl,
            gap: theme.spacing.lg,
          }}
        >
          <Text variant="body" colorToken="textSecondary">
            It comes off your timeline, along with the file you saved. You’ll get a few seconds to put it back.
          </Text>
          <Row gap="md">
            <View style={{ flex: 1 }}>
              <Button label="Keep it" variant="secondary" onPress={() => setConfirmingDelete(false)} fullWidth />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Delete" variant="danger" onPress={startDelete} fullWidth />
            </View>
          </Row>
        </ScrollView>
      </BottomSheet>
    </>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function typedDate(timestamp: number): string {
  const [year, month, day] = isoDateOf(timestamp).split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}
