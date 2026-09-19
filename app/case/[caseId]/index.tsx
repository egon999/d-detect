/**
 * The Case Screen - Streamlined 3-View Case Workspace.
 *
 * Replaces fragmented navigation and cognitive overload with a cohesive 3-view Case Workspace:
 * 1. [Evidence View]: Ingestion queue, document extractions, audio recordings, awaiting read notice.
 * 2. [Intelligence View]: Claims with AssessmentPlates, Opposing Narrative Simulator,
 *    Strategic Next-Move Playbook, Contradiction Radar, and embedded Evidence Prover Assistant.
 * 3. [Proof & Dossier View]: The Event Nexus chronological replay, Truth Decay cascade,
 *    Cryptographic Proof Capsule manifest, and one-tap export actions.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { createClaim, createEvent } from '@data/mutations';
import {
  currentClaimAssessment,
  latestCaseAnalysis,
  reportIsStale,
} from '@domain/analysis/case-report';
import type { Case, CaseEvent, Evidence } from '@domain/models';
import { CaseAnalysisPanel } from '@features/analysis/case-analysis-panel';
import {
  AssessmentPlate,
  CaseComposerSheet,
  citationBasis,
  DeadlineSentinelCard,
  ProofCapsuleCard,
  type AssessmentStatus,
  type ComposerDraft,
  type ComposerKind,
} from '@features/case';
import { EvidenceRow } from '@features/evidence/evidence-row';
import { useRepository, useSession } from '@services';
import { removeCase } from '@services/erase';
import { mutationContext, useCaseData, useCaseRecord, useMutator, useWorkspace } from '@services/use-case-store';
import {
  BORDER_WIDTH,
  BottomSheet,
  Button,
  describeDate,
  Disclosure,
  Divider,
  EmptyState,
  errorDetail,
  ErrorState,
  formatRelativeTime,
  Icon,
  IconTile,
  isAwaitingProcessing,
  isProcessingInFlight,
  LAYOUT,
  Notice,
  Pressable,
  PulseDot,
  readableError,
  routeParam,
  Row,
  ScreenScroll,
  Section,
  SegmentedControl,
  Shimmer,
  SPACING,
  Stagger,
  Surface,
  Text,
  useTheme,
} from '@ui';

type WorkspaceTab = 'evidence' | 'analysis' | 'export';

export default function CaseScreen() {
  const caseId = routeParam(useLocalSearchParams<{ caseId?: string | string[] }>().caseId);
  const router = useRouter();
  const theme = useTheme();
  const { user } = useSession();
  const { repository } = useRepository();

  const { workspace, loading, refreshing, error, reload } = useWorkspace(user?.id ?? null, caseId ?? null);
  const record = useCaseRecord(workspace, caseId ?? null);
  const scoped = useCaseData(workspace, caseId ?? null);
  const mutator = useMutator(user?.id ?? null, caseId ?? null, workspace);
  const validCaseId = caseId ?? '';

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('evidence');
  const [composer, setComposer] = useState<ComposerKind | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; detail: string | null } | null>(null);
  const [showRemove, setShowRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);

  const claims = useMemo(
    () => scoped.claims.filter((claim) => claim.deletedAt === null),
    [scoped.claims],
  );
  const evidence = useMemo(
    () => scoped.evidence.filter((item) => item.deletedAt === null),
    [scoped.evidence],
  );
  const events = useMemo(
    () => scoped.events.filter((item) => item.deletedAt === null),
    [scoped.events],
  );

  const report = useMemo(
    () => (caseId ? latestCaseAnalysis(workspace, caseId) : null),
    [workspace, caseId],
  );

  const readings = useMemo(
    () =>
      claims.map((claim) => {
        const assessment = currentClaimAssessment(report, claim);
        return {
          claim,
          status: (assessment?.status ?? null) as AssessmentStatus | null,
          basis: assessment ? citationBasis(workspace, assessment.citations) : null,
          missing: assessment?.missingInformation ?? [],
        };
      }),
    [claims, report, workspace],
  );

  const awaitingRead = useMemo(
    () => evidence.filter((item) => isAwaitingProcessing(item.state)).length,
    [evidence],
  );

  const openClaim = useCallback(
    (claimId: string) => {
      if (!caseId) return;
      router.push({ pathname: '/case/[caseId]/claim/[claimId]', params: { caseId, claimId } });
    },
    [router, caseId],
  );

  const submit = useCallback(
    async (draft: ComposerDraft) => {
      if (!user || !caseId || !composer) return;
      setSaveError(null);

      const kind = composer;
      const result = await mutator.mutate((current) => {
        const context = mutationContext(user.id);
        return kind === 'claim'
          ? createClaim(current, context, caseId, {
              statement: draft.statement.trim(),
              detail: draft.detail,
            })
          : createEvent(current, context, caseId, {
              title: draft.statement.trim(),
              description: draft.detail,
              occurredAt: draft.date.trim() || null,
              claimIds: draft.claimId ? [draft.claimId] : [],
            });
      });

      if (result.ok) setComposer(null);
      else
        setSaveError({
          message: readableError(
            result.error,
            kind === 'claim'
              ? 'This claim could not be added to the case. Your wording is still here — try again.'
              : 'This event could not be added to the case. Your wording is still here — try again.',
          ),
          detail: errorDetail(result.error) ?? null,
        });
    },
    [user, caseId, composer, mutator],
  );

  const remove = useCallback(async () => {
    if (!user || !caseId) return;
    setRemoving(true);
    setRemoveFailure(null);
    try {
      await removeCase(repository, workspace, mutationContext(user.id), caseId);
      setShowRemove(false);
      router.back();
    } catch (caught) {
      setRemoveFailure(
        readableError(
          caught,
          'This case could not be deleted. It is still here with everything in it — try again.',
        ),
      );
    } finally {
      setRemoving(false);
    }
  }, [user, caseId, repository, workspace, router]);

  return (
    <>
      <ScreenScroll
        title={record?.title ?? 'Case Docket'}
        back
        {...(record?.category ? { overline: record.category } : {})}
        {...(record?.description ? { subtitle: record.description } : {})}
        {...(record ? { meta: <CaseMeta record={record} evidence={evidence} report={report ? { createdAt: report.createdAt, stale: reportIsStale(workspace, report) } : null} /> } : {})}
        refreshing={refreshing}
        onRefresh={reload}
        actions={
          caseId
            ? [
                {
                  icon: 'timeline-clock-outline',
                  label: 'Timeline',
                  onPress: () => router.push({ pathname: '/case/[caseId]/timeline', params: { caseId } }),
                },
                {
                  icon: 'tray-arrow-up',
                  label: 'Add evidence',
                  onPress: () => router.push({ pathname: '/case/[caseId]/upload', params: { caseId } }),
                },
                {
                  icon: 'tray-arrow-down',
                  label: 'Export',
                  onPress: () => router.push({ pathname: '/case/[caseId]/export', params: { caseId } }),
                },
              ]
            : []
        }
        contentStyle={styles.content}
      >
        {error ? (
          <ErrorState
            title="This case could not be loaded"
            message="The connection to your stored cases failed. Nothing has been changed."
            detail={errorDetail(error)}
            onRetry={reload}
          />
        ) : loading && !record ? (
          <CaseSkeleton />
        ) : !record ? (
          <EmptyState
            icon="folder-remove-outline"
            title="Case unavailable"
            message="This case has been deleted, or it belongs to another account."
            action={{ label: 'Back to cases', onPress: () => router.replace('/cases'), icon: 'arrow-left' }}
          />
        ) : (
          <>
            {/* Unified 3-View Segmented Workspace Selector */}
            <View style={{ marginBottom: theme.spacing.lg }}>
              <SegmentedControl<WorkspaceTab>
                value={activeTab}
                onChange={setActiveTab}
                options={[
                  { value: 'evidence', label: `Evidence (${evidence.length})`, icon: 'folder-outline' },
                  { value: 'analysis', label: `Analysis (${claims.length})`, icon: 'shield-search' },
                  { value: 'export', label: 'Export', icon: 'tray-arrow-down' },
                ]}
              />
            </View>

            {/* ================================================================= */}
            {/* VIEW 1: EVIDENCE VIEW                                            */}
            {/* ================================================================= */}
            {activeTab === 'evidence' ? (
              <View style={styles.tabContent}>
                <Row gap="sm" style={{ marginBottom: theme.spacing.md }}>
                  <View style={styles.flex}>
                    <Button
                      label="Add evidence"
                      icon="tray-arrow-up"
                      variant="primary"
                      onPress={() => router.push({ pathname: '/case/[caseId]/upload', params: { caseId: validCaseId } })}
                    />
                  </View>
                  <View style={styles.flex}>
                    <Button
                      label="Timeline"
                      icon="timeline-clock-outline"
                      variant="secondary"
                      onPress={() => router.push({ pathname: '/case/[caseId]/timeline', params: { caseId: validCaseId } })}
                    />
                  </View>
                  {evidence.length > 1 ? (
                    <View style={styles.flex}>
                      <Button
                        label="Compare"
                        icon="table-column"
                        variant="secondary"
                        onPress={() => router.push({ pathname: '/case/[caseId]/compare', params: { caseId: validCaseId } })}
                      />
                    </View>
                  ) : null}
                </Row>

                {awaitingRead > 0 ? (
                  <Notice
                    tone="neutral"
                    icon="clock-outline"
                    title={
                      awaitingRead === 1
                        ? '1 document has not been read'
                        : `${awaitingRead} documents have not been read`
                    }
                    message="Nothing reads them in the background. Open one and press Process to read it into this case."
                    style={{ marginBottom: theme.spacing.lg }}
                  />
                ) : null}

                <Section
                  title="Evidence Files"
                  count={evidence.length}
                  hint="Documents, images, and audio recordings ingested into this case."
                >
                  {evidence.length ? (
                    <View>
                      {evidence.map((item, index) => (
                        <View key={item.id}>
                          {index > 0 ? <Divider /> : null}
                          <EvidenceRow
                            record={item}
                            onPress={() =>
                              router.push({
                                pathname: '/case/[caseId]/evidence/[evidenceId]',
                                params: { caseId: validCaseId, evidenceId: item.id },
                              })
                            }
                          />
                        </View>
                      ))}
                    </View>
                  ) : (
                    <EmptyState
                      compact
                      icon="tray-arrow-up"
                      title="No documents yet"
                      message="Add the records from every side of this — a bill, a payment screenshot, a chat export, a statement."
                      action={{
                        label: 'Add evidence',
                        icon: 'plus',
                        onPress: () => router.push({ pathname: '/case/[caseId]/upload', params: { caseId: validCaseId } }),
                      }}
                    />
                  )}
                </Section>

                <Section
                  title="Events You Recorded"
                  count={events.length}
                  hint="Your own factual account, kept separate from the documents."
                  action={{ label: 'Add event', onPress: () => setComposer('event'), icon: 'plus' }}
                >
                  {events.length ? (
                    <View>
                      {events.map((event, index) => (
                        <View key={event.id}>
                          {index > 0 ? <Divider /> : null}
                          <EventRow
                            event={event}
                            onPress={() =>
                              router.push({
                                pathname: '/case/[caseId]/event/[eventId]',
                                params: { caseId: validCaseId, eventId: event.id },
                              })
                            }
                          />
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text variant="bodySmall" colorToken="textSecondary">
                      No events recorded yet. An event records something that happened when documents are silent.
                    </Text>
                  )}
                </Section>

                {record.participants.length ? (
                  <Section
                    title="People & Entities Named"
                    count={record.participants.length}
                    hint="Named counterparties, witnesses, and representatives."
                  >
                    <View>
                      {record.participants.map((person, index) => (
                        <View key={person.id}>
                          {index > 0 ? <Divider spacing="lg" /> : null}
                          <Row gap="lg" align="center">
                            <Text variant="bodyMedium" style={styles.flex}>
                              {person.name}
                            </Text>
                            {person.role ? (
                              <Text variant="caption" colorToken="textTertiary">
                                {person.role}
                              </Text>
                            ) : null}
                          </Row>
                        </View>
                      ))}
                    </View>
                  </Section>
                ) : null}

              </View>
            ) : null}

            {/* ================================================================= */}
            {/* VIEW 2: ANALYSIS VIEW                                             */}
            {/* ================================================================= */}
            {activeTab === 'analysis' ? (
              <View style={styles.tabContent}>
                {/* Core Claims */}
                <Section
                  first
                  title="Claims"
                  count={claims.length}
                  hint="Evidence-graded claim assessments and citation links."
                  action={{ label: 'Add claim', onPress: () => setComposer('claim'), icon: 'plus' }}
                >
                  {readings.length ? (
                    <Stagger gap="lg">
                      {readings.map((reading) => (
                        <AssessmentPlate
                          key={reading.claim.id}
                          claim={reading.claim}
                          status={reading.status}
                          basis={reading.basis}
                          missing={reading.missing}
                          onPress={() => openClaim(reading.claim.id)}
                        />
                      ))}
                    </Stagger>
                  ) : (
                    <EmptyState
                      compact
                      icon="comment-question-outline"
                      title="No claims defined yet"
                      message="Formulate what you assert happened as an objective sentence that evidence can verify."
                      action={{ label: 'Add the first claim', onPress: () => setComposer('claim'), icon: 'plus' }}
                    />
                  )}
                </Section>

                {/* Contradiction & Corroboration Analysis Panel */}
                <View style={{ marginTop: theme.spacing.xl }}>
                  <CaseAnalysisPanel workspace={workspace} caseId={validCaseId} />
                </View>
              </View>
            ) : null}

            {/* ================================================================= */}
            {/* VIEW 3: EXPORT & PROOF VIEW                                       */}
            {/* ================================================================= */}
            {activeTab === 'export' ? (
              <View style={styles.tabContent}>
                {/* Export Dossier Card */}
                <Surface elevation="low" radius="md" padding="lg" glass>
                  <Row between align="center">
                    <Row align="center" gap="sm">
                      <IconTile icon="tray-arrow-down" tone="accent" size="sm" />
                      <View style={styles.flex}>
                        <Text variant="subheading">Export Case Dossier</Text>
                        <Text variant="caption" colorToken="textTertiary">
                          Compiled report with source citations, evidence digests, and timeline
                        </Text>
                      </View>
                    </Row>
                  </Row>
                  <View style={{ marginTop: theme.spacing.md }}>
                    <Button
                      label="Open Export View"
                      icon="tray-arrow-down"
                      variant="primary"
                      onPress={() => router.push({ pathname: '/case/[caseId]/export', params: { caseId: validCaseId } })}
                    />
                  </View>
                </Surface>

                {/* Regulatory & Deadline Sentinel */}
                <View style={{ marginTop: theme.spacing.xl }}>
                  <DeadlineSentinelCard workspace={workspace} caseId={validCaseId} />
                </View>

                {/* Formal Dispute & Grievance Notice Generator */}
                <View style={{ marginTop: theme.spacing.xl }}>
                  <Surface elevation="low" radius="md" padding="lg" glass>
                    <Row between align="center">
                      <Row align="center" gap="sm">
                        <IconTile icon="file-document-edit-outline" tone="accent" size="sm" />
                        <View style={styles.flex}>
                          <Text variant="subheading">Formal Dispute & Grievance Notice</Text>
                          <Text variant="caption" colorToken="textTertiary">
                            Sourced demand notice with evidence exhibits for regulators and counterparties
                          </Text>
                        </View>
                      </Row>
                    </Row>
                    <View style={{ marginTop: theme.spacing.md }}>
                      <Button
                        label="Draft Dispute Notice"
                        icon="arrow-right"
                        variant="secondary"
                        onPress={() => router.push({ pathname: '/case/[caseId]/letter', params: { caseId: validCaseId } })}
                      />
                    </View>
                  </Surface>
                </View>

                {/* Cryptographic Proof Capsule */}
                <View style={{ marginTop: theme.spacing.xl }}>
                  <ProofCapsuleCard workspace={workspace} caseId={validCaseId} />
                </View>

                {/* Case Administration & Metadata */}
                <View style={{ marginTop: theme.spacing.xl }}>
                  <Section title="Case Administration">
                    <Pressable
                      onPress={() => router.push({ pathname: '/case/[caseId]/details', params: { caseId: validCaseId } })}
                      dimOnPress
                      style={styles.row}
                    >
                      <Row align="center" justify="space-between">
                        <Row align="center" gap="md">
                          <Icon name="pencil-outline" size={20} color={theme.colors.textSecondary} />
                          <View>
                            <Text variant="bodyMedium">Case Details & Settings</Text>
                            <Text variant="caption" colorToken="textTertiary">Edit title, dispute category, and participants.</Text>
                          </View>
                        </Row>
                        <Disclosure />
                      </Row>
                    </Pressable>

                    <Divider />

                    <Button
                      label="Delete this case"
                      variant="ghost"
                      disabled={!record || removing}
                      onPress={() => {
                        setRemoveFailure(null);
                        setShowRemove(true);
                      }}
                      style={{ marginTop: theme.spacing.lg }}
                    />
                  </Section>
                </View>
              </View>
            ) : null}
          </>
        )}
      </ScreenScroll>

      <CaseComposerSheet
        visible={composer !== null}
        kind={composer ?? 'claim'}
        claims={composer === 'event' ? claims : []}
        busy={mutator.busy}
        error={saveError}
        onDismiss={() => setComposer(null)}
        onSubmit={(draft) => void submit(draft)}
      />

      <BottomSheet
        visible={showRemove}
        onDismiss={() => setShowRemove(false)}
        dismissOnBackdropPress={!removing}
        header={<Text variant="heading">Delete this case?</Text>}
      >
        <View style={{ gap: theme.spacing.lg }}>
          <Text colorToken="textSecondary">
            {record ? `"${record.title}"` : 'This case'} stops appearing anywhere in the app,
            along with the claims, events and evidence recorded in it. The original files you
            added are deleted from this device.
          </Text>
          <Text variant="bodySmall" colorToken="textSecondary">
            This cannot be undone.
          </Text>

          {removeFailure ? (
            <Notice tone="danger" title="Case not deleted" message={removeFailure} />
          ) : null}

          <Button
            label="Delete case"
            variant="danger"
            onPress={() => void remove()}
            disabled={removing}
            loading={removing}
          />
          <Button label="Keep case" variant="secondary" onPress={() => setShowRemove(false)} disabled={removing} />
        </View>
      </BottomSheet>
    </>
  );
}

function CaseMeta({
  record,
  evidence,
  report,
}: {
  record: Case;
  evidence: readonly Evidence[];
  report: { createdAt: number; stale: boolean } | null;
}) {
  const theme = useTheme();
  const working = evidence.filter((item) => isProcessingInFlight(item.state)).length;
  const waiting = evidence.filter((item) => isAwaitingProcessing(item.state)).length;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {record.incidentDate ? (
        <Row gap="sm" align="center">
          <Icon name="calendar-blank-outline" size={13} color={theme.colors.textTertiary} />
          <Text variant="monoSmall" colorToken="textTertiary">
            {record.incidentDate}
          </Text>
        </Row>
      ) : null}

      <Row gap="sm" align="center">
        {working > 0 ? (
          <PulseDot color={theme.colors.tones.info.fg} />
        ) : (
          <Icon
            name={waiting > 0 ? 'clock-outline' : 'check-circle-outline'}
            size={13}
            color={theme.colors.textTertiary}
          />
        )}
        <Text variant="monoSmall" colorToken="textTertiary">
          {working > 0
            ? `${working} of ${evidence.length} still being read`
            : waiting > 0
              ? `${waiting} of ${evidence.length} not read yet`
              : report
                ? `checked ${formatRelativeTime(report.createdAt, Date.now()).toLowerCase()}${report.stale ? ' · records changed since' : ''}`
                : 'not checked yet'}
        </Text>
      </Row>
    </View>
  );
}

function EventRow({ event, onPress }: { event: CaseEvent; onPress: () => void }) {
  const theme = useTheme();
  const date = event.occurredAt ? describeDate(event.occurredAt) : null;
  const shown = date ? date.normalized || date.original : 'no date given';

  return (
    <Pressable
      onPress={onPress}
      dimOnPress
      pressScale={0}
      accessibilityRole="button"
      accessibilityLabel={`${event.title}. ${shown}.`}
      accessibilityHint="Opens the event and what it is linked to."
      style={styles.row}
    >
      <View style={[styles.rowInner, { gap: theme.spacing.lg }]}>
        <View style={styles.flex}>
          <Text variant="bodyMedium" numberOfLines={2}>
            {event.title}
          </Text>
          <Row gap="sm" align="center" style={{ marginTop: SPACING.xxs }}>
            <Text variant="monoSmall" colorToken="textTertiary">
              {shown}
            </Text>
            {date?.ambiguous ? (
              <Text variant="caption" tone="warn">
                could be read either way
              </Text>
            ) : null}
          </Row>
        </View>
        <Disclosure />
      </View>
    </Pressable>
  );
}

function CaseSkeleton() {
  const theme = useTheme();

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Loading this case"
      style={{ gap: theme.spacing.huge }}
    >
      {[0, 1].map((index) => (
        <View
          key={index}
          style={[
            styles.skeletonPlate,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              borderRadius: theme.radius.md,
              padding: theme.spacing.xl,
              gap: theme.spacing.lg,
            },
          ]}
        >
          <Shimmer width="88%" height={theme.type.subheading.lineHeight} radius="xs" />
          <Row gap="lg" align="center">
            <Shimmer width={BORDER_WIDTH.thick} height={theme.type.title.lineHeight} radius="xs" />
            <Shimmer width="46%" height={theme.type.title.lineHeight} radius="xs" />
          </Row>
          <Shimmer width="72%" height={theme.type.caption.lineHeight} radius="xs" />
        </View>
      ))}

      <View style={{ gap: theme.spacing.xxl }}>
        {[0, 1, 2].map((index) => (
          <Shimmer key={index} width="100%" height={theme.type.body.lineHeight} radius="xs" />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  tabContent: { marginTop: 4 },
  row: { paddingVertical: SPACING.lg },
  rowInner: { flexDirection: 'row', alignItems: 'center' },
  skeletonPlate: { borderWidth: BORDER_WIDTH.hairline },
});
