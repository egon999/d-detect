import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, View, useWindowDimensions } from 'react-native';

import {
  ApiError,
  addCaseFile,
  addCaseStatement,
  analyzeCase,
  clearCaseAnalysis,
  deleteCase,
  getCase,
  getCaseReport,
  isCancelled,
  readableError,
  updateCase,
  worthRetrying,
  type CaseAnalysis,
  type CaseDetail,
  type CaseItem,
  type CaseReport,
  type CaseSide,
  type Coverage,
  type VerdictPoint,
} from '@api';
import {
  BottomSheet,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  GlassSurface,
  Icon,
  IconButton,
  IconTile,
  IndeterminateBar,
  Notice,
  Pressable,
  ProgressBar,
  ProgressChip,
  Row,
  ScreenScroll,
  SegmentedControl,
  SkeletonList,
  Stack,
  Text,
  TextField,
  formatTimestamp,
  useTheme,
  useToast,
  type IconName,
  type ScreenAction,
} from '@ui';

import {
  buildReportText,
  caseProgress,
  compareActionLabel,
  compareBlockerCopy,
  compareFailureCopy,
  compareReadiness,
  CONFIDENCE_NOTE,
  CONFLICT_ABOUT_LABEL,
  coverageDisclosure,
  factSampleNote,
  groupItemsBySide,
  groupSignals,
  isComparisonOutOfDate,
  itemStateLabel,
  materialGaps,
  readingProgress,
  reportFileName,
  resolveCitations,
  SIGNAL_GROUP_ORDER,
  SIGNAL_GROUP_TITLE,
  SIGNAL_GROUP_TONE,
  STANDING_LABEL,
  storedComparisonProblem,
  strengthenSection,
  STRENGTH_NOTE,
  WIDE_LAYOUT,
  type FailureCopy,
} from './_logic';

const POLL_MS = 2500;

type Pane = 'evidence' | 'comparison' | 'report' | 'dates';
type Sheet = 'add' | 'statement' | 'edit' | 'delete' | 'clear' | null;
type Busy = 'upload' | 'statement' | 'compare' | 'report' | 'edit' | 'delete' | 'clear' | null;

function itemIcon(item: Pick<CaseItem, 'kind'>): IconName {
  return item.kind === 'statement' ? 'message-text-outline' : 'file-document-outline';
}

const SIDE_LABEL: Record<CaseSide, string> = { mine: 'What I have', theirs: 'What they are saying' };

function ItemStateChip({ item }: { item: CaseItem }) {
  const state = itemStateLabel(item);
  if (state.busy) return <ProgressChip label={state.label} tone="info" />;
  return <Chip label={state.label} tone={state.tone} />;
}

function SheetBody({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const theme = useTheme();
  return (
    <>
      <Row between style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.md }}>
        <Text variant="heading" style={{ flex: 1 }}>
          {title}
        </Text>
        <IconButton icon="close" accessibilityLabel="Close" onPress={close} />
      </Row>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.xxl }}
      >
        <Stack gap="lg">{children}</Stack>
      </ScrollView>
    </>
  );
}

function ItemRow({ item, onPress }: { item: CaseItem; onPress: () => void }) {
  const theme = useTheme();
  const sample = factSampleNote(item.facts);

  return (
    <Pressable
      onPress={onPress}
      dimOnPress
      accessibilityRole="button"
      accessibilityLabel={`${item.label}. ${itemStateLabel(item).label}.`}
      style={{
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.md,
      }}
    >
      <Row gap="md" align="flex-start">
        <Icon name={itemIcon(item)} size={22} color={theme.colors.textSecondary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="body" numberOfLines={2}>
            {item.label}
          </Text>
          {item.excerpt ? (
            <Text variant="caption" colorToken="textSecondary" numberOfLines={2} style={{ marginTop: 4 }}>
              {item.excerpt}
            </Text>
          ) : null}
          <Row gap="sm" wrap align="center" style={{ marginTop: theme.spacing.sm }}>
            <ItemStateChip item={item} />
            {item.fileHadMoreText ? <Chip label="Only part could be saved" tone="warn" icon="alert-outline" /> : null}
            {sample ? <Chip label="Holds more than is listed" tone="neutral" icon="information-outline" /> : null}
          </Row>
        </View>
        <Icon name="chevron-right" size={20} color={theme.colors.textTertiary} />
      </Row>
    </Pressable>
  );
}

function EvidenceSide({
  side,
  claim,
  items,
  onAdd,
  onOpen,
  onEditAccounts,
}: {
  side: CaseSide;
  claim: string;
  items: CaseItem[];
  onAdd: () => void;
  onOpen: (item: CaseItem) => void;
  onEditAccounts: () => void;
}) {
  const theme = useTheme();
  const mine = side === 'mine';

  return (
    <GlassSurface padding="lg" tone={mine ? 'accent' : undefined}>
      <Stack gap="lg">
        <Row between gap="md">
          <Row gap="sm" align="center" style={{ flex: 1, minWidth: 0 }}>
            <IconTile
              icon={mine ? 'account-outline' : 'account-multiple-outline'}
              size="sm"
              tone={mine ? 'accent' : 'neutral'}
            />
            <Text variant="subheading" style={{ flex: 1 }}>
              {SIDE_LABEL[side]}
            </Text>
          </Row>
          <IconButton
            icon="plus"
            accessibilityLabel={mine ? 'Add something of mine' : 'Add something of theirs'}
            onPress={onAdd}
            filled
          />
        </Row>

        {}
        {claim ? (
          <Pressable
            onPress={onEditAccounts}
            dimOnPress
            accessibilityRole="button"
            accessibilityLabel={mine ? 'Change your account of what happened' : 'Change their account'}
            contentStyle={{ gap: theme.spacing.xs }}
            style={{
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.border,
              padding: theme.spacing.md,
            }}
          >
            <Row between gap="sm" align="center">
              <Text variant="overline" colorToken="textTertiary">
                {mine ? 'In your words' : 'In their words, as you heard them'}
              </Text>
              <Icon name="pencil-outline" size={14} color={theme.colors.textTertiary} />
            </Row>
            <Text variant="body" colorToken="textSecondary">
              {claim}
            </Text>
          </Pressable>
        ) : null}

        {items.length > 0 ? (
          <Stack gap="sm">
            {items.map((item) => (
              <ItemRow key={item.id} item={item} onPress={() => onOpen(item)} />
            ))}
          </Stack>
        ) : (
          <EmptyState
            compact
            icon={mine ? 'folder-open-outline' : 'message-text-outline'}
            title={mine ? 'Nothing of yours here yet' : 'Nothing from them yet'}
            message={
              mine
                ? 'A photo of the receipt, the screenshot of the message, the agreement — whatever you have. If you have no paper at all, write down what happened; that counts too.'
                : 'What they sent you — a message, a letter, a bill. If they have only said things out loud, write down what they said and when.'
            }
            action={{
              label: mine ? 'Add what you have' : 'Add what they said',
              onPress: onAdd,
              icon: 'plus',
            }}
          />
        )}

        {items.length > 0 ? (
          <Button
            label={mine ? 'Add something else of mine' : 'Add something else of theirs'}
            icon="plus"
            variant="secondary"
            onPress={onAdd}
            fullWidth
          />
        ) : null}
      </Stack>
    </GlassSurface>
  );
}

function Cited({
  ids,
  record,
  analysis,
  find,
  onOpen,
}: {
  ids: readonly string[];
  record: CaseDetail;
  analysis: CaseAnalysis | null;
  find?: string;
  onOpen: (item: CaseItem, find?: string) => void;
}) {
  const cited = resolveCitations(ids, record, analysis);
  if (cited.length === 0) return null;

  return (
    <Row gap="sm" wrap>
      {cited.map((citation) =>
        citation.item ? (
          <Pressable
            key={citation.id}
            onPress={() => onOpen(citation.item!, find)}
            dimOnPress
            accessibilityRole="button"
            accessibilityLabel={`Open ${citation.label}`}
          >
            <Chip
              label={citation.label}
              icon={itemIcon(citation.item)}
              tone={citation.side === 'mine' ? 'accent' : 'neutral'}
              shrink
            />
          </Pressable>
        ) : (
          <Chip
            key={citation.id}
            label={citation.account ? citation.label : `${citation.label} — no longer in this case`}
            icon={citation.account ? 'account-outline' : 'alert-outline'}
            tone={citation.removed ? 'warn' : 'neutral'}
            shrink
          />
        ),
      )}
    </Row>
  );
}

function PointList({
  points,
  record,
  analysis,
  onOpen,
}: {
  points: readonly VerdictPoint[];
  record: CaseDetail;
  analysis: CaseAnalysis | null;
  onOpen: (item: CaseItem, find?: string) => void;
}) {
  return (
    <Stack gap="md">
      {points.map((point, index) => (
        <Stack gap="sm" key={`${index}-${point.point}`}>
          <Text variant="body">{point.point}</Text>
          <Cited ids={point.sources} record={record} analysis={analysis} onOpen={onOpen} />
        </Stack>
      ))}
    </Stack>
  );
}

function CoverageNote({ coverage }: { coverage: Coverage | null }) {
  const disclosure = coverageDisclosure(coverage);
  if (!disclosure) return null;

  const names = disclosure.unrecoverable;
  const shortfall =
    names.length === 0
      ? null
      : names.length === 1
        ? `${names[0]} was already cut short when it was saved, so nothing here has seen all of it, and reading it again will not recover the rest. The original file still has everything.`
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} were already cut short when they were saved, so nothing here has seen all of them, and reading them again will not recover the rest. The original files still have everything.`;

  if (!disclosure.title) {
    return (
      <Stack gap="xs">
        <Text variant="caption" colorToken="textTertiary">
          {disclosure.message}
        </Text>
        {shortfall ? (
          <Text variant="caption" colorToken="textTertiary">
            {shortfall}
          </Text>
        ) : null}
      </Stack>
    );
  }
  return <Notice tone="warn" title={disclosure.title} message={disclosure.message} detail={shortfall} />;
}

function ComparisonView({
  record,
  onOpen,
  onCompare,
  onClear,
  onOpenReport,
  disabled,
  blockerAction,
}: {
  record: CaseDetail;
  onOpen: (item: CaseItem, find?: string) => void;
  onCompare: () => void;
  onClear: () => void;
  onOpenReport: () => void;
  disabled: boolean;
  blockerAction: { label: string; onPress: () => void } | null;
}) {
  const theme = useTheme();
  const analysis = record.analysis;
  const verdict = analysis?.verdict ?? null;
  const outOfDate = isComparisonOutOfDate(record);
  const grouped = groupSignals(record.signals);
  const anySignal = SIGNAL_GROUP_ORDER.some((group) => grouped[group].length > 0);
  const confidence = verdict ? CONFIDENCE_NOTE[verdict.confidence] : null;
  const strengthen = verdict ? strengthenSection(verdict) : null;

  const unreadable = storedComparisonProblem(record);

  return (
    <Stack gap="lg">
      {unreadable ? (
        <GlassSurface padding="lg" tone="warn">
          <Stack gap="md">
            <Row gap="sm" align="center">
              <Icon name="alert-outline" size={18} color={theme.tone('warn').fg} />
              <Text variant="subheading" style={{ flex: 1 }}>
                {unreadable.title}
              </Text>
            </Row>
            <Text variant="body" colorToken="textSecondary">
              {unreadable.message}
            </Text>
            <Button
              label="Compare the two sides again"
              icon="scale-balance"
              onPress={onCompare}
              disabled={disabled}
            />
          </Stack>
        </GlassSurface>
      ) : null}

      {outOfDate ? (
        <GlassSurface padding="lg" tone="warn">
          <Stack gap="md">
            <Row gap="sm" align="center">
              <Icon name="alert-outline" size={18} color={theme.tone('warn').fg} />
              <Text variant="subheading" style={{ flex: 1 }}>
                This reading is older than the case
              </Text>
            </Row>
            <Text variant="body" colorToken="textSecondary">
              Something has been added or changed since the two sides were last set against each other, so
              what is below does not cover all of it.
            </Text>
            <Row gap="sm" wrap>
              <Button label="Compare again" icon="scale-balance" onPress={onCompare} disabled={disabled} />
              <Button
                label="Remove this reading"
                icon="trash-can-outline"
                variant="ghost"
                onPress={onClear}
                disabled={disabled}
              />
            </Row>
          </Stack>
        </GlassSurface>
      ) : null}

      {verdict && analysis ? (
        <>
          <GlassSurface
            variant="hero"
            padding="xl"
            tone={verdict.standing === 'not_enough_evidence' ? 'warn' : 'accent'}
          >
            <Stack gap="md">
              <Chip
                label={STANDING_LABEL[verdict.standing]}
                tone={verdict.standing === 'not_enough_evidence' ? 'warn' : 'accent'}
              />
              <Text variant="heading">{verdict.headline}</Text>
              <Text variant="body" colorToken="textSecondary">
                {verdict.summary}
              </Text>
              {confidence ? (
                <Stack gap="xs">
                  <Chip label={confidence.label} tone={confidence.tone} />
                  <Text variant="caption" colorToken="textSecondary">
                    {confidence.detail}
                  </Text>
                </Stack>
              ) : null}
              <Text variant="caption" colorToken="textTertiary">
                Compared {formatTimestamp(analysis.createdAt)}
              </Text>
            </Stack>
          </GlassSurface>

          <CoverageNote coverage={analysis.coverage} />

          {}
          {verdict.yourAccount || verdict.theirAccount ? (
            <Stack gap="md">
              <Text variant="subheading">What each of you says happened</Text>
              {verdict.yourAccount ? (
                <GlassSurface padding="lg" tone="accent">
                  <Stack gap="xs">
                    <Text variant="overline" colorToken="textTertiary">
                      You
                    </Text>
                    <Text variant="body">{verdict.yourAccount}</Text>
                  </Stack>
                </GlassSurface>
              ) : null}
              {verdict.theirAccount ? (
                <GlassSurface padding="lg">
                  <Stack gap="xs">
                    <Text variant="overline" colorToken="textTertiary">
                      Them
                    </Text>
                    <Text variant="body">{verdict.theirAccount}</Text>
                  </Stack>
                </GlassSurface>
              ) : null}
            </Stack>
          ) : null}

          {verdict.conflicts.length > 0 ? (
            <Stack gap="md">
              <Text variant="subheading">Where the two accounts contradict each other</Text>
              {verdict.conflicts.map((conflict, index) => (
                <GlassSurface key={`${index}-${conflict.point}`} padding="lg" tone="warn">
                  <Stack gap="md">
                    <Chip label={CONFLICT_ABOUT_LABEL[conflict.about]} tone="warn" />
                    <Text variant="subheading">{conflict.point}</Text>

                    <Stack gap="sm">
                      <Text variant="overline" colorToken="textTertiary">
                        Your side
                      </Text>
                      <Text variant="body">{conflict.yourSide || 'You have not said anything on this point.'}</Text>
                      {conflict.yourValue ? (
                        <Text variant="monoValue" colorToken="textAccent">
                          {conflict.yourValue}
                        </Text>
                      ) : null}
                      <Cited
                        ids={conflict.yourSources}
                        record={record}
                        analysis={analysis}
                        {...(conflict.yourValue ? { find: conflict.yourValue } : {})}
                        onOpen={onOpen}
                      />
                    </Stack>

                    <Stack gap="sm">
                      <Text variant="overline" colorToken="textTertiary">
                        Their side
                      </Text>
                      <Text variant="body">
                        {conflict.theirSide || 'They have not said anything on this point.'}
                      </Text>
                      {conflict.theirValue ? (
                        <Text variant="monoValue">{conflict.theirValue}</Text>
                      ) : null}
                      <Cited
                        ids={conflict.theirSources}
                        record={record}
                        analysis={analysis}
                        {...(conflict.theirValue ? { find: conflict.theirValue } : {})}
                        onOpen={onOpen}
                      />
                    </Stack>

                    {conflict.reading ? (
                      <Text variant="body" colorToken="textSecondary">
                        {conflict.reading}
                      </Text>
                    ) : null}
                  </Stack>
                </GlassSurface>
              ))}
            </Stack>
          ) : null}

          {verdict.supported.length > 0 ? (
            <GlassSurface padding="lg">
              <Stack gap="md">
                <Row gap="sm" align="center">
                  <Icon name="check-circle-outline" size={18} color={theme.tone('ok').fg} />
                  <Text variant="subheading" style={{ flex: 1 }}>
                    What your material backs up
                  </Text>
                </Row>
                <PointList points={verdict.supported} record={record} analysis={analysis} onOpen={onOpen} />
              </Stack>
            </GlassSurface>
          ) : null}

          {}
          {verdict.notSupported.length > 0 ? (
            <GlassSurface padding="lg" tone="warn">
              <Stack gap="md">
                <Row gap="sm" align="center">
                  <Icon name="alert-circle-outline" size={18} color={theme.tone('warn').fg} />
                  <Text variant="subheading" style={{ flex: 1 }}>
                    What it does not back up
                  </Text>
                </Row>
                <PointList points={verdict.notSupported} record={record} analysis={analysis} onOpen={onOpen} />
              </Stack>
            </GlassSurface>
          ) : null}

          {}
          {strengthen ? (
            <GlassSurface padding="lg">
              <Stack gap="md">
                <Stack gap="xs">
                  <Text variant="subheading">{strengthen.title}</Text>
                  <Text variant="bodySmall" colorToken="textSecondary">
                    {strengthen.intro}
                  </Text>
                </Stack>
                {strengthen.points.map((gap, index) => (
                  <Row key={`${index}-${gap.point}`} gap="sm" align="flex-start">
                    <View style={{ paddingTop: 3 }}>
                      <Icon name="plus-circle-outline" size={17} color={theme.tone('accent').fg} />
                    </View>
                    <Stack gap="xxs" style={{ flex: 1 }}>
                      <Text variant="body">{gap.point}</Text>
                      {gap.wouldShow ? (
                        <Text variant="caption" colorToken="textSecondary">
                          {gap.wouldShow}
                        </Text>
                      ) : null}
                    </Stack>
                  </Row>
                ))}
              </Stack>
            </GlassSurface>
          ) : null}

          {verdict.evidence.length > 0 ? (
            <Stack gap="md">
              <Text variant="subheading">What each piece does for this</Text>
              {verdict.evidence.map((finding, index) => {
                const cited = resolveCitations([finding.itemId], record, analysis)[0] ?? null;
                const note = STRENGTH_NOTE[finding.strength];
                return (
                  <GlassSurface key={`${finding.itemId}-${index}`} padding="lg">
                    <Stack gap="md">
                      <Row gap="sm" between wrap align="center">
                        <Text variant="subheading" style={{ flex: 1 }}>
                          {cited?.label ?? 'Something no longer in this case'}
                        </Text>
                        <Chip label={note.label} tone={note.tone} shrink />
                      </Row>
                      <Text variant="body" colorToken="textSecondary">
                        {finding.reason}
                      </Text>
                      {cited?.item ? (
                        <Button
                          label="Open this"
                          icon={itemIcon(cited.item)}
                          variant="ghost"
                          size="sm"
                          onPress={() => onOpen(cited.item!)}
                        />
                      ) : (
                        <Text variant="caption" tone="warn">
                          This was removed from the case after the comparison ran. Compare again to leave it out.
                        </Text>
                      )}
                    </Stack>
                  </GlassSurface>
                );
              })}
            </Stack>
          ) : null}

          {verdict.nextStep ? (
            <GlassSurface padding="lg" tone="accent">
              <Stack gap="sm">
                <Text variant="subheading">What you could do next</Text>
                <Text variant="body">{verdict.nextStep}</Text>
              </Stack>
            </GlassSurface>
          ) : null}

          <Button
            label="Make a report of this"
            icon="file-document-outline"
            variant="secondary"
            onPress={onOpenReport}
            disabled={disabled}
            fullWidth
          />

          <Text variant="caption" colorToken="textTertiary">
            This reads only what you added here. It cannot confirm a bank transfer, prove a document is
            genuine, or tell you what any authority would decide. It is not legal advice.
          </Text>
        </>
      ) : (
        <EmptyState
          compact
          icon="scale-balance"
          title="The two sides have not been set against each other yet"
          message="When you are ready, both accounts are read together: what they agree on, exactly where they contradict each other, and what would make your side stronger."
          action={
            blockerAction
              ? { label: blockerAction.label, onPress: blockerAction.onPress, icon: 'plus' }
              : { label: 'Compare the two sides', onPress: onCompare, icon: 'scale-balance' }
          }
        />
      )}

      {}
      {anySignal ? (
        <Stack gap="lg">
          <Text variant="subheading">What the material itself shows</Text>
          {SIGNAL_GROUP_ORDER.filter((group) => grouped[group].length > 0).map((group) => (
            <Stack gap="md" key={group}>
              <Text variant="overline" colorToken="textTertiary">
                {SIGNAL_GROUP_TITLE[group]}
              </Text>
              {grouped[group].map((signal, index) => (
                <GlassSurface key={`${signal.kind}-${index}`} padding="lg" tone={toneFor(group)}>
                  <Stack gap="sm">
                    <Text variant="subheading">{signal.headline}</Text>
                    <Text variant="body" colorToken="textSecondary">
                      {signal.detail}
                    </Text>
                    <Cited ids={signal.itemIds} record={record} analysis={analysis} onOpen={onOpen} />
                  </Stack>
                </GlassSurface>
              ))}
            </Stack>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

function toneFor(group: keyof typeof SIGNAL_GROUP_TONE): 'ok' | 'warn' | 'accent' | undefined {
  const tone = SIGNAL_GROUP_TONE[group];
  return tone === 'neutral' || tone === 'info' ? undefined : tone;
}

async function shareReportText(text: string, name: string): Promise<void> {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return;
  }
  if (!FileSystem.cacheDirectory) throw new Error('There is nowhere on this phone to write the file.');
  const destination = `${FileSystem.cacheDirectory}${name}`;
  try {
    await FileSystem.writeAsStringAsync(destination, text);
    if (!(await Sharing.isAvailableAsync())) {
      throw new Error('This phone has no way to save or send a file from an app.');
    }
    await Sharing.shareAsync(destination, {
      mimeType: 'text/plain',
      UTI: 'public.plain-text',
      dialogTitle: 'Your case summary',
    });
  } finally {

    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
  }
}

function ReportView({
  id,
  record,
  busy,
  onCompare,
}: {
  id: string;
  record: CaseDetail;
  busy: boolean;
  onCompare: () => void;
}) {
  const toast = useToast();
  const [report, setReport] = useState<CaseReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    setFailure(null);
    try {
      const next = await getCaseReport(id);
      if (current !== requestId.current) return;
      setReport(next);
      setStale(false);
    } catch (cause) {
      if (current !== requestId.current) return;
      setReport(null);
      if (cause instanceof ApiError && cause.status === 409) {
        setStale(true);
        setFailure(readableError(cause, 'This case has changed since it was compared.'));
      } else {
        setStale(false);
        setFailure(readableError(cause, 'The report could not be put together just now.'));
      }
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const text = useMemo(() => (report ? buildReportText(report) : null), [report]);

  const share = () => {
    if (!report || !text) return;
    void (async () => {
      try {
        await shareReportText(text, reportFileName(report.title, report.preparedAt));
      } catch (cause) {
        toast.show({ message: readableError(cause, 'The file could not be saved just now.'), tone: 'warn' });
      }
    })();
  };

  if (loading && !report) {
    return <SkeletonList count={2} />;
  }

  if (!record.analysis) {
    return (
      <EmptyState
        compact
        icon="file-document-outline"
        title="There is nothing to write up yet"
        message="A report is a summary of the comparison, so the two sides have to be set against each other first."
      />
    );
  }

  if (failure && !report) {
    return (
      <Stack gap="md">
        <ErrorState compact message={failure} onRetry={stale ? onCompare : () => void load()} />
        {stale ? (
          <Text variant="caption" colorToken="textTertiary">
            Comparing the two sides again brings the report up to date with everything in the case.
          </Text>
        ) : null}
      </Stack>
    );
  }

  if (!report || !text) return null;

  return (
    <Stack gap="lg">
      <GlassSurface padding="lg">
        <Stack gap="sm">
          <Text variant="subheading">This is the whole case, written up</Text>
          <Text variant="bodySmall" colorToken="textSecondary">
            Everything below is what the file will contain, word for word — both accounts, what was read
            from each piece, where the two disagree, what the material does and does not back up, and what
            would make your side stronger. Read it before you send it: it does not only say the things you
            would like it to.
          </Text>
        </Stack>
      </GlassSurface>

      <GlassSurface padding="lg">
        <Text variant="mono" selectable>
          {text}
        </Text>
      </GlassSurface>

      <Button
        label={Platform.OS === 'web' ? 'Download this summary' : 'Save or send this summary'}
        icon="download-outline"
        onPress={share}
        disabled={busy}
        fullWidth
      />
      <Text variant="caption" colorToken="textTertiary">
        {`Saved as ${reportFileName(report.title, report.preparedAt)}. It is a summary of what you added here, not legal advice, and not a decision by anybody.`}
      </Text>
    </Stack>
  );
}

function DatesView({ record, onOpen }: { record: CaseDetail; onOpen: (item: CaseItem) => void }) {
  const theme = useTheme();

  const events = useMemo(() => {
    const all: Array<{
      key: string;
      at: number;
      title: string;
      detail: string;
      icon: IconName;
      source?: CaseItem;
      dayOnly?: boolean;
    }> = [{ key: 'created', at: record.createdAt, title: 'Case started', detail: record.title, icon: 'folder-outline' }];

    for (const item of record.items) {
      all.push({
        key: item.id,
        at: item.createdAt,
        title: item.side === 'mine' ? 'You added something' : 'You added something of theirs',
        detail: item.label,
        icon: itemIcon(item),
        source: item,
      });
      const seen = new Set<number>();
      for (const [index, date] of item.facts.dates.entries()) {
        if (seen.has(date.at) || !Number.isFinite(date.at)) continue;
        seen.add(date.at);
        all.push({
          key: `${item.id}-date-${index}`,
          at: date.at,
          title: 'A date written in the material',
          detail: `${date.raw} — ${item.label}`,
          icon: 'calendar-outline',
          source: item,
          dayOnly: date.precision === 'day',
        });
      }
    }

    if (record.analysis) {
      all.push({
        key: record.analysis.id,
        at: record.analysis.createdAt,
        title: 'Both sides compared',
        detail: record.analysis.verdict.headline,
        icon: 'scale-balance',
      });
    }

    return all.sort((left, right) => left.at - right.at);
  }, [record]);

  return (
    <GlassSurface padding="lg">
      <Stack gap="lg">
        {events.map((event, index) => (
          <Row key={event.key} gap="md" align="flex-start">
            <View style={{ alignItems: 'center', alignSelf: 'stretch', width: theme.layout.tileSize }}>
              <IconTile icon={event.icon} tone={event.dayOnly ? 'neutral' : 'accent'} size="sm" />
              {index < events.length - 1 ? (
                <View
                  style={{
                    width: 1,
                    flex: 1,
                    minHeight: theme.spacing.xxl,
                    backgroundColor: theme.colors.border,
                    marginTop: theme.spacing.sm,
                  }}
                />
              ) : null}
            </View>
            <Stack gap="xs" style={{ flex: 1, paddingBottom: theme.spacing.md }}>
              <Text variant="caption" colorToken="textTertiary">
                {formatTimestamp(event.at)}
              </Text>
              <Text variant="subheading">{event.title}</Text>
              <Text variant="body" colorToken="textSecondary">
                {event.detail}
              </Text>
              {event.source ? (
                <Button
                  label="Open this"
                  variant="ghost"
                  size="sm"
                  onPress={() => onOpen(event.source as CaseItem)}
                />
              ) : null}
            </Stack>
          </Row>
        ))}
      </Stack>
    </GlassSurface>
  );
}

export default function CaseScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const theme = useTheme();
  const toast = useToast();
  const { width } = useWindowDimensions();

  const [record, setRecord] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<{ message: string; retry: (() => void) | null } | null>(
    null,
  );

  const [compareFailure, setCompareFailure] = useState<FailureCopy | null>(null);
  const [pane, setPane] = useState<Pane>('evidence');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [side, setSide] = useState<CaseSide>('mine');
  const [busy, setBusy] = useState<Busy>(null);
  const [statementLabel, setStatementLabel] = useState('');
  const [statementText, setStatementText] = useState('');
  const [draft, setDraft] = useState({ title: '', question: '', myClaim: '', theirClaim: '' });

  const requestId = useRef(0);
  const lock = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
    };
  }, []);

  const reload = useCallback(async (): Promise<boolean> => {
    const current = ++requestId.current;
    try {
      if (!id) throw new ApiError(404, 'That case could not be found.', null, null);
      const result = await getCase(id);
      if (!mounted.current || current !== requestId.current) return false;
      setRecord(result);
      setError(null);
      return true;
    } catch (cause) {
      if (mounted.current && current === requestId.current) {
        setError(readableError(cause, 'That case could not be opened just now.'));
      }
      return false;
    } finally {
      if (mounted.current && current === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [id]);

  const load = useCallback(() => void reload(), [reload]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        requestId.current += 1;
      };
    }, [load]),
  );

  useEffect(() => {
    if (!record?.counts.pending || error || busy) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [record, error, busy, load]);

  const run = async (operation: Busy, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    requestId.current += 1;
    setBusy(operation);
    setActionError(null);
    try {
      await action();
    } catch (cause) {

      if (mounted.current && !isCancelled(cause)) {
        setActionError({
          message: readableError(cause, 'That did not work. Please try again.'),
          retry: worthRetrying(cause) ? () => void run(operation, action) : null,
        });
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const closeSheet = () => {
    if (!busy) {
      setSheet(null);
      setActionError(null);
    }
  };

  const openAdd = (nextSide: CaseSide) => {
    setSide(nextSide);
    setActionError(null);
    setSheet('add');
  };

  const openItem = useCallback(
    (item: CaseItem, find?: string) => {
      const query = find ? `&find=${encodeURIComponent(find)}` : '';
      router.push(`/case/item?id=${encodeURIComponent(id)}&itemId=${encodeURIComponent(item.id)}${query}`);
    },
    [id],
  );

  const openReport = useCallback(() => setPane('report'), []);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/cases'));

  const upload = () =>
    run('upload', async () => {
      const picked = await DocumentPicker.getDocumentAsync({
        type: [
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/heic',
          'application/pdf',
          'text/plain',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets[0]) return;
      const asset = picked.assets[0];
      const file =
        Platform.OS === 'web' && asset.file
          ? asset.file
          : { uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'application/octet-stream' };
      const result = await addCaseFile(id, file, { side });
      setSheet(null);
      setPane('evidence');
      await load();
      toast.show({
        message: result.duplicate
          ? 'That is already on this side of the case.'
          : result.item.status === 'ready'
            ? 'Added, and read.'
            : 'Added. It is being read now.',
        tone: result.duplicate ? 'info' : 'ok',
      });
    });

  const saveStatement = () =>
    run('statement', async () => {
      await addCaseStatement(id, {
        side,
        label: statementLabel.trim() || (side === 'mine' ? 'What I remember' : 'What they said'),
        text: statementText.trim(),
      });
      setStatementLabel('');
      setStatementText('');
      setSheet(null);
      setPane('evidence');
      await load();
      toast.show({ message: 'Written down and kept with the case.', tone: 'ok' });
    });

  const compare = (force = false) =>
    run('compare', async () => {
      setCompareFailure(null);
      try {
        await analyzeCase(id, force);
      } catch (cause) {
        if (mounted.current && !isCancelled(cause)) {

          setCompareFailure(
            compareFailureCopy(cause instanceof ApiError ? cause.status : null, {
              stillReading: record?.counts.pending ?? 0,
            }),
          );
          setPane('comparison');
        }
        await load();
        return;
      }
      await load();
      setPane('comparison');
    });

  const clearComparison = () =>
    run('clear', async () => {
      const result = await clearCaseAnalysis(id);
      setRecord(result.case);
      setCompareFailure(null);
      setSheet(null);
      setPane('evidence');
      toast.show({ message: 'That reading is gone. Your evidence is untouched.', tone: 'ok' });
    });

  const openEdit = () => {
    if (!record) return;
    setDraft({
      title: record.title,
      question: record.question,
      myClaim: record.myClaim,
      theirClaim: record.theirClaim,
    });
    setActionError(null);
    setSheet('edit');
  };

  const saveEdit = () =>
    run('edit', async () => {
      const result = await updateCase(id, {
        title: draft.title.trim(),
        question: draft.question.trim(),
        myClaim: draft.myClaim.trim(),
        theirClaim: draft.theirClaim.trim(),
      });
      setRecord(result);
      setSheet(null);
      toast.show({ message: 'Saved.', tone: 'ok' });
    });

  const toggleResolved = () =>
    run('edit', async () => {
      if (!record) return;
      setRecord(await updateCase(id, { status: record.status === 'resolved' ? 'open' : 'resolved' }));
      setSheet(null);
    });

  const removeCase = () =>
    run('delete', async () => {
      await deleteCase(id);
      setSheet(null);
      router.replace('/(tabs)/cases');
    });

  const sided = useMemo(() => groupItemsBySide(record?.items ?? []), [record]);
  const gaps = useMemo(() => materialGaps(record?.items ?? []), [record]);
  const readiness = useMemo(
    () =>
      record
        ? compareReadiness(record)
        : { ready: false, blocker: { kind: 'nothing_added' } as const, oneSided: true },
    [record],
  );
  const blockerCopy = readiness.blocker ? compareBlockerCopy(readiness.blocker) : null;
  const progress = record ? caseProgress(record) : null;
  const outOfDate = record ? isComparisonOutOfDate(record) : false;

  const reading = useMemo(() => readingProgress(record?.items ?? []), [record]);

  const unreadableComparison = record ? storedComparisonProblem(record) : null;

  const blockerAction = useMemo(() => {
    if (!blockerCopy?.action || !readiness.blocker) return null;
    const kind = readiness.blocker.kind;
    const label = blockerCopy.action;
    if (kind === 'nothing_of_yours') return { label, onPress: () => openAdd('mine') };
    if (kind === 'nothing_readable') {
      return {
        label,
        onPress: () => {
          setPane('evidence');
          const first = gaps.needsWords[0] ?? gaps.unread[0];
          if (first) openItem(first);
        },
      };
    }
    return { label, onPress: () => openAdd('mine') };
  }, [blockerCopy, readiness.blocker, gaps, openItem]);

  const actions: ScreenAction[] = record
    ? [
        ...(record.analysis && !outOfDate
          ? [{ icon: 'file-document-outline' as const, label: 'Make a report', onPress: openReport, disabled: !!busy }]
          : []),
        { icon: 'pencil-outline' as const, label: 'Change the details', onPress: openEdit, disabled: !!busy },
      ]
    : [];

  const footer = record ? (
    busy === 'compare' ? (
      <GlassSurface padding="lg">
        <Stack gap="sm">
          <Row gap="sm" align="center">
            <ProgressChip label="Setting the two sides against each other" tone="info" />
          </Row>
          <IndeterminateBar accessibilityLabel="Comparing the two sides" />
          <Text variant="caption" colorToken="textSecondary">
            This reads every piece you have added and can take a little while. Nothing is needed from you,
            and nothing is lost if you leave this screen.
          </Text>
        </Stack>
      </GlassSurface>
    ) : blockerAction ? (
      <Button label={blockerAction.label} icon="plus" onPress={blockerAction.onPress} fullWidth />
    ) : reading ? (
      <GlassSurface padding="lg">
        <Stack gap="sm">
          <Row gap="sm" align="center" wrap>
            <ProgressChip label={reading.label} tone="info" />
            <Text variant="caption" colorToken="textSecondary">
              {reading.done} of {reading.total} read
            </Text>
          </Row>
          <ProgressBar
            value={reading.fraction}
            tone="info"
            size="sm"
            accessibilityLabel={`${reading.done} of ${reading.total} pieces read`}
          />
          <Text variant="caption" colorToken="textSecondary">
            {reading.sentence}
          </Text>
        </Stack>
      </GlassSurface>
    ) : (
      <Button
        label={compareActionLabel({
          running: false,
          hasComparison: !!record.analysis,
          outOfDate,
        })}
        icon="scale-balance"
        onPress={() => void compare(outOfDate)}
        disabled={!!busy}
        fullWidth
      />
    )
  ) : undefined;

  return (
    <>
      <ScreenScroll
        title={record?.title ?? 'Case'}
        overline="Case"
        back
        onBack={back}
        subtitle={record?.question || undefined}
        meta={
          record?.status === 'resolved' ? (
            <Chip label="Settled" tone="ok" icon="check-circle-outline" />
          ) : progress ? (
            <Chip label={progress.label} tone={progress.tone} />
          ) : undefined
        }
        onRefresh={() => {
          setRefreshing(true);
          void load();
        }}
        refreshing={refreshing}
        actions={actions}
        {...(footer ? { footer } : {})}
      >
        {loading ? (
          <SkeletonList count={3} />
        ) : !record ? (
          <ErrorState
            title="This case could not be opened"
            message={error ?? 'It may have been deleted.'}
            onRetry={() => void load()}
          />
        ) : (
          <Stack gap="lg">
            {error ? <ErrorState compact message={error} onRetry={() => void load()} /> : null}
            {actionError && !sheet ? (
              <GlassSurface padding="lg" tone="danger">
                <Stack gap="md">
                  <Text variant="body">{actionError.message}</Text>
                  <Row gap="sm" wrap>
                    {actionError.retry ? (
                      <Button
                        label="Try that again"
                        icon="refresh"
                        size="sm"
                        onPress={actionError.retry}
                        disabled={!!busy}
                      />
                    ) : null}
                    <Button
                      label="Dismiss"
                      variant="ghost"
                      size="sm"
                      onPress={() => setActionError(null)}
                    />
                  </Row>
                </Stack>
              </GlassSurface>
            ) : null}
            {compareFailure ? (
              <GlassSurface padding="lg" tone="danger">
                <Stack gap="md">
                  <Text variant="subheading">{compareFailure.title}</Text>
                  <Text variant="body" colorToken="textSecondary">
                    {compareFailure.message}
                  </Text>
                  <Row gap="sm" wrap>
                    {compareFailure.retryLabel ? (
                      <Button
                        label={compareFailure.retryLabel}
                        onPress={() => void compare(true)}
                        disabled={!!busy}
                        size="sm"
                      />
                    ) : null}
                    <Button
                      label="Not now"
                      variant="ghost"
                      size="sm"
                      onPress={() => setCompareFailure(null)}
                    />
                  </Row>
                </Stack>
              </GlassSurface>
            ) : null}

            {}
            {pane === 'report' ? (
              <Row gap="sm" align="center">
                <Button
                  label="Back to the comparison"
                  icon="arrow-left"
                  variant="ghost"
                  size="sm"
                  onPress={() => setPane('comparison')}
                />
              </Row>
            ) : (
              <SegmentedControl<Pane>
                value={pane}
                onChange={setPane}
                options={[
                  { value: 'evidence', label: 'Evidence', icon: 'folder-outline' },
                  { value: 'comparison', label: 'Comparison', icon: 'scale-balance' },
                  { value: 'dates', label: 'Dates', icon: 'calendar-outline' },
                ]}
              />
            )}

            {pane === 'evidence' ? (
              <>
                {}
                {blockerCopy ? (
                  <Notice
                    tone={blockerCopy.tone === 'neutral' ? 'info' : blockerCopy.tone}
                    title={blockerCopy.title}
                    message={blockerCopy.message}
                  />
                ) : readiness.oneSided ? (
                  <Notice
                    tone="accent"
                    icon="account-multiple-outline"
                    title="Nothing from their side yet"
                    message="A comparison can still be run, and it will say plainly that only your side is here — but it cannot find a contradiction with nothing to contradict. Add what they sent you, or write down what they said."
                  />
                ) : null}

                {}
                {unreadableComparison ? (
                  <Notice
                    tone="warn"
                    icon="alert-circle-outline"
                    title={unreadableComparison.title}
                    message={unreadableComparison.message}
                  />
                ) : outOfDate ? (
                  <Notice
                    tone="warn"
                    title="The case has changed since it was compared"
                    message="What is under Comparison is a reading of older material. Compare again when you are ready, or remove that reading."
                  />
                ) : null}

                {gaps.needsWords.length > 0 ? (
                  <Notice
                    tone="accent"
                    icon="help-circle-outline"
                    title={
                      gaps.needsWords.length === 1
                        ? 'One file could not be read'
                        : `${gaps.needsWords.length} files could not be read`
                    }
                    message="Nothing could be read out of it, so it is waiting on you. Open it and say what it shows, and it counts towards the comparison just the same."
                  />
                ) : null}

                {gaps.unread.length > 0 ? (
                  <Notice
                    tone="warn"
                    icon="alert-circle-outline"
                    title={
                      gaps.unread.length === 1
                        ? 'One file came back unreadable'
                        : `${gaps.unread.length} files came back unreadable`
                    }
                    message="It is still here and still listed — nothing was dropped quietly. Open it to try again, or add a clearer copy."
                  />
                ) : null}

                {gaps.partlySaved.length > 0 ? (
                  <Notice
                    tone="warn"
                    icon="text-long"
                    title={
                      gaps.partlySaved.length === 1
                        ? 'One file was longer than could be saved'
                        : 'Some files were longer than could be saved'
                    }
                    message={`Only part of ${gaps.partlySaved.map((item) => item.label).join(', ')} was kept, so nothing here has seen all of it. Reading it again cannot recover the rest — the original file still can.`}
                  />
                ) : null}

                <View
                  style={{
                    flexDirection: width >= WIDE_LAYOUT ? 'row' : 'column',
                    gap: theme.spacing.lg,
                    alignItems: 'stretch',
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <EvidenceSide
                      side="mine"
                      claim={record.myClaim}
                      items={sided.mine}
                      onAdd={() => openAdd('mine')}
                      onOpen={openItem}
                      onEditAccounts={openEdit}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <EvidenceSide
                      side="theirs"
                      claim={record.theirClaim}
                      items={sided.theirs}
                      onAdd={() => openAdd('theirs')}
                      onOpen={openItem}
                      onEditAccounts={openEdit}
                    />
                  </View>
                </View>

                {record.analysis ? (
                  <Button
                    label="See the comparison"
                    icon="arrow-right"
                    iconTrailing
                    variant="secondary"
                    onPress={() => setPane('comparison')}
                    fullWidth
                  />
                ) : null}
              </>
            ) : pane === 'comparison' ? (
              <ComparisonView
                record={record}
                onOpen={openItem}
                onCompare={() => void compare(true)}
                onClear={() => setSheet('clear')}
                onOpenReport={openReport}
                disabled={!!busy}
                blockerAction={blockerAction}
              />
            ) : pane === 'report' ? (
              <ReportView
                id={id}
                record={record}
                busy={!!busy}
                onCompare={() => void compare(true)}
              />
            ) : (
              <DatesView record={record} onOpen={openItem} />
            )}
          </Stack>
        )}
      </ScreenScroll>

      <BottomSheet visible={sheet !== null} onDismiss={closeSheet} dismissOnBackdropPress={!busy}>
        <SheetBody
          title={
            sheet === 'add'
              ? side === 'mine'
                ? 'Add something of yours'
                : 'Add something of theirs'
              : sheet === 'statement'
                ? 'Write down what happened'
                : sheet === 'edit'
                  ? 'The details of this case'
                  : sheet === 'delete'
                    ? 'Delete this case?'
                    : 'Remove this reading?'
          }
          close={closeSheet}
        >
          {actionError ? (
            <Notice tone="danger" message={actionError.message} onDismiss={() => setActionError(null)} />
          ) : null}

          {sheet === 'add' || sheet === 'statement' ? (
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
          ) : null}

          {sheet === 'add' ? (
            <>
              <Button
                label="Choose a photo or a file"
                icon="paperclip"
                onPress={() => void upload()}
                loading={busy === 'upload'}
                disabled={!!busy}
                fullWidth
              />
              <Button
                label="Write it down instead"
                icon="message-text-outline"
                variant="secondary"
                onPress={() => setSheet('statement')}
                disabled={!!busy}
                fullWidth
              />
              <Text variant="caption" colorToken="textTertiary">
                Screenshots, photos, PDFs, Word documents and text files. Whatever is on it is read, and you
                can correct what was read.
              </Text>
            </>
          ) : null}

          {sheet === 'statement' ? (
            <>
              <TextField
                label="What should this be called?"
                labelHint="optional"
                placeholder="The phone call on 5 September"
                value={statementLabel}
                onChangeText={setStatementLabel}
                maxLength={160}
                editable={!busy}
              />
              <TextField
                label="What was said, or what happened?"
                placeholder="Any amount, date or name you remember helps — it is compared the same way a document is."
                multiline
                minHeight={180}
                value={statementText}
                onChangeText={setStatementText}
                maxLength={8000}
                editable={!busy}
              />
              <Button
                label="Keep this with the case"
                onPress={() => void saveStatement()}
                loading={busy === 'statement'}
                disabled={!!busy || !statementText.trim()}
                fullWidth
              />
            </>
          ) : null}

          {sheet === 'edit' && record ? (
            <>
              <TextField
                label="What happened?"
                value={draft.title}
                onChangeText={(title) => setDraft((value) => ({ ...value, title }))}
                maxLength={160}
                editable={!busy}
              />
              <TextField
                label="What do you want to happen?"
                labelHint="optional"
                value={draft.question}
                onChangeText={(question) => setDraft((value) => ({ ...value, question }))}
                maxLength={400}
                multiline
                minHeight={80}
                editable={!busy}
              />
              <TextField
                label="What you say happened"
                labelHint="optional"
                value={draft.myClaim}
                onChangeText={(myClaim) => setDraft((value) => ({ ...value, myClaim }))}
                maxLength={4000}
                multiline
                editable={!busy}
              />
              <TextField
                label="What they are saying"
                labelHint="optional"
                value={draft.theirClaim}
                onChangeText={(theirClaim) => setDraft((value) => ({ ...value, theirClaim }))}
                maxLength={4000}
                multiline
                editable={!busy}
              />
              <Button
                label="Save"
                onPress={() => void saveEdit()}
                loading={busy === 'edit'}
                disabled={!!busy || !draft.title.trim()}
                fullWidth
              />
              <Button
                label={record.status === 'resolved' ? 'Reopen this case' : 'Mark this as settled'}
                icon="check-circle-outline"
                variant="secondary"
                onPress={() => void toggleResolved()}
                disabled={!!busy}
                fullWidth
              />
              <Button
                label="Delete this case"
                icon="trash-can-outline"
                variant="ghost"
                onPress={() => setSheet('delete')}
                disabled={!!busy}
                fullWidth
              />
            </>
          ) : null}

          {sheet === 'clear' ? (
            <>
              <Text variant="body">
                The reading of the two sides is removed. Everything you added stays exactly where it is, and
                you can set them against each other again whenever you want.
              </Text>
              <Button
                label="Remove the reading"
                variant="danger"
                onPress={() => void clearComparison()}
                loading={busy === 'clear'}
                disabled={!!busy}
                fullWidth
              />
              <Button label="Keep it" variant="secondary" onPress={closeSheet} disabled={!!busy} fullWidth />
            </>
          ) : null}

          {sheet === 'delete' ? (
            <>
              <Text variant="body">
                This deletes the case, everything added to it and the comparison, and it cannot be undone.
                Anything saved in your own timeline stays there.
              </Text>
              <Button
                label="Delete this case"
                variant="danger"
                onPress={() => void removeCase()}
                loading={busy === 'delete'}
                disabled={!!busy}
                fullWidth
              />
              <Button
                label="Keep this case"
                variant="secondary"
                onPress={() => setSheet('edit')}
                disabled={!!busy}
                fullWidth
              />
            </>
          ) : null}
        </SheetBody>
      </BottomSheet>
    </>
  );
}
