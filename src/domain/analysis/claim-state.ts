import { isConflictFinding, type ClaimState } from '../enums';
import type { AnalysisResult, Claim, Evidence, Workspace } from '../models';
import { buildRuleContext } from '../rules/engine';
import { evidenceLabel, evidenceLinkedTo, independentSources } from '../rules/support';
import type { RuleContext } from '../rules/types';

/**
 * Claim state.
 *
 * A claim is never reduced to true or false. Four states exist because the third and
 * fourth are the honest answers most of the time:
 *
 * - `SUPPORTED`      — at least one source backs it, nothing material contradicts it.
 * - `CONTRADICTED`   — at least one *material* contradiction and no support.
 * - `MIXED_REVIEW`   — both support and contradiction exist. A human decides.
 * - `UNSUPPORTED`    — nothing is linked yet. Says nothing about the truth of the claim.
 *
 * "Material" is a flag a user sets on a CONTRADICTS link. A signed document that
 * disagrees is material; an offhand remark that disagrees is not. The machine does not
 * try to judge this itself.
 */

export interface ClaimStateEvaluation {
  state: ClaimState;
  supporting: Evidence[];
  contradicting: Evidence[];
  /** Contradictions the user marked as material — the only kind that can flip a claim. */
  materialContradictions: Evidence[];
  /** Supporting sources that are not copies or derivatives of one another. */
  independentSupport: Evidence[];
  /** Ordered, human-readable steps explaining how the state was reached. */
  trace: string[];
}

function evaluateWithContext(
  context: RuleContext,
  claim: Claim,
  analysisResults: readonly AnalysisResult[] = [],
): ClaimStateEvaluation {
  const trace: string[] = [];

  const supporting = [...evidenceLinkedTo(context, 'claim', claim.id, ['SUPPORTS'])];
  const relevant = evidenceLinkedTo(context, 'claim', claim.id, ['RELEVANT_TO_CLAIM']);
  const contradicting = [...evidenceLinkedTo(context, 'claim', claim.id, ['CONTRADICTS'])];

  const materialLinks = context
    .linksTo('claim', claim.id)
    .filter((link) => link.type === 'CONTRADICTS' && link.material);
  const materialContradictions = [
    ...materialLinks
      .map((link) => context.evidenceById.get(link.from.id))
      .filter((item): item is Evidence => Boolean(item)),
  ];

  // Incorporate findings from the rule engine that reference this claim
  const relevantFindings = analysisResults.filter(
    (r) =>
      r.caseId === claim.caseId &&
      !r.provisional &&
      r.status !== 'DISMISSED' &&
      r.status !== 'RESOLVED' &&
      r.relatedClaimIds.includes(claim.id),
  );

  for (const finding of relevantFindings) {
    const isConflict = isConflictFinding(finding.resultType);

    const isCorroboration = finding.resultType === 'CORROBORATED_CLAIM';

    if (isConflict) {
      for (const evId of finding.supportingEvidenceIds) {
        const item = context.evidenceById.get(evId);
        if (item && !contradicting.some((c) => c.id === item.id)) {
          contradicting.push(item);
        }
      }
      trace.push(`Rule finding "${finding.title}" (${finding.resultType}) identifies contradictory evidence.`);
    } else if (isCorroboration) {
      for (const evId of finding.supportingEvidenceIds) {
        const item = context.evidenceById.get(evId);
        if (item && !supporting.some((s) => s.id === item.id)) {
          supporting.push(item);
        }
      }
      trace.push(`Rule finding "${finding.title}" corroborates this claim.`);
    }
  }

  const independentSupport = independentSources(context, supporting);

  trace.push(
    `${supporting.length} item(s) linked as supporting` +
      (supporting.length ? `: ${supporting.map(evidenceLabel).join(', ')}` : ''),
  );
  if (relevant.length) {
    trace.push(
      `${relevant.length} item(s) marked relevant but not asserted as supporting — these do not ` +
        `change the state on their own`,
    );
  }
  trace.push(
    `${contradicting.length} item(s) linked as contradicting` +
      (contradicting.length ? `: ${contradicting.map(evidenceLabel).join(', ')}` : ''),
  );
  if (supporting.length > independentSupport.length) {
    trace.push(
      `${supporting.length - independentSupport.length} supporting item(s) discounted as duplicates ` +
        `or derivatives, leaving ${independentSupport.length} independent source(s)`,
    );
  }
  if (contradicting.length) {
    trace.push(
      `${materialContradictions.length} of ${contradicting.length} contradiction(s) are marked material`,
    );
  }

  let state: ClaimState;
  if (supporting.length > 0 && contradicting.length > 0) {
    state = 'MIXED_REVIEW';
    trace.push('Both support and contradiction are present, so this needs a human decision.');
  } else if (supporting.length > 0) {
    state = 'SUPPORTED';
    trace.push('Supported by the linked evidence, with nothing currently contradicting it.');
  } else if (materialContradictions.length > 0) {
    state = 'CONTRADICTED';
    trace.push('A material contradiction exists and nothing supports the claim.');
  } else if (contradicting.length > 0) {
    // Non-material contradictions alone are not enough to call a claim contradicted.
    state = 'MIXED_REVIEW';
    trace.push(
      'Contradicting evidence exists but none of it is marked material, so the claim is held for ' +
        'review rather than treated as contradicted.',
    );
  } else {
    state = 'UNSUPPORTED';
    trace.push('Nothing is linked to this claim yet. This says nothing about whether it is true.');
  }

  return { state, supporting, contradicting, materialContradictions, independentSupport, trace };
}

/** Evaluates one claim. Builds a context internally; prefer the bulk form in loops. */
export function evaluateClaim(workspace: Readonly<Workspace>, claimId: string): ClaimStateEvaluation | null {
  const claim = workspace.claims.find((item) => item.id === claimId && !item.deletedAt);
  if (!claim) return null;
  if (!workspace.cases.some((item) => item.id === claim.caseId)) return null;
  return evaluateWithContext(buildRuleContext(workspace, claim.caseId), claim, workspace.analysisResults);
}

/** Evaluates every claim in a case against a single shared context. */
export function evaluateCaseClaims(
  workspace: Readonly<Workspace>,
  caseId: string,
): Map<string, ClaimStateEvaluation> {
  if (!workspace.cases.some((item) => item.id === caseId)) {
    return new Map();
  }
  const context = buildRuleContext(workspace, caseId);
  return new Map(context.claims.map((claim) => [claim.id, evaluateWithContext(context, claim, workspace.analysisResults)]));
}

/** Recomputes the cached `state` field on every claim in a case. */
export function refreshClaimStates(workspace: Readonly<Workspace>, caseId: string, now: number): Claim[] {
  if (!workspace.cases.some((item) => item.id === caseId)) {
    return [];
  }
  const evaluations = evaluateCaseClaims(workspace, caseId);
  return workspace.claims
    .filter((claim) => claim.caseId === caseId && !claim.deletedAt)
    .map((claim) => {
      const state = evaluations.get(claim.id)?.state ?? 'UNSUPPORTED';
      return state === claim.state ? claim : { ...claim, state, updatedAt: now };
    });
}

/** Case-level rollup used by the dashboard and case header. */
export function claimStateSummary(
  evaluations: ReadonlyMap<string, ClaimStateEvaluation>,
): Record<ClaimState, number> {
  const summary: Record<ClaimState, number> = {
    SUPPORTED: 0,
    CONTRADICTED: 0,
    UNSUPPORTED: 0,
    MIXED_REVIEW: 0,
  };
  for (const evaluation of evaluations.values()) summary[evaluation.state] += 1;
  return summary;
}
