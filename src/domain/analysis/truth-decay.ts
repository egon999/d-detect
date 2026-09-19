/**
 * Truth Decay & Credibility Cascade (Contradiction Ripple Engine).
 *
 * When an assertion or document is proven false or contradicted:
 * - Traces the cascade blast radius through the relationship graph.
 * - Identifies dependent claims whose evidentiary pillar collapses.
 * - Computes the Participant Credibility Index (PCI) based on verifiable vs contradicted statements.
 */

import type { Claim, Evidence, EvidenceRelationship, Workspace } from '@domain/models';

export interface CompromisedClaim {
  claimId: string;
  statement: string;
  priorState: 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'UNRESOLVED';
  compromiseReason: string;
  dependentEvidenceId: string;
}

export interface ParticipantCredibility {
  name: string;
  role?: string;
  totalStatements: number;
  verifiedStatements: number;
  contradictedStatements: number;
  reliabilityScore: number; // 0 to 100%
  status: 'RELIABLE' | 'QUESTIONABLE' | 'SEVERELY_COMPROMISED';
}

export interface CredibilityCascadeResult {
  caseId: string;
  contradictionCount: number;
  blastRadius: number; // Count of affected entities
  compromisedClaims: CompromisedClaim[];
  participantCredibilities: ParticipantCredibility[];
  cascadeSummary: string;
}

export function propagateContradictionCascade(workspace: Workspace, caseId: string): CredibilityCascadeResult {
  const cId = caseId;
  const claims = workspace.claims.filter((c) => c.caseId === cId && !c.deletedAt);
  const evidenceList = workspace.evidence.filter((e) => e.caseId === cId && !e.deletedAt);
  const relationships = workspace.relationships.filter((r) => r.caseId === cId);
  const analysisResults = workspace.analysisResults.filter((a) => a.caseId === cId);

  const getRelFrom = (r: any): { kind?: string; id?: string } => r.from ?? r.source ?? {};
  const getRelTo = (r: any): { kind?: string; id?: string } => r.to ?? r.target ?? {};
  const getRelType = (r: any): string => r.type ?? r.relationType ?? '';

  // 1. Identify all contradicted evidence IDs
  const contradictedEvidenceIds = new Set<string>();
  const contradictionLinks = relationships.filter((r) => getRelType(r) === 'CONTRADICTS');
  for (const link of contradictionLinks) {
    const from = getRelFrom(link);
    const to = getRelTo(link);
    if (from.kind === 'evidence' && from.id) contradictedEvidenceIds.add(from.id);
    if (to.kind === 'evidence' && to.id) contradictedEvidenceIds.add(to.id);
  }

  // Also pull in possible conflicts from analysis results
  for (const res of analysisResults) {
    if (res.resultType === 'POSSIBLE_CONFLICT') {
      for (const evdId of res.supportingEvidenceIds) contradictedEvidenceIds.add(evdId);
    }
  }

  // 2. Trace ripple effect to dependent claims
  const compromisedClaims: CompromisedClaim[] = [];
  for (const clm of claims) {
    const supportingLinks = relationships.filter((r) => {
      const to = getRelTo(r);
      return to.kind === 'claim' && to.id === clm.id && getRelType(r) === 'SUPPORTS';
    });
    const supportingEvidenceIds = supportingLinks
      .map(getRelFrom)
      .filter((from) => from.kind === 'evidence' && Boolean(from.id))
      .map((from) => from.id as string);

    // If any supporting evidence is tainted by a contradiction
    const taintedEvidence = supportingEvidenceIds.find((id) => contradictedEvidenceIds.has(id));
    if (taintedEvidence) {
      const evd = evidenceList.find((e) => e.id === taintedEvidence);
      compromisedClaims.push({
        claimId: clm.id,
        statement: clm.statement,
        priorState: clm.state === 'SUPPORTED' ? 'SUPPORTED' : 'PARTIALLY_SUPPORTED',
        compromiseReason: `Directly supported by discredited evidence "${evd?.title || taintedEvidence}" which contains unresolved contradictions.`,
        dependentEvidenceId: taintedEvidence,
      });
    }
  }

  // 3. Compute Participant Credibility Ratings
  const partyMap = new Map<
    string,
    { total: number; verified: number; contradicted: number; role?: string }
  >();

  for (const evd of evidenceList) {
    const parties = evd.extraction?.parties ?? [];
    const isContradicted = contradictedEvidenceIds.has(evd.id);

    for (const p of parties) {
      const name = ((p as any).name ?? p.normalized ?? p.original ?? '').trim();
      if (!name) continue;
      const role = (p as any).role;
      const stat = partyMap.get(name) ?? { total: 0, verified: 0, contradicted: 0, role };
      stat.total += 1;
      if (isContradicted) stat.contradicted += 1;
      else stat.verified += 1;
      partyMap.set(name, stat);
    }
  }

  const participantCredibilities: ParticipantCredibility[] = Array.from(partyMap.entries()).map(
    ([name, stat]) => {
      const ratio = stat.total > 0 ? stat.verified / stat.total : 1;
      const score = Math.round(ratio * 100);
      let status: ParticipantCredibility['status'] = 'RELIABLE';
      if (score < 50) status = 'SEVERELY_COMPROMISED';
      else if (score < 80) status = 'QUESTIONABLE';

      return {
        name,
        role: stat.role,
        totalStatements: stat.total,
        verifiedStatements: stat.verified,
        contradictedStatements: stat.contradicted,
        reliabilityScore: score,
        status,
      };
    }
  );

  const blastRadius = contradictedEvidenceIds.size + compromisedClaims.length;

  let cascadeSummary = 'All evidence sources remain internally consistent with zero cascading contradictions.';
  if (blastRadius > 0) {
    cascadeSummary = `Identified ${contradictedEvidenceIds.size} contradicted evidence item(s) compromising ${compromisedClaims.length} dependent claim(s). Total cascade blast radius is ${blastRadius} records.`;
  }

  return {
    caseId,
    contradictionCount: contradictedEvidenceIds.size,
    blastRadius,
    compromisedClaims,
    participantCredibilities,
    cascadeSummary,
  };
}
