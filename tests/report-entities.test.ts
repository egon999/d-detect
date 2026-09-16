import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/domain/analysis/graph';
import { quoteNamesEntity, sourceBackedReportEntities } from '../src/domain/analysis/report-entities';
import { caseAnalysisSchema, type CaseAnalysis } from '../src/domain/models';
import { buildSearchIndex } from '../src/services/search-index';
import { CASE_ID, OWNER, claim, evidence, link, testCase, workspace } from './helpers';

function scenario() {
  const source = evidence('Priya Sharma submitted reference TX-1001.', { id: 'ev_name' });
  source.extraction!.segments = [{ id: 'seg_name', text: source.extraction!.sourceText, startOffset: 0, endOffset: source.extraction!.sourceText.length, method: 'OCR' }];
  const quote = { evidenceId: source.id, segmentId: 'seg_name', quote: source.extraction!.sourceText, startOffset: 0, endOffset: source.extraction!.sourceText.length, stance: 'CONTEXT' as const };
  const report = caseAnalysisSchema.parse({
    id: 'report_names', ownerId: OWNER, caseId: CASE_ID, createdAt: 2000, updatedAt: 2000, jobId: 'job_names', schemaVersion: '1',
    summary: 'A source names a participant and reference.', claims: [], agreements: [], contradictions: [], timeline: [],
    entities: [{ name: 'Priya Sharma', type: 'PERSON', citations: [quote] }], limitations: [],
    coverage: { totalEvidence: 1, processedEvidence: 1, excludedEvidenceIds: [], truncated: false }, model: 'test-model', promptVersion: '1',
  });
  const data = workspace({ evidence: [source], caseAnalyses: [report] });
  return { source, quote, report, data };
}
const allKinds = ['claim', 'event', 'evidence', 'entity', 'conflict'] as const;

describe('source-backed report entities', () => {
  it('builds inspectable graph mentions and search results leading to the exact source passage', () => {
    const { data, report, quote } = scenario();
    const graph = buildGraph(data, CASE_ID, { kinds: allKinds });
    const entity = graph.nodes.find(node => node.reportKind === 'entity');
    expect(entity).toMatchObject({ label: 'Priya Sharma', citations: [quote] });
    expect(graph.edges).toEqual([expect.objectContaining({ from: quote.evidenceId, to: entity!.id, type: 'MENTIONS', material: false, citations: [quote] })]);
    const found = buildSearchIndex(OWNER, data.cases, [data]).find(record => record.kind === 'Entities');
    expect(found).toMatchObject({ id: `entity:${report.id}:0`, title: 'Priya Sharma', caseId: CASE_ID, recordId: quote.evidenceId, segmentId: quote.segmentId, text: quote.quote });
  });
  it('requires full names and references instead of substring or first-name collisions', () => {
    expect(quoteNamesEntity('Joanne Kumar made payment.', 'Ann')).toBe(false);
    expect(quoteNamesEntity('Reference TX-10010.', 'TX-1001')).toBe(false);
    expect(quoteNamesEntity('Priya\n Sharma: receipt.', 'Priya Sharma')).toBe(true);
    expect(quoteNamesEntity('Joann first, Ann second.', 'Ann')).toBe(true);
    const { data, report } = scenario();
    report.entities[0]!.name = 'Priya Sharm';
    expect(sourceBackedReportEntities(data, report)).toEqual([]);
  });
  it('rejects invented quotes and invalid source offsets from graph and entity search', () => {
    const { data, report } = scenario();
    report.entities[0]!.citations[0]!.quote = 'Priya Sharma paid successfully.';
    expect(buildGraph(data, CASE_ID, { kinds: allKinds }).nodes.some(node => node.reportKind === 'entity')).toBe(false);
    expect(buildSearchIndex(OWNER, data.cases, [data]).some(record => record.kind === 'Entities')).toBe(false);
  });
  it('does not create mention edges from context passages that do not name the entity', () => {
    const { data, report } = scenario();
    const context = evidence('The payment status is pending.', { id: 'ev_context' });
    context.extraction!.segments = [{ id: 'seg_context', text: context.extraction!.sourceText, startOffset: 0, endOffset: context.extraction!.sourceText.length, method: 'OCR' }];
    data.evidence.push(context);
    report.entities[0]!.citations.push({ evidenceId: context.id, segmentId: 'seg_context', quote: context.extraction!.sourceText, startOffset: 0, endOffset: context.extraction!.sourceText.length, stance: 'CONTEXT' });
    expect(buildGraph(data, CASE_ID, { kinds: allKinds }).edges.map(edge => edge.from)).toEqual(['ev_name']);
  });
  it('rejects references to another case even when its evidence is present in account search', () => {
    const { data, report, source } = scenario();
    source.caseId = 'case_other';
    data.cases.push(testCase({ id: 'case_other' }));
    expect(sourceBackedReportEntities(data, report)).toEqual([]);
    expect(buildSearchIndex(OWNER, data.cases, [data]).some(record => record.kind === 'Entities')).toBe(false);
  });
  it('does not index foreign reports or outdated source interpretations', () => {
    const { data, report, source } = scenario();
    source.updatedAt = 3000;
    expect(sourceBackedReportEntities(data, report)).toEqual([]);
    source.updatedAt = 1000;
    report.ownerId = 'other_account';
    expect(buildSearchIndex(OWNER, data.cases, [data]).some(record => record.kind === 'Entities')).toBe(false);
  });
  it('supports older saved reports without the optional entities collection', () => {
    const { data, report } = scenario();
    delete (report as Partial<CaseAnalysis>).entities;
    expect(sourceBackedReportEntities(data, report)).toEqual([]);
    expect(buildGraph(data, CASE_ID, { kinds: allKinds }).edges).toEqual([]);
  });
  it('uses only the newest report for derived graph nodes and search results', () => {
    const { data, report } = scenario();
    data.caseAnalyses.push({ ...report, id: 'report_new', createdAt: 3000, updatedAt: 3000, entities: [] });
    expect(buildGraph(data, CASE_ID, { kinds: allKinds }).edges).toEqual([]);
    expect(buildSearchIndex(OWNER, data.cases, [data]).some(record => record.kind === 'Entities')).toBe(false);
  });
  it('never displays a cached verdict after the claim statement changes', () => {
    const { data, report, quote } = scenario();
    const assertion = claim('Priya submitted the reference.', { id: 'clm_reference', state: 'SUPPORTED' });
    data.claims.push(assertion);
    report.claims.push({ claimId: assertion.id, statement: assertion.statement, status: 'SUPPORTED', explanation: 'The source names the reference.', citations: [{ ...quote, stance: 'SUPPORTS' }], missingInformation: [], limitations: [] });
    assertion.statement = 'Priya completed the transfer.';
    const graph = buildGraph(data, CASE_ID, { kinds: allKinds });
    expect(graph.nodes.find(node => node.id === assertion.id)).toMatchObject({ sublabel: 'Not assessed for this claim version' });
    expect(graph.edges.some(edge => edge.to === assertion.id)).toBe(false);
  });
  it('preserves earlier manual links as context while removing outdated rule polarity', () => {
    const { data, source } = scenario();
    const assertion = claim('A revised allegation.', { id: 'clm_edited', updatedAt: 3000 });
    data.claims.push(assertion);
    data.relationships.push(
      link({ kind: 'evidence', id: source.id }, { kind: 'claim', id: assertion.id }, 'SUPPORTS', { id: 'manual_before_edit', updatedAt: 1000, note: 'The receipt appears to support the earlier statement.' }),
      link({ kind: 'evidence', id: source.id }, { kind: 'claim', id: assertion.id }, 'CONTRADICTS', { id: 'rule_before_edit', origin: 'RULE', updatedAt: 1000 }),
    );
    const graph = buildGraph(data, CASE_ID, { kinds: allKinds });
    expect(graph.edges).toEqual([expect.objectContaining({ id: 'manual_before_edit', type: 'RELATED_TO', material: false, reason: expect.stringContaining('predates a claim edit') })]);
    expect(buildGraph(data, CASE_ID, { relationshipTypes: ['SUPPORTS'] }).edges).toEqual([]);
    data.relationships[0]!.updatedAt = 4000;
    expect(buildGraph(data, CASE_ID).edges[0]?.type).toBe('SUPPORTS');
  });
});
