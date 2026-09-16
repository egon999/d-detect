import { effectiveExtraction } from '../extraction/merge';
import { deterministicId } from '../ids';
import type {
  AnalysisResult,
  CaseEvent,
  Claim,
  Evidence,
  EvidenceRelationship,
  Extraction,
  UnconfirmedRead,
  Workspace,
} from '../models';
import { quarantineFinding, unconfirmedReadsOf } from './provenance';
import { enabledRules } from './registry';
import type { AnalysisRunResult, Rule, RuleContext, RuleFinding } from './types';

/**
 * The analysis engine.
 *
 * Responsibilities, deliberately narrow:
 *
 * 1. Build a read-only, indexed view of one case.
 * 2. Run every enabled rule over it.
 * 3. Turn findings into `AnalysisResult` documents with **stable, derived ids**.
 * 4. Preserve human review state across runs, and resolve findings that no longer hold.
 *
 * It contains no domain judgement of its own — all of that lives in the rules — and it
 * performs no I/O, so the entire reasoning system is testable in plain Node.
 */

/** Filters out soft-deleted records and anything belonging to another case. */
function activeIn<T extends { id: string; caseId: string; deletedAt?: number | null }>(
  items: readonly T[],
  caseId: string,
): T[] {
  return items
    .filter((item) => item.caseId === caseId && !item.deletedAt)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Builds the shared context. Extractions are memoised because several rules ask for
 * the same evidence and `effectiveExtraction` re-applies every confirmed override.
 *
 * `now` is optional and defaults to `null`, which is what the derived read models
 * (`timeline`, `graph`, `claim-state`, and the compare screen) pass by omission. They ask
 * this context structural questions — what links to what, which claim is supported — and
 * none of those answers depend on today's date.
 *
 * It is deliberately not defaulted to `Date.now()`. A rule reading a clock nobody passed it
 * is how an analysis stops being reproducible: the same workspace would produce different
 * findings on different days with nothing in the inputs to explain it. `null` means "no
 * clock was supplied", every time-aware rule checks for it, and the engine is the only
 * caller that has a real timestamp to give.
 */
export function buildRuleContext(
  workspace: Readonly<Workspace>,
  caseId: string,
  now: number | null = null,
): RuleContext {
  const parentCase = workspace.cases.find((item) => item.id === caseId);
  if (!parentCase) throw new Error(`Case ${caseId} is not present in the workspace`);

  const evidence = activeIn<Evidence>(workspace.evidence, caseId);
  const claims = activeIn<Claim>(workspace.claims, caseId);
  const events = activeIn<CaseEvent>(workspace.events, caseId);

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const claimById = new Map(claims.map((item) => [item.id, item]));
  const eventById = new Map(events.map((item) => [item.id, item]));

  const exists = (ref: { kind: string; id: string }): boolean => {
    if (ref.kind === 'evidence') return evidenceById.has(ref.id);
    if (ref.kind === 'claim') return claimById.has(ref.id);
    if (ref.kind === 'event') return eventById.has(ref.id);
    if (ref.kind === 'entity') {
      const pId = ref.id.replace(/^entity:/, '');
      return (parentCase.participants ?? []).some((p) => p.id === pId);
    }
    if (ref.kind === 'conflict') {
      const cId = ref.id.replace(/^conflict:/, '');
      return workspace.analysisResults.some((r) => r.id === cId);
    }
    return false;
  };

  // A relationship whose endpoint was deleted is dropped rather than followed, so a
  // removed document cannot keep propping up a claim.
  const relationships = workspace.relationships
    .filter((link) => link.caseId === caseId && exists(link.from) && exists(link.to))
    .sort((a, b) => a.id.localeCompare(b.id));

  const incoming = new Map<string, EvidenceRelationship[]>();
  const outgoing = new Map<string, EvidenceRelationship[]>();
  const push = (index: Map<string, EvidenceRelationship[]>, key: string, link: EvidenceRelationship) => {
    const list = index.get(key);
    if (list) list.push(link);
    else index.set(key, [link]);
  };
  for (const link of relationships) {
    push(incoming, `${link.to.kind}:${link.to.id}`, link);
    push(outgoing, `${link.from.kind}:${link.from.id}`, link);
  }

  const extractionCache = new Map<string, Extraction | null>();
  const unconfirmedCache = new Map<string, readonly UnconfirmedRead[]>();

  const context: RuleContext = {
    caseId,
    ownerId: parentCase.ownerId,
    now,
    evidence,
    claims,
    events,
    relationships,
    evidenceById,
    claimById,
    eventById,

    extractionOf(evidenceId) {
      if (extractionCache.has(evidenceId)) return extractionCache.get(evidenceId) ?? null;
      const item = evidenceById.get(evidenceId);
      const result = item ? effectiveExtraction(item) : null;
      extractionCache.set(evidenceId, result);
      return result;
    },

    unconfirmedReads(evidenceId) {
      const cached = unconfirmedCache.get(evidenceId);
      if (cached) return cached;
      // Deliberately over the *effective* extraction: a field the user has confirmed
      // reads as MANUAL by now and is therefore no longer an unconfirmed reading.
      const result = unconfirmedReadsOf(evidenceId, context.extractionOf(evidenceId));
      unconfirmedCache.set(evidenceId, result);
      return result;
    },

    linksTo(kind, id) {
      return incoming.get(`${kind}:${id}`) ?? [];
    },

    linksFrom(kind, id) {
      return outgoing.get(`${kind}:${id}`) ?? [];
    },
  };

  return context;
}

/**
 * Converts a rule finding into a stored document.
 *
 * The id is derived from the rule and the entities involved, never from a counter or a
 * clock. Two consequences the whole pipeline depends on:
 *
 * - re-running analysis overwrites the same document instead of creating a second copy,
 *   so a retried Cloud Function is harmless; and
 * - `createdAt` and a human's `status` survive every subsequent run, so dismissing a
 *   finding actually sticks.
 *
 * This is also the single place the provenance quarantine is applied. Doing it here
 * rather than inside each rule means a rule cannot forget it, cannot disagree with
 * another rule about it, and cannot promote its own finding above what its inputs
 * support. See `./provenance`.
 */
function toAnalysisResult(
  rule: Rule,
  finding: RuleFinding,
  context: RuleContext,
  previous: AnalysisResult | undefined,
  now: number,
): AnalysisResult {
  const id = deterministicId('an', rule.id, ...finding.key);
  const quarantine = quarantineFinding(rule, finding, context);

  return {
    id,
    ownerId: context.ownerId,
    caseId: context.caseId,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    resultType: rule.resultType,
    severity: quarantine.severity,
    title: finding.title,
    explanation: quarantine.explanation,
    supportingEvidenceIds: [...(finding.supportingEvidenceIds ?? [])],
    relatedClaimIds: [...(finding.relatedClaimIds ?? [])],
    relatedEventIds: [...(finding.relatedEventIds ?? [])],
    triggeredRuleIds: [rule.id],
    aiSuggestionIds: previous?.aiSuggestionIds ?? [],
    inputs: finding.inputs,
    confidence: quarantine.confidence,
    provisional: quarantine.provisional,
    unconfirmedReads: quarantine.unconfirmedReads,
    // A finding a human already handled stays handled. Only RESOLVED is reset, because
    // a resolved condition that fires again is genuinely new information.
    status: previous && previous.status !== 'RESOLVED' ? previous.status : 'OPEN',
    reviewedAt: previous?.reviewedAt ?? null,
    reviewNote: previous?.reviewNote ?? '',
  };
}

/**
 * Runs the enabled rules over one case.
 *
 * `now` is injected rather than read from the clock so that tests are deterministic
 * and so a Cloud Function and the client agree on a single timestamp for a run.
 */
export function runAnalysis(
  workspace: Readonly<Workspace>,
  caseId: string,
  now: number,
  rules = enabledRules(),
): AnalysisRunResult {
  const context = buildRuleContext(workspace, caseId, now);
  const previousById = new Map(
    workspace.analysisResults.filter((item) => item.caseId === caseId).map((item) => [item.id, item]),
  );

  const results: AnalysisResult[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    for (const finding of rule.evaluate(context)) {
      const id = deterministicId('an', rule.id, ...finding.key);
      // Guard against a rule emitting the same finding twice in one pass.
      if (seen.has(id)) continue;
      seen.add(id);
      results.push(toAnalysisResult(rule, finding, context, previousById.get(id), now));
    }
  }

  // Anything previously open that no rule produced this time is now resolved. It is
  // kept, not deleted: the history of what the case used to look like is part of the
  // audit story.
  const resolved = [...previousById.values()]
    .filter((item) => !seen.has(item.id) && item.status !== 'RESOLVED' && item.status !== 'DISMISSED')
    .map((item) => ({ ...item, status: 'RESOLVED' as const, updatedAt: now }));

  return {
    results: results.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id),
    ),
    resolved,
    evaluatedRuleIds: rules.map((rule) => rule.id),
    runAt: now,
  };
}

export const SEVERITY_ORDER: Record<AnalysisResult['severity'], number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  INFO: 3,
};

/**
 * Applies a run to a workspace, returning a new one. Used by the local adapter, the
 * seed script and tests; the Firestore adapter writes the same results in a batch.
 */
export function applyAnalysisRun(workspace: Workspace, run: AnalysisRunResult, caseId: string): Workspace {
  const updatedIds = new Set([...run.results, ...run.resolved].map((item) => item.id));
  return {
    ...workspace,
    analysisResults: [
      ...workspace.analysisResults.filter((item) => !updatedIds.has(item.id)),
      ...run.results,
      ...run.resolved,
    ],
    cases: workspace.cases.map((item) =>
      item.id === caseId ? { ...item, lastAnalyzedAt: run.runAt, updatedAt: run.runAt } : item,
    ),
  };
}
