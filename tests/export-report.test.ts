import { describe, expect, it } from 'vitest';
import { buildCaseReportHtml, escapeHtml } from '@domain/analysis/export-report';
import { emptyWorkspace, type CaseAnalysis } from '@domain/models';
import { currentClaimAssessment } from '@domain/analysis/case-report';
import { createCase } from '@data/mutations';
import { claim, workspace, CASE_ID, OWNER } from './helpers';

describe('safe case report export', () => {
  it('escapes user content rather than executing markup in the print view', () => {
    const result = createCase(emptyWorkspace(), { ownerId: 'owner_1', now: 1 }, { title: '<script>alert(1)</script>', description: '<img src=x onerror=alert(1)>' });
    const html = buildCaseReportHtml(result.workspace, result.workspace.cases[0]!.id, 1);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('No saved assessment');
  });
  it('fails for missing cases and escapes all attribute delimiters', () => {
    expect(() => buildCaseReportHtml(emptyWorkspace(), 'missing', 1)).toThrow('not available');
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
  it('does not attach an earlier verdict to an edited or foreign claim', () => {
    const assertion = claim('Payment completed');
    const report: CaseAnalysis = {
      id: 'report_test', jobId: 'job_test', ownerId: OWNER, caseId: CASE_ID,
      createdAt: 2000, updatedAt: 2000, schemaVersion: '1', summary: '', entities: [],
      claims: [{ claimId: assertion.id, statement: assertion.statement, status: 'SUPPORTED', explanation: 'Earlier statement.', citations: [], missingInformation: [], limitations: [] }],
      agreements: [], contradictions: [], timeline: [], limitations: [],
      coverage: { totalEvidence: 0, processedEvidence: 0, excludedEvidenceIds: [], truncated: false },
      model: 'test-model', promptVersion: '1',
    };
    expect(currentClaimAssessment(report, assertion)?.status).toBe('SUPPORTED');
    expect(currentClaimAssessment(report, { ...assertion, ownerId: 'other_owner' })).toBeNull();
    const edited = { ...assertion, statement: 'Payment failed', updatedAt: 3000 };
    const html = buildCaseReportHtml(workspace({ claims: [edited], caseAnalyses: [report] }), CASE_ID, 4000);
    expect(html).toContain('Payment failed');
    expect(html).toContain('Not assessed for this version of the claim');
    expect(html).not.toContain('<strong>Supported</strong>');
  });
});
