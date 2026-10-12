import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';

import {
  ApiError,
  currentAuthHeaders,
  deleteCaseItem,
  describeCaseItem,
  fileEndpoint,
  getCaseItem,
  readableError,
  retryCaseItem,
  updateCaseItem,
  useFileSource,
  type CaseItemDetail,
  type CaseSide,
} from '@api';
import {
  BottomSheet,
  Button,
  Chip,
  ErrorState,
  formatMoneyCompact,
  formatTimestamp,
  GlassSurface,
  Icon,
  IconButton,
  Notice,
  ProgressChip,
  Row,
  ScreenScroll,
  SegmentedControl,
  SkeletonCard,
  Stack,
  Text,
  TextField,
  useTheme,
  useToast,
} from '@ui';

import { factSampleNote, itemStateLabel, itemStateNote, quoteLineFor } from './_logic';

const POLL_MS = 2500;

type Busy = 'save' | 'describe' | 'retry' | 'remove' | 'original' | null;

const SIDE_TITLE: Record<CaseSide, string> = { mine: 'Something of yours', theirs: 'Something of theirs' };

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

function Preview({ item }: { item: CaseItemDetail }) {
  const theme = useTheme();
  const { source, failed: loadFailed } = useFileSource(item.fileId);
  const [failed, setFailed] = useState(false);

  if (failed || loadFailed) {
    return <Notice tone="info" message="The picture could not be shown here. The original file still opens." />;
  }
  if (!source) return <ProgressChip label="Fetching the picture" tone="neutral" />;
  return (
    <Image
      source={source}
      contentFit="contain"
      accessibilityLabel={`The file itself: ${item.label}`}
      onError={() => setFailed(true)}
      style={{
        width: '100%',
        height: 320,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surface,
      }}
    />
  );
}

function Facts({ item }: { item: CaseItemDetail }) {
  const rows: Array<{ key: string; label: string; value: string; mono?: boolean }> = [
    ...item.facts.amounts.map((amount, index) => ({
      key: `amount-${index}`,
      label: amount.role === 'total' ? 'Amount' : 'One line of it',
      value: formatMoneyCompact(amount.minor, amount.currency),
    })),
    ...item.facts.dates.map((date, index) => ({
      key: `date-${index}`,
      label: 'A date written on it',
      value: date.raw,
    })),
    ...item.facts.references.map((reference, index) => ({
      key: `reference-${index}`,
      label: 'A reference number on it',
      value: reference.value,
      mono: true,
    })),
  ];
  const sample = factSampleNote(item.facts);
  if (rows.length === 0 && !sample) return null;

  return (
    <GlassSurface padding="lg">
      <Stack gap="md">
        <Text variant="subheading">What this says, in detail</Text>
        <Stack gap="sm">
          {rows.map((row) => (
            <Row key={row.key} between wrap gap="sm">
              <Text variant="caption" colorToken="textSecondary">
                {row.label}
              </Text>
              <Text variant={row.mono ? 'monoValue' : 'body'} selectable>
                {row.value}
              </Text>
            </Row>
          ))}
        </Stack>
        {}
        {sample ? (
          <Text variant="caption" colorToken="textTertiary">
            {sample}
          </Text>
        ) : null}
      </Stack>
    </GlassSurface>
  );
}

export default function CaseItemScreen() {
  const params = useLocalSearchParams<{ id: string; itemId: string; find?: string }>();
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  const id = first(params.id);
  const itemId = first(params.itemId);
  const find = first(params.find);

  const theme = useTheme();
  const toast = useToast();

  const [item, setItem] = useState<CaseItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState('');
  const [side, setSide] = useState<CaseSide>('mine');
  const [description, setDescription] = useState('');
  const [comparisonCleared, setComparisonCleared] = useState(false);

  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      if (!id || !itemId) throw new ApiError(404, 'That could not be found.', null, null);
      const result = await getCaseItem(id, itemId);
      if (!mounted.current) return;
      setItem(result);
      setLabel(result.label);
      setSide(result.side);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(readableError(cause, 'That could not be opened just now.'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [id, itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!item || (item.status !== 'pending' && item.status !== 'reading') || busy) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [item, busy, load]);

  const run = async (operation: Busy, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(operation);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      if (mounted.current) setActionError(readableError(cause, 'That did not work. Please try again.'));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      if (!item) return;
      const patch: { label?: string; side?: CaseSide } = {};
      if (label.trim() && label.trim() !== item.label) patch.label = label.trim();
      if (side !== item.side) patch.side = side;
      if (!patch.label && !patch.side) {
        setEditing(false);
        return;
      }
      const result = await updateCaseItem(id, itemId, patch);
      setEditing(false);
      setComparisonCleared(result.analysisCleared);
      await load();
      toast.show({
        message: result.analysisCleared
          ? 'Changed. The earlier comparison no longer fits, so it has gone.'
          : 'Changed.',
        tone: 'ok',
      });
    });

  const describe = () =>
    run('describe', async () => {
      await describeCaseItem(id, itemId, description.trim());
      setDescription('');
      await load();
      toast.show({ message: 'Saved in your words. It counts towards the comparison now.', tone: 'ok' });
    });

  const retry = () =>
    run('retry', async () => {
      await retryCaseItem(id, itemId);
      await load();
      toast.show({ message: 'Having another go at reading it.', tone: 'info' });
    });

  const remove = () =>
    run('remove', async () => {
      await deleteCaseItem(id, itemId);
      setConfirmRemove(false);
      toast.show({ message: 'Removed from the case.', tone: 'ok' });
      back();
    });

  const openOriginal = () =>
    run('original', async () => {
      if (!item?.fileId) return;
      const endpoint = fileEndpoint(item.fileId);
      const headers = await currentAuthHeaders();
      const safeName =
        (item.fileName || item.label).replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 120) || 'file';
      if (Platform.OS === 'web') {
        const response = await fetch(endpoint, { headers });
        if (!response.ok) throw new ApiError(response.status, 'The file could not be opened. Please try again.', null, null);
        downloadBlob(await response.blob(), safeName);
        return;
      }
      if (!(await Sharing.isAvailableAsync()) || !FileSystem.cacheDirectory) {
        throw new ApiError(0, 'This device cannot open the file from here.', null, null);
      }
      const destination = `${FileSystem.cacheDirectory}${item.fileId}-${safeName}`;
      try {
        const result = await FileSystem.downloadAsync(endpoint, destination, { headers });
        if (result.status !== 200) {
          throw new ApiError(result.status, 'The file could not be opened. Please try again.', null, null);
        }
        await Sharing.shareAsync(result.uri);
      } finally {
        await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
      }
    });

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace(`/case/${encodeURIComponent(id)}`);
  };

  const state = item ? itemStateLabel(item) : null;
  const quote = item && find ? quoteLineFor(item.text || item.excerpt, find) : null;
  const dirty = !!item && (label.trim() !== item.label || side !== item.side);

  const readingTitle = !item
    ? ''
    : item.kind === 'statement'
      ? 'What you wrote'
      : item.readBy === 'described'
        ? 'Your description of this file'
        : 'What was read from this file';

  return (
    <>
      <ScreenScroll
        title={item?.label ?? 'A piece of the case'}
        overline={item ? SIDE_TITLE[item.side] : 'Case'}
        back
        onBack={back}
        meta={state ? (state.busy ? <ProgressChip label={state.label} /> : <Chip label={state.label} tone={state.tone} />) : undefined}
        actions={
          item
            ? [
                {
                  icon: 'pencil-outline',
                  label: 'Correct what this is',
                  onPress: () => setEditing((value) => !value),
                  disabled: !!busy,
                },
              ]
            : []
        }
      >
        {loading ? (
          <SkeletonCard lines={4} />
        ) : !item ? (
          <ErrorState
            title="This could not be opened"
            message={error ?? 'It may have been removed from the case.'}
            onRetry={() => void load()}
          />
        ) : (
          <Stack gap="lg">
            {actionError ? (
              <Notice tone="danger" message={actionError} onDismiss={() => setActionError(null)} />
            ) : null}

            {comparisonCleared ? (
              <Notice
                tone="warn"
                title="The earlier comparison was removed"
                message="Every line of it was written in terms of which side each thing was on, so moving this made it wrong rather than merely out of date. Set the two sides against each other again when you are ready."
                onDismiss={() => setComparisonCleared(false)}
              />
            ) : null}

            {}
            {find ? (
              <GlassSurface padding="lg" tone={quote ? 'accent' : 'warn'}>
                <Stack gap="sm">
                  <Row gap="sm" align="center">
                    <Icon
                      name={quote ? 'text-search' : 'alert-outline'}
                      size={17}
                      color={quote ? theme.tone('accent').fg : theme.tone('warn').fg}
                    />
                    <Text variant="overline" colorToken="textTertiary">
                      {quote ? 'The line this points to' : 'That detail is not in this text'}
                    </Text>
                  </Row>
                  {quote ? (
                    <Text variant="mono" selectable>
                      {quote}
                    </Text>
                  ) : (
                    <Text variant="body" colorToken="textSecondary">
                      {`“${find}” does not appear in what was saved from this piece. Read the whole thing below, and open the original if you need to check it.`}
                    </Text>
                  )}
                </Stack>
              </GlassSurface>
            ) : null}

            {editing ? (
              <GlassSurface padding="lg">
                <Stack gap="md">
                  <Text variant="subheading">What is this, and whose is it?</Text>
                  <TextField
                    label="What should it be called?"
                    value={label}
                    onChangeText={setLabel}
                    maxLength={160}
                    editable={!busy}
                  />
                  <SegmentedControl<CaseSide>
                    value={side}
                    onChange={(next) => {
                      if (!busy) setSide(next);
                    }}
                    options={[
                      { value: 'mine', label: 'Mine', icon: 'account-outline' },
                      { value: 'theirs', label: 'Theirs', icon: 'account-multiple-outline' },
                    ]}
                  />
                  <Text variant="caption" colorToken="textTertiary">
                    Nothing is read again — the words on it do not change because of what it is called. Moving
                    it to the other side does remove any comparison already made, because every line of one
                    depends on which side a thing was on.
                  </Text>
                  <Button
                    label="Save this correction"
                    onPress={() => void save()}
                    loading={busy === 'save'}
                    disabled={!!busy || !label.trim() || !dirty}
                    fullWidth
                  />
                  <Button
                    label="Leave it as it is"
                    variant="ghost"
                    onPress={() => {
                      setEditing(false);
                      setLabel(item.label);
                      setSide(item.side);
                    }}
                    disabled={!!busy}
                    fullWidth
                  />
                </Stack>
              </GlassSurface>
            ) : null}

            <Text variant="caption" colorToken="textTertiary">
              Added {formatTimestamp(item.createdAt)}
            </Text>

            {}
            <Text variant="bodySmall" colorToken="textSecondary">
              {itemStateNote(item)}
            </Text>

            {item.mime?.startsWith('image/') && item.fileId ? <Preview key={item.fileId} item={item} /> : null}

            {item.readNote ? (
              <Notice tone={item.status === 'ready' ? 'info' : 'warn'} message={item.readNote} />
            ) : null}

            {}
            {item.fileHadMoreText ? (
              <Notice
                tone="warn"
                icon="text-long"
                title="Only part of this file was kept"
                message="The file held more words than could be saved, so what is below is not all of it, and reading it again will not recover the rest. The original file still has everything."
              />
            ) : null}

            {item.status === 'needs_context' && item.question ? (
              <GlassSurface padding="lg" tone="accent">
                <Stack gap="md">
                  <Row gap="sm" align="center">
                    <Icon name="help-circle-outline" size={18} color={theme.tone('accent').fg} />
                    <Text variant="overline" tone="accent">
                      Your words instead
                    </Text>
                  </Row>
                  <Text variant="subheading">{item.question}</Text>
                  <TextField
                    label="What does this show?"
                    placeholder="Any amount, date or name you can see on it."
                    value={description}
                    onChangeText={setDescription}
                    multiline
                    minHeight={120}
                    maxLength={8000}
                    editable={!busy}
                  />
                  <Button
                    label="Save what it shows"
                    onPress={() => void describe()}
                    loading={busy === 'describe'}
                    disabled={!!busy || !description.trim()}
                    fullWidth
                  />
                  <Text variant="caption" colorToken="textTertiary">
                    Kept as your description of the file, never as words read off it — everywhere it appears.
                  </Text>
                </Stack>
              </GlassSurface>
            ) : null}

            {item.text || item.excerpt ? (
              <GlassSurface padding="lg">
                <Stack gap="sm">
                  <Text variant="subheading">{readingTitle}</Text>
                  <Text variant="body" selectable>
                    {item.text || item.excerpt}
                  </Text>
                  {item.kind !== 'statement' && item.readBy !== 'described' ? (
                    <Text variant="caption" colorToken="textTertiary">
                      If this is wrong or garbled, the file is the thing to trust. Open it below, and you can
                      say what it shows in your own words instead.
                    </Text>
                  ) : null}
                </Stack>
              </GlassSurface>
            ) : null}

            <Facts item={item} />

            {item.fileId ? (
              <Button
                label={Platform.OS === 'web' ? 'Download the original' : 'Open the original'}
                icon="download-outline"
                variant="secondary"
                onPress={() => void openOriginal()}
                loading={busy === 'original'}
                disabled={!!busy}
                fullWidth
              />
            ) : null}

            {(item.status === 'failed' || item.status === 'unreadable' || item.status === 'needs_context') &&
            item.fileId ? (
              <Button
                label="Try reading it again"
                icon="refresh"
                variant={item.status === 'needs_context' ? 'secondary' : 'primary'}
                onPress={() => void retry()}
                loading={busy === 'retry'}
                disabled={!!busy}
                fullWidth
              />
            ) : null}

            <Button
              label="Remove this from the case"
              icon="trash-can-outline"
              variant="ghost"
              onPress={() => setConfirmRemove(true)}
              disabled={!!busy}
              fullWidth
            />
          </Stack>
        )}
      </ScreenScroll>

      <BottomSheet visible={confirmRemove} onDismiss={() => !busy && setConfirmRemove(false)} dismissOnBackdropPress={!busy}>
        <Row between style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.md }}>
          <Text variant="heading" style={{ flex: 1 }}>
            Remove this from the case?
          </Text>
          <IconButton icon="close" accessibilityLabel="Close" onPress={() => setConfirmRemove(false)} />
        </Row>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.xxl }}
        >
          <Stack gap="lg">
            <Text variant="body">
              {`${item?.label ?? 'This'} is taken out of the case, and any comparison that leaned on it stops being right. You can add it again later.`}
            </Text>
            <Button
              label="Remove it"
              variant="danger"
              onPress={() => void remove()}
              loading={busy === 'remove'}
              disabled={!!busy}
              fullWidth
            />
            <Button
              label="Keep it"
              variant="secondary"
              onPress={() => setConfirmRemove(false)}
              disabled={!!busy}
              fullWidth
            />
          </Stack>
        </ScrollView>
      </BottomSheet>

      <View />
    </>
  );
}
