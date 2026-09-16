import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/domain/analysis/graph';
import type { CaseAnalysis, CaseCitation, Evidence } from '../src/domain/models';
import { claim, evidence, testCase, workspace, CASE_ID, OWNER } from './helpers';

function source(id: string, text: string): Evidence {
  const item = evidence(text, { id });
  item.extraction!.sourceText = text;
  item.extraction!.segments = [{ id: `${id}-segment`, text, startOffset: 0, endOffset: text.length, method: 'TEXT' }];
  return item;
}
function citation(item: Evidence, stance: CaseCitation['stance'] = 'CONTEXT'): CaseCitation {
  return { evidenceId: item.id, segmentId: item.extraction!.segments[0]!.id, quote: item.extraction!.sourceText, startOffset: 0, endOffset: item.extraction!.sourceText.length, stance };
}
function scenario() {
  const paid = source('evd_paid', 'Payment completed: INR 500.');
  const failed = source('evd_failed', 'Payment failed: INR 500.');
  const assertion = claim('Payment completed', { id: 'clm_payment' });
  const report: CaseAnalysis = {
    id: 'report_test', jobId: 'job_test', ownerId: OWNER, caseId: CASE_ID, createdAt: 2000, updatedAt: 2000,
    schemaVersion: '1', summary: 'Two records disagree about status.', entities: [],
    claims: [{ claimId: assertion.id, statement: assertion.statement, status: 'DISPUTED', explanation: 'The two records show opposite payment statuses.', citations: [citation(paid, 'SUPPORTS'), citation(failed, 'CONTRADICTS')], missingInformation: ['Bank settlement record'], limitations: [] }],
    agreements: [{ statement: 'Both records show INR 500.', citations: [citation(paid), citation(failed)] }],
    contradictions: [{ statement: 'The payment status differs.', citations: [citation(paid), citation(failed)] }],
    timeline: [{ description: 'A payment was attempted.', occurredAt: null, citations: [citation(failed)] }],
    limitations: [], coverage: { totalEvidence: 2, processedEvidence: 2, excludedEvidenceIds: [], truncated: false }, model: 'test-model', promptVersion: '1',
  };
  return { data: workspace({ claims: [assertion], evidence: [paid, failed], caseAnalyses: [report] }), report, paid, failed };
}

describe('evidence-grounded graph', () => {
  it('creates claim polarity only from validated citation stances and carries quotations', () => {
    const { data } = scenario();
    const graph = buildGraph(data, CASE_ID, { kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'] });
    const links = graph.edges.filter(edge => edge.to === 'clm_payment');
    expect(links.map(edge => edge.type).sort()).toEqual(['CONTRADICTS', 'SUPPORTS']);
    expect(links.every(edge => edge.citations.length === 1 && edge.reason.includes('opposite'))).toBe(true);
    expect(graph.nodes.find(node => node.id === 'clm_payment')?.sublabel).toBe('Disputed');
  });
  it('connects statements to their sources without claiming a contradiction contradicts its own evidence', () => {
    const { data } = scenario();
    const graph = buildGraph(data, CASE_ID, { kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'] });
    expect(graph.nodes.filter(node => node.reportKind).map(node => node.reportKind).sort()).toEqual(['agreement', 'contradiction', 'timeline']);
    expect(graph.edges.filter(edge => edge.to.includes(':contradiction:')).every(edge => edge.type === 'RELATED_TO' && edge.citations.length)).toBe(true);
  });
  it('excludes fabricated quotations and removes statements whose source changed', () => {
    const { data, paid } = scenario();
    paid.extraction!.sourceText = 'Original source was corrected.';
    const graph = buildGraph(data, CASE_ID, { kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'] });
    expect(graph.edges.some(edge => edge.from === paid.id)).toBe(false);
    expect(graph.nodes.some(node => node.reportKind === 'agreement' || node.reportKind === 'contradiction')).toBe(false);
  });
  it('cannot follow a citation to another case or account', () => {
    const { data, paid } = scenario();
    paid.caseId = 'case_other';
    expect(buildGraph(data, CASE_ID, { kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'] }).edges.some(edge => edge.from === paid.id)).toBe(false);
    paid.caseId = CASE_ID; paid.ownerId = 'user_other';
    expect(buildGraph(data, CASE_ID, { kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'] }).nodes.some(node => node.id === paid.id)).toBe(false);
  });
  it('uses only the latest report, and ignores a report for another case', () => {
    const { data, report } = scenario();
    data.caseAnalyses.push({ ...report, id: 'report_new', createdAt: 3000, claims: [], agreements: [], contradictions: [], timeline: [] });
    data.caseAnalyses.push({ ...report, id: 'report_foreign', caseId: 'case_other', createdAt: 4000 });
    expect(buildGraph(data, CASE_ID, { kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'] }).edges).toEqual([]);
  });
  it('does not preserve a claim link after the claim statement changes', () => {
    const { data } = scenario();
    data.claims[0]!.statement = 'A different allegation';
    expect(buildGraph(data, CASE_ID, { kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'] }).edges.some(edge => edge.to === 'clm_payment')).toBe(false);
  });
  it('applies relationship, kind and user-only filters to every derived edge', () => {
    const { data } = scenario();
    expect(buildGraph(data, CASE_ID, { relationshipTypes: ['CONTRADICTS'] }).edges.map(edge => edge.type)).toEqual(['CONTRADICTS']);
    expect(buildGraph(data, CASE_ID, { kinds: ['evidence'] }).edges).toEqual([]);
    expect(buildGraph(data, CASE_ID, { userLinksOnly: true }).edges).toEqual([]);
  });
  it('does not turn first-name matches, titles or claimant role into authorship links', () => {
    const item = source('evd_name', 'Joanne Kumar sent the receipt.');
    item.title = 'Ann document';
    item.extraction!.people = [{ evidenceId: item.id, method: 'AI', original: 'Joanne Kumar', normalized: 'joanne kumar', sourceQuote: item.extraction!.sourceText }];
    const data = workspace({ cases: [testCase({ participants: [{ id: 'person_ann', name: 'Ann Kumar', role: 'claimant' }] })], evidence: [item], claims: [claim('Money is missing')] });
    expect(buildGraph(data, CASE_ID, { kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'] }).edges).toEqual([]);
  });
  it('only makes a mention when a full extracted name is backed by a valid source passage', () => {
    const item = source('evd_name', 'Ann Kumar sent the receipt.');
    item.extraction!.people = [{ evidenceId: item.id, method: 'AI', original: 'Ann Kumar', normalized: 'ann kumar', sourceQuote: item.extraction!.sourceText }];
    const data = workspace({ cases: [testCase({ participants: [{ id: 'person_ann', name: 'Ann Kumar', role: 'claimant' }] })], evidence: [item] });
    const links = buildGraph(data, CASE_ID, { kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'] }).edges;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ type: 'MENTIONS', material: false });
    expect(links[0]?.citations).toHaveLength(1);
    item.extraction!.people[0]!.sourceQuote = 'Invented quote';
    expect(buildGraph(data, CASE_ID, { kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'] }).edges).toEqual([]);
  });
  it('packs only occupied bands rather than reserving vertical room for empty node categories', () => {
    const graph = buildGraph(workspace({ evidence: [source('evd_only', 'A source document.')] }), CASE_ID);
    expect(graph.height).toBeLessThan(300);
    expect(graph.nodes[0]!.y).toBeLessThan(150);
  });
});
