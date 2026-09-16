/**
 * Reading a saved assessment back out of the store.
 *
 * ## Why every read re-checks its own foundations
 *
 * A {@link CaseAnalysis} is a snapshot. It was written against the evidence and claims as
 * they stood at one moment, and both can change afterwards — a document is deleted, a claim
 * is reworded, a source is reprocessed and its offsets move. Nothing rewrites the stored
 * assessment when that happens, because an assessment that silently edited itself would be
 * worse than a stale one: the reader would have no way to tell that the ground had shifted.
 *
 * So the functions here verify at display time rather than trusting what was written. A
 * citation is resolved against the current source text and withheld if it no longer matches;
 * an assessment is attached to a claim only while the claim still says what it said; and the
 * whole report is marked stale when anything in the case has been touched since it was made.
 *
 * ## None of this decides whether the evidence is any good
 *
 * These are integrity checks on the app's own records, not on the documents. A citation that
 * resolves cleanly proves the passage is really in the file that was uploaded. It says nothing
 * about whether that file is genuine, complete, or honest.
 */

import type { CaseAnalysis, CaseCitation, Claim, Workspace } from '../models';

/**
 * The saved assessment for a claim, or null when there is not one for *this* wording.
 *
 * The statement is compared, not just the id. A user who edits a claim after it was assessed
 * has asked a different question, and showing the old verdict under the new wording would
 * attribute a conclusion to a statement that was never examined. Owner and case are checked
 * for the same reason a query is scoped: a report must never describe someone else's claim.
 */
export function currentClaimAssessment(report: CaseAnalysis | null, claim: Claim) {
  if (!report) return null;
  if (report.caseId !== claim.caseId || report.ownerId !== claim.ownerId || claim.deletedAt) return null;

  return (
    report.claims.find((item) => item.claimId === claim.id && item.statement === claim.statement) ?? null
  );
}

/**
 * Re-reads a citation against the source it points at.
 *
 * Returns null — meaning "do not present this as current" — when the source is gone, when it
 * belongs to a case that is gone, when the cited segment no longer exists, or when the text at
 * the recorded offsets is not the quotation that was stored. That last check is the important
 * one: offsets survive reprocessing, but the characters under them may not, and a quotation
 * rendered from stale offsets would put words in a document's mouth.
 */
export function resolveCitation(workspace: Workspace, citation: CaseCitation) {
  const evidence = workspace.evidence.find((item) => item.id === citation.evidenceId && !item.deletedAt);
  if (!evidence) return null;

  const caseIsLive = workspace.cases.some(
    (item) => item.id === evidence.caseId && item.ownerId === evidence.ownerId && !item.deletedAt,
  );
  if (!caseIsLive) return null;

  const segment = evidence.extraction?.segments.find((item) => item.id === citation.segmentId);
  if (!segment) return null;

  // The quotation has to sit inside the segment it claims to come from, and the source text
  // at those offsets has to still read the same. Either failing means the document was
  // reprocessed or replaced under a citation that was written against the old text.
  if (citation.startOffset < segment.startOffset || citation.endOffset > segment.endOffset) return null;

  const text = evidence.extraction?.sourceText ?? '';
  if (text.slice(citation.startOffset, citation.endOffset) !== citation.quote) return null;

  return { evidence, segment };
}

/** The most recent assessment for a case, or null when it has never been assessed. */
export function latestCaseAnalysis(workspace: Workspace, caseId: string): CaseAnalysis | null {
  const owner = workspace.cases.find((item) => item.id === caseId && !item.deletedAt)?.ownerId;
  if (!owner) return null;

  return (
    workspace.caseAnalyses
      .filter((item) => item.caseId === caseId && item.ownerId === owner)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

/**
 * How many distinct sources actually stand behind an assessment, in a sentence.
 *
 * ## Distinct, not counted
 *
 * Sources are keyed by file hash where there is one, so the same document cited eight times —
 * or uploaded twice under two names — counts once. A raw citation count would let a single
 * screenshot read as eight corroborating sources, which is the specific way this number could
 * mislead someone into thinking a claim is well supported.
 *
 * ## The warning is sticky per source
 *
 * If *any* passage cited from a document was read by OCR or by a model, that document carries
 * the "check it against the original" warning. It is accumulated rather than overwritten:
 * earlier this recorded only the last citation seen for each source, so an OCR passage
 * followed by a deterministic one from the same file silently cleared the warning — the
 * reader was told nothing needed checking precisely when something did.
 *
 * ## It is a count, and it says so
 *
 * Two documents agreeing are not two independent witnesses; they may share an author, a
 * template or an origin. The closing sentence refuses that inference rather than leaving the
 * number to imply it.
 */
export function evidenceBasis(workspace: Workspace, citations: CaseCitation[]): string {
  const sources = new Map<string, { modeled: boolean; statement: boolean }>();

  for (const citation of citations) {
    const resolved = resolveCitation(workspace, citation);
    if (!resolved) continue;

    const { evidence, segment } = resolved;

    // A hash identifies a file across re-uploads. A typed statement has no file, so it is
    // keyed by its own text; anything else with no hash falls back to its record id.
    const key = evidence.sha256 || (evidence.kind === 'NOTE' ? `statement:${evidence.note}` : evidence.id);

    const machineRead = segment.method === 'AI' || segment.method === 'OCR';
    const existing = sources.get(key);

    sources.set(key, {
      modeled: (existing?.modeled ?? false) || machineRead,
      statement: evidence.kind === 'NOTE',
    });
  }

  if (sources.size === 0) return 'No checkable source passage supports this assessment.';

  const entries = [...sources.values()];
  const notes = entries.filter((source) => source.statement).length;
  const modeled = entries.some((source) => source.modeled);

  const countPhrase = `${sources.size} distinct cited ${sources.size === 1 ? 'source' : 'sources'}`;
  const notePhrase = notes
    ? `, including ${notes} user ${notes === 1 ? 'statement' : 'statements'}`
    : '';
  const machinePhrase = modeled ? 'OCR or transcription requires checking against the original. ' : '';

  return `${countPhrase}${notePhrase}. ${machinePhrase}Source independence and authenticity are not established by this count.`;
}

/**
 * Whether the case has moved on since this assessment was made.
 *
 * Any touched record in the case counts — evidence, claims, or the case itself. The comparison
 * is against `createdAt` rather than `updatedAt` because the assessment describes the state of
 * the case at the moment it was generated.
 */
export function reportIsStale(workspace: Workspace, report: CaseAnalysis): boolean {
  const belongsToCase = (item: { id: string } | { caseId: string }): boolean =>
    'caseId' in item ? item.caseId === report.caseId : item.id === report.caseId;

  return [...workspace.evidence, ...workspace.claims, ...workspace.cases].some(
    (item) => belongsToCase(item) && item.updatedAt > report.createdAt,
  );
}

/** Assessment outcomes as a reader sees them. Never show the stored value. */
export const ASSESSMENT_LABELS = {
  SUPPORTED: 'Supported',
  PARTIALLY_SUPPORTED: 'Partially supported',
  CONTRADICTED: 'Contradicted',
  DISPUTED: 'Disputed',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
  UNRESOLVED: 'Unresolved',
} as const;
