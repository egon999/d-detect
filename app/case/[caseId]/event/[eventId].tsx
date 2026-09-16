/**
 * Event detail.
 *
 * An event is the one record in a case that is *asserted* rather than uploaded: it says
 * something happened on a date. So this screen is built around the two questions a reader
 * has about such an assertion — when exactly, and what backs it up.
 *
 * ## Why the date gets its own card
 *
 * The date is the load-bearing field. Everything the rule engine concludes about ordering,
 * gaps and conflicts is derived from it, so the screen shows what the source actually said
 * *and* how the system read it, side by side, and never collapses the two into one
 * confident-looking line. A date known only to "March 2024" is shown as March 2024 with the
 * reason it is imprecise, rather than being promoted to the 1st of the month — which is the
 * mistake the whole normalization layer exists to avoid.
 *
 * ## Why there is no header in this file
 *
 * There was, and it was a second design for the one piece of chrome every other screen gets
 * from `ScreenScroll`: its own back button with no deep-link fallback (so arriving here from
 * a link left the user with a button that did nothing), a 16pt gutter against the app's 20,
 * and a `heading`-rank title where the rest of the app sets `display`. All of it is now the
 * primitive's, which also brings the refresh control and the safe-area handling this screen
 * was doing by hand. `Section` carries the four section headers for the same reason — it
 * already sets a count in mono, which is what two of them were spelling into their titles.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { reviewFinding } from '@data/mutations';
import { evaluateCaseClaims } from '@domain/analysis/claim-state';
import { RELATIONSHIP_LABELS } from '@domain/enums';
import type { AnalysisResult, Claim, Evidence } from '@domain/models';
import { FindingCard } from '@features/analysis/finding-card';
import { ClaimCard } from '@features/claims/claim-card';
import { EvidenceRow } from '@features/evidence/evidence-row';
import { useSession } from '@services';
import { mutationContext, useCaseRecord, useMutator, useWorkspace } from '@services/use-case-store';
import {
  Chip,
  DATE_PRECISION_LABELS,
  describeDate,
  describeProvenance,
  Divider,
  EmptyState,
  errorDetail,
  ErrorState,
  formatRelativeTime,
  LAYOUT,
  Notice,
  readableError,
  Row,
  ScreenScroll,
  Section,
  SkeletonCard,
  Stack,
  Surface,
  Text,
  useTheme,
} from '@ui';

export default function EventDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { caseId, eventId } = useLocalSearchParams<{ caseId: string; eventId: string }>();
  const { user } = useSession();

  // `error` matters here for a specific reason: a failed load leaves the workspace empty,
  // the event is then not found in it, and the not-found branch below would tell the reader
  // their event had been deleted. "Could not be read" and "does not exist" are opposite
  // statements about their data, so the two are kept apart.
  const { workspace, loading, refreshing, error, reload } = useWorkspace(user?.id ?? null, caseId ?? null);
  const targetCase = useCaseRecord(workspace, caseId ?? null);
  const mutator = useMutator(user?.id ?? null, caseId ?? null, workspace);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const event = useMemo(
    () => workspace.events.find((record) => record.id === eventId && !record.deletedAt) ?? null,
    [workspace.events, eventId],
  );

  /**
   * Evidence attached to this event, in either direction.
   *
   * Direction is not meaningful for display here — an "evidence ATTACHED_TO_EVENT event"
   * link and an "event RELATED_TO evidence" link both mean the document bears on this
   * event — so both are collected and the relationship type is shown per row instead.
   */
  const linkedEvidence = useMemo(() => {
    if (!eventId) return [];
    const found: Array<{ record: Evidence; label: string }> = [];
    const seen = new Set<string>();

    for (const relationship of workspace.relationships) {
      const { from, to } = relationship;
      const otherRef =
        from.kind === 'event' && from.id === eventId
          ? to
          : to.kind === 'event' && to.id === eventId
            ? from
            : null;
      if (!otherRef || otherRef.kind !== 'evidence' || seen.has(otherRef.id)) continue;

      const record = workspace.evidence.find((item) => item.id === otherRef.id && !item.deletedAt);
      if (!record) continue;

      seen.add(record.id);
      found.push({ record, label: RELATIONSHIP_LABELS[relationship.type] });
    }

    return found;
  }, [workspace.relationships, workspace.evidence, eventId]);

  /**
   * Claims this event is part of the story for.
   *
   * Two sources, deliberately merged: the event's own `claimIds` (the authored link) and
   * any relationship edges pointing at a claim (links created later, by a person, a rule
   * or an accepted AI suggestion). Showing only the first would hide half the picture.
   */
  const linkedClaims = useMemo(() => {
    if (!event) return [];
    const ids = new Set(event.claimIds);

    for (const relationship of workspace.relationships) {
      const { from, to } = relationship;
      if (from.kind === 'event' && from.id === event.id && to.kind === 'claim') ids.add(to.id);
      else if (to.kind === 'event' && to.id === event.id && from.kind === 'claim') ids.add(from.id);
    }

    const found: Claim[] = [];
    for (const id of ids) {
      const record = workspace.claims.find((claim) => claim.id === id && !claim.deletedAt);
      if (record) found.push(record);
    }
    return found;
  }, [event, workspace.relationships, workspace.claims]);

  /** Findings that named this event. These are why a timeline row shows a conflict marker. */
  const findings = useMemo(() => {
    if (!eventId) return [];
    // Scoped by `caseId` as well as by event, matching the filters in
    // `@features/analysis/case-analysis-panel`. Event ids are globally unique in practice,
    // so this changes nothing today — but it is the one filter on this screen that could
    // otherwise surface another case's finding if two ids ever collided.
    return workspace.analysisResults.filter(
      (result) => result.caseId === caseId && result.relatedEventIds.includes(eventId),
    );
  }, [workspace.analysisResults, eventId, caseId]);

  /**
   * Records a reader's judgement on one of those findings, through the same mutation path
   * as every other write: the pure `reviewFinding` mutation runs against the live
   * workspace inside `mutate`, so the optimistic state and the stored state come from the
   * same function. `useMutator` resolves failures as values rather than throwing, so the
   * review row stays usable and the error is shown next to it.
   *
   * The signed-out case says so rather than returning quietly. The review controls are
   * hidden in that state (see `onReview` below), so this is the narrow race where the
   * session ends between a paint and a tap — but a review that appears to be accepted and
   * is silently dropped is exactly the kind of false reassurance this screen must not give.
   */
  const reviewFindingHere = useCallback(
    async (finding: AnalysisResult, status: 'REVIEWED' | 'DISMISSED', note: string) => {
      if (!user) {
        setReviewError('You are signed out, so this review was not saved. Sign in and try again.');
        return;
      }
      setReviewError(null);
      const result = await mutator.mutate((current) =>
        reviewFinding(current, mutationContext(user.id), finding.id, status, note),
      );
      if (!result.ok)
        setReviewError(
          readableError(result.error, 'That review could not be saved. Nothing was changed.'),
        );
    },
    [mutator, user],
  );

  const caseLoaded = Boolean(caseId) && targetCase !== null;

  const claimEvaluations = useMemo(() => {
    if (!caseLoaded || !caseId) return new Map();
    return evaluateCaseClaims(workspace, caseId);
  }, [workspace, caseId, caseLoaded]);

  // Same shape as the case screen's guard, and for the same reason: the workspace
  // subscription has not emitted on first paint, so a missing record during `loading` is
  // normal and must not be reported as a deleted one. A load *failure* is separated out
  // ahead of both, because it is not evidence either way about whether the event exists.
  //
  // The masthead title is deliberately about the *screen* rather than about the event —
  // "Event" and nothing else — because at this point the app does not know what the event
  // is called, and "Loading Event..." was a title that shouted a state at the reader.
  if (!event) {
    return (
      <ScreenScroll title="Event" back contentStyle={styles.content}>
        {error ? (
          <ErrorState
            title="This event could not be loaded"
            message="The connection to your stored cases failed, so this event could not be read. It has not been deleted, and nothing has been changed."
            detail={errorDetail(error)}
            onRetry={reload}
          />
        ) : loading ? (
          <Stack
            gap="lg"
            accessibilityRole="progressbar"
            accessibilityLabel="Reading this event"
          >
            <SkeletonCard lines={5} />
            <SkeletonCard lines={3} />
          </Stack>
        ) : (
          <EmptyState
            icon="calendar-remove"
            title="This event is not here"
            message="It may have been removed, or it belongs to another case. Nothing was loaded."
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

  const date = event.occurredAt ? describeDate(event.occurredAt) : null;
  const sourceEvidence = event.occurredAt
    ? workspace.evidence.find((item) => item.id === event.occurredAt?.evidenceId) ?? null
    : null;

  return (
    <ScreenScroll
      title={event.title}
      back
      {...(targetCase?.title ? { subtitle: targetCase.title } : {})}
      refreshing={refreshing}
      onRefresh={reload}
      contentStyle={styles.content}
    >
      <Section
        first
        title="When this happened"
        hint="What the document said and how the app read it, kept separate."
      >
        <Surface elevation="low" padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
          {date ? (
            <>
              <View>
                {/* Was "NORMALIZED" — the name of a pipeline stage, shouted. The reader's
                    question is whose reading this is, and the answer is the app's. */}
                <Text variant="label" colorToken="textSecondary">
                  How the app read it
                </Text>
                <Row gap="sm" align="center" wrap style={{ marginTop: theme.spacing.xs }}>
                  <Text variant="title">{date.normalized || 'Not resolvable'}</Text>
                  <Chip
                    tone={event.occurredAt?.precision === 'DAY' ? 'ok' : 'warn'}
                    label={DATE_PRECISION_LABELS[event.occurredAt?.precision ?? 'UNKNOWN']}
                    size="sm"
                  />
                  {date.ambiguous ? <Chip tone="warn" label="Reads two ways" size="sm" /> : null}
                </Row>
              </View>

              <View>
                <Text variant="label" colorToken="textSecondary">
                  As written in the document
                </Text>
                <View
                  style={[
                    styles.quote,
                    {
                      backgroundColor: theme.colors.surfaceSunken,
                      borderRadius: theme.radius.sm,
                      padding: theme.spacing.md,
                      marginTop: theme.spacing.xs,
                    },
                  ]}
                >
                  {/* Mono, because this is the string as it stands in the file. */}
                  <Text variant="mono">{date.original}</Text>
                </View>
              </View>

              {/* The honesty requirement: an imprecise or ambiguous date says so, in place,
                  rather than being presented as a resolved fact. */}
              {date.hint ? (
                <Notice
                  tone={date.ambiguous ? 'warn' : 'info'}
                  title={date.ambiguous ? 'This date reads two ways' : 'This date is not exact'}
                  message={date.hint}
                />
              ) : null}

              {event.occurredAt ? (
                <View>
                  <Text variant="label" colorToken="textSecondary">
                    Where this date came from
                  </Text>
                  <Text
                    variant="bodySmall"
                    colorToken="textSecondary"
                    style={{ marginTop: theme.spacing.xs }}
                  >
                    {describeProvenance(event.occurredAt.method, event.occurredAt.sourceQuote)}
                  </Text>
                  {sourceEvidence ? (
                    <View style={{ marginTop: theme.spacing.sm }}>
                      <EvidenceRow
                        record={sourceEvidence}
                        onPress={() =>
                          router.push({
                            pathname: '/case/[caseId]/evidence/[evidenceId]',
                            params: { caseId: event.caseId, evidenceId: sourceEvidence.id },
                          })
                        }
                      />
                    </View>
                  ) : null}
                </View>
              ) : null}
            </>
          ) : (
            <Notice
              tone="neutral"
              title="No date recorded"
              message="This event has no date, so it is placed at the end of the timeline rather than guessed at."
            />
          )}
        </Surface>
      </Section>

      {event.description ? (
        <Section
          title="Description"
          hint={`Your own account of this event, recorded ${formatRelativeTime(event.createdAt, Date.now())}.`}
        >
          <Surface elevation="low" padding="lg" radius="lg">
            {/* No `lineHeight` override. `body` is 15.5/23.5 and the 22 that was here set
                the one paragraph of the user's own writing tighter than every other
                paragraph in the app. */}
            <Text variant="body">{event.description}</Text>
          </Surface>
        </Section>
      ) : null}

      {findings.length > 0 ? (
        <Section
          title="Findings on this event"
          count={findings.length}
          hint="What the automatic checks noticed, with the values they compared."
        >
          <Stack gap="lg">
            {reviewError ? (
              <Notice
                tone="danger"
                title="That review could not be saved"
                message={reviewError}
                onDismiss={() => setReviewError(null)}
              />
            ) : null}
            {/*
              Signed out, the review controls are not offered at all and the reason is
              stated. They used to render unconditionally and do nothing when tapped, which
              left a reader believing they had marked a finding reviewed when no such record
              was ever written.
            */}
            {!user ? (
              <Notice
                tone="info"
                title="Sign in to review findings"
                message="You can read these findings, but marking one as reviewed or setting it aside is saved to your account. Sign in to do that."
              />
            ) : null}
            {findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                {...(user ? { onReview: reviewFindingHere } : {})}
              />
            ))}
          </Stack>
        </Section>
      ) : null}

      <Section
        title="Linked evidence"
        count={linkedEvidence.length}
        hint="Documents that bear on this event."
      >
        {linkedEvidence.length > 0 ? (
          <Surface elevation="low" padding="lg" radius="lg">
            {linkedEvidence.map(({ record, label }, index) => (
              <View key={record.id}>
                {index > 0 ? <Divider /> : null}
                <Chip
                  tone="neutral"
                  label={label}
                  size="sm"
                  style={{ marginTop: index > 0 ? theme.spacing.md : 0 }}
                />
                <EvidenceRow
                  record={record}
                  onPress={() =>
                    router.push({
                      pathname: '/case/[caseId]/evidence/[evidenceId]',
                      params: { caseId: event.caseId, evidenceId: record.id },
                    })
                  }
                />
              </View>
            ))}
          </Surface>
        ) : (
          /*
            Was a `Notice` reading "Attach evidence from the evidence screen" — an
            instruction naming a screen the reader had no way to reach from here. The link
            is made on a document's own screen, so the route out of this empty state is the
            one that gets a document into the case in the first place.
          */
          <EmptyState
            compact
            icon="paperclip"
            title="No documents linked yet"
            message="Nothing in this case documents this event. Open a document and use its connect action to link it here — or add one, if the case has nothing that covers this."
            action={{
              label: 'Add evidence',
              icon: 'plus',
              onPress: () =>
                router.push({
                  pathname: '/case/[caseId]/upload',
                  params: { caseId: event.caseId },
                }),
            }}
          />
        )}
      </Section>

      <Section
        title="Claims this event is part of"
        count={linkedClaims.length}
        hint="The statements this event forms part of the story for."
      >
        {linkedClaims.length > 0 ? (
          <Stack gap="lg">
            {linkedClaims.map((claim) => (
              <ClaimCard
                key={claim.id}
                claim={claim}
                evaluation={claimEvaluations.get(claim.id)}
                onPress={() =>
                  router.push({
                    pathname: '/case/[caseId]/claim/[claimId]',
                    params: { caseId: event.caseId, claimId: claim.id },
                  })
                }
              />
            ))}
          </Stack>
        ) : (
          /*
            Was one centred sentence in an otherwise empty card, with nothing to do about
            it. Claims are written on the case screen, so that is where this goes.
          */
          <EmptyState
            compact
            icon="scale-balance"
            title="Not part of any claim"
            message="A claim is a statement you want checked against the documents. Linking this event to one is what puts it into the story that claim tells."
            action={{
              label: 'Open this case',
              icon: 'arrow-left',
              onPress: () =>
                router.push({ pathname: '/case/[caseId]', params: { caseId: event.caseId } }),
            }}
          />
        )}
      </Section>
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  content: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  // The one bespoke box left, and it earns it: the source string is set apart from the
  // app's own reading of it, which is the distinction this whole screen exists to hold.
  // No border — the sunken fill already states the edge, and a border on top of it would
  // be the second line around one box.
  quote: { alignSelf: 'stretch' },
});
