import React, { useCallback, useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteClaim, linkEntities, unlinkEntities, updateClaim } from '@data/mutations';
import { ASSESSMENT_LABELS, latestCaseAnalysis, reportIsStale } from '@domain/analysis/case-report';
import { RELATIONSHIP_LABELS, type RelationshipType } from '@domain/enums';
import type { CaseAnalysis } from '@domain/models';
import { CitationList } from '@features/analysis/case-analysis-panel';
import { requestCaseAnalysis, useRepository, useSession } from '@services';
import { mutationContext, useCaseRecord, useWorkspace } from '@services/use-case-store';
import {
  Button,
  Chip,
  EmptyState,
  errorDetail,
  ErrorState,
  IconButton,
  Notice,
  RADIUS,
  readableError,
  routeParam,
  Row,
  ScreenScroll,
  SkeletonCard,
  SkeletonList,
  SlideUpIn,
  SPACING,
  Stack,
  Surface,
  Text,
  TextField,
  useTheme,
} from '@ui';

const LINK_TYPES: RelationshipType[] = ['RELEVANT_TO_CLAIM', 'SUPPORTS', 'CONTRADICTS'];

/**
 * What produced a saved assessment, read off the record itself.
 *
 * The engine that writes these records today is deterministic — it compares extracted
 * values against rules, and no model is called — so labelling its output "AI" would
 * attribute a conclusion to a system that never ran. The label therefore comes from the
 * report's own `model`/`promptVersion` fields, which is where a reader looks to find out
 * where a conclusion came from. An optional AI pass, when one is connected, records a
 * model name there and is labelled for what it is: assistance a person reviews.
 */
function assessmentProvenance(report: CaseAnalysis): { label: string; note: string } {
  const deterministic =
    report.model === 'deterministic-rule-engine' || report.promptVersion === 'no-prompt-deterministic';
  return deterministic
    ? {
        label: 'Checked by rules',
        note: 'Reached by comparing the values read from your documents against fixed consistency checks. No AI model was involved.',
      }
    : {
        label: 'AI-assisted',
        note: 'An AI model you connected contributed to this reading. Check it against the quoted passages before relying on it.',
      };
}

/**
 * One claim, and everything the case has to say about it.
 *
 * ## The distinction this screen has to hold on to
 *
 * Three different things on this screen look similar and are not:
 *
 *   - **The claim.** A statement the user wants checked. Not a fact.
 *   - **The assessment.** What the evidence supports, with the passages it was read from.
 *   - **The relationships.** A person's judgement that a source bears on the claim.
 *
 * The third is the one most easily mistaken for the second. A user linking a receipt as
 * `SUPPORTS` has recorded an opinion, not established a fact, and the section that lists
 * those links says so rather than leaving it to be inferred from the word "supports".
 *
 * ## Why an assessment can go stale
 *
 * An assessment is stored against the exact statement it examined. Editing the claim
 * afterwards leaves a conclusion attached to wording it never saw, so `assessment` is
 * resolved only when the stored statement still matches — and when it does not, the screen
 * says which wording was assessed instead of silently showing the old conclusion.
 */
export default function ClaimDetailScreen() {
  const params = useLocalSearchParams<{ caseId?: string | string[]; claimId?: string | string[] }>();
  const caseId = routeParam(params.caseId);
  const claimId = routeParam(params.claimId);
  const { user } = useSession();
  const { repository } = useRepository();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const { workspace, loading, refreshing, error, reload } = useWorkspace(user?.id ?? null, caseId ?? null);
  const caseRecord = useCaseRecord(workspace, caseId ?? null);

  const claim = workspace.claims.find(
    (item) => item.id === claimId && item.caseId === caseId && !item.deletedAt,
  );

  const report = latestCaseAnalysis(workspace, caseId ?? '');
  const savedAssessment = report?.claims.find((item) => item.claimId === claimId);
  // Only treat the stored conclusion as current when it examined this exact wording.
  const assessment = savedAssessment?.statement === claim?.statement ? savedAssessment : undefined;
  const provenance = report && assessment ? assessmentProvenance(report) : null;

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [failureDetail, setFailureDetail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState('');
  const [detail, setDetail] = useState('');
  const [linking, setLinking] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<string | null>(null);
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('RELEVANT_TO_CLAIM');
  const [reason, setReason] = useState('');
  const [removing, setRemoving] = useState(false);

  const links = useMemo(
    () =>
      workspace.relationships.filter(
        (link) =>
          link.caseId === caseId &&
          link.origin === 'USER' &&
          (link.from.id === claimId || link.to.id === claimId),
      ),
    [workspace.relationships, caseId, claimId],
  );

  const jobs = useMemo(
    () =>
      workspace.processingJobs
        .filter((job) => job.caseId === caseId && job.type === 'CASE')
        .sort((a, b) => b.createdAt - a.createdAt),
    [workspace.processingJobs, caseId],
  );

  const running = jobs.some((job) => job.state === 'QUEUED' || job.state === 'PROCESSING');
  // Nothing to compare until at least one document has readable text in it.
  const ready = workspace.evidence.some((item) => !item.deletedAt && item.extraction?.sourceText.trim());

  const action = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    setFailureDetail(null);
    setNotice(null);
    try {
      await work();
    } catch (caught) {
      // `readableError` keeps an internal message — a stack frame, a driver code, a
      // `QuotaExceededError` — out of the sentence the reader is given, while
      // `errorDetail` keeps it available below for anyone who wants it.
      setFailure(readableError(caught, 'That could not be completed. Nothing was changed.'));
      setFailureDetail(errorDetail(caught) ?? null);
    } finally {
      setBusy(false);
    }
  }, []);

  const saveClaim = useCallback(async () => {
    if (!user || !claim || !statement.trim()) return;
    await action(async () => {
      const mutation = updateClaim(workspace, mutationContext(user.id), claim.id, { statement, detail });
      await repository.commit(user.id, mutation.changes);
      reload();
      setEditing(false);
      setNotice('Claim updated. Run the assessment again to check this wording against the evidence.');
    });
  }, [user, claim, statement, detail, workspace, repository, reload, action]);

  const saveLink = useCallback(async () => {
    if (!user || !claim || !caseId || !selectedEvidence || !reason.trim()) return;
    await action(async () => {
      const mutation = linkEntities(workspace, mutationContext(user.id), caseId, {
        from: { kind: 'evidence', id: selectedEvidence },
        to: { kind: 'claim', id: claim.id },
        type: relationshipType,
        note: reason.trim(),
        origin: 'USER',
        material: false,
      });
      await repository.commit(user.id, mutation.changes);
      reload();
      setLinking(false);
      setReason('');
      setNotice('Saved. This link is recorded as your judgement, not as a finding.');
    });
  }, [user, claim, selectedEvidence, reason, relationshipType, workspace, caseId, repository, reload, action]);

  /*
    Three states, not one.

    This block used to be a single `Notice` whose title flipped to the word "Loading" and
    whose message was `error?.message` — so the first paint of every claim showed a box
    titled "Loading" with a "Try again" button under it, inviting a retry of something that
    had not failed, and a real failure showed a raw exception string as the whole
    explanation. Loading, failed and absent are three different things to say, and the
    reader can act on only one of them.
  */
  if (!claim) {
    return (
      <ScreenScroll title="Claim" back>
        {error ? (
          <ErrorState
            title="This claim could not be loaded"
            message="The stored copy of this case could not be read, so the claim could not be opened. Nothing has been changed."
            detail={errorDetail(error)}
            onRetry={reload}
          />
        ) : loading ? (
          <Stack
            gap="lg"
            accessibilityRole="progressbar"
            accessibilityLabel="Opening this claim"
          >
            <SkeletonCard lines={4} />
            <SkeletonList count={2} />
          </Stack>
        ) : (
          <EmptyState
            icon="file-question-outline"
            title="This claim is not here"
            message="It may have been removed, or it belongs to a different case."
            {...(caseId
              ? {
                  action: {
                    label: 'Open this case',
                    icon: 'arrow-left' as const,
                    onPress: () => router.replace({ pathname: '/case/[caseId]', params: { caseId } }),
                  },
                }
              : {})}
          />
        )}
      </ScreenScroll>
    );
  }

  const availableEvidence = workspace.evidence.filter((item) => !item.deletedAt);

  return (
    <ScreenScroll
      title="Claim review"
      back
      refreshing={refreshing}
      onRefresh={reload}
      {...(caseRecord?.title ? { subtitle: caseRecord.title } : {})}
    >
      {/*
        One entrance for the whole column, a beat after the masthead.

        Deliberately not a `Stagger`. The blocks below are mostly conditional — two stale-
        assessment warnings, a running-job notice, a save confirmation — so a cascade would
        re-time itself every time the user saved something, and `Stagger`'s positional keys
        would remount the siblings under a newly-appearing notice and replay their entrances
        mid-session. A claim review is also read as one document rather than as a list, and
        ten blocks arriving in sequence reads slower than the same ten arriving together.
      */}
      <SlideUpIn delay={theme.motion.stagger}>
        <View style={{ gap: theme.spacing.xl }}>
          {/*
            Two different failures, kept apart. `failure` is something the reader just
            tried to do and it did not happen; `error` is the background refresh losing
            contact while the claim stays readable on screen. One title for both — and a
            raw `error.message` as the body — told them neither.
          */}
          {failure ? (
            <Notice
              tone="danger"
              title="That did not happen"
              message={failure}
              detail={failureDetail}
              onDismiss={() => {
                setFailure(null);
                setFailureDetail(null);
              }}
            />
          ) : null}
          {error ? (
            <Notice
              tone="warn"
              title="This claim may be out of date"
              message="The latest version of this case could not be read, so what is shown here is the last copy that loaded. Nothing has been changed."
              detail={errorDetail(error)}
            />
          ) : null}
          {notice ? <Notice tone="info" title="Saved" message={notice} /> : null}

          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
            <Text variant="heading">{claim.statement}</Text>
            {claim.detail ? <Text colorToken="textSecondary">{claim.detail}</Text> : null}
            <Text variant="caption" colorToken="textSecondary">
              A claim is a statement to be checked against the documents — not something the app
              assumes is true.
            </Text>
            <Row gap="sm" style={styles.wrap}>
              <Button
                label="Edit claim"
                variant="secondary"
                onPress={() => {
                  setStatement(claim.statement);
                  setDetail(claim.detail);
                  setEditing(true);
                }}
              />
              <Button label="Connect evidence" variant="ghost" onPress={() => setLinking(true)} />
            </Row>
          </Surface>

          {report && reportIsStale(workspace, report) ? (
            <Notice
              tone="warn"
              title="The case has changed since this was assessed"
              message="Documents or claims were added or edited afterwards. Run the assessment again to take them into account."
            />
          ) : null}

          {savedAssessment && !assessment ? (
            <Notice
              tone="warn"
              title="This wording has not been assessed"
              message={`The saved conclusion examined a different statement: "${savedAssessment.statement}". Run the assessment again before applying it to the current wording.`}
            />
          ) : null}

          {assessment && provenance ? (
            <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
              <Row gap="sm" align="center" style={styles.wrap}>
                <Text variant="heading">{ASSESSMENT_LABELS[assessment.status]}</Text>
                <Chip label={provenance.label} tone="neutral" size="sm" />
              </Row>

              <Text variant="caption" colorToken="textSecondary">
                Saved {new Date(report!.createdAt).toLocaleString()}
              </Text>
              <Text variant="caption" colorToken="textSecondary">
                {provenance.note}
              </Text>

              <Text>{assessment.explanation}</Text>

              <CitationList citations={assessment.citations} workspace={workspace} caseId={claim.caseId} />

              {assessment.missingInformation.length ? (
                <View style={{ gap: theme.spacing.sm }}>
                  <Text variant="subheading">What is still missing</Text>
                  {assessment.missingInformation.map((item, index) => (
                    <Bullet key={index} theme={theme}>
                      {item}
                    </Bullet>
                  ))}
                </View>
              ) : null}

              {assessment.limitations.length ? (
                <View style={{ gap: theme.spacing.sm }}>
                  <Text variant="subheading">What this does not settle</Text>
                  {assessment.limitations.map((item, index) => (
                    <Bullet key={index} theme={theme}>
                      {item}
                    </Bullet>
                  ))}
                </View>
              ) : null}
            </Surface>
          ) : (
            <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
              <Text variant="heading">Not assessed yet</Text>
              <Text colorToken="textSecondary">
                Add documents that bear on this claim and run the assessment. It is checked alongside
                the other claims and documents in the case, not on its own.
              </Text>
            </Surface>
          )}

          {running ? (
            <Notice
              tone="info"
              title="Assessment running"
              message="The comparison is running on this device. You can leave this screen — the result is saved with the case."
            />
          ) : null}

          {jobs[0]?.state === 'FAILED' ? (
            <Notice
              tone="warn"
              title="The last assessment did not finish"
              message={jobs[0].lastError ?? 'Try again once the documents have finished processing.'}
            />
          ) : null}

          <Row gap="sm" style={styles.wrap}>
            <Button
              label={running ? 'Comparing documents…' : assessment ? 'Assess again' : 'Assess this case'}
              loading={busy}
              disabled={busy || running || !ready}
              onPress={() =>
                void action(async () => {
                  if (!user || !caseId) return;
                  await requestCaseAnalysis(caseId, { repository, ownerId: user.id });
                  reload();
                  setNotice('Assessment finished on this device.');
                })
              }
            />
            <Button
              label="Add evidence"
              variant="secondary"
              onPress={() => router.push({ pathname: '/case/[caseId]/upload', params: { caseId: claim.caseId } })}
            />
          </Row>

          {!ready ? (
            <Text variant="bodySmall" colorToken="textSecondary">
              Nothing can be assessed until at least one document has been read. Add a document, or
              wait for processing to finish.
            </Text>
          ) : null}

          <View style={{ gap: theme.spacing.md }}>
            <Text variant="heading">Links you recorded</Text>
            <Text colorToken="textSecondary">
              These record your reading of why a document matters. They are kept separate from the
              assessment because they are your judgement, not a finding from the evidence.
            </Text>

            {!links.length ? (
              <Text colorToken="textSecondary">You have not linked any documents to this claim.</Text>
            ) : (
              links.map((link) => {
                const evidenceId =
                  link.from.kind === 'evidence'
                    ? link.from.id
                    : link.to.kind === 'evidence'
                      ? link.to.id
                      : null;
                const source = workspace.evidence.find((item) => item.id === evidenceId && !item.deletedAt);

                return (
                  <Surface key={link.id} padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
                    <Row gap="sm" align="center" style={styles.wrap}>
                      <Text variant="subheading">{source?.title ?? 'Link in this case'}</Text>
                      <Chip label={RELATIONSHIP_LABELS[link.type]} tone="neutral" size="sm" />
                    </Row>

                    <Text colorToken={link.note ? 'text' : 'textSecondary'}>
                      {link.note || 'No reason was recorded for this link.'}
                    </Text>

                    <Row gap="sm" style={styles.wrap}>
                      {source ? (
                        <Button
                          label="Open document"
                          variant="secondary"
                          onPress={() =>
                            router.push({
                              pathname: '/case/[caseId]/evidence/[evidenceId]',
                              params: { caseId: claim.caseId, evidenceId: source.id },
                            })
                          }
                        />
                      ) : null}
                      <Button
                        label="Remove link"
                        variant="ghost"
                        disabled={busy}
                        onPress={() =>
                          void action(async () => {
                            if (!user) return;
                            await repository.commit(
                              user.id,
                              unlinkEntities(workspace, mutationContext(user.id), link.id).changes,
                            );
                            reload();
                          })
                        }
                      />
                    </Row>
                  </Surface>
                );
              })
            )}
          </View>

          <Text variant="caption" colorToken="textSecondary">
            An assessment describes what the submitted records show. It does not establish that a
            document is genuine, and it is not a legal judgment. Read the quoted passages and the
            limitations before relying on it.
          </Text>

          <Button label="Remove claim" variant="ghost" onPress={() => setRemoving(true)} />
        </View>
      </SlideUpIn>

      <Modal visible={editing} animationType="slide" onRequestClose={() => setEditing(false)}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.sheet,
            {
              backgroundColor: theme.colors.canvas,
              paddingTop: insets.top + theme.spacing.lg,
              paddingBottom: insets.bottom + theme.spacing.xl,
            },
          ]}
        >
          <Row justify="space-between" align="center">
            <Text variant="heading">Edit claim</Text>
            <IconButton icon="close" accessibilityLabel="Close claim editor" onPress={() => setEditing(false)} />
          </Row>
          <TextField
            label="Claim statement"
            hint="One statement that can be checked. Split a claim that contains two."
            value={statement}
            onChangeText={setStatement}
            maxLength={500}
            multiline
          />
          <TextField
            label="Context and details"
            value={detail}
            onChangeText={setDetail}
            maxLength={4000}
            multiline
          />
          {failure ? (
            <Notice
              title="The claim could not be saved"
              message={failure}
              detail={failureDetail}
              tone="danger"
            />
          ) : null}
          <Button
            label="Save claim"
            onPress={() => void saveClaim()}
            disabled={!statement.trim() || busy}
            loading={busy}
          />
        </ScrollView>
      </Modal>

      <Modal visible={linking} animationType="slide" onRequestClose={() => setLinking(false)}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.sheet,
            {
              backgroundColor: theme.colors.canvas,
              paddingTop: insets.top + theme.spacing.lg,
              paddingBottom: insets.bottom + theme.spacing.xl,
            },
          ]}
        >
          <Row justify="space-between" align="center">
            <Text variant="heading">Connect evidence</Text>
            <IconButton icon="close" accessibilityLabel="Close evidence picker" onPress={() => setLinking(false)} />
          </Row>

          {availableEvidence.length ? (
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="subheading">Which document?</Text>
              {availableEvidence.map((item) => (
                <Button
                  key={item.id}
                  label={item.title}
                  variant={selectedEvidence === item.id ? 'primary' : 'secondary'}
                  onPress={() => setSelectedEvidence(item.id)}
                />
              ))}
            </View>
          ) : (
            <Text colorToken="textSecondary">
              This case has no documents yet. Add one first, then come back to link it.
            </Text>
          )}

          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading">How does it relate?</Text>
            <Row gap="sm" style={styles.wrap}>
              {LINK_TYPES.map((type) => (
                <Button
                  key={type}
                  label={RELATIONSHIP_LABELS[type]}
                  size="sm"
                  variant={relationshipType === type ? 'primary' : 'secondary'}
                  onPress={() => setRelationshipType(type)}
                />
              ))}
            </Row>
          </View>

          <TextField
            label="Why does this document matter?"
            hint="Recorded with the link, so the reasoning survives alongside it."
            value={reason}
            onChangeText={setReason}
            maxLength={2000}
            multiline
          />

          {failure ? (
            <Notice
              title="The link could not be saved"
              message={failure}
              detail={failureDetail}
              tone="danger"
            />
          ) : null}

          <Button
            label="Save link"
            disabled={!selectedEvidence || !reason.trim() || busy}
            loading={busy}
            onPress={() => void saveLink()}
          />
        </ScrollView>
      </Modal>

      <Modal visible={removing} transparent onRequestClose={() => setRemoving(false)}>
        <View style={[styles.overlay, { backgroundColor: theme.colors.overlay }]}>
          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
            <Text variant="heading">Remove this claim?</Text>
            <Text>
              It leaves the active case. The documents stay, and the history of what happened to this
              claim is kept.
            </Text>
            {failure ? (
              <Notice
                title="The claim could not be removed"
                message={failure}
                detail={failureDetail}
                tone="danger"
              />
            ) : null}
            <Button
              label="Remove claim"
              disabled={busy}
              loading={busy}
              onPress={() =>
                void action(async () => {
                  if (!user) return;
                  await repository.commit(
                    user.id,
                    deleteClaim(workspace, mutationContext(user.id), claim.id).changes,
                  );
                  setRemoving(false);
                  router.back();
                })
              }
            />
            <Button label="Keep claim" variant="secondary" onPress={() => setRemoving(false)} />
          </Surface>
        </View>
      </Modal>
    </ScreenScroll>
  );
}

/** A list item. The marker is drawn, so it never gets copied out as a stray hyphen. */
function Bullet({ children, theme }: { children: React.ReactNode; theme: ReturnType<typeof useTheme> }) {
  return (
    <Row gap="sm" align="flex-start">
      <View
        style={[styles.dot, { backgroundColor: theme.colors.textTertiary, marginTop: theme.spacing.sm }]}
      />
      <Text colorToken="textSecondary" style={styles.flex}>
        {children}
      </Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  sheet: { flexGrow: 1, padding: SPACING.xxl, gap: SPACING.xl },
  overlay: { flex: 1, padding: SPACING.xxl, justifyContent: 'center' },
  wrap: { flexWrap: 'wrap' },
  dot: { width: SPACING.xs, height: SPACING.xs, borderRadius: RADIUS.pill },
  flex: { flex: 1 },
});
