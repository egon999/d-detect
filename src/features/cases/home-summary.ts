/**
 * The one sentence the home screen says about a case.
 *
 * ## Why the outcome words are not written here
 *
 * They were, and it printed "2 undefined". The module kept its own six-key object of
 * lowercase outcome words and reached into it with `labels[status as keyof typeof labels]` —
 * a cast, which is the compiler being told to stop checking the one thing it was there to
 * check. Any assessment status that was not one of those six literals therefore resolved to
 * `undefined` and went straight into the interpolated sentence on the app's first screen,
 * with no type error and no runtime guard anywhere between the store and the reader.
 *
 * `ASSESSMENT_LABELS` — in `@domain/analysis/case-report`, a module this file already imports
 * from, carrying the docblock "never show the stored value" — is the authority for what these
 * outcomes are called. It is keyed by `ClaimAssessment['status']`, so indexing it with a
 * status needs no cast and the compiler proves the lookup total: adding a seventh outcome to
 * the schema is a build failure here rather than a word missing from a sentence on screen.
 */

import { ASSESSMENT_LABELS, reportIsStale, resolveCitation } from '@domain/analysis/case-report';
import type { Case, CaseAnalysis, ClaimAssessment, Workspace } from '@domain/models';

export interface HomeSummary {
  message: string;
  detail: string | null;
  report: CaseAnalysis | null;
  stale: boolean;
}

type AssessmentStatus = ClaimAssessment['status'];

/**
 * The outcomes whose sentence-start label does not survive being dropped mid-sentence.
 *
 * "Insufficient evidence" is a heading; "1 with insufficient evidence" is the same fact in a
 * list of counts. Everything else lowercases cleanly, so only the exception is stated —
 * `Partial`, so this cannot become a second full copy of the vocabulary by accretion.
 */
const MID_SENTENCE: Partial<Record<AssessmentStatus, string>> = {
  INSUFFICIENT_EVIDENCE: 'with insufficient evidence',
};

/** One outcome, worded for the middle of a sentence. Total by construction. */
function assessmentPhrase(status: AssessmentStatus): string {
  return MID_SENTENCE[status] ?? ASSESSMENT_LABELS[status].toLowerCase();
}

/**
 * How many claims came out at each outcome.
 *
 * Insertion-ordered rather than sorted, so the phrase is stable across renders: a list of
 * counts that reorders itself between two identical reviews reads as the numbers changing.
 */
function assessmentTally(claims: readonly ClaimAssessment[]): string {
  const counts = new Map<AssessmentStatus, number>();
  for (const claim of claims) counts.set(claim.status, (counts.get(claim.status) ?? 0) + 1);
  return [...counts].map(([status, count]) => `${count} ${assessmentPhrase(status)}`).join(', ');
}

/** Summarize the saved assessment, never infer a verdict from absence of rule findings. */
export function summarizeCase(record: Case, workspace: Workspace): HomeSummary {
  const belongs = (item: { caseId: string; ownerId: string }) => item.caseId === record.id && item.ownerId === record.ownerId;
  const evidence = workspace.evidence.filter((item) => belongs(item) && item.deletedAt === null);
  const claims = workspace.claims.filter((item) => belongs(item) && item.deletedAt === null);
  const report = workspace.caseAnalyses.filter(belongs).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  const activeJob = workspace.processingJobs.filter(belongs).find((job) => job.state === 'QUEUED' || job.state === 'PROCESSING');
  const citations = report ? [...report.claims, ...report.agreements, ...report.contradictions, ...report.timeline].flatMap((item) => item.citations) : [];
  const stale = Boolean(report && (reportIsStale(workspace, report) || citations.some((citation) => !resolveCitation(workspace, citation))));
  if (activeJob) return { report, stale, message: activeJob.evidenceId ? 'Evidence processing is underway.' : 'Case analysis is underway.', detail: 'Open the case to see how far it has got.' };
  if (report) {
    const coverage = `${report.coverage.processedEvidence} of ${report.coverage.totalEvidence} evidence sources included${report.coverage.truncated ? '; coverage is incomplete' : ''}.`;
    if (stale) return { report, stale, message: 'The case changed after its latest review.', detail: `${coverage} Check it again before relying on what that review says.` };
    const tally = assessmentTally(report.claims);
    if (!tally) return { report, stale, message: 'The latest review did not reach an outcome on any claim.', detail: `${coverage} Open the case to read what it could not settle.` };
    return { report, stale, message: `Latest claim review: ${tally}.`, detail: `${coverage} Open the case to read the quotes each outcome rests on.` };
  }
  if (!claims.length) return { report, stale, message: 'What should this case help you check?', detail: 'Add a claim, then attach a document that may support or contradict it.' };
  if (!evidence.length) return { report, stale, message: 'Your claim is ready for evidence.', detail: 'Add a screenshot, document, recording or written account relevant to the claim.' };
  const ready = evidence.filter((item) => item.extraction?.segments.length);
  if (ready.length) return { report, stale, message: `${ready.length} evidence ${ready.length === 1 ? 'source is' : 'sources are'} ready for claim review.`, detail: 'Open the case to check what they support, contradict or leave unresolved.' };
  const failed = evidence.filter((item) => item.state === 'FAILED');
  if (failed.length) return { report, stale, message: 'Some documents could not be read.', detail: 'Open the case to see which ones, and to try them again.' };
  return { report, stale, message: 'Your documents have not been read yet.', detail: 'Open the case to have them read for the dates, amounts and names they contain.' };
}
