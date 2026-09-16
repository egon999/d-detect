/**
 * The case screen.
 *
 * Everything else in this product is a detail view of something that appears here. So the
 * question this screen has to answer in the first screenful, before any scrolling, is the
 * only question a person opens a case to ask: *what did I say happened, and how does the
 * evidence stand against it?*
 *
 * ## The order of the page, and why it is that order
 *
 * Claims first, as `AssessmentPlate`s. Not the case description, not the source count, not a
 * row of navigation. A claim and its graded assessment is the one pairing that only this
 * product produces, and it is placed where the eye lands.
 *
 * The totals come *after* the claims. The instinct is to lead with four stat tiles — sources,
 * claims, findings, events — and it is the wrong instinct twice over: it spends the top of the
 * screen on numbers nobody opened the case to read, and it pushes the assessments below the
 * fold on a small phone. A statement of account puts its totals at the end, and so does this.
 *
 * Navigation is last, and it is a list of destinations that each say what they contain rather
 * than a row of buttons. Five wrapping pill buttons under the title was the previous design:
 * it read as a toolbar, it competed with the content, and "Timeline" alone does not tell
 * anyone whether the timeline is worth opening. The two actions that must always be reachable
 * — add evidence, export — are in the header bar instead, where they do not consume content
 * space at all.
 *
 * ## Why the claim list is not sorted by severity
 *
 * It stays in the order the user wrote it. Floating the contradicted claims to the top would
 * be the app asserting which of the user's claims matters most, on the one screen whose whole
 * premise is that it grades evidence and does not conclude. `ASSESSMENT_RANK` exists for
 * counting, and is deliberately not used here.
 *
 * ## Why the composer is a sheet
 *
 * See `@features/case/composer-sheet`. In short: this is a reading screen, composing a claim
 * is a writing task, and growing a form in the middle of the list moved the thing the reader
 * was looking at.
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
  citationBasis,
  type AssessmentStatus,
  type CitationBasis,
} from '@features/case/assessment';
import { AssessmentPlate } from '@features/case/assessment-plate';
import { CaseLedger, type LedgerLine } from '@features/case/case-ledger';
import { CaseComposerSheet, type ComposerDraft, type ComposerKind } from '@features/case/composer-sheet';
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
  isProcessingInFlight,
  LAYOUT,
  needsHumanAction,
  Notice,
  Pressable,
  PulseDot,
  readableError,
  Row,
  ScreenScroll,
  Section,
  Shimmer,
  SPACING,
  Stagger,
  Text,
  useTheme,
  type IconName,
} from '@ui';

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/**
 * The other case screens, each described by what a reader will find there.
 *
 * `hint` is the reason this is a list of rows and not a row of buttons: "Compare" is a verb
 * with no object, while "Two records of the same payment, field by field" tells someone
 * whether the screen is worth the tap. `available` is a predicate rather than a boolean so
 * each destination states its own precondition next to itself — the compare screen has
 * nothing to show with one document, and offering it anyway teaches users that half the
 * navigation leads to empty screens.
 */
interface Destination {
  pathname:
    | '/case/[caseId]/compare'
    | '/case/[caseId]/timeline'
    | '/case/[caseId]/graph'
    | '/case/[caseId]/audit'
    | '/case/[caseId]/export'
    | '/case/[caseId]/letter';
  icon: IconName;
  label: string;
  hint: string;
  available: (data: { evidence: number; events: number; relationships: number }) => boolean;
}

const DESTINATIONS: readonly Destination[] = [
  {
    pathname: '/case/[caseId]/letter',
    icon: 'file-sign',
    label: 'Escalation letter',
    hint: 'A complaint to the next authority, written out of this case and left for you to fill and send.',
    // Always enabled, including when the screen has nothing to draft. The preconditions —
    // a dated complaint, a reply window that has passed, nothing dated after it — are three
    // sentences long and the screen states which one is unmet; a greyed-out row states none
    // of it and teaches the user that this part of the app is broken.
    available: () => true,
  },
  {
    pathname: '/case/[caseId]/compare',
    icon: 'table-column',
    label: 'Compare documents',
    hint: 'The same amount, date or name as each document states it, side by side.',
    available: ({ evidence }) => evidence > 1,
  },
  {
    pathname: '/case/[caseId]/timeline',
    icon: 'timeline-clock-outline',
    label: 'Timeline',
    hint: 'Everything in date order, with the gaps and the undated items kept visible.',
    available: ({ evidence, events }) => evidence + events > 0,
  },
  {
    pathname: '/case/[caseId]/graph',
    icon: 'vector-polyline',
    label: 'Connections',
    hint: 'Which documents, claims and events the analysis linked, and on what grounds.',
    available: ({ relationships }) => relationships > 0,
  },
  {
    pathname: '/case/[caseId]/audit',
    icon: 'history',
    label: 'History',
    hint: 'Every change to this case, hash-chained so a missing entry is detectable.',
    available: () => true,
  },
  {
    pathname: '/case/[caseId]/export',
    icon: 'tray-arrow-down',
    label: 'Export',
    hint: 'A copy of the case with its assessments, limitations and cited passages.',
    available: () => true,
  },
];

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function CaseScreen() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { user } = useSession();
  const { repository } = useRepository();

  const { workspace, loading, refreshing, error, reload } = useWorkspace(user?.id ?? null, caseId ?? null);
  const record = useCaseRecord(workspace, caseId ?? null);
  const scoped = useCaseData(workspace, caseId ?? null);
  const mutator = useMutator(user?.id ?? null, caseId ?? null, workspace);

  const [composer, setComposer] = useState<ComposerKind | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; detail: string | null } | null>(null);
  const [showRemove, setShowRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);

  /**
   * Deleted records are filtered here, not by the store.
   *
   * `workspaceForCase` scopes by `caseId` and nothing else — it is a projection, not a policy
   * — so a soft-deleted claim arrives in `scoped.claims` with `deletedAt` set. The previous
   * version of this screen rendered them, which meant a claim a user had removed reappeared
   * with whatever assessment it last had.
   */
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

  /**
   * One entry per live claim, resolved against the *current* report.
   *
   * `currentClaimAssessment` returns null when the claim's wording has changed since the run,
   * and that null is carried through to the plate rather than smoothed over. An assessment of
   * a sentence the user has since rewritten is not an assessment of the claim in front of
   * them.
   */
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

  const ledger = useMemo(
    () => buildLedger({ evidence, claims: readings, events, results: scoped.analysisResults }),
    [evidence, readings, events, scoped.analysisResults],
  );

  const destinationContext = useMemo(
    () => ({
      evidence: evidence.length,
      events: events.length,
      relationships: scoped.relationships.length,
    }),
    [evidence.length, events.length, scoped.relationships.length],
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
      // `useMutator` returns failures as values rather than throwing, so the sheet stays open
      // with the text still in it. A form that closes on a failed save loses the user's words.
      //
      // The sentence is written per kind, and this used to be `result.error.message` — a raw
      // exception string in front of someone who was adding a claim. It names what did not get
      // saved and says the words are still there, because the next thing they will want to know
      // is whether they have to type it again.
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

  const openComposer = useCallback((kind: ComposerKind) => {
    setSaveError(null);
    setComposer(kind);
  }, []);

  /**
   * Deleting the case.
   *
   * Until now there was no way to. `deleteCase` has existed in `@data/mutations` since the
   * mutations were written and had no call site anywhere in `app` or `src` — so a case created
   * by mistake, or one finished with, stayed in the list permanently and the only way to be rid
   * of it was the account-wide erase in the profile. That is a strange thing for an evidence app
   * to ask of someone who uploaded the wrong bank statement.
   *
   * The work is in `removeCase`, not here, because the destructive half is easy to get wrong and
   * worth testing: the tombstone has to commit before any file is touched, and the case's
   * originals have to go with it or they sit in the app's private directory with no record left
   * that can name them. See its docblock for both arguments.
   *
   * A non-zero return is not a failure and is deliberately not shown. The case is gone from every
   * list either way; the number counts files that survived, which the account-wide erase sweeps
   * by directory rather than by record. Reporting it would tell someone their deletion failed
   * when it did not.
   */
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

  return (    <>
      <ScreenScroll
        title={record?.title ?? 'Case'}
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
                  icon: 'tray-arrow-up',
                  label: 'Add evidence',
                  onPress: () => router.push({ pathname: '/case/[caseId]/upload', params: { caseId } }),
                },
                {
                  icon: 'tray-arrow-down',
                  label: 'Export this case',
                  onPress: () => router.push({ pathname: '/case/[caseId]/export', params: { caseId } }),
                },
              ]
            : []
        }
        // `LAYOUT.maxContentWidth` rather than an inline number: on a tablet or the web build
        // an unconstrained column sets claim sentences 900pt wide, which is unreadable at any
        // type size. `ScreenScroll` deliberately does not impose this itself, so each screen
        // states the measure its content wants.
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
            message="This case has been deleted, or it belongs to another account. Nothing was loaded."
            action={{ label: 'Back to cases', onPress: () => router.replace('/cases'), icon: 'arrow-left' }}
          />
        ) : (
          <>
            <Section
              first
              title="What you asked us to check"
              count={claims.length}
              hint="Each claim is graded against the documents in this case. A grade is a reading of the evidence, not a verdict."
              action={{ label: 'Add claim', onPress: () => openComposer('claim'), icon: 'plus' }}
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
                  title="Nothing to check yet"
                  message="Write down what you say happened, as a sentence a document could confirm or contradict. That is what the documents get compared against."
                  action={{ label: 'Add the first claim', onPress: () => openComposer('claim'), icon: 'plus' }}
                />
              )}
            </Section>

            <Section title="This case in figures" hint="Counts only. None of these is a finding.">
              <CaseLedger lines={ledger} />
            </Section>

            <Section
              title="Evidence"
              count={evidence.length}
              hint="Each document is read on its own before anything is compared."
              {...(evidence.length > 1 && caseId
                ? {
                    action: {
                      label: 'Compare',
                      icon: 'table-column' as IconName,
                      onPress: () =>
                        router.push({ pathname: '/case/[caseId]/compare', params: { caseId } }),
                    },
                  }
                : {})}
            >
              {evidence.length ? (
                <View>
                  {evidence.map((item, index) => (
                    <View key={item.id}>
                      {index > 0 ? <Divider /> : null}
                      <EvidenceRow
                        record={item}
                        onPress={() =>
                          caseId
                            ? router.push({
                                pathname: '/case/[caseId]/evidence/[evidenceId]',
                                params: { caseId, evidenceId: item.id },
                              })
                            : undefined
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
                  message="Add the records from every side of this — a bill, a payment screenshot, a chat export, a statement. One document cannot be checked against anything."
                  action={{
                    label: 'Add evidence',
                    icon: 'plus',
                    onPress: () =>
                      caseId
                        ? router.push({ pathname: '/case/[caseId]/upload', params: { caseId } })
                        : undefined,
                  }}
                />
              )}
            </Section>

            {/*
              The analysis panel owns everything about the report itself — running it, its
              summary, its limitations, its citations. This screen deliberately does not
              restate any of that: the plates above show the report's *conclusions per claim*,
              and duplicating the panel's content here would give a reader two places to look
              for the same sentence and no way to tell which was newer.
            */}
            {caseId ? (
              <View style={{ marginTop: theme.spacing.huge }}>
                <CaseAnalysisPanel workspace={workspace} caseId={caseId} />
              </View>
            ) : null}

            <Section
              title="Events you recorded"
              count={events.length}
              hint="Your own account of what happened, kept separate from what the documents say."
              action={{ label: 'Add event', onPress: () => openComposer('event'), icon: 'plus' }}
            >
              {events.length ? (
                <View>
                  {events.map((event, index) => (
                    <View key={event.id}>
                      {index > 0 ? <Divider /> : null}
                      <EventRow
                        event={event}
                        onPress={() =>
                          caseId
                            ? router.push({
                                pathname: '/case/[caseId]/event/[eventId]',
                                params: { caseId, eventId: event.id },
                              })
                            : undefined
                        }
                      />
                    </View>
                  ))}
                </View>
              ) : (
                <Text variant="bodySmall" colorToken="textSecondary">
                  Nothing recorded. An event is useful when a document is silent about something
                  you remember — the analysis can then say the point is unevidenced rather than
                  never having heard of it.
                </Text>
              )}
            </Section>

            {record.participants.length ? (
              <Section
                title="People named in this case"
                count={record.participants.length}
                hint="Supplied by you when the case was opened. Who actually authored a document is assessed separately, per document."
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

            <Section
              title="Go further"
              hint="Each of these reads the same records from a different angle. None of them adds a conclusion."
            >
              <View>
                {DESTINATIONS.map((destination, index) => {
                  const enabled = destination.available(destinationContext);
                  return (
                    <View key={destination.pathname}>
                      {index > 0 ? <Divider /> : null}
                      <DestinationRow
                        destination={destination}
                        enabled={enabled}
                        onPress={() =>
                          caseId
                            ? router.push({ pathname: destination.pathname, params: { caseId } })
                            : undefined
                        }
                      />
                    </View>
                  );
                })}
              </View>
            </Section>

            {/*
              A ghost button, at the bottom, below the navigation.

              Matched to "Remove evidence from case" on the evidence screen rather than given a
              danger-tinted button here: a destructive action that looks dangerous before it has
              been asked for makes a reading screen feel hazardous to scroll. The weight belongs
              on the confirmation, where the button is `danger` and the consequences are spelled
              out, not on the thing that merely opens it.
            */}
            <Button
              label="Delete this case"
              variant="ghost"
              disabled={!record || removing}
              onPress={() => {
                setRemoveFailure(null);
                setShowRemove(true);
              }}
              style={{ marginTop: theme.spacing.xl }}
            />

            <Text
              variant="caption"
              colorToken="textTertiary"
              style={{ marginTop: theme.spacing.huge }}
            >
              This case holds what you uploaded and what the analysis could read from it. It
              does not establish that a document is authentic, that a document is independent, or
              that anyone is telling the truth.
            </Text>
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

      {/*
        The confirmation, where all the weight is.

        Three sentences, in the order a person needs them: what disappears, what happens to the
        files, and that it is final. Naming the file deletion separately matters — it is the only
        part of this that reaches outside the app, and someone who assumed their uploads were
        still recoverable somewhere should not find out afterwards.

        `dismissOnBackdropPress` is on, because a stray tap here cancels rather than destroys, but
        off while the work is in flight so a tap cannot orphan a commit that is mid-air.
      */}
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

// ---------------------------------------------------------------------------
// Masthead meta
// ---------------------------------------------------------------------------

/**
 * The line under the title: when the incident was, and when the case was last read.
 *
 * Mono, because every value on it is either a figure the user entered as a date or a
 * timestamp the system recorded — the sans face on this line would claim these are prose.
 *
 * `PulseDot` appears only while a document is genuinely mid-extraction. That restriction is
 * the whole reason the dot means anything: a pulse that is always on is decoration, and the
 * one thing a reader needs to know before trusting a plate is whether the sources behind it
 * have all been read yet.
 */
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
          <Icon name="check-circle-outline" size={13} color={theme.colors.textTertiary} />
        )}
        <Text variant="monoSmall" colorToken="textTertiary">
          {working > 0
            ? `${working} of ${evidence.length} still being read`
            : report
              ? `checked ${formatRelativeTime(report.createdAt, Date.now()).toLowerCase()}${report.stale ? ' · records changed since' : ''}`
              : 'not checked yet'}
        </Text>
      </Row>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One recorded event.
 *
 * The date is mono and the title is sans, which is the same split the whole app uses: the
 * title is the user's sentence, the date is a value with a precision. `describeDate` is what
 * keeps "March 2024" from being rendered as though the user had said the 1st.
 */
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

/**
 * One destination.
 *
 * A disabled row still shows its precondition instead of disappearing. A navigation list that
 * changes length as a case fills up gives the reader no stable map of the product, and "needs
 * more than one source" is more useful than an absence they cannot interrogate.
 */
function DestinationRow({
  destination,
  enabled,
  onPress,
}: {
  destination: Destination;
  enabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      dimOnPress
      pressScale={0}
      accessibilityRole="link"
      accessibilityLabel={destination.label}
      accessibilityHint={destination.hint}
      accessibilityState={{ disabled: !enabled }}
      style={styles.row}
    >
      <View style={[styles.rowInner, { gap: theme.spacing.lg }]}>
        <Icon name={destination.icon} size={19} color={theme.colors.textSecondary} />
        <View style={styles.flex}>
          <Text variant="bodyMedium">{destination.label}</Text>
          <Text variant="caption" colorToken="textTertiary" style={{ marginTop: SPACING.xxs }}>
            {enabled ? destination.hint : 'Not available yet — this case has too little in it.'}
          </Text>
        </View>
        {enabled ? <Disclosure /> : null}
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * The first-paint placeholder, shaped like what is coming.
 *
 * Two plate-sized blocks and a short ruled ledger, in the real proportions. A centred spinner
 * was the alternative and it is worse in a specific way: it tells the reader nothing about
 * what is arriving, and when the content lands the whole page jumps because a 40pt spinner and
 * a 600pt case share no geometry.
 */
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

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Builds the four ledger lines.
 *
 * Every `note` is a qualification of the figure above it, and each one exists because the
 * bare count is misleading on its own: a source count that includes half-read documents, a
 * claim count that includes claims the last run never saw, an event count that includes
 * undated events, a findings count that includes findings resting on an unconfirmed image
 * read. A count with no note is a count that needs none.
 */
function buildLedger({
  evidence,
  claims,
  events,
  results,
}: {
  evidence: readonly Evidence[];
  claims: ReadonlyArray<{ status: AssessmentStatus | null; basis: CitationBasis | null }>;
  events: readonly CaseEvent[];
  results: ReadonlyArray<{ status: string; provisional: boolean; deletedAt?: number | null }>;
}): LedgerLine[] {
  const working = evidence.filter((item) => isProcessingInFlight(item.state)).length;
  const attention = evidence.filter((item) => needsHumanAction(item.state)).length;
  const unassessed = claims.filter((claim) => claim.status === null).length;
  const undated = events.filter((event) => event.occurredAt === null).length;
  const open = results.filter((item) => (item.deletedAt ?? null) === null && item.status === 'OPEN');
  const provisional = open.filter((item) => item.provisional).length;

  const sourceNote =
    working > 0
      ? `${working} still being read`
      : attention > 0
        ? `${attention} need a second look`
        : null;

  const claimNote = unassessed > 0 ? `${unassessed} not checked in their current wording` : null;
  const eventNote = undated > 0 ? `${undated} without a date` : null;
  const findingNote =
    provisional > 0 ? `${provisional} rest on a value read from an image` : null;

  return [
    { label: 'Documents', value: evidence.length, ...(sourceNote ? { note: sourceNote } : {}) },
    { label: 'Claims', value: claims.length, ...(claimNote ? { note: claimNote } : {}) },
    { label: 'Events you recorded', value: events.length, ...(eventNote ? { note: eventNote } : {}) },
    { label: 'Findings still open', value: open.length, ...(findingNote ? { note: findingNote } : {}) },
  ];
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  // `Pressable` wraps its children in one animated view, so the row's own layout has to live
  // on an inner container — a `gap` here would have a single child to space.
  row: { paddingVertical: SPACING.lg },
  rowInner: { flexDirection: 'row', alignItems: 'center' },
  skeletonPlate: { borderWidth: BORDER_WIDTH.hairline },
});
