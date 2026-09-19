import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useMemo, useState } from 'react';
import { Platform, Share, StyleSheet, View } from 'react-native';

import {
  generateDisputeNotice,
  type DisputeNotice,
} from '@domain/analysis/dispute-notice-generator';
import {
  draftQuestions,
  draftReadiness,
  fillLine,
  filingDraftForCase,
  renderDraftText,
  type DraftLine,
  type DraftQuestion,
  type FilingDraft,
} from '@domain/analysis/filing-draft';
import { describeLimitation, type LimitationWindow } from '@domain/analysis/limitation';
import { useSession } from '@services';
import { useDraftAnswers } from '@services/draft-answers';
import { useCaseRecord, useWorkspace } from '@services/use-case-store';
import {
  Button,
  Chip,
  Divider,
  EmptyState,
  errorDetail,
  ErrorState,
  HIT_TARGET,
  Icon,
  IconTile,
  LAYOUT,
  Notice,
  Pressable,
  readableError,
  routeParam,
  Row,
  ScreenScroll,
  Section,
  SegmentedControl,
  SkeletonCard,
  SPACING,
  Stack,
  Surface,
  Text,
  TextField,
  useTheme,
  useToast,
} from '@ui';

type LetterMode = 'notice' | 'regulatory';

export default function FilingLetterScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const caseId = routeParam(useLocalSearchParams<{ caseId?: string | string[] }>().caseId);
  const { user } = useSession();
  const { workspace, loading, refreshing, error: loadError, reload } = useWorkspace(user?.id ?? null, caseId);

  const record = useCaseRecord(workspace, caseId);
  const { answers, setAnswer, clearCaseAnswers, loaded } = useDraftAnswers(user?.id ?? null, caseId ?? null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  // Mode: Notice of Dispute (Default & Universal) or Regulatory Ombudsman Escalation
  const [mode, setMode] = useState<LetterMode>('notice');

  // Universal Formal Dispute Notice
  const disputeNotice: DisputeNotice | null = useMemo(() => {
    if (!caseId || !record) return null;
    try {
      return generateDisputeNotice(workspace, caseId, { noticeDateMs: now });
    } catch {
      return null;
    }
  }, [workspace, caseId, record, now]);

  // Regulatory Filing Draft (when a complaint went unanswered past scheme window)
  const draft = useMemo(
    () => (caseId ? filingDraftForCase(workspace, caseId, now) : null),
    [workspace, caseId, now],
  );

  const questions = useMemo(() => (draft ? draftQuestions(draft) : []), [draft]);
  const readiness = useMemo(
    () => (draft ? draftReadiness(draft, answers) : { blanks: 0, toCheck: 0 }),
    [draft, answers],
  );

  const evidenceTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of workspace.evidence) {
      if (!item.deletedAt) map.set(item.id, item.title);
    }
    return map;
  }, [workspace.evidence]);

  const letterText = useMemo(
    () => (draft ? renderDraftText(draft, answers) : ''),
    [draft, answers],
  );

  // ---------------------------------------------------------------------------
  // Action Handlers
  // ---------------------------------------------------------------------------

  const copyNotice = useCallback(async () => {
    if (!disputeNotice) return;
    setError(null);
    try {
      if (Platform.OS === 'web') {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
        if (clipboard?.writeText) {
          await clipboard.writeText(disputeNotice.plainText);
          toast.show({ message: 'Dispute notice copied to clipboard.' });
          return;
        }
      }
      await Share.share({ message: disputeNotice.plainText, title: disputeNotice.subject });
      toast.show({ message: 'Dispute notice shared.' });
    } catch (caught) {
      setError(readableError(caught, 'Notice could not be copied or shared.'));
    }
  }, [disputeNotice, toast]);

  const shareNoticePdf = useCallback(async () => {
    if (!disputeNotice) return;
    setBusy(true);
    setError(null);
    try {
      if (Platform.OS === 'web') {
        await Print.printAsync({ html: disputeNotice.html });
        return;
      }

      const file = await Print.printToFileAsync({ html: disputeNotice.html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Save Dispute Notice',
          UTI: 'com.adobe.pdf',
        });
      } else {
        await Print.printAsync({ uri: file.uri });
      }
    } catch (caught) {
      setError(readableError(caught, 'The dispute notice PDF could not be created.'));
    } finally {
      setBusy(false);
    }
  }, [disputeNotice]);

  const shareDraftText = useCallback(async () => {
    if (!draft) return;
    setError(null);
    try {
      if (Platform.OS === 'web') {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
        if (clipboard?.writeText) {
          await clipboard.writeText(letterText);
          toast.show({ message: 'The letter is on your clipboard.' });
          return;
        }
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ text: letterText, title: draft.subject });
          return;
        }
        setError('This browser will not let the app copy or share the letter. Use Print instead.');
        return;
      }
      await Share.share({ message: letterText, title: draft.subject });
    } catch (caught) {
      setError(readableError(caught, 'The letter could not be shared.'));
    }
  }, [draft, letterText, toast]);

  const shareDraftPdf = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const html = letterHtml(draft, letterText);

      if (Platform.OS === 'web') {
        await Print.printAsync({ html });
        return;
      }

      const file = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Save the letter',
          UTI: 'com.adobe.pdf',
        });
      } else {
        await Print.printAsync({ uri: file.uri });
      }
    } catch (caught) {
      setError(readableError(caught, 'The letter could not be created.'));
    } finally {
      setBusy(false);
    }
  }, [draft, letterText]);

  const discard = useCallback(() => {
    clearCaseAnswers();
    toast.show({ message: 'Your answers for this letter were cleared. The letter itself is unchanged.' });
  }, [clearCaseAnswers, toast]);

  // ---------------------------------------------------------------------------
  // Pre-load / Error States
  // ---------------------------------------------------------------------------

  if (loading && !record) {
    return (
      <ScreenScroll title="Dispute Notice & Letter" back contentStyle={styles.content}>
        <Stack gap="lg" accessibilityRole="progressbar" accessibilityLabel="Loading case and preparing notice">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={8} />
        </Stack>
      </ScreenScroll>
    );
  }

  if (loadError || !record) {
    return (
      <ScreenScroll
        title="Dispute Notice"
        back
        contentStyle={styles.content}
        refreshing={refreshing}
        onRefresh={reload}
      >
        {loadError ? (
          <ErrorState
            title="This case could not be read"
            message="The connection to your stored cases failed, so nothing could be assembled."
            detail={errorDetail(loadError)}
            onRetry={reload}
          />
        ) : (
          <EmptyState
            icon="folder-remove-outline"
            title="Case unavailable"
            message="This case has been deleted or cannot be found."
            action={{ label: 'Back to cases', onPress: () => router.replace('/cases'), icon: 'arrow-left' }}
          />
        )}
      </ScreenScroll>
    );
  }

  // ---------------------------------------------------------------------------
  // Main Render
  // ---------------------------------------------------------------------------

  return (
    <ScreenScroll
      title={mode === 'notice' ? 'Dispute & Demand Notice' : 'Regulatory Escalation'}
      back
      subtitle={record.title}
      contentStyle={styles.content}
      refreshing={refreshing}
      onRefresh={reload}
      meta={
        mode === 'notice' && disputeNotice ? (
          <Row gap="sm" wrap>
            <Chip
              label={`${disputeNotice.cureWindowDays}-Day Cure Window`}
              tone="warn"
              icon="clock-alert-outline"
            />
            <Chip
              label={`${disputeNotice.exhibits.length} Evidence Exhibits`}
              tone="ok"
              icon="shield-check-outline"
            />
            {disputeNotice.financialDemand.hasFinancialClaim ? (
              <Chip
                label={disputeNotice.financialDemand.totalAmountFormatted}
                tone="accent"
                icon="cash-multiple"
              />
            ) : null}
          </Row>
        ) : draft ? (
          <Row gap="sm" wrap>
            <Chip label={`${draft.daysElapsed} days unanswered`} tone="warn" icon="clock-alert-outline" />
            <LimitationChip window={draft.limitation} />
            <Chip
              label={readiness.blanks === 0 ? 'Nothing left to write' : `${readiness.blanks} to write`}
              tone={readiness.blanks === 0 ? 'ok' : 'info'}
              icon="pencil-outline"
            />
            {readiness.toCheck > 0 ? (
              <Chip label={`${readiness.toCheck} to check`} tone="warn" icon="image-search-outline" />
            ) : null}
          </Row>
        ) : null
      }
      footer={
        mode === 'notice' && disputeNotice ? (
          <Row gap="sm">
            <Button
              label="Copy notice"
              icon="content-copy"
              onPress={() => void copyNotice()}
              variant="secondary"
              style={styles.flex}
            />
            <Button
              label={Platform.OS === 'web' ? 'Print' : 'Save PDF'}
              icon="file-pdf-box"
              onPress={() => void shareNoticePdf()}
              loading={busy}
              disabled={busy}
              style={styles.flex}
            />
          </Row>
        ) : draft ? (
          <Row gap="sm">
            <Button label="Share as text" onPress={() => void shareDraftText()} variant="secondary" style={styles.flex} />
            <Button
              label={Platform.OS === 'web' ? 'Print' : 'Share as PDF'}
              onPress={() => void shareDraftPdf()}
              loading={busy}
              disabled={busy}
              style={styles.flex}
            />
          </Row>
        ) : null
      }
    >
      <View style={{ gap: theme.spacing.lg }}>
        {/* Mode Selector (When regulatory draft is triggered alongside formal dispute notice) */}
        {draft ? (
          <View style={{ marginBottom: theme.spacing.sm }}>
            <SegmentedControl<LetterMode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'notice', label: 'Dispute Notice', icon: 'file-document-edit-outline' },
                { value: 'regulatory', label: 'Ombudsman Draft', icon: 'shield-account' },
              ]}
            />
          </View>
        ) : null}

        {error ? <Notice title="Action not completed" message={error} tone="danger" /> : null}

        {/* ================================================================= */}
        {/* MODE 1: FORMAL NOTICE OF DISPUTE & REMEDY DEMAND                 */}
        {/* ================================================================= */}
        {mode === 'notice' && disputeNotice ? (
          <View style={{ gap: theme.spacing.xl }}>
            {/* Executive Notice Header */}
            <Surface glass elevation="low" radius="lg" padding="lg" style={{ gap: theme.spacing.md }}>
              <Row between align="center">
                <Text variant="label" colorToken="textTertiary">
                  REF: {disputeNotice.referenceNumber}
                </Text>
                <Text variant="caption" colorToken="textTertiary">
                  DATE: {disputeNotice.noticeDate}
                </Text>
              </Row>

              <Divider spacing="xs" />

              <Row gap="md">
                <View style={styles.flex}>
                  <Text variant="caption" colorToken="textTertiary">TO (RESPONDENT)</Text>
                  <Text variant="bodyMedium" style={{ fontWeight: '600' }}>
                    {disputeNotice.recipient.name}
                  </Text>
                  <Text variant="caption" colorToken="textSecondary">
                    {disputeNotice.recipient.role}
                  </Text>
                </View>

                <View style={styles.flex}>
                  <Text variant="caption" colorToken="textTertiary">FROM (CLAIMANT)</Text>
                  <Text variant="bodyMedium" style={{ fontWeight: '600' }}>
                    {disputeNotice.sender.name}
                  </Text>
                  <Text variant="caption" colorToken="textSecondary">
                    {disputeNotice.sender.role}
                  </Text>
                </View>
              </Row>

              <View style={{ marginTop: theme.spacing.xs }}>
                <Text variant="caption" colorToken="textTertiary">SUBJECT</Text>
                <Text variant="bodyMedium" style={{ fontWeight: '700', marginTop: 2 }}>
                  {disputeNotice.subject}
                </Text>
              </View>
            </Surface>

            {/* Section 1: Facts & Chronology */}
            <Section title="1. Factual Background & Chronology" count={disputeNotice.summaryOfFacts.length}>
              <Surface radius="lg" padding="lg" glass elevation="low" style={{ gap: theme.spacing.sm }}>
                {disputeNotice.summaryOfFacts.map((fact, idx) => (
                  <Row key={idx} gap="sm" align="flex-start">
                    <Text variant="monoSmall" colorToken="textTertiary" style={{ width: 24 }}>
                      1.{idx + 1}
                    </Text>
                    <Text variant="body" style={styles.flex}>
                      {fact}
                    </Text>
                  </Row>
                ))}
              </Surface>
            </Section>

            {/* Section 2: Substantiated Claims */}
            <Section title="2. Substantiated Claims" count={disputeNotice.claims.length}>
              <Surface radius="lg" padding="lg" glass elevation="low" style={{ gap: theme.spacing.md }}>
                {disputeNotice.claims.length > 0 ? (
                  disputeNotice.claims.map((clm, idx) => (
                    <View key={clm.id} style={{ gap: theme.spacing.xxs }}>
                      {idx > 0 ? <Divider spacing="sm" /> : null}
                      <Row gap="sm" align="flex-start">
                        <Text variant="monoSmall" colorToken="textTertiary" style={{ width: 24 }}>
                          2.{idx + 1}
                        </Text>
                        <View style={styles.flex}>
                          <Text variant="body" style={{ fontWeight: '500' }}>
                            {clm.statement}
                          </Text>
                          <Row gap="xs" style={{ marginTop: SPACING.xs }}>
                            <Chip
                              label={clm.status}
                              size="sm"
                              tone={clm.status === 'SUPPORTED' ? 'ok' : clm.status === 'CONTRADICTED' ? 'danger' : 'neutral'}
                            />
                            <Chip
                              label={`${clm.citationCount} Citations`}
                              size="sm"
                              tone="accent"
                            />
                          </Row>
                        </View>
                      </Row>
                    </View>
                  ))
                ) : (
                  <Text variant="bodySmall" colorToken="textSecondary">
                    Add claims to this case to substantiate specific legal grievances.
                  </Text>
                )}
              </Surface>
            </Section>

            {/* Section 3: Financial Demand (If Applicable) */}
            {disputeNotice.financialDemand.hasFinancialClaim ? (
              <Section title="3. Financial Accounting & Remedy Demand">
                <Surface radius="lg" padding="lg" glass elevation="low" style={{ gap: theme.spacing.md }}>
                  <Row between align="center">
                    <Text variant="body">Principal Withheld / Owed</Text>
                    <Text variant="body" style={{ fontWeight: '600' }}>
                      ${(disputeNotice.financialDemand.principalMinor / 100).toFixed(2)}
                    </Text>
                  </Row>

                  {disputeNotice.financialDemand.interestMinor > 0 ? (
                    <Row between align="center">
                      <Text variant="body" colorToken="textSecondary">Accrued Statutory Interest</Text>
                      <Text variant="body" tone="accent">
                        +${(disputeNotice.financialDemand.interestMinor / 100).toFixed(2)}
                      </Text>
                    </Row>
                  ) : null}

                  {disputeNotice.financialDemand.penaltiesMinor > 0 ? (
                    <Row between align="center">
                      <Text variant="body" colorToken="textSecondary">Statutory Penalties</Text>
                      <Text variant="body" tone="warn">
                        +${(disputeNotice.financialDemand.penaltiesMinor / 100).toFixed(2)}
                      </Text>
                    </Row>
                  ) : null}

                  <Divider />

                  <Row between align="center">
                    <Text variant="subheading">Total Monetary Demand</Text>
                    <Text variant="subheading" tone="accent" style={{ fontWeight: '700' }}>
                      {disputeNotice.financialDemand.totalAmountFormatted}
                    </Text>
                  </Row>
                </Surface>
              </Section>
            ) : null}

            {/* Section 4: Exhibit Schedule with SHA-256 Hashes */}
            <Section title="4. Cryptographically Verified Exhibits" count={disputeNotice.exhibits.length}>
              <Surface radius="lg" padding="lg" glass elevation="low" style={{ gap: theme.spacing.md }}>
                {disputeNotice.exhibits.length > 0 ? (
                  disputeNotice.exhibits.map((ex, idx) => (
                    <View key={ex.id} style={{ gap: theme.spacing.xxs }}>
                      {idx > 0 ? <Divider spacing="sm" /> : null}
                      <Row between align="center">
                        <Row align="center" gap="sm">
                          <IconTile icon="file-document-outline" size="sm" tone="accent" />
                          <View>
                            <Text variant="bodyMedium" style={{ fontWeight: '600' }}>
                              [{ex.index}] {ex.title}
                            </Text>
                            <Text variant="caption" colorToken="textTertiary">
                              {ex.fileName} · {ex.kind}
                            </Text>
                          </View>
                        </Row>
                      </Row>
                      <View style={{ marginTop: SPACING.xs, backgroundColor: theme.colors.surfaceSunken, padding: SPACING.sm, borderRadius: theme.radius.xs }}>
                        <Text variant="caption" colorToken="textTertiary">
                          SHA-256 Digest:
                        </Text>
                        <Text variant="monoSmall" colorToken="textSecondary" numberOfLines={1}>
                          {ex.sha256}
                        </Text>
                      </View>
                    </View>
                  ))
                ) : (
                  <Text variant="bodySmall" colorToken="textSecondary">
                    No evidence records attached. Ingest records to automatically index them as exhibits.
                  </Text>
                )}
              </Surface>
            </Section>

            {/* Section 5: Cure Window & Reservation of Rights */}
            <Section title="5. Final Demand & Statutory Cure Window">
              <Notice
                tone="danger"
                icon="alert-decagram"
                title={`${disputeNotice.cureWindowDays}-Day Formal Cure Window`}
                message={`Demand is hereby made to satisfy this claim on or before ${disputeNotice.deadlineDate}. Failure to remit payment or cure this breach will result in statutory ombudsman filing, arbitration, or judicial proceedings.`}
              />
            </Section>
          </View>
        ) : null}

        {/* ================================================================= */}
        {/* MODE 2: REGULATORY OMBUDSMAN ESCALATION                           */}
        {/* ================================================================= */}
        {mode === 'regulatory' && draft ? (
          <View style={{ gap: theme.spacing.lg }}>
            <LimitationNotice window={draft.limitation} />

            {questions.length > 0 ? (
              <Section
                first
                title="What only you can answer"
                count={readiness.blanks}
                hint="What you write here appears in the letter below as you type."
              >
                <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
                  {questions.map((question) => (
                    <QuestionField
                      key={question.slot}
                      question={question}
                      value={answers[question.slot] ?? ''}
                      editable={loaded}
                      onChange={(value) => setAnswer(question.slot, value)}
                    />
                  ))}
                </Surface>
              </Section>
            ) : null}

            <Section
              title="The letter"
              hint="Tap the source under a line to open the document it was assembled from."
            >
              <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.lg }}>
                {draft.sections.map((section, index) => (
                  <View key={section.heading} style={{ gap: theme.spacing.sm }}>
                    {index > 0 ? <Divider spacing="sm" /> : null}
                    <Text variant="label" colorToken="textSecondary">
                      {section.heading}
                    </Text>
                    {section.lines.map((item, lineIndex) => {
                      const { evidenceId } = item;
                      return (
                        <LetterLine
                          key={`${section.heading}:${lineIndex}`}
                          item={item}
                          text={fillLine(item, answers)}
                          sourceTitle={sourceTitleFor(item, evidenceTitles)}
                          {...(evidenceId && caseId
                            ? {
                                onPressSource: () =>
                                  router.push({
                                    pathname: '/case/[caseId]/evidence/[evidenceId]',
                                    params: { caseId, evidenceId },
                                  }),
                              }
                            : {})}
                        />
                      );
                    })}
                  </View>
                ))}
              </Surface>
            </Section>

            <Section
              title="Documents to attach"
              count={draft.annexures.length}
              hint="Send copies of these with the letter. The app does not attach them for you."
            >
              <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
                {draft.annexures.map((annexure) => (
                  <View key={annexure.serial} style={{ gap: theme.spacing.xxs }}>
                    <Text variant="bodyMedium">
                      {annexure.serial}. {annexure.title}
                    </Text>
                    {annexure.date ? (
                      <Text variant="caption" colorToken="textTertiary">
                        Dated {annexure.date}
                      </Text>
                    ) : null}
                  </View>
                ))}
                <Text variant="caption" colorToken="textTertiary">
                  The letter prints a fingerprint for each file. That identifies the bytes held in the
                  app; it does not establish that a document is genuine.
                </Text>
              </Surface>
            </Section>

            <Section title="Before you send it">
              <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.sm }}>
                <Text variant="bodySmall" colorToken="textSecondary">
                  This letter was assembled from the documents in this case. It is a draft for you
                  to read, change and send yourself — the app does not file anything on your behalf.
                </Text>
                <Button
                  label="Clear what I wrote"
                  onPress={discard}
                  variant="ghost"
                  icon="eraser"
                  disabled={readiness.blanks === questions.length}
                />
              </Surface>
            </Section>
          </View>
        ) : null}
      </View>
    </ScreenScroll>
  );
}

function QuestionField({
  question,
  value,
  editable,
  onChange,
}: {
  question: DraftQuestion;
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();
  const roomy = question.slot === 'relief' || question.slot === 'address';

  return (
    <TextField
      label={question.placeholder}
      value={value}
      onChangeText={onChange}
      editable={editable}
      placeholder={editable ? 'Not yet written' : 'Loading…'}
      {...(roomy
        ? {
            multiline: true,
            minHeight: theme.type.body.lineHeight * (question.slot === 'relief' ? 4 : 3),
          }
        : {})}
      {...(question.personal
        ? { labelHint: 'saved for next time' }
        : question.lines > 1
          ? { hint: `Fills ${question.lines} lines of the letter` }
          : {})}
    />
  );
}

function LimitationChip({ window }: { window: LimitationWindow }) {
  if (window.state === 'UNKNOWN') {
    return <Chip label="Time limit unclear" tone="neutral" icon="help-circle-outline" />;
  }

  if (window.state === 'CLOSED') {
    return <Chip label="Past the usual window" tone="warn" icon="calendar-alert" />;
  }

  const days = window.daysRemaining ?? 0;
  if (window.state === 'CLOSING') {
    return (
      <Chip
        label={`${days} ${days === 1 ? 'day' : 'days'} left to file`}
        tone="warn"
        icon="calendar-clock"
      />
    );
  }

  return <Chip label={`Window open to ${window.closesOn}`} tone="neutral" icon="calendar-check" />;
}

function LimitationNotice({ window }: { window: LimitationWindow }) {
  if (window.state === 'OPEN') return null;

  const sentence = describeLimitation(window);

  if (window.state === 'UNKNOWN') {
    return (
      <Notice
        tone="neutral"
        icon="help-circle-outline"
        title="Check the time limit for this route yourself"
        message={[sentence, window.whenClosed, window.provision ? `The limit is set by ${window.provision}.` : null]
          .filter(Boolean)
          .join(' ')}
      />
    );
  }

  const guidance =
    window.state === 'CLOSED'
      ? 'It is still worth writing: the delay itself is part of what happened, and the letter is the record of it.'
      : 'It is worth sending this sooner rather than later.';

  return (
    <Notice
      tone="warn"
      icon={window.state === 'CLOSED' ? 'calendar-alert' : 'calendar-clock'}
      title={
        window.state === 'CLOSED' ? 'Past the usual window for this route' : 'The window is closing'
      }
      message={`${sentence} ${guidance} The limit comes from ${window.provision}; these schemes are amended, so check the current rule before you rely on the date.`}
    />
  );
}

function LetterLine({
  item,
  text,
  sourceTitle,
  onPressSource,
}: {
  item: DraftLine;
  text: string;
  sourceTitle: string | null;
  onPressSource?: () => void;
}) {
  const theme = useTheme();
  const unanswered = item.kind === 'BLANK' && text === item.text;

  const byline =
    item.kind === 'FACT' && sourceTitle ? (
      <Row gap="xxs" align="center">
        <Icon
          name={item.needsCheck ? 'image-search-outline' : 'file-document-outline'}
          size={12}
          color={item.needsCheck ? theme.colors.tones.warn.fg : theme.colors.textTertiary}
        />
        <Text variant="caption" colorToken={item.needsCheck ? 'textSecondary' : 'textTertiary'}>
          {sourceTitle}
          {item.needsCheck ? ' · read from an image, check it' : ''}
        </Text>
      </Row>
    ) : null;

  return (
    <View style={{ gap: theme.spacing.xxs }}>
      <Text
        variant="body"
        {...(unanswered ? { tone: 'warn' as const } : { colorToken: 'text' as const })}
        style={
          unanswered
            ? [
                styles.unanswered,
                {
                  backgroundColor: theme.colors.tones.warn.bg,
                  borderRadius: theme.radius.xs,
                  paddingHorizontal: theme.spacing.sm,
                  paddingVertical: theme.spacing.xxs,
                },
              ]
            : undefined
        }
      >
        {text}
      </Text>

      {byline && onPressSource ? (
        <Pressable
          onPress={onPressSource}
          dimOnPress
          pressScale={0}
          accessibilityRole="link"
          accessibilityLabel={`Open the source: ${sourceTitle}`}
          accessibilityHint="Opens the document this line was assembled from"
          style={styles.byline}
        >
          {byline}
        </Pressable>
      ) : (
        byline
      )}
    </View>
  );
}

function sourceTitleFor(item: DraftLine, titles: ReadonlyMap<string, string>): string | null {
  if (!item.evidenceId) return null;
  return titles.get(item.evidenceId) ?? null;
}

function letterHtml(draft: FilingDraft, text: string): string {
  const escape = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escape(draft.subject)}</title>` +
    '<style>' +
    '@page { margin: 22mm 18mm; }' +
    'body { font-family: Georgia, "Times New Roman", serif; font-size: 11.5pt; line-height: 1.65; color: #111; }' +
    'pre { font-family: inherit; font-size: inherit; line-height: inherit; white-space: pre-wrap; word-wrap: break-word; margin: 0; }' +
    '</style></head><body>' +
    `<pre>${escape(text)}</pre>` +
    '</body></html>'
  );
}

const styles = StyleSheet.create({
  content: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  flex: { flex: 1 },
  unanswered: { alignSelf: 'flex-start' },
  byline: {
    minHeight: HIT_TARGET,
    justifyContent: 'center',
    paddingRight: SPACING.sm,
    alignSelf: 'flex-start',
  },
});
