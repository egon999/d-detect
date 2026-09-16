import { describe, expect, it } from 'vitest';
import { summarizeCase } from '../src/features/cases/home-summary';
import { caseActivity } from '../src/features/cases/activity';
import { caseAnalysisSchema, processingJobSchema } from '../src/domain/models';
import { OWNER, CASE_ID, claim, evidence, testCase, workspace } from './helpers';

function reviewedCase() {
  const source = evidence('Payment failed', { id: 'evd_one' });
  source.extraction!.segments = [{ id: 'seg_1', text: 'Payment failed', startOffset: 0, endOffset: 14, method: 'DETERMINISTIC' }];
  const assertion = claim('Payment completed', { id: 'claim_one' });
  const report = caseAnalysisSchema.parse({
    id: 'report_one', jobId: 'job_one', ownerId: OWNER, caseId: CASE_ID, createdAt: 2000, updatedAt: 2000,
    schemaVersion: '1', model: 'test-model', promptVersion: 'test-v1', summary: 'The supplied receipt says failed.',
    claims: [{ claimId: assertion.id, statement: assertion.statement, status: 'CONTRADICTED', explanation: 'The receipt records failure.', citations: [{ evidenceId: source.id, segmentId: 'seg_1', quote: 'Payment failed', startOffset: 0, endOffset: 14, stance: 'CONTRADICTS' }], missingInformation: [], limitations: [] }],
    agreements: [], contradictions: [], timeline: [], limitations: [], coverage: { totalEvidence: 1, processedEvidence: 1, excludedEvidenceIds: [], truncated: false },
  });
  return workspace({ evidence: [source], claims: [assertion], caseAnalyses: [report] });
}

describe('truthful home summary', () => {
  it('uses a saved contradiction even when there are no deterministic rule findings', () => {
    const data = reviewedCase();
    expect(data.analysisResults).toEqual([]);
    expect(summarizeCase(testCase(), data).message).toContain('1 contradicted');
  });
  it('allows one extracted source to review a claim', () => {
    const data = reviewedCase(); data.caseAnalyses = [];
    expect(summarizeCase(testCase(), data).message).toBe('1 evidence source is ready for claim review.');
  });
  it('marks stale and incomplete coverage rather than claiming a current clean case', () => {
    const data = reviewedCase();
    data.caseAnalyses[0]!.coverage.truncated = true;
    expect(summarizeCase(testCase(), data).detail).toContain('coverage is incomplete');
    data.evidence[0]!.updatedAt = 3000;
    expect(summarizeCase(testCase(), data)).toMatchObject({ stale: true, message: 'The case changed after its latest review.' });
  });
  it('does not present a broken quotation as current', () => {
    const data = reviewedCase(); data.caseAnalyses[0]!.claims[0]!.citations[0]!.quote = 'Payment succeeded';
    expect(summarizeCase(testCase(), data).stale).toBe(true);
  });
  it('ignores another owner report with a colliding case ID', () => {
    const data = reviewedCase(); data.caseAnalyses[0]!.ownerId = 'another_owner';
    expect(summarizeCase(testCase(), data).report).toBeNull();
  });
});

describe('saved case activity', () => {
  it('shows actual job state, excludes foreign jobs and suppresses duplicate job audit entries', () => {
    const data = reviewedCase();
    const job = processingJobSchema.parse({ id: 'job_one', ownerId: OWNER, caseId: CASE_ID, evidenceId: 'evd_one', createdAt: 1000, updatedAt: 2000, state: 'FAILED', lastError: 'The file could not be read.' });
    data.processingJobs = [job, { ...job, id: 'foreign_job', ownerId: 'other' }];
    data.auditLogs = [{ id: 'audit_one', ownerId: OWNER, caseId: CASE_ID, createdAt: 2000, updatedAt: 2000, action: 'EVIDENCE_PROCESSED', actorId: OWNER, entityRefs: [], summary: 'Processed evidence', metadata: { jobId: job.id } }];
    expect(caseActivity(OWNER, data)).toEqual([expect.objectContaining({ title: 'Evidence processing failed', failed: true, detail: 'The file could not be read.' })]);
  });
  it('returns truthful empty activity without synthetic notifications', () => {
    expect(caseActivity(OWNER, workspace())).toEqual([]);
  });
});
