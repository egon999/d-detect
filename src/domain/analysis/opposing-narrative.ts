/**
 * Opposing Narrative Simulator & Blind-Spot Hunter.
 *
 * Models the dispute from the counterparty's perspective:
 * - Scans for uncorroborated verbal claims, missing delivery receipts, and tacit consent windows.
 * - Detects chronological voids (>30 days of unrecorded activity) where an adversary could argue abandonment.
 * - Formulates the strongest counter-argument hypothesis and prescribes concrete remedial evidence to gather.
 */

import type { Case, CaseEvent, Claim, Evidence, Workspace } from '@domain/models';
import { daysBetween, normalizeDate } from '@domain/normalize/dates';
import { runAnalysis } from '@domain/rules/engine';

export type VulnerabilityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface BlindSpot {
  id: string;
  title: string;
  description: string;
  severity: VulnerabilityLevel;
  category: 'UNSUPPORTED_CLAIM' | 'TIMELINE_GAP' | 'VERBAL_AMBIGUITY' | 'MISSING_CONFIRMATION' | 'ORPHAN_EVIDENCE';
  counterpartyArgument: string;
  suggestedRemedy: string;
  relatedClaimIds: string[];
  relatedEvidenceIds: string[];
}

export interface TimeGap {
  fromDate: string;
  toDate: string;
  days: number;
  description: string;
}

export interface OpposingNarrativeReport {
  caseId: string;
  overallVulnerability: VulnerabilityLevel;
  vulnerabilityScore: number; // 0 (impenetrable) to 100 (highly vulnerable)
  counterpartyDefenseHypothesis: string;
  blindSpots: BlindSpot[];
  unaddressedTimeGaps: TimeGap[];
  strengths: string[];
}

export function simulateOpposingNarrative(workspace: Workspace, caseId: string): OpposingNarrativeReport {
  const cId = caseId;
  const claims = workspace.claims.filter((c) => c.caseId === cId && !c.deletedAt);
  const evidenceList = workspace.evidence.filter((e) => e.caseId === cId && !e.deletedAt);
  const events = workspace.events.filter((ev) => ev.caseId === cId && !ev.deletedAt);
  const relationships = workspace.relationships.filter((r) => r.caseId === cId);
  const getRelFrom = (r: any): { kind?: string; id?: string } => r.from ?? r.source ?? {};
  const getRelTo = (r: any): { kind?: string; id?: string } => r.to ?? r.target ?? {};
  const getRelType = (r: any): string => r.type ?? r.relationType ?? '';

  const blindSpots: BlindSpot[] = [];
  const strengths: string[] = [];
  let vulnerabilityScore = 0;

  // 1. Evaluate Claim Backing & Verbal Ambiguity
  for (const clm of claims) {
    const supportingLinks = relationships.filter((r) => {
      const to = getRelTo(r);
      return to.kind === 'claim' && to.id === clm.id && getRelType(r) === 'SUPPORTS';
    });
    const supportingEvidenceIds = supportingLinks
      .map(getRelFrom)
      .filter((from) => from.kind === 'evidence' && Boolean(from.id))
      .map((from) => from.id as string);

    const backingEvidence = evidenceList.filter((e) => supportingEvidenceIds.includes(e.id));
    const isOnlyNotes = backingEvidence.every((e) => e.kind === 'NOTE');

    if (backingEvidence.length === 0) {
      blindSpots.push({
        id: `spot_${clm.id}`,
        title: `Unsupported Claim: "${clm.statement.slice(0, 45)}..."`,
        description: 'This claim lacks any linked supporting documentation or third-party records.',
        severity: 'HIGH',
        category: 'UNSUPPORTED_CLAIM',
        counterpartyArgument: 'The opposing party will argue this is an unsubstantiated subjective assertion with zero evidentiary backing.',
        suggestedRemedy: 'Attach bank debits, email threads, contracts, or signed acknowledgments.',
        relatedClaimIds: [clm.id],
        relatedEvidenceIds: [],
      });
      vulnerabilityScore += 25;
    } else if (isOnlyNotes) {
      blindSpots.push({
        id: `spot_note_${clm.id}`,
        title: `Self-Serving Note: "${clm.statement.slice(0, 45)}..."`,
        description: 'This claim is supported only by typed notes rather than objective external evidence.',
        severity: 'MEDIUM',
        category: 'VERBAL_AMBIGUITY',
        counterpartyArgument: 'Opposing counsel will characterize this as self-serving hearsay created after the fact.',
        suggestedRemedy: 'Corroborate your notes with contemporaneous text messages, timestamps, or witness memos.',
        relatedClaimIds: [clm.id],
        relatedEvidenceIds: backingEvidence.map((e) => e.id),
      });
      vulnerabilityScore += 15;
    } else {
      strengths.push(`Claim "${clm.statement.slice(0, 35)}..." is supported by ${backingEvidence.length} objective document(s).`);
    }
  }

  // 2. Chronological Void / Timeline Gap Detection
  const unaddressedTimeGaps: TimeGap[] = [];
  const datedEvents = events
    .map((e) => {
      const dateVal = e.occurredAt?.iso ?? (e as any).date;
      if (!dateVal || typeof dateVal !== 'string') return null;
      const norm = normalizeDate(dateVal);
      return norm.iso ? { ...e, normDate: norm } : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => (a.normDate.iso ?? '').localeCompare(b.normDate.iso ?? ''));

  for (let i = 0; i < datedEvents.length - 1; i++) {
    const curr = datedEvents[i]!;
    const next = datedEvents[i + 1]!;
    const gap = daysBetween(curr.normDate, next.normDate);

    if (gap !== null && gap > 35) {
      const gapDesc = `${gap} days elapsed between "${curr.title}" and "${next.title}" without recorded activity.`;
      unaddressedTimeGaps.push({
        fromDate: curr.normDate.iso ?? '',
        toDate: next.normDate.iso ?? '',
        days: gap,
        description: gapDesc,
      });

      blindSpots.push({
        id: `spot_gap_${curr.id}_${next.id}`,
        title: `Critical Chronological Gap (${gap} Days)`,
        description: gapDesc,
        severity: gap > 90 ? 'HIGH' : 'MEDIUM',
        category: 'TIMELINE_GAP',
        counterpartyArgument: `Opposing party will argue that the ${gap}-day silence implies tacit acceptance or failure to mitigate damages.`,
        suggestedRemedy: 'Document any phone calls, follow-up messages, or reasons for delay during this window.',
        relatedClaimIds: [],
        relatedEvidenceIds: [],
      });
      vulnerabilityScore += gap > 90 ? 20 : 10;
    }
  }

  // 3. Orphan Evidence Check (Evidence not connected to any claim or event)
  for (const evd of evidenceList) {
    const isLinked = relationships.some((r) => {
      const from = getRelFrom(r);
      const to = getRelTo(r);
      return (
        (from.kind === 'evidence' && from.id === evd.id) ||
        (to.kind === 'evidence' && to.id === evd.id)
      );
    });
    if (!isLinked && evidenceList.length > 1) {
      blindSpots.push({
        id: `spot_orphan_${evd.id}`,
        title: `Unlinked Evidence: "${evd.title}"`,
        description: 'This file is uploaded to the case but has no stated relationship to any claim or event.',
        severity: 'LOW',
        category: 'ORPHAN_EVIDENCE',
        counterpartyArgument: 'Adversary will argue this file is irrelevant clutter introduced to confuse the record.',
        suggestedRemedy: 'Link this evidence to a specific claim statement or timeline event.',
        relatedClaimIds: [],
        relatedEvidenceIds: [evd.id],
      });
      vulnerabilityScore += 5;
    }
  }

  // 4. Run standard deterministic rules to fold in rule-detected conflicts
  const analysisRun = runAnalysis(workspace, caseId, Date.now());
  const conflicts = analysisRun.results.filter((r) => r.resultType === 'POSSIBLE_CONFLICT');
  for (const c of conflicts) {
    blindSpots.push({
      id: `spot_conflict_${c.id}`,
      title: `Direct Contradiction: ${c.title}`,
      description: c.explanation,
      severity: c.severity === 'HIGH' ? 'CRITICAL' : 'HIGH',
      category: 'MISSING_CONFIRMATION',
      counterpartyArgument: 'Opposing party will seize upon this internal discrepancy to impeach your overall credibility.',
      suggestedRemedy: 'Clarify the reason for this numerical or date difference before presenting the case.',
      relatedClaimIds: c.relatedClaimIds,
      relatedEvidenceIds: c.supportingEvidenceIds,
    });
    vulnerabilityScore += c.severity === 'HIGH' ? 30 : 20;
  }

  vulnerabilityScore = Math.min(100, vulnerabilityScore);

  let overallVulnerability: VulnerabilityLevel = 'LOW';
  if (vulnerabilityScore >= 70) overallVulnerability = 'CRITICAL';
  else if (vulnerabilityScore >= 45) overallVulnerability = 'HIGH';
  else if (vulnerabilityScore >= 20) overallVulnerability = 'MEDIUM';

  // 5. Synthesize Counterparty Defense Hypothesis
  let counterpartyDefenseHypothesis = 'The opposing party has limited room for procedural evasion, as core claims are backed by objective records.';
  if (blindSpots.some((b) => b.category === 'MISSING_CONFIRMATION')) {
    counterpartyDefenseHypothesis = 'The opposing party will focus on existing contradictory dates or amounts in your records to discredit your narrative.';
  } else if (blindSpots.some((b) => b.category === 'UNSUPPORTED_CLAIM')) {
    counterpartyDefenseHypothesis = 'The opposing party will claim failure of burden of proof, attacking uncorroborated assertions as speculation.';
  } else if (unaddressedTimeGaps.length > 0) {
    counterpartyDefenseHypothesis = 'The opposing party will argue unreasonable delay, laches, or implied waiver due to substantial timeline gaps.';
  }

  return {
    caseId,
    overallVulnerability,
    vulnerabilityScore,
    counterpartyDefenseHypothesis,
    blindSpots,
    unaddressedTimeGaps,
    strengths,
  };
}
