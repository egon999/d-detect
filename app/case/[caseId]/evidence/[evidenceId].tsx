import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { confirmEvidenceFields, deleteEvidence, linkEntities, reviewAiSuggestion, unlinkEntities } from '@data/mutations';
import { put } from '@data/repository';
import type { EntityRef, Extraction, Provenance } from '@domain/models';
import { PROCESSING_STATE_LABELS, RELATIONSHIP_LABELS, type RelationshipType } from '@domain/enums';
import { shortDigest } from '@domain/analysis/audit-chain';
import { latestCaseAnalysis } from '@domain/analysis/case-report';
import { CitationList } from '@features/analysis/case-analysis-panel';
import { confidenceBand, readStoredEvidenceFile, requestEvidenceProcessing, useRepository, useSession, type PrivateEvidenceFile } from '@services';
import { eraseOriginals } from '@services/erase';
import { mutationContext, useCaseRecord, useWorkspace } from '@services/use-case-store';
import { Button, Chip, CONFIDENCE_LABELS, Icon, IconButton, Notice, PaperSheet, ProvenanceValue, Row, routeParam, ScreenScroll, SlideUpIn, Surface, Text, TextField, formatBytes, readableError, useTheme } from '@ui';

const LINK_TYPES: RelationshipType[] = ['RELEVANT_TO_CLAIM', 'SUPPORTS', 'CONTRADICTS', 'ATTACHED_TO_EVENT'];
const timestamp = (milliseconds: number) => `${Math.floor(milliseconds / 60000)}:${Math.floor(milliseconds / 1000 % 60).toString().padStart(2, '0')}`;

/**
 * Every list-valued extraction field a person can correct: the ones whose entries carry an
 * `original` reading. Derived from the schema so a new such field cannot be added without the
 * compiler demanding a label for it below.
 */
type CorrectableFieldKey = { [K in keyof Extraction]: Extraction[K] extends ReadonlyArray<{ original: string }> ? K : never }[keyof Extraction];

/**
 * Reader-facing name for each correctable field. These replace labels that were previously
 * derived from the camelCase object key by regex, which surfaced code identifiers verbatim
 * ("invoiceNumbers" became "invoice Numbers"). Wording matches the compare screen's rows so a
 * field is called the same thing everywhere, and "Transaction reference" is preferred over
 * "Transaction ID" because a raw id is not what the field holds.
 */
const FIELD_LABELS: Record<CorrectableFieldKey, string> = {
  dates: 'Date',
  amounts: 'Amount',
  parties: 'Party',
  people: 'Person',
  organizations: 'Organisation',
  emails: 'Email address',
  phones: 'Phone number',
  invoiceNumbers: 'Invoice number',
  orderNumbers: 'Order number',
  transactionIds: 'Transaction reference',
  addresses: 'Address',
  keywords: 'Keyword',
};

/** The correctable fields this screen lists, in display order. Unchanged from the original set. */
const CORRECTION_FIELD_KEYS = ['dates', 'amounts', 'people', 'organizations', 'invoiceNumbers', 'transactionIds', 'orderNumbers'] as const satisfies readonly CorrectableFieldKey[];

/**
 * The model's contestability band in plain words. It rates how open to dispute a document's
 * contents look — missing terms, unclear dates, no counter-signature — not whether anyone is
 * in the wrong, and not a probability. Rendered only for a known band, so an unexpected
 * payload value can never reach the screen as a raw token.
 */
const CONTEST_RISK_LABELS: Record<'LOW' | 'MEDIUM' | 'HIGH', string> = { LOW: 'low', MEDIUM: 'moderate', HIGH: 'high' };
// Widened view of the map above, for looking up a payload value that is only a `string`.
const CONTEST_RISK_LOOKUP: Record<string, string | undefined> = CONTEST_RISK_LABELS;
function contestRiskLine(payload: Record<string, unknown>): string | null {
  const { disputeRisk, riskExplanation } = payload;
  if (typeof disputeRisk !== 'string' || typeof riskExplanation !== 'string') return null;
  const band = CONTEST_RISK_LOOKUP[disputeRisk];
  return band ? `How open to dispute this looks: ${band}. ${riskExplanation}` : null;
}

export default function EvidenceDetailScreen() {
  const params = useLocalSearchParams<{ caseId?: string | string[]; evidenceId?: string | string[]; segmentId?: string | string[] }>();
  const caseId = routeParam(params.caseId);
  const evidenceId = routeParam(params.evidenceId);
  const segmentId = routeParam(params.segmentId);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  // The paper material's ink, for the extracted passages further down. Read off the theme
  // rather than through `usePaper()` because this screen already holds a theme.
  const paper = theme.colors.paper;
  const { user } = useSession();
  const { repository } = useRepository();
  const { workspace, loading, refreshing, error, reload } = useWorkspace(user?.id ?? null, caseId ?? null);
  const caseRecord = useCaseRecord(workspace, caseId);
  const evidence = workspace.evidence.find(item => item.id === evidenceId && item.caseId === caseId && !item.deletedAt);
  const extraction = evidence?.extraction;
  const selectedSegment = extraction?.segments.find(segment => segment.id === segmentId);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [original, setOriginal] = useState<PrivateEvidenceFile | null>(null);
  const originalRef = useRef<PrivateEvidenceFile | null>(null);
  const alive = useRef(true);
  const currentEvidenceId = useRef(evidenceId);
  currentEvidenceId.current = evidenceId;
  const [showLink, setShowLink] = useState(false);
  const [target, setTarget] = useState<EntityRef | null>(null);
  const [linkType, setLinkType] = useState<RelationshipType>('RELEVANT_TO_CLAIM');
  const [reason, setReason] = useState('');
  const [correctionPath, setCorrectionPath] = useState('');
  const [correction, setCorrection] = useState('');
  const [showRemove, setShowRemove] = useState(false);
  const [visibleSegments, setVisibleSegments] = useState(10);
  const [showMetadata, setShowMetadata] = useState(false);
  const report = latestCaseAnalysis(workspace, caseId ?? '');
  const citations = useMemo(() => report?.claims.flatMap(assessment => assessment.citations).filter(citation => citation.evidenceId === evidenceId) ?? [], [report, evidenceId]);
  const links = workspace.relationships.filter(link => link.caseId === caseId && link.origin === 'USER' && (link.from.id === evidenceId || link.to.id === evidenceId));
  // This source's AI readings: model proposals about this document, for review. A
  // decision still waiting comes ahead of one already made, and within each group the
  // newest proposal is first.
  const aiReadings = workspace.aiSuggestions
    .filter(item => item.caseId === caseId && item.evidenceId === evidenceId && item.kind === 'FIELD_EXTRACTION')
    .sort((a, b) => (a.status === 'SUGGESTED' ? 0 : 1) - (b.status === 'SUGGESTED' ? 0 : 1) || b.createdAt - a.createdAt);
  const jobs = workspace.processingJobs.filter(job => job.evidenceId === evidenceId).sort((a, b) => b.createdAt - a.createdAt);
  const processing = evidence?.state === 'PROCESSING' || jobs.some(job => ['QUEUED', 'PROCESSING'].includes(job.state));
  /**
   * The record exists and its file does not.
   *
   * A note carries its text on the record itself and never has a stored original, so it is
   * excluded. For everything else this is the one condition under which no button on this
   * screen can do anything: there are no bytes to read, and a retry would read nothing.
   * Keyed on the absent path rather than on a state, because the states that can hold this
   * shape are `UPLOADING` (the upload is still running, or the process that was running it
   * is gone) and `FAILED` (it was abandoned, and said so) — and the offer is the same either way.
   */
  const missingOriginal = !!evidence && !evidence.storagePath && evidence.kind !== 'NOTE';
  /**
   * The extracted values a person can correct, each carrying the provenance it was read with.
   *
   * The provenance was always here and was always discarded: every field entry in `Extraction`
   * extends `provenanceSchema`, so each of these values already knows whether it came off a text
   * layer, out of an image, or from a model — and this screen rendered all of them in the same
   * plain sans as the prose around them. Keeping it lets `ProvenanceValue` do the one job the
   * product is built on: showing what the document said as distinct from what anyone concluded.
   *
   * `documentType` is the one entry with no stored provenance record, because it is not a
   * per-value extraction. It is written by `classifyDocumentType` in the deterministic pipeline,
   * so `DETERMINISTIC` is a statement of fact rather than a guess — and the alternative, leaving
   * it null, would have `ProvenanceValue` describe it as something the user typed, which is the
   * one wrong answer.
   */
  const correctionFields: ReadonlyArray<{ path: string; label: string; value: string; provenance: Provenance | null; caveat: string | null }> = extraction && evidence ? [
    { path: 'documentType', label: 'Document type', value: extraction.documentType, provenance: { evidenceId: evidence.id, method: 'DETERMINISTIC' }, caveat: null },
    ...CORRECTION_FIELD_KEYS.flatMap(key => {
      /*
        Sifted for holes before it is mapped, because this list is not guaranteed to be dense.

        `effectiveExtraction` layers a person's corrections over the machine extraction by field
        path, and a path is an index - `phones.3` means the fourth phone number the extractor
        found on the run that produced it. Reprocessing replaces the extraction and deliberately
        keeps the corrections (`mutations.ts` leaves `confirmedFields` untouched), so a second,
        cleaner pass that finds fewer phone numbers leaves that correction pointing past the end
        of the new list. `effectiveExtraction` handles it by assigning the carried-over value to
        its original position, which is the right call - the position *is* the path, so moving
        the value would silently re-key it to a field it is not about - but it builds that array
        by writing to the position, and every position below it the new extraction did not fill
        stays a hole. Spreading a sparse array yields `undefined` at each hole rather than
        skipping it, so `field.original` below threw during render.

        That crash was not recoverable from inside the app: the only control that can delete the
        offending correction is on this screen, so the screen a person had to reach to fix it was
        the screen that died on it. The root cause is a write-side one and is being fixed there.
        This guard is what keeps a malformed map from taking the screen down in the meantime, and
        it is worth keeping afterwards - a render pass has no business trusting a list to be
        dense, and a field that no longer exists is a thing to omit rather than to throw on.

        The paths keep coming from the original index, never from the position in the sifted
        list, so nothing here can introduce the re-keying that skipping the hole avoids.
      */
      const present = extraction[key].flatMap((field, index) =>
        (field as typeof field | undefined) === undefined ? [] : [{ field, index }],
      );
      // Number only when there is more than one of a field, so a lone amount reads "Amount"
      // rather than "Amount 1", which would imply a second the reader should look for. Counted
      // over what is actually shown: numbering by the raw index would print "Amount 1" beside
      // "Amount 4" and send the reader looking for two that are not there.
      return present.map(({ field, index }, ordinal) => ({
        path: `${key}.${index}`,
        label: present.length > 1 ? `${FIELD_LABELS[key]} ${ordinal + 1}` : FIELD_LABELS[key],
        value: field.original,
        // The entry *is* the provenance record — `textFieldSchema` and the rest extend it.
        provenance: field satisfies Provenance,
        // Only a date carries `ambiguous`, and it is the one caveat a reader cannot work out
        // for themselves: "04/05" is a real date either way, and which one it is changes the
        // case. Said here rather than in a notice at the bottom, next to the value it is about.
        caveat: 'ambiguous' in field && field.ambiguous ? 'Written in a form that reads as two different dates. Check the original before relying on it.' : null,
      }));
    }),
  ] : [];

  useEffect(() => { alive.current = true; setOriginal(null); return () => { alive.current = false; void originalRef.current?.release(); originalRef.current = null; }; }, [evidenceId]);
  function closeOriginal() { void originalRef.current?.release(); originalRef.current = null; setOriginal(null); }
  /**
   * Runs one of this screen's actions and reports a failure a person can act on.
   *
   * `fallback` is per-caller rather than one house sentence because the seven things this wraps
   * fail for unrelated reasons, and "The action could not be completed" — what every one of them
   * used to say once the raw message was unusable — tells a reader nothing about which of the
   * seven it was. `readableError` keeps a message the domain layer wrote as a sentence (the
   * sharing check below raises one) and replaces a provider string or a `TypeError` with this.
   */
  async function action(work: () => Promise<void>, fallback: string) {
    setBusy(true); setFailure(null); setNotice(null);
    try { await work(); } catch (caught) { setFailure(readableError(caught, fallback)); }
    finally { setBusy(false); }
  }
  async function openOriginal() {
    if (!evidence?.storagePath || !user) return;
    await action(async () => {
      // The owner-scoped read, not the session-scoped one: the original is on this
      // device whenever it was added here, including in a local (signed-out) workspace.
      const file = await readStoredEvidenceFile(user.id, evidence.storagePath!);
      if (!alive.current || currentEvidenceId.current !== evidenceId) { await file.release(); return; }
      void originalRef.current?.release(); originalRef.current = file; setOriginal(file);
    }, 'The original file could not be opened. It may have been moved or removed from this device.');
  }
  async function retry() {
    if (!caseId || !evidenceId || !user) return;
    await action(async () => {
      await requestEvidenceProcessing(caseId, evidenceId, { repository, ownerId: user.id }); reload();
      setNotice('The source was processed on this device. The result is saved to the case.');
    }, 'This source could not be processed. Check that the original file still opens, then try again.');
  }
  async function saveLink() {
    if (!user || !caseId || !evidence || !target || !reason.trim()) return;
    await action(async () => {
      const mutation = linkEntities(workspace, mutationContext(user.id), caseId, { from: { kind: 'evidence', id: evidence.id }, to: target, type: linkType, note: reason.trim(), material: false, origin: 'USER' });
      await repository.commit(user.id, mutation.changes); reload(); setShowLink(false); setReason(''); setTarget(null);
      setNotice('Your relationship was saved as a user assertion. Run a case assessment to compare the sources.');
    }, 'Your relationship could not be saved. Nothing was changed — try again.');
  }
  async function saveCorrection() {
    if (!user || !evidence || !correctionPath || !correction.trim()) return;
    await action(async () => {
      const mutation = confirmEvidenceFields(workspace, mutationContext(user.id), evidence.id, { [correctionPath]: correction.trim() });
      await repository.commit(user.id, mutation.changes); reload(); setCorrectionPath(''); setCorrection('');
      setNotice('Your correction is saved separately. The original file and extracted passage are preserved.');
    }, 'Your correction could not be saved. The extracted value is unchanged — try again.');
  }
  async function remove() {
    if (!user || !evidence) return;
    await action(async () => {
      /**
       * Commit the tombstone, then take the bytes.
       *
       * This order is the whole point. `deleteEvidence` keeps the row and stamps `deletedAt`,
       * which the audit trail needs, but every read path filters tombstones out and there is no
       * restore anywhere in the app — so once the commit lands, the original is a file no screen
       * can reach and no feature will ask for again. On a phone that means a bank statement the
       * user believes they deleted is still in the app's private directory.
       *
       * Shredding first would be the version that loses data: a commit that then failed would
       * leave a live record pointing at bytes that no longer exist, and the user would see the
       * document still listed and be unable to open it. `eraseOriginals` deliberately does not
       * throw, because the deletion the user asked for has already succeeded by the time it runs.
       */
      await repository.commit(user.id, deleteEvidence(workspace, mutationContext(user.id), evidence.id).changes);
      await eraseOriginals([evidence.storagePath]);
      setShowRemove(false); router.back();
    }, 'This evidence could not be removed. It is still attached to the case — try again.');
  }
  async function reviewReading(suggestionId: string, status: 'ACCEPTED' | 'REJECTED') {
    if (!user) return;
    await action(async () => {
      // Review state and an audit entry only. A suggested value becomes real through the
      // corrections below, never through accepting the suggestion.
      await repository.commit(user.id, reviewAiSuggestion(workspace, mutationContext(user.id), suggestionId, status).changes);
      reload();
    }, 'Your decision could not be recorded. The reading is unchanged — try again.');
  }
  const panel = { gap: 14 };
  if (!evidence) return <ScreenScroll title="Evidence" back><Notice title={loading ? 'Loading this document' : 'This document is not in the case'} message={loading ? 'Fetching the case this document belongs to.' : readableError(error, 'It may have been removed, or it belongs to a different case.')} tone={error ? 'danger' : 'info'} /><Button label="Try again" onPress={reload} /></ScreenScroll>;

  return <ScreenScroll title={evidence.title} subtitle={caseRecord?.title} back refreshing={refreshing} onRefresh={reload}>
    {/* One entrance for the column, a beat after the masthead. Not a `Stagger`: most of
        these blocks are conditional on processing state, so a cascade would re-time itself
        as jobs finish, and positional keys would replay entrances under a new notice. */}
    <SlideUpIn delay={theme.motion.stagger}>
      <View style={{ gap: 22 }}>
        {failure || error ? <Notice tone="danger" title="That did not work" message={failure ?? readableError(error, 'This document could not be refreshed. Check your connection and try again.')} /> : null}
        {notice ? <Notice tone="info" title="Saved" message={notice} /> : null}
        {selectedSegment ? <Surface padding="lg" style={{ ...panel, borderWidth: 2, borderColor: theme.colors.accent }}>
          <Text variant="subheading">Cited source passage</Text>
          <Text selectable>{selectedSegment.text}</Text>
          <Text variant="caption" colorToken="textSecondary">{selectedSegment.page ? `Page ${selectedSegment.page} | ` : ''}{selectedSegment.startMs !== undefined ? `${timestamp(selectedSegment.startMs)}${selectedSegment.endMs !== undefined ? ` to ${timestamp(selectedSegment.endMs)}` : ''} | ` : ''}{selectedSegment.method === 'MANUAL' ? 'User-provided statement' : 'Extracted content; check against the original'}</Text>
        </Surface> : segmentId ? <Notice title="The cited passage changed" message="This segment is no longer in the current extraction. Review the original and request an updated assessment." tone="warn" /> : null}
        <Surface padding="lg" style={panel}>
          <Row justify="space-between" align="center" style={{ flexWrap: 'wrap', gap: 8 }}>
            <Chip
              label={PROCESSING_STATE_LABELS[evidence.state]}
              tone={evidence.state === 'EXTRACTED' || evidence.state === 'ANALYZED' || evidence.state === 'CONFIRMED' ? 'ok' : evidence.state === 'FAILED' ? 'danger' : 'accent'}
              size="sm"
            />
            {evidence.sha256 ? (
              <Row align="center" gap="xs">
                <Icon name="shield-check" size={14} color={theme.tone('ok').fg} />
                <Text variant="monoSmall" selectable>
                  SHA-256: {shortDigest(evidence.sha256, 6)}
                </Text>
              </Row>
            ) : null}
          </Row>

          <Text variant="bodySmall" colorToken="textSecondary">
            {evidence.fileName ?? 'Typed statement'}{evidence.sizeBytes !== null ? ` · ${formatBytes(evidence.sizeBytes)}` : ''}
            {evidence.sourceLabel ? ` · Source: ${evidence.sourceLabel}` : ''}
          </Text>
          {evidence.capturedAt ? <Text variant="caption" colorToken="textTertiary">Recorded: {evidence.capturedAt}</Text> : null}
          {evidence.note ? <Text style={{ marginTop: 2 }}>{evidence.note}</Text> : null}

          {!missingOriginal && (evidence.failureReason || jobs[0]?.state === 'FAILED') ? (
            <Notice tone="warn" title="Processing could not finish" message={readableError(evidence.failureReason || jobs[0]?.lastError, 'Check that the original file still opens, then process it again.')} />
          ) : null}
          {processing ? <Text colorToken="textSecondary">Processing on-device. Results will appear here once ready.</Text> : null}
          {missingOriginal ? <Notice tone="warn" title="Original file not stored" message="This entry was created but its file did not finish uploading. Re-add the file to enable extraction." /> : null}

          <Row gap="sm" style={{ flexWrap: 'wrap', marginTop: 4 }}>
            {evidence.storagePath ? (
              <Button label="View original" variant="primary" icon="eye-outline" loading={busy} onPress={() => void openOriginal()} />
            ) : null}
            {missingOriginal ? (
              <Button label="Add original file" onPress={() => router.push({ pathname: '/case/[caseId]/upload', params: { caseId: evidence.caseId } })} />
            ) : (
              <Button label={processing ? 'Processing…' : extraction ? 'Reprocess' : 'Process'} variant="secondary" icon="refresh" disabled={busy || processing} onPress={() => void retry()} />
            )}
            <Button label="Connect" variant="ghost" icon="link-variant" onPress={() => setShowLink(true)} />
          </Row>
        </Surface>
        {extraction?.limitations.length ? <Notice tone="warn" title="Reading limitations" message={extraction.limitations.join('\n')} /> : null}
        {aiReadings.length ? (
          <Surface padding="lg" style={panel}>
            <Row align="center" gap="sm">
              <Icon name="brain" size={16} color={theme.colors.accent} />
              <Text variant="subheading">Model Extraction Proposal</Text>
            </Row>
            <Text variant="caption" colorToken="textSecondary">
              Field suggestions extracted by model analysis. Confirm or edit below.
            </Text>
            {aiReadings.map(item => {
              const contestRisk = contestRiskLine(item.payload);
              return (
                <View key={item.id} style={{ gap: 8 }}>
                  {item.status !== 'SUGGESTED' ? <Chip label={item.status === 'ACCEPTED' ? 'Accepted' : 'Dismissed'} tone="neutral" size="sm" /> : null}
                  <Text variant="bodySmall">{item.summary}</Text>
                  {contestRisk ? <Text variant="bodySmall" colorToken="textSecondary">{contestRisk}</Text> : null}
                  <Text variant="caption" colorToken="textSecondary">
                    {item.confidence === null ? 'No model confidence score reported' : `Confidence: ${CONFIDENCE_LABELS[confidenceBand(item.confidence)]}`}
                  </Text>
                  {item.status === 'SUGGESTED' ? (
                    <Row gap="sm" style={{ flexWrap: 'wrap' }}>
                      <Button label="Accept" size="sm" disabled={busy} onPress={() => void reviewReading(item.id, 'ACCEPTED')} />
                      <Button label="Dismiss" size="sm" variant="secondary" disabled={busy} onPress={() => void reviewReading(item.id, 'REJECTED')} />
                    </Row>
                  ) : null}
                </View>
              );
            })}
          </Surface>
        ) : null}
        <View style={panel}>
          <Text variant="heading">Extracted content</Text>
          {!extraction?.sourceText ? <Text colorToken="textSecondary">No readable content is available yet. Processing results and any limitations will appear here.</Text> : <>
            <Text variant="bodySmall" colorToken="textSecondary">The passages below preserve what was extracted. OCR and transcription can misread content; compare significant details with the original.</Text>
            {extraction.segments.length ? extraction.segments.slice(0, visibleSegments).map((segment, index) => <PaperSheet key={segment.id} emphasis={segment.id === segmentId ? 'accent' : null}>
              <Text variant="monoSmall" style={{ color: paper.meta }}>{segment.page ? `Page ${segment.page}` : `Passage ${index + 1}`}{segment.startMs !== undefined ? ` | ${timestamp(segment.startMs)}${segment.endMs !== undefined ? ` to ${timestamp(segment.endMs)}` : ''}` : ''}</Text>
              <Text variant="mono" selectable style={{ color: paper.text }}>{segment.text}</Text>
            </PaperSheet>) : <PaperSheet><Text variant="mono" selectable style={{ color: paper.text }}>{extraction.sourceText}</Text></PaperSheet>}
            {extraction.segments.length > visibleSegments ? <Button variant="secondary" label={`Show more passages (${visibleSegments} of ${extraction.segments.length})`} onPress={() => setVisibleSegments(value => value + 20)} /> : null}
          </>}
        </View>
        {citations.length ? <View style={panel}><Text variant="heading">Used in the saved assessment</Text><CitationList citations={citations} workspace={workspace} caseId={evidence.caseId} /></View> : null}
        {correctionFields.length ? <Surface padding="lg" style={panel}>
          <Text variant="heading">Review extracted details</Text>
          <Text colorToken="textSecondary">Each value shows how it was read. Correcting one records your reading alongside it — the original file and the extracted passage are never changed.</Text>
          {correctionFields.slice(0, 50).map(field => {
            const confirmed = evidence.confirmedFields[field.path];
            return <View key={field.path} style={{ gap: 6 }}>
              {/*
                Once a person has corrected a value, *their* reading is the value and the
                document's becomes the "as written" line beneath it — with the rule and the
                typeface switching to the human channel, because that is now what this is. The
                previous version showed the machine's reading as the value and the correction as
                a footnote under it, which put the app's guess above the user's answer on the one
                screen built for disagreeing with the app.
              */}
              <ProvenanceValue
                label={field.label}
                value={confirmed ?? field.value}
                originalValue={confirmed ? field.value : null}
                provenance={confirmed ? { evidenceId: evidence.id, method: 'MANUAL' } : field.provenance}
                caveat={confirmed ? null : field.caveat}
              />
              <Button label={confirmed ? `Change your ${field.label.toLowerCase()}` : `Correct ${field.label.toLowerCase()}`} variant="ghost" size="sm" onPress={() => { setCorrectionPath(field.path); setCorrection(confirmed ?? field.value); }} />
            </View>;
          })}
          {correctionPath ? <View style={panel}><TextField label="Your corrected reading" value={correction} onChangeText={setCorrection} maxLength={600} /><Button label="Save correction" disabled={!correction.trim() || busy || processing} loading={busy} onPress={() => void saveCorrection()} /><Button variant="ghost" label="Cancel" onPress={() => setCorrectionPath('')} /></View> : null}
        </Surface> : null}
        {links.length ? <View style={panel}><Text variant="heading">Relationships you recorded</Text>{links.map(link => <Surface key={link.id} padding="lg" style={panel}>
          <Text variant="subheading">{RELATIONSHIP_LABELS[link.type]}</Text><Text>{link.note || 'No explanation was recorded for this link.'}</Text><Text variant="caption" colorToken="textSecondary">User assertion</Text>
          <Button label="Remove this link" variant="ghost" size="sm" onPress={() => void action(async () => { if (user) { await repository.commit(user.id, unlinkEntities(workspace, mutationContext(user.id), link.id).changes); reload(); } }, 'That link could not be removed. It is still on the document — try again.')} />
        </Surface>)}</View> : null}
        <Button label={showMetadata ? 'Hide file details' : 'File details'} variant="ghost" onPress={() => setShowMetadata(value => !value)} />
        {showMetadata ? <Surface padding="lg" style={panel}><Text variant="caption">Added {new Date(evidence.createdAt).toLocaleString()}</Text>{evidence.sha256 ? <><Text variant="caption">Original file SHA-256</Text><Text variant="monoSmall" selectable>{evidence.sha256}</Text><Text variant="caption" colorToken="textSecondary">Identifies the stored bytes; it does not prove the record is authentic.</Text></> : null}</Surface> : null}
        <Button label="Remove evidence from case" variant="ghost" disabled={processing || busy} onPress={() => setShowRemove(true)} />
      </View>
    </SlideUpIn>
    <Modal visible={Boolean(original)} animationType="slide" onRequestClose={closeOriginal}>
      <View style={[styles.modal, { backgroundColor: theme.colors.canvas, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}><Row justify="space-between"><Text variant="heading">Original file</Text><IconButton icon="close" accessibilityLabel="Close original file" onPress={closeOriginal} /></Row>
        {original && evidence.kind === 'IMAGE' ? <Image source={{ uri: original.uri }} resizeMode="contain" style={{ flex: 1, width: '100%', minHeight: 300 }} accessibilityLabel={`Original ${evidence.title}`} /> : null}
        {original && Platform.OS === 'web' && evidence.kind === 'PDF' ? React.createElement('iframe', { title: `Original ${evidence.title}`, src: original.uri, sandbox: '', style: { border: 0, width: '100%', flex: 1, minHeight: 420 } }) : null}
        {original && Platform.OS === 'web' && (evidence.kind === 'AUDIO' || evidence.kind === 'VIDEO') ? React.createElement(evidence.kind === 'AUDIO' ? 'audio' : 'video', { controls: true, src: original.uri, style: { width: '100%', maxHeight: '75vh' } }) : null}
        {original ? Platform.OS === 'web' ? React.createElement('a', { href: original.uri, download: evidence.fileName ?? 'evidence', style: { color: theme.colors.accent, padding: 16 } }, 'Download original file') : <Button label="Open or share original file" onPress={() => void action(async () => { const sharing = await import('expo-sharing'); if (!(await sharing.isAvailableAsync())) throw new Error('File sharing is unavailable on this device.'); await sharing.shareAsync(original.uri, { mimeType: evidence.mimeType ?? undefined }); }, 'The original file could not be shared from this device.')} /> : null}
        {failure ? <Notice title="The original file could not be opened" message={failure} tone="danger" /> : null}
      </View>
    </Modal>
    <Modal visible={showLink} animationType="slide" onRequestClose={() => setShowLink(false)}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.canvas, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}><Row justify="space-between"><Text variant="heading">Connect this source</Text><IconButton icon="close" accessibilityLabel="Close relationship editor" onPress={() => setShowLink(false)} /></Row>
      <Text colorToken="textSecondary">Record why this source matters. This is your interpretation, separate from the saved analysis.</Text>
      {workspace.claims.filter(item => !item.deletedAt).map(item => <Button key={item.id} variant={target?.id === item.id ? 'primary' : 'secondary'} label={item.statement} onPress={() => { setTarget({ kind: 'claim', id: item.id }); setLinkType('RELEVANT_TO_CLAIM'); }} />)}
      {workspace.events.filter(item => !item.deletedAt).map(item => <Button key={item.id} variant={target?.id === item.id ? 'primary' : 'secondary'} label={item.title} onPress={() => { setTarget({ kind: 'event', id: item.id }); setLinkType('ATTACHED_TO_EVENT'); }} />)}
      {!workspace.claims.length && !workspace.events.length ? <Text>Add a claim or event to the case first.</Text> : null}
      <Row gap="sm" style={{ flexWrap: 'wrap' }}>{LINK_TYPES.filter(type => target?.kind === 'event' ? type === 'ATTACHED_TO_EVENT' : type !== 'ATTACHED_TO_EVENT').map(type => <Button key={type} label={RELATIONSHIP_LABELS[type]} size="sm" variant={linkType === type ? 'primary' : 'secondary'} onPress={() => setLinkType(type)} />)}</Row>
      <TextField label="Why are these connected?" value={reason} onChangeText={setReason} multiline maxLength={2000} />
      {failure ? <Notice tone="danger" title="Could not save link" message={failure} /> : null}<Button label="Save relationship" disabled={!target || !reason.trim() || busy} onPress={() => void saveLink()} />
    </ScrollView></Modal>
    <Modal visible={showRemove} transparent onRequestClose={() => setShowRemove(false)}><View style={[styles.overlay, { backgroundColor: theme.colors.overlay }]}><Surface padding="lg" style={panel}><Text variant="heading">Remove this evidence?</Text><Text>It stops contributing to new assessments, and the original file is deleted from this device. The record stays in the case history, so earlier assessments still show what they were based on.</Text><Text variant="bodySmall" colorToken="textSecondary">This cannot be undone.</Text>{failure ? <Notice title="Evidence could not be removed" message={failure} tone="danger" /> : null}<Button label="Remove from case" variant="danger" onPress={() => void remove()} disabled={busy} loading={busy} /><Button label="Keep evidence" variant="secondary" onPress={() => setShowRemove(false)} /></Surface></View></Modal>
  </ScreenScroll>;
}
const styles = StyleSheet.create({ modal: { flexGrow: 1, padding: 24, gap: 20 }, overlay: { flex: 1, padding: 24, justifyContent: 'center' } });
