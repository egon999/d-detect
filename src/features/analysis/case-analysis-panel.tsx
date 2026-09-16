import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { createClaim, linkEntities, reviewAiSuggestion } from '@data/mutations';
import type { AIExtractionSuggestion, CaseCitation, Workspace } from '@domain/models';
import { isConflictFinding } from '@domain/enums';
import { ASSESSMENT_LABELS, evidenceBasis, latestCaseAnalysis, reportIsStale, resolveCitation } from '@domain/analysis/case-report';
import { runEvidenceIntelligence, type DiscoveredAssertion } from '@domain/analysis/evidence-intelligence';
import { aiAvailable, confidenceBand, isOnDeviceSuggestion, requestCaseAnalysis, useMutator, useRepository } from '@services';
import { AISetupNotice } from './ai-setup-notice';
import {
  ASSERTION_KIND_LABELS,
  Button,
  Chip,
  CONFIDENCE_LABELS,
  EXTRACTION_METHOD_ICON,
  EXTRACTION_METHOD_LABELS,
  EXTRACTION_METHOD_TONE,
  formatRelativeTime,
  Icon,
  Notice,
  PaperSheet,
  readableError,
  readableToken,
  Row,
  Stack,
  Surface,
  Text,
  usePaper,
  useTheme,
  type IconName,
  type Tone,
} from '@ui';

/**
 * What each suggestion kind proposes, in the terms a reviewer reads.
 *
 * Phrased as the question the panel answers rather than the name of the pass that produced
 * it. "Cross-document reconciliation" is what the code does; "Where your documents
 * disagree" is what the user came to find out.
 */
const SUGGESTION_KIND_LABELS: Record<AIExtractionSuggestion['kind'], string> = {
  FIELD_EXTRACTION: 'Reading of a document',
  RELATIONSHIP: 'Proposed connection',
  DOCUMENT_TYPE: 'Proposed document type',
  EVENT_MATCH: 'Proposed event match',
  CROSS_DOCUMENT_RECONCILIATION: 'Where your documents disagree',
  SUPPORT_STRENGTH: 'What your documents support',
  MISSING_INFORMATION: 'What your case is missing',
  TIMELINE_COHERENCE: 'Whether the dates add up',
  // Nothing writes this any more; the label stays so a case that already holds one still
  // renders it with a name instead of a blank. See the note on `kind` in `@domain/models`.
  DISPUTE_SYNTHESIS: 'Case summary',
};

/** "1 source" / "3 sources". "(s)" is form-speak, and this word appears in two counts. */
function sourceCount(count: number): string {
  return `${count} ${count === 1 ? 'source' : 'sources'}`;
}

/**
 * How a segment was read, in words.
 *
 * The label map, not `method.toLowerCase()`: printing the raw value put "deterministic" /
 * "ocr" / "ai" in front of a reader — the internal name of the machinery, rather than the
 * plain phrase the rest of the app uses for the same thing.
 *
 * Guarded at runtime even though the cast tells the compiler the lookup cannot miss. A
 * segment's method is persisted as a plain string (`models.ts:114`) rather than the enum,
 * so a record written by an older build could hold anything; both a raw `ocr` and the word
 * `undefined` are worse to show than the clause being absent.
 */
function methodLabel(method: string): string {
  return (EXTRACTION_METHOD_LABELS as Record<string, string | undefined>)[method] ?? '';
}

/** The method's tone, or `neutral` for a stored string no current build would write. */
function methodTone(method: string): Tone {
  return (EXTRACTION_METHOD_TONE as Record<string, Tone | undefined>)[method] ?? 'neutral';
}

/** Where in the document the passage sits, when the segment recorded it. */
function locatorOf(segment: { page?: number | undefined; startMs?: number | undefined }): string {
  if (segment.page) return `Page ${segment.page}`;
  if (segment.startMs !== undefined) return `${Math.floor(segment.startMs / 1000)}s`;
  return '';
}

/**
 * How a passage was read, stamped at the foot of the sheet it is quoted on.
 *
 * The same device `Excerpt` uses, in the method's own tone, because a passage a rule lifted
 * out of a PDF and one recovered off a photograph are different qualities of evidence and the
 * reader has to be able to rank them without reading the caption. Renders nothing for a stored
 * method string no current build would write.
 */
function ReadingStamp({ method }: { method: string }) {
  const theme = useTheme();
  const label = methodLabel(method);
  if (!label) return null;

  const tone = methodTone(method);
  const icon = (EXTRACTION_METHOD_ICON as Record<string, IconName | undefined>)[method];

  return (
    <Row gap="xs" align="center" justify="flex-end">
      {icon ? <Icon name={icon} size={12} color={theme.tone(tone).fg} /> : null}
      <Text variant="monoSmall" tone={tone} numberOfLines={1}>
        {label}
      </Text>
    </Row>
  );
}

/**
 * Citations carried inside a suggestion payload, when the producing pass included any.
 *
 * No suggestion kind written today carries citations (the cross-document operations that
 * produce verified citations are not persisted as suggestions yet), so this usually
 * returns nothing. It exists so that the day one does, the section renders its quotes
 * and their sources without a second wiring pass - and so nothing in the payload is ever
 * rendered unchecked: each entry must name a document, a segment and a quote.
 */
function payloadCitations(payload: Record<string, unknown>): Array<{ evidenceId: string; segmentId: string; quote: string }> {
  if (!Array.isArray(payload.citations)) return [];
  return payload.citations.filter(
    (entry): entry is { evidenceId: string; segmentId: string; quote: string } =>
      typeof entry === 'object' && entry !== null &&
      typeof (entry as { evidenceId?: unknown }).evidenceId === 'string' &&
      typeof (entry as { segmentId?: unknown }).segmentId === 'string' &&
      typeof (entry as { quote?: unknown }).quote === 'string',
  );
}

/**
 * The passages a saved assessment rests on.
 *
 * Two decisions carry the weight here.
 *
 * **The quote is monospace.** It is verbatim material lifted out of the user's own
 * document, which is the single case the app's sans/mono split exists to mark — and it was
 * set in the body face while labels the app assigned itself took the mono scale, so the
 * typography claimed document provenance exactly where there was none and dropped it where
 * there was. Everything the app wrote around the quote — the source line, the caveat when a
 * citation no longer resolves — stays in the sans face for the same reason.
 *
 * **There is no box.** Each citation used to be an always-bordered `Surface
 * variant="sunken"`, rendered from inside a card that already states its own edge — a
 * claim with three passages was a hairlined box holding three hairlined boxes, which the
 * `Surface` docblock names as the largest single contributor to the app reading as cheap.
 *
 * It is a sheet of paper now, which is the same argument carried one step further: the quote
 * is the reader's document and everything around it is the app, and `PaperSheet` is the one
 * material in the design system that says so. The typographic quote marks came off with the
 * box — a sheet of paper *is* the quotation mark, and `“…”` around a fragment that starts
 * mid-sentence was punctuating the app's cut as though the document had written it.
 *
 * **The byline is positions, not a dot-joined string.** It read `Title · Page 3 · 12s · Read
 * from an image`: four unrelated facts at one rank, which a reader has to parse before
 * learning any of them. The locator is a folio at the head of the sheet, the method is a
 * stamp at its foot in the method's own tone, and the document's name is the app's line
 * underneath.
 */
export function CitationList({ citations, workspace, caseId }: { citations: CaseCitation[]; workspace: Workspace; caseId: string }) {
  const router = useRouter();
  const paper = usePaper();
  return <Stack gap="lg">{citations.map((citation, index) => {
    const found = resolveCitation(workspace, citation);
    const source = found?.evidence.caseId === caseId ? found : null;
    const locator = source ? locatorOf(source.segment) : '';
    return <Stack key={`${citation.evidenceId}:${citation.segmentId}:${index}`} gap="sm">
      <PaperSheet>
        {locator ? <Text variant="monoSmall" style={{ color: paper.meta }}>{locator}</Text> : null}
        <Text variant="mono" selectable style={{ color: paper.text }}>{citation.quote}</Text>
        {source ? <ReadingStamp method={source.segment.method} /> : null}
      </PaperSheet>
      <Text variant="caption" colorToken="textSecondary">
        {source?.evidence.title ?? 'The document this came from is no longer in the case'}
      </Text>
      {source ? <Button label="View source" variant="ghost" size="sm" onPress={() => router.push({
        pathname: '/case/[caseId]/evidence/[evidenceId]',
        params: { caseId, evidenceId: citation.evidenceId, segmentId: citation.segmentId },
      })} /> : <Text variant="caption" colorToken="textSecondary">The passage cannot be opened for checking: the document it was read from has changed or has been removed from this case.</Text>}
    </Stack>;
  })}</Stack>;
}

/**
 * The case's AI suggestions: what a connected model proposed, for a person to accept or
 * dismiss.
 *
 * Rendered after the deterministic report, never in place of any part of it. Accepting
 * or dismissing writes review state and an audit entry through `reviewAiSuggestion` -
 * nothing in the case changes until the user applies a proposal themselves through the
 * ordinary screens (confirm a field, link a record).
 *
 * `aiAvailable()` is checked on mount so that "no key configured" shows the setup notice
 * rather than a permanently empty section. It reads the keystore only; it never spends
 * a request.
 */
export function AiSuggestionsSection({ workspace, caseId }: { workspace: Workspace; caseId: string }) {
  const router = useRouter();
  const theme = useTheme();
  const ownerId = workspace.cases.find((item) => item.id === caseId)?.ownerId ?? null;
  const mutator = useMutator(ownerId, caseId, workspace);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    aiAvailable().then(
      (available) => { if (alive) setAiConfigured(available); },
      () => { if (alive) setAiConfigured(false); },
    );
    return () => { alive = false; };
  }, []);

  const suggestions = workspace.aiSuggestions.filter((item) => item.caseId === caseId);
  // A decision waiting on a person outranks a record of one already made, and within
  // each group the newest proposal comes first.
  const ordered = [...suggestions].sort((a, b) =>
    (a.status === 'SUGGESTED' ? 0 : 1) - (b.status === 'SUGGESTED' ? 0 : 1) || b.createdAt - a.createdAt,
  );

  function review(id: string, status: 'ACCEPTED' | 'REJECTED') {
    if (!ownerId) return;
    void mutator.mutate((current) => reviewAiSuggestion(current, { ownerId, now: Date.now() }, id, status));
  }

  return <Stack gap="md">
    <Text variant="heading">Suggestions</Text>
    <Text variant="bodySmall" colorToken="textSecondary">Proposals about your documents, separate from the assessment above. Accepting records your review; the case itself only changes through the actions you take on it.</Text>
    {/* `aiConfigured` is null until the keystore read returns. Both branches below test for
        a settled value, so without this line the heading sat above an empty void for the
        length of that read — which on a cold start is a no-key user's first impression of
        the section. It says what is happening rather than guessing an answer it does not
        have yet. */}
    {aiConfigured === null ? <Text variant="bodySmall" colorToken="textSecondary">Checking whether a model is connected…</Text> : null}
    {aiConfigured === false ? <AISetupNotice action="read what your documents mean, propose connections to your claims and events, and say what the case is missing" compact /> : null}
    {aiConfigured && suggestions.length === 0 ? <Text variant="bodySmall" colorToken="textSecondary">Nothing here yet. Suggestions appear after a document is read or an assessment is run.</Text> : null}
    {ordered.map((item) => {
      const sources = item.sourceEvidenceIds
        .map((id) => workspace.evidence.find((entry) => entry.id === id && entry.caseId === caseId && !entry.deletedAt))
        .filter((entry) => entry !== undefined);
      const citations = payloadCitations(item.payload);
      /*
        Some of these were produced by comparing values on this device, with no model
        involved: amounts in one currency are arithmetic and shared identifiers are string
        equality, so those comparisons run whether or not a key is connected. A record that
        came from the device must not wear the violet AI mark — violet means "a model wrote
        this", and a reader who has learnt that is entitled to rely on it.
      */
      const onDevice = isOnDeviceSuggestion(item);
      return <Surface key={item.id} padding="lg" style={{ gap: theme.spacing.md }}>
        <Row gap="sm" align="center" wrap>
          <Chip label={SUGGESTION_KIND_LABELS[item.kind]} tone={onDevice ? 'neutral' : 'ai'} size="sm" />
          {item.status !== 'SUGGESTED' ? <Chip label={item.status === 'ACCEPTED' ? 'Accepted' : 'Dismissed'} tone="neutral" size="sm" /> : null}
        </Row>
        <Text variant="bodySmall">{item.summary}</Text>
        {/*
          Two facts, two positions, rather than `Suggested by AI · Strong grounds`.

          The provenance is a stamp — the same `creation` glyph in the same `ai` tone the app
          uses everywhere a model wrote a value, so a reader who has learnt that mark once
          recognises it here without reading the words. The rank beside it is the model's own
          report of its confidence, which is a separate claim by a separate speaker, and the
          dot between them said nothing about which was which.

          An on-device record has no such self-report to show. It states what it compared
          instead, because "it did not state how confident it is" would be describing a
          speaker that was never asked.
        */}
        <Row between align="center" gap="sm">
          <Text variant="caption" colorToken="textSecondary" style={{ flex: 1 }}>
            {onDevice
              ? 'Compared on this device, without a model'
              : item.confidence === null
                ? 'It did not state how confident it is'
                : `Its own confidence: ${CONFIDENCE_LABELS[confidenceBand(item.confidence)]}`}
          </Text>
          <ReadingStamp method={onDevice ? 'DETERMINISTIC' : 'AI'} />
        </Row>
        {sources.length > 0 ? <Row gap="sm" wrap>
          {sources.map((source) => <Button key={source.id} label={`Open ${source.title}`} variant="ghost" size="sm" onPress={() => router.push({ pathname: '/case/[caseId]/evidence/[evidenceId]', params: { caseId, evidenceId: source.id } })} />)}
        </Row> : null}
        {/*
          Paper, for the same reason `CitationList` is paper: these characters are the reader's
          document, and everything else on this card is a model talking about it. Set on a sheet
          the `“…”` marks are redundant — worse than redundant, since the payload's quote is a
          fragment and the marks punctuated the model's cut as though the document had written it.
        */}
        {citations.length > 0 ? <Stack gap="sm">
          {citations.map((citation, index) => <PaperSheet key={`${citation.evidenceId}:${citation.segmentId}:${index}`}>
            <Text variant="mono" selectable style={{ color: theme.colors.paper.text }}>{citation.quote}</Text>
          </PaperSheet>)}
        </Stack> : null}
        {item.status === 'SUGGESTED' ? <Row gap="sm" wrap>
          <Button label="Accept" size="sm" disabled={mutator.busy} onPress={() => review(item.id, 'ACCEPTED')} />
          <Button label="Dismiss" size="sm" variant="secondary" disabled={mutator.busy} onPress={() => review(item.id, 'REJECTED')} />
        </Row> : null}
      </Surface>;
    })}
  </Stack>;
}
export function CaseAnalysisPanel({ workspace, caseId }: { workspace: Workspace; caseId: string }) {
  const { repository } = useRepository();
  const router = useRouter();
  const theme = useTheme();
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedJobId, setSavedJobId] = useState<string | null>(null);
  useEffect(() => { setError(null); setSavedJobId(null); }, [caseId]);
  const report = latestCaseAnalysis(workspace, caseId);
  const evidence = workspace.evidence.filter((e) => e.caseId === caseId && !e.deletedAt);
  const claims = workspace.claims.filter((c) => c.caseId === caseId && !c.deletedAt);
  const findings = workspace.analysisResults.filter((r) => r.caseId === caseId && r.status !== 'DISMISSED');
  const jobs = workspace.processingJobs.filter((j) => j.caseId === caseId && j.type === 'CASE').sort((a, b) => b.createdAt - a.createdAt);
  const latestJob = jobs[0];

  const ownerId = workspace.cases.find((item) => item.id === caseId)?.ownerId ?? null;
  const mutator = useMutator(ownerId, caseId, workspace);
  const intelligence = useMemo(() => runEvidenceIntelligence(workspace, caseId), [workspace, caseId]);
  const [promotingId, setPromotingId] = useState<string | null>(null);

  async function promoteAssertion(assertion: DiscoveredAssertion) {
    if (!ownerId || promotingId) return;
    setPromotingId(assertion.id);
    try {
      await mutator.mutate((current) => {
        const now = Date.now();
        const mCtx = { ownerId, now };
        const claimMutation = createClaim(current, mCtx, caseId, {
          statement: assertion.statement,
          detail: assertion.detail,
        });
        let nextWs = claimMutation.workspace;
        const newClaim = nextWs.claims.find((c) => c.statement === assertion.statement.trim() && !c.deletedAt);
        if (newClaim) {
          for (const evId of assertion.sourceEvidenceIds) {
            try {
              const linkMut = linkEntities(nextWs, mCtx, caseId, {
                from: { kind: 'evidence', id: evId },
                to: { kind: 'claim', id: newClaim.id },
                type: assertion.corroboration === 'CONTRADICTED' ? 'CONTRADICTS' : 'SUPPORTS',
                origin: 'USER',
              });
              nextWs = linkMut.workspace;
            } catch {
              // Ignore duplicate link error
            }
          }
        }
        return { ...claimMutation, workspace: nextWs };
      });
    } finally {
      setPromotingId(null);
    }
  }

  const existingClaimStatements = useMemo(
    () => new Set(claims.map((c) => c.statement.toLowerCase().trim())),
    [claims],
  );
  const unpromotedAssertions = useMemo(
    () => intelligence.discoveredAssertions.filter((a) => !existingClaimStatements.has(a.statement.toLowerCase().trim())),
    [intelligence.discoveredAssertions, existingClaimStatements],
  );

  /**
   * One path for every workspace kind. `requestCaseAnalysis` runs the deterministic
   * engine on this device and writes the job and the report itself — there is no remote
   * service to fall back from, so there is no branch on `kind` and no second attempt
   * hiding in a `catch`. The context is passed rather than resolved inside, so the run
   * commits through the same adapter this panel's workspace subscription watches and the
   * report appears without a reload.
   */
  async function analyze() {
    setRequesting(true); setError(null);
    try {
      const owner = workspace.cases.find((c) => c.id === caseId)?.ownerId || '';
      const receipt = await requestCaseAnalysis(caseId, { repository, ownerId: owner });
      setSavedJobId(receipt.jobId);
    } catch (inner) {
      // `readableError` decides only one thing: whether what it was handed reads as a
      // sentence for a person. The sentence below is the one that actually fires for a
      // `TypeError`, a Zod issue array or a storage permission string — which is what this
      // line used to put in front of a reader as the message of a danger notice.
      setError(
        readableError(
          inner,
          'The check could not start. Your documents are saved — try again, and if it keeps failing, reopen the case and start it from there.',
        ),
      );
    } finally {
      setRequesting(false);
    }
  }

  const conflictFindings = findings.filter((f) => isConflictFinding(f.resultType));

  return <Stack gap="xl">
    <Surface padding="lg" style={{ gap: theme.spacing.md }}>
      <Text variant="heading">Check the claims against the evidence</Text>
      <Text colorToken="textSecondary">Compare the sources together, inspect conflicts, and see what remains unanswered. A saved assessment includes the exact passages behind it.</Text>
      {!claims.length ? <Text colorToken="textSecondary">No claim written yet. The assessment still reports what the sources say and where they disagree — add a claim to have it weighed for and against as well.</Text> : null}
      {!evidence.length ? <Text colorToken="textSecondary">Add the original records or a clearly attributed statement to begin.</Text> : null}
      {evidence.length > 0 ? <Text variant="bodySmall" colorToken="textSecondary">{sourceCount(evidence.length)} available for cross-checking.</Text> : null}
      {evidence.length >= 2 ? (
        <Row gap="sm" align="center" wrap>
          {/*
            Neutral below 1.0, not `warn`. Two documents that came from the same statement are
            the ordinary case, not a problem the reader caused, and an amber chip on a count
            that is merely lower than the total reads as an accusation. The ratio is also not
            repeated as a percentage: "2 of 3" is the same fact said once.
          */}
          <Chip
            label={`${intelligence.independence.independentSources} of ${sourceCount(intelligence.independence.totalSources)} independent`}
            tone={intelligence.independence.ratio < 1.0 ? 'neutral' : 'ok'}
            size="sm"
          />
          {intelligence.independence.ratio < 1.0 ? (
            <Text variant="caption" colorToken="textSecondary">
              Copies of the same record are counted once.
            </Text>
          ) : null}
        </Row>
      ) : null}
      {evidence.length >= 2 && intelligence.independence.warnings.length > 0 ? (
        <Notice
          title="Some documents are not independent"
          message={intelligence.independence.warnings.join(' ')}
          tone="warn"
        />
      ) : null}
      {error ? <Notice title="The check did not start" message={error} tone="danger" /> : null}
      {latestJob?.state === 'FAILED' ? <Notice
        title="The last check did not finish"
        message={readableError(
          latestJob.lastError,
          'The last check stopped before it finished. Your documents are saved — run it again.',
        )}
        tone="warn"
      /> : null}
      {savedJobId ? <Notice title="Assessment saved" message="The comparison finished on this device. The saved assessment is shown below." tone="ok" /> : null}
      <Row gap="md" wrap>
        <Button label={requesting ? 'Comparing evidence…' : report ? 'Run a new assessment' : 'Analyse the evidence'} onPress={() => void analyze()}
          loading={requesting} disabled={requesting || !evidence.length} />
        <Button label="Add evidence" variant="secondary" onPress={() => router.push({ pathname: '/case/[caseId]/upload', params: { caseId } })} />
      </Row>
    </Surface>

    {conflictFindings.length > 0 ? (
      <Stack gap="sm">
        {conflictFindings.map((f) => (
          <Notice
            key={f.id}
            title={f.title}
            message={f.explanation}
            tone="danger"
          />
        ))}
      </Stack>
    ) : null}

    {report ? <>
      {reportIsStale(workspace, report) ? <Notice title="Sources have changed" message="This is a saved assessment of an earlier version of the case. Run a new assessment to include the latest changes." tone="warn" /> : null}
      <Stack gap="sm">
        <Text variant="heading">What the evidence shows</Text>
        {/*
          A bare `toLocaleString()` put an unlabelled machine timestamp under the heading. The
          same relative phrasing every other screen uses, with the word that says what the
          date is *of* — a reader needs to know how old this assessment is, not when it was
          serialised.
        */}
        <Text variant="caption" colorToken="textSecondary">Assessed {formatRelativeTime(report.createdAt, Date.now())}</Text>
        <Text>{report.summary}</Text>
        <Text variant="bodySmall" colorToken="textSecondary">Coverage: {report.coverage.processedEvidence} of {sourceCount(report.coverage.totalEvidence)} examined.</Text>
      </Stack>
      {report.claims.map((claim) => {
        const tone = claim.status === 'SUPPORTED' ? 'ok' : claim.status === 'CONTRADICTED' ? 'danger' : claim.status === 'DISPUTED' ? 'warn' : 'neutral';
        return <Surface key={claim.claimId} padding="lg" style={{ gap: theme.spacing.md }}>
          <Chip label={ASSESSMENT_LABELS[claim.status]} tone={tone} size="sm" />
          <Text variant="subheading">{claim.statement}</Text>
          <Text>{claim.explanation}</Text>
          <Text variant="bodySmall" colorToken="textSecondary">{evidenceBasis(workspace, claim.citations)}</Text>
          <CitationList citations={claim.citations} workspace={workspace} caseId={caseId} />
          {claim.missingInformation.length ? <Stack gap="xs"><Text variant="subheading">What is missing</Text>{claim.missingInformation.map((text, i) => <Text key={i} colorToken="textSecondary">• {text}</Text>)}</Stack> : null}
          {claim.limitations.map((text, i) => <Text key={i} variant="bodySmall" colorToken="textSecondary">{text}</Text>)}
        </Surface>;
      })}
      {([['Where sources agree', report.agreements], ['Where sources conflict', report.contradictions]] as const).map(([title, itemFindings]) => itemFindings.length ? <Stack key={title} gap="md">
        <Text variant="heading">{title}</Text>
        {itemFindings.map((finding, i) => <Surface key={i} padding="lg" style={{ gap: theme.spacing.md }}><Text>{finding.statement}</Text><CitationList citations={finding.citations} workspace={workspace} caseId={caseId} /></Surface>)}
      </Stack> : null)}
      {report.timeline.length ? <Stack gap="md"><Text variant="heading">Events described by the sources</Text>{report.timeline.map((event, i) => <Surface key={i} padding="lg" style={{ gap: theme.spacing.sm }}>
        <Text variant="caption" colorToken="textSecondary">{event.occurredAt || 'Time not established'}</Text><Text>{event.description}</Text><CitationList citations={event.citations} workspace={workspace} caseId={caseId} />
      </Surface>)}</Stack> : null}
      {report.limitations.length ? <Surface padding="lg" style={{ gap: theme.spacing.sm }}><Text variant="subheading">Limits of this assessment</Text>{report.limitations.map((text, i) => <Text key={i} colorToken="textSecondary">• {text}</Text>)}</Surface> : null}
      <Text variant="caption" colorToken="textSecondary">Support describes what the submitted records say. It does not establish document authenticity, completeness, or a legal finding. Check the original sources before acting.</Text>
    </> : null}

    {intelligence.completenessGaps.length > 0 ? (
      <Stack gap="md">
        <Text variant="heading">What is still missing</Text>
        {/*
          Not "resolves these uncertainties". Adding a document can answer a question the
          records leave open; it cannot settle the question, and the caveat at the foot of the
          saved assessment says so. Three places on this screen used to promise three
          different things about what an upload achieves; they now say the same one.
        */}
        <Text variant="bodySmall" colorToken="textSecondary">
          Questions the records currently leave open. Adding a document that speaks to one of them gives the next assessment more to work with.
        </Text>
        {intelligence.completenessGaps.map((gap) => (
          <Surface key={gap.id} padding="md" style={{ gap: theme.spacing.sm }}>
            {/* `warn` / `neutral`, not `danger` / `warn`: a gap is a question, not a finding against the case. */}
            <Row between align="center" wrap gap="sm">
              <Text variant="subheading">{gap.title}</Text>
              <Chip
                label={gap.severity === 'HIGH' ? 'Worth adding first' : 'Optional'}
                tone={gap.severity === 'HIGH' ? 'warn' : 'neutral'}
                size="sm"
              />
            </Row>
            <Text variant="bodySmall">{gap.question}</Text>
            <Text variant="caption" colorToken="textSecondary">{gap.suggestedAction}</Text>
            <Row gap="sm">
              <Button
                label="Add evidence"
                size="sm"
                variant="secondary"
                onPress={() => router.push({ pathname: '/case/[caseId]/upload', params: { caseId } })}
              />
            </Row>
          </Surface>
        ))}
      </Stack>
    ) : null}

    {unpromotedAssertions.length > 0 ? (
      <Stack gap="md">
        <Text variant="heading">Discovered from evidence</Text>
        {/*
          Not "formally verified". Adding a claim puts it in the list the next assessment
          weighs for and against; nothing here verifies anything, and the foot of the
          assessment says the app does not establish authenticity or a legal finding.
        */}
        <Text variant="bodySmall" colorToken="textSecondary">
          Statements read out of your records. Add one as a claim to have the next assessment weigh the evidence for and against it.
        </Text>
        {unpromotedAssertions.map((assertion) => {
          const tone =
            assertion.corroboration === 'CORROBORATED'
              ? 'ok'
              : assertion.corroboration === 'CONTRADICTED'
              ? 'danger'
              : 'neutral';
          const label =
            assertion.corroboration === 'CORROBORATED'
              ? 'Corroborated across sources'
              : assertion.corroboration === 'CONTRADICTED'
              ? 'Contradicted by status'
              : 'Single source';
          return (
            <Surface key={assertion.id} padding="md" style={{ gap: theme.spacing.sm }}>
              {/*
                The kind chip was a violet `ai` chip reading `TRANSACTION`. Two errors in one
                element: violet is reserved for content a model produced, and
                `runEvidenceIntelligence` is a deterministic pass over the extracted text; and
                the raw union member was going to the reader unmapped. `readableToken` is the
                fallback for a kind added to the union but not to the map.
              */}
              <Row between align="center" wrap gap="sm">
                <Chip
                  label={ASSERTION_KIND_LABELS[assertion.kind] ?? readableToken(assertion.kind)}
                  tone="neutral"
                  size="sm"
                />
                <Chip label={label} tone={tone} size="sm" />
              </Row>
              <Text variant="subheading">{assertion.statement}</Text>
              <Text variant="caption" colorToken="textSecondary">{assertion.detail}</Text>
              {assertion.citations.length > 0 ? (
                <CitationList citations={assertion.citations} workspace={workspace} caseId={caseId} />
              ) : null}
              <Row gap="sm">
                <Button
                  label={promotingId === assertion.id ? 'Adding…' : 'Add as a claim'}
                  size="sm"
                  disabled={mutator.busy || promotingId !== null}
                  onPress={() => void promoteAssertion(assertion)}
                />
              </Row>
            </Surface>
          );
        })}
      </Stack>
    ) : null}

    <AiSuggestionsSection workspace={workspace} caseId={caseId} />
  </Stack>;
}
