import { describe, expect, it } from 'vitest';
import { buildSampleWorkspace, SAMPLE_CASE_ID } from './fixtures/build-sample-workspace';
import { SAMPLE_DOCUMENTS, sampleText } from './fixtures/sample-documents';
import { buildGraph, orphanNodes } from '@domain/analysis/graph';
import { buildTimeline } from '@domain/analysis/timeline';
import { evaluateCaseClaims } from '@domain/analysis/claim-state';
import { hashText } from '@domain/hashing';
import { analysisResultSchema, caseSchema, claimSchema, evidenceSchema } from '@domain/models';
import { runAnalysis } from '@domain/rules/engine';

/**
 * The rule engine over a full multi-document case, end to end.
 *
 * Everything asserted here is *derived*. The builder supplies raw document text, the real
 * extractor reads it, and the real engine decides what the findings are. If a rule, a
 * normaliser or the claim-state resolver regresses, these expectations fail — which is the
 * point: this is the closest thing to a real case that runs in CI.
 */

const OWNER = 'user_corpus';
const workspace = buildSampleWorkspace(OWNER);
const findings = workspace.analysisResults;
const typesFound = new Set(findings.map((result) => result.resultType));

describe('workspace shape', () => {
  it('produces a case with claims, events, evidence and relationships', () => {
    expect(workspace.cases).toHaveLength(1);
    expect(workspace.claims).toHaveLength(3);
    expect(workspace.events).toHaveLength(4);
    expect(workspace.evidence).toHaveLength(SAMPLE_DOCUMENTS.length);
    expect(workspace.relationships.length).toBeGreaterThanOrEqual(9);
  });

  it('validates against the same schemas real user data passes through', () => {
    expect(() => caseSchema.parse(workspace.cases[0])).not.toThrow();
    for (const claim of workspace.claims) expect(() => claimSchema.parse(claim)).not.toThrow();
    for (const item of workspace.evidence) expect(() => evidenceSchema.parse(item)).not.toThrow();
    for (const result of findings) expect(() => analysisResultSchema.parse(result)).not.toThrow();
  });

  it('belongs entirely to the signed-in user, like any other case', () => {
    const everything = [
      ...workspace.cases,
      ...workspace.claims,
      ...workspace.events,
      ...workspace.evidence,
      ...workspace.relationships,
      ...findings,
      ...workspace.auditLogs,
    ];
    for (const record of everything) expect(record.ownerId).toBe(OWNER);
  });

  it('hashes real document bytes rather than storing a placeholder fingerprint', () => {
    const invoice = workspace.evidence.find((item) => item.id === 'evd_sample_invoice')!;
    const copy = workspace.evidence.find((item) => item.id === 'evd_sample_invoice_duplicate')!;
    expect(invoice.sha256).toBe(hashText(sampleText('invoice')));
    expect(copy.sha256).toBe(invoice.sha256);
  });

  it('derives nothing at all from a file whose contents could not be read', () => {
    // The corpus deliberately contains one unreadable document. Everything derived from it
    // must be empty rather than invented, and the record must land in REVIEW_REQUIRED so a
    // person is asked instead of a guess being presented as a reading.
    const unreadable = workspace.evidence.find(
      (item) => item.id === 'evd_sample_unreadable_screenshot',
    )!;
    expect(unreadable.kind).toBe('IMAGE');
    expect(unreadable.state).toBe('REVIEW_REQUIRED');
    expect(unreadable.extraction?.sourceText).toBe('');
    expect(unreadable.extraction?.dates).toEqual([]);
    expect(unreadable.extraction?.amounts).toEqual([]);
    expect(unreadable.confirmedAt).toBeNull();
    // The reason has to say what the user should do about it, not just that it failed.
    expect(unreadable.failureReason).toMatch(/no text could be read/i);
    // It still has a file, so it still has a size and a fingerprint.
    expect(unreadable.sizeBytes).toBeGreaterThan(0);
    expect(unreadable.sha256).not.toBeNull();
  });

  it('gives a typed note no file and therefore no hash', () => {
    const note = workspace.evidence.find((item) => item.kind === 'NOTE')!;
    expect(note.sha256).toBeNull();
    expect(note.storagePath).toBeNull();
  });
});

describe('findings the demonstration relies on', () => {
  it('covers every finding type the walkthrough shows', () => {
    expect([...typesFound].sort()).toEqual([
      'AMOUNT_MISMATCH',
      'CORROBORATED_CLAIM',
      'CORROBORATED_EVENT',
      'DUPLICATE_EVIDENCE',
      'MISSING_EVIDENCE',
      'POSSIBLE_CONFLICT',
      'RELATED_EVIDENCE',
      'UNLINKED_EVIDENCE',
      'UNSUPPORTED_CLAIM',
    ]);
  });

  it('detects the re-uploaded invoice by hash, not by file name', () => {
    const duplicate = findings.find((result) => result.resultType === 'DUPLICATE_EVIDENCE')!;
    expect(duplicate.supportingEvidenceIds.sort()).toEqual([
      'evd_sample_invoice',
      'evd_sample_invoice_duplicate',
    ]);
    expect(duplicate.severity).toBe('LOW');
  });

  it('finds the 45,000 shortfall between the invoice and the payment', () => {
    const mismatch = findings.find((result) => result.resultType === 'AMOUNT_MISMATCH')!;
    expect(mismatch.severity).toBe('HIGH');
    expect(mismatch.inputs['Difference']).toBe('INR 45,000.00');
    expect(mismatch.inputs['Compared because']).toContain('INV2024018');
  });

  it('finds the disputed handover date and names both sources', () => {
    const conflict = findings.find((result) => result.resultType === 'POSSIBLE_CONFLICT')!;
    expect(conflict.relatedEventIds).toEqual(['evt_sample_delivery']);
    expect(conflict.supportingEvidenceIds.sort()).toEqual([
      'evd_sample_client_reply',
      'evd_sample_delivery_email',
    ]);
    expect(conflict.explanation).toContain('15 March 2024');
    expect(conflict.explanation).toContain('12 March 2024');
  });

  it('notices the required event nothing evidences', () => {
    const missing = findings.find((result) => result.resultType === 'MISSING_EVIDENCE')!;
    expect(missing.relatedEventIds).toEqual(['evt_sample_due']);
    // The finding suggests a concrete document rather than just reporting a gap — and the
    // suggestion belongs in the caveat, not the observation. `explanation` states what the
    // records show; naming the document that would close the gap is advice about what to do
    // next, which is what the split is for. Asserted on the field directly rather than on
    // `caveat ?? explanation`, because a fallback would pass whichever field it landed in and
    // so would stop pinning the thing this test exists to pin.
    expect(missing.caveat).toMatch(/bank statement|receipt|confirmation/i);
    expect(missing.explanation).not.toMatch(/bank statement|receipt|confirmation/i);
  });

  it('flags the verbal agreement nobody can produce a record of', () => {
    const unsupported = findings.find((result) => result.resultType === 'UNSUPPORTED_CLAIM')!;
    expect(unsupported.relatedClaimIds).toEqual(['clm_sample_terms']);
  });

  it('reports corroboration only where sources are genuinely independent', () => {
    const claim = findings.find((result) => result.resultType === 'CORROBORATED_CLAIM')!;
    expect(claim.relatedClaimIds).toEqual(['clm_sample_balance']);
    // Three distinct documents, and notably not the duplicate invoice copy.
    expect(claim.supportingEvidenceIds).toHaveLength(3);
    expect(claim.supportingEvidenceIds).not.toContain('evd_sample_invoice_duplicate');
  });

  it('raises a single grouped finding for the shared invoice number', () => {
    const related = findings.filter((result) => result.resultType === 'RELATED_EVIDENCE');
    expect(related).toHaveLength(1);
    expect(related[0]?.supportingEvidenceIds).not.toContain('evd_sample_invoice_duplicate');
  });

  it('notices the follow-up note that is connected to nothing', () => {
    const unlinked = findings.filter((result) => result.resultType === 'UNLINKED_EVIDENCE');
    expect(unlinked.map((result) => result.supportingEvidenceIds).flat()).toEqual([
      'evd_sample_reminder_note',
    ]);
  });

  it('explains every finding in plain language and shows the values compared', () => {
    for (const result of findings) {
      expect(result.explanation.length).toBeGreaterThan(80);
      expect(Object.keys(result.inputs).length).toBeGreaterThan(0);
      expect(result.triggeredRuleIds).toHaveLength(1);
      expect(result.status).toBe('OPEN');
    }
  });

  it('never asserts that a finding proves anything', () => {
    for (const result of findings) {
      expect(result.explanation).not.toMatch(/\b(proves|proven|confirms that|legally|guaranteed)\b/i);
    }
  });

  /**
   * The same invariant `tests/rule-engine.test.ts` applies to its own fixture, run against the
   * corpus — which is the fixture that actually exercises the rules that broke it.
   *
   * Three rules wrote `classification.category` into `inputs`, so a reader was shown
   * "Discrepancy: MATERIAL_AMOUNT_CONTRADICTION", and a fourth wrote `field.method`, so another
   * read "DETERMINISTIC". The existing check would have caught all four; it never ran on them,
   * because its hand-built fixture happens not to produce an amount mismatch, a date conflict or
   * an overdue complaint. A guard that only inspects findings nobody was getting wrong is not a
   * guard, so it runs here too, over the corpus that raises one of nearly every kind.
   */
  it('shows no stored identifier in any finding input', () => {
    for (const result of findings) {
      for (const [label, value] of Object.entries(result.inputs)) {
        // SHA-256 is the one legitimate all-caps term a reader recognises.
        if (label !== 'SHA-256') {
          expect(label, `label "${label}"`).not.toMatch(/^[A-Z][A-Z_]+$/);
        }
        expect(value, `value of "${label}"`).not.toMatch(/^[A-Z][A-Z_]{3,}$/);
        // camelCase keys are code identifiers that leaked into the interface.
        expect(label, `label "${label}"`).not.toMatch(/^[a-z]+[A-Z]/);
      }
    }
  });
});

describe('derived claim states', () => {
  it('reaches all three states the reasoning model can justify here', () => {
    const states = Object.fromEntries(workspace.claims.map((claim) => [claim.id, claim.state]));
    expect(states['clm_sample_delivered']).toBe('MIXED_REVIEW');
    expect(states['clm_sample_balance']).toBe('SUPPORTED');
    expect(states['clm_sample_terms']).toBe('UNSUPPORTED');
  });

  it('caches states that match a fresh evaluation of the relationships', () => {
    const evaluations = evaluateCaseClaims(workspace, SAMPLE_CASE_ID);
    for (const claim of workspace.claims) {
      expect(claim.state).toBe(evaluations.get(claim.id)?.state);
    }
  });

  it('explains the disputed claim with a readable trace', () => {
    const evaluation = evaluateCaseClaims(workspace, SAMPLE_CASE_ID).get('clm_sample_delivered')!;
    expect(evaluation.supporting).toHaveLength(1);
    expect(evaluation.materialContradictions).toHaveLength(1);
    expect(evaluation.trace.join(' ')).toMatch(/needs a human decision/i);
  });
});

describe('derived views', () => {
  it('builds a timeline spanning the whole dispute', () => {
    const timeline = buildTimeline(workspace, SAMPLE_CASE_ID, { includeEvidence: false });
    expect(timeline.entries.map((entry) => entry.id)).toEqual([
      'evt_sample_agreement',
      'evt_sample_delivery',
      'evt_sample_due',
      'evt_sample_part_payment',
    ]);
    expect(timeline.undatedCount).toBe(0);
    expect(timeline.groups.map((group) => group.label)).toEqual(['January 2024', 'March 2024']);
  });

  it('marks the disputed handover inline on the timeline', () => {
    const timeline = buildTimeline(workspace, SAMPLE_CASE_ID, { includeEvidence: false });
    const delivery = timeline.entries.find((entry) => entry.id === 'evt_sample_delivery')!;
    expect(delivery.hasConflict).toBe(true);
  });

  it('builds a connected graph from the stored relationships', () => {
    const graph = buildGraph(workspace, SAMPLE_CASE_ID);
    expect(graph.nodes).toHaveLength(3 + 4 + SAMPLE_DOCUMENTS.length);
    expect(graph.edges).toHaveLength(workspace.relationships.length);
    // The follow-up note is deliberately unlinked, so the empty-state path has something
    // real to show.
    expect(orphanNodes(graph).map((node) => node.id)).toContain('evd_sample_reminder_note');
  });

  it('lays the graph out identically every time', () => {
    expect(buildGraph(workspace, SAMPLE_CASE_ID)).toEqual(buildGraph(workspace, SAMPLE_CASE_ID));
  });
});

describe('reproducibility', () => {
  it('builds byte-identical workspaces from the same seed', () => {
    expect(buildSampleWorkspace(OWNER)).toEqual(buildSampleWorkspace(OWNER));
  });

  it('produces no new findings when analysis is run again over the seeded case', () => {
    const again = runAnalysis(workspace, SAMPLE_CASE_ID, Date.parse('2024-04-05T09:00:00.000Z'));
    expect(again.results).toEqual(findings);
    expect(again.resolved).toEqual([]);
  });

  it('records an audit trail without copying document contents into it', () => {
    expect(workspace.auditLogs.length).toBeGreaterThanOrEqual(SAMPLE_DOCUMENTS.length + 3);
    for (const entry of workspace.auditLogs) {
      expect(entry.summary.length).toBeLessThan(200);
      for (const value of Object.values(entry.metadata)) expect(value.length).toBeLessThan(80);
    }
  });
});
