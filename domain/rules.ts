import type { AnalysisResult, ClaimState, Evidence, EvidenceRelationship, RuleDefinition, Workspace } from './models';
import { effectiveExtraction } from './normalization';

export const ruleDefinitions: RuleDefinition[] = [
  { id: 'exact-duplicate-v1', description: 'Identical source bytes', condition: 'SHA-256 equality', priority: 100, enabled: true, actionType: 'DUPLICATE_EVIDENCE' },
  { id: 'invoice-related-v1', description: 'Matching invoice identifier', condition: 'Normalized invoice equality', priority: 50, enabled: true, actionType: 'RELATED_EVIDENCE' },
  { id: 'transaction-related-v1', description: 'Matching transaction identifier', condition: 'Normalized transaction equality', priority: 50, enabled: true, actionType: 'RELATED_EVIDENCE' },
  { id: 'amount-mismatch-v1', description: 'Different amounts on matching records', condition: 'Same identifier/currency and difference > 1% (minimum 1 minor unit)', priority: 90, enabled: true, actionType: 'AMOUNT_MISMATCH' },
  { id: 'unsupported-claim-v1', description: 'Claim without supporting evidence', condition: 'No incoming SUPPORTS evidence link', priority: 80, enabled: true, actionType: 'UNSUPPORTED_CLAIM' },
  { id: 'missing-event-source-v1', description: 'Required event without evidence', condition: 'Required event has no evidence link', priority: 80, enabled: true, actionType: 'MISSING_EVIDENCE' },
  { id: 'event-date-conflict-v1', description: 'Sources linked to one event report different dates', condition: 'Different exact dates across source records; possible, not proven, conflict', priority: 95, enabled: true, actionType: 'POSSIBLE_CONFLICT' },
  { id: 'event-corroboration-v1', description: 'Multiple independent supporting sources', condition: 'Two non-duplicate, non-derived sources explicitly SUPPORT one event', priority: 40, enabled: true, actionType: 'CORROBORATED_EVENT' },
];
export function stableId(...parts: string[]): string {
  const text = parts.join('|');
  let first = 2166136261, second = 5381;
  for (let i = 0; i < text.length; i++) { first = Math.imul(first ^ text.charCodeAt(i), 16777619); second = Math.imul(second, 33) ^ text.charCodeAt(i); }
  return `r_${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}
export function activeLinks(data: Workspace, caseId: string): EvidenceRelationship[] {
  const live = new Set(data.evidence.filter(e => e.caseId === caseId && !e.deletedAt).map(e => e.id));
  return data.relationships.filter(r => r.caseId === caseId && (r.from.kind !== 'evidence' || live.has(r.from.id)) && (r.to.kind !== 'evidence' || live.has(r.to.id)));
}
export function claimState(data: Workspace, claimId: string): ClaimState {
  const claim = data.claims.find(c => c.id === claimId);
  if (!claim) return 'UNSUPPORTED';
  const links = activeLinks(data, claim.caseId).filter(r => r.to.id === claimId && r.to.kind === 'claim' && r.from.kind === 'evidence');
  const supports = links.some(r => r.type === 'SUPPORTS');
  const contradictions = links.filter(r => r.type === 'CONTRADICTS');
  if (supports && contradictions.length) return 'MIXED_REVIEW';
  if (contradictions.some(r => r.material)) return 'CONTRADICTED';
  if (contradictions.length) return 'MIXED_REVIEW';
  return supports ? 'SUPPORTED' : 'UNSUPPORTED';
}
export function analyze(data: Workspace, caseId: string, now: number, definitions = ruleDefinitions): AnalysisResult[] {
  const parent = data.cases.find(c => c.id === caseId);
  if (!parent) throw new Error('Case not found');
  const enabled = new Map(definitions.filter(r => r.enabled).map(r => [r.id, r]));
  const evidence = data.evidence.filter(e => e.caseId === caseId && !e.deletedAt).sort((a, b) => a.id.localeCompare(b.id));
  const links = activeLinks(data, caseId);
  const results: AnalysisResult[] = [];
  const emit = (ruleId: string, keys: string[], details: Pick<AnalysisResult, 'title' | 'explanation' | 'severity' | 'supportingEvidenceIds' | 'relatedClaimIds' | 'relatedEventIds' | 'inputs' | 'confidence'>) => {
    const rule = enabled.get(ruleId); if (!rule) return;
    const id = stableId(caseId, ruleId, ...keys.slice().sort(), JSON.stringify(details.inputs));
    const previous = data.analysisResults.find(r => r.id === id);
    results.push({ id, ownerId: parent.ownerId, caseId, createdAt: previous?.createdAt ?? now, updatedAt: now, resultType: rule.actionType, triggeredRuleIds: [ruleId], aiSuggestionIds: [], status: previous && previous.status !== 'RESOLVED' ? previous.status : 'OPEN', ...details });
  };
  const pairDetails = (a: Evidence, b: Evidence) => ({ supportingEvidenceIds: [a.id, b.id], relatedClaimIds: [], relatedEventIds: [], inputs: { firstSource: a.title, secondSource: b.title } });
  for (let i = 0; i < evidence.length; i++) for (let j = i + 1; j < evidence.length; j++) {
    const a = evidence[i]!, b = evidence[j]!;
    if (a.hash && a.hash === b.hash) emit('exact-duplicate-v1', [a.id, b.id], { ...pairDetails(a, b), title: 'Exact duplicate source', explanation: `${a.title} and ${b.title} have the same SHA-256 fingerprint. Do not count them as independent support.`, severity: 'LOW', confidence: 'Exact Match', inputs: { ...pairDetails(a, b).inputs, sha256: a.hash } });
    const ax = effectiveExtraction(a), bx = effectiveExtraction(b); if (!ax || !bx) continue;
    let matching = false;
    for (const [field, rule] of [['invoiceNumbers', 'invoice-related-v1'], ['transactionIds', 'transaction-related-v1']] as const) {
      const common = ax[field].map(f => f.value).filter(v => bx[field].some(f => f.value === v)).sort();
      if (common.length) { matching = true; emit(rule, [a.id, b.id], { ...pairDetails(a, b), title: 'Related source identifiers', explanation: `Both sources contain ${common.join(', ')}. This links their subject matter; it does not establish independent corroboration.`, severity: 'INFO', confidence: 'Exact Match', inputs: { ...pairDetails(a, b).inputs, identifier: common.join(', ') } }); }
    }
    if (matching && ax.amounts.length === 1 && bx.amounts.length === 1) {
      const x = ax.amounts[0]!, y = bx.amounts[0]!;
      if (x.currency === y.currency && Math.abs(x.minorUnits - y.minorUnits) > Math.max(1, Math.max(Math.abs(x.minorUnits), Math.abs(y.minorUnits)) * 0.01)) emit('amount-mismatch-v1', [a.id, b.id], { ...pairDetails(a, b), title: 'Matching records, different amounts', explanation: `The matching identifiers have different ${x.currency} amounts (${x.original} versus ${y.original}). Partial payments or fees may explain the difference; review both sources.`, severity: 'HIGH', confidence: 'Needs Review', inputs: { firstAmount: String(x.minorUnits), secondAmount: String(y.minorUnits), currency: x.currency } });
    }
  }
  for (const claim of data.claims.filter(c => c.caseId === caseId).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!links.some(r => r.to.kind === 'claim' && r.to.id === claim.id && r.from.kind === 'evidence' && r.type === 'SUPPORTS')) emit('unsupported-claim-v1', [claim.id], { title: 'Claim needs supporting evidence', explanation: `“${claim.statement}” currently has no supporting evidence link. Add a relevant source and explain its connection.`, severity: 'MEDIUM', confidence: 'Needs Review', supportingEvidenceIds: [], relatedClaimIds: [claim.id], relatedEventIds: [], inputs: { claim: claim.statement } });
    for (const eventId of [...claim.requiredEventIds].sort()) if (!links.some(r => r.to.kind === 'event' && r.to.id === eventId && r.from.kind === 'evidence' && ['SUPPORTS', 'ATTACHED_TO_EVENT'].includes(r.type))) emit('missing-event-source-v1', [claim.id, eventId], { title: 'Required event has no source', explanation: `The event “${data.events.find(e => e.id === eventId)?.title ?? eventId}” is required by this claim but has no attached/supporting evidence. A receipt, message or contemporaneous note would make it inspectable.`, severity: 'MEDIUM', confidence: 'Needs Review', supportingEvidenceIds: [], relatedClaimIds: [claim.id], relatedEventIds: [eventId], inputs: { claim: claim.statement, requiredEvent: eventId } });
  }
  for (const event of data.events.filter(e => e.caseId === caseId).sort((a, b) => a.id.localeCompare(b.id))) {
    const sources = evidence.filter(e => links.some(r => r.from.kind === 'evidence' && r.from.id === e.id && r.to.kind === 'event' && r.to.id === event.id && ['SUPPORTS', 'ATTACHED_TO_EVENT'].includes(r.type)));
    const dated = sources.map(e => ({ e, dates: [...new Set(effectiveExtraction(e)?.dates.filter(d => d.precision === 'DAY' && d.iso).map(d => d.iso!) ?? [])].sort() })).filter(d => d.dates.length === 1);
    if (new Set(dated.map(d => d.dates[0])).size > 1) emit('event-date-conflict-v1', [event.id, ...dated.map(d => d.e.id)], { title: 'Sources disagree on an event date', explanation: `${dated.map(d => `${d.e.title}: ${d.dates[0]}`).join('; ')}. These sources are linked to “${event.title}”. Different dates may refer to different stages; verify before changing the event.`, severity: 'HIGH', confidence: 'Needs Review', supportingEvidenceIds: dated.map(d => d.e.id), relatedClaimIds: event.claimIds, relatedEventIds: [event.id], inputs: Object.fromEntries(dated.map(d => [d.e.id, d.dates[0]!])) });
    const supporting = sources.filter(e => e.hash && links.some(r => r.from.id === e.id && r.to.id === event.id && r.type === 'SUPPORTS') && !links.some(r => r.from.id === e.id && ['DERIVED_FROM', 'DUPLICATE_OF'].includes(r.type)));
    const independent = supporting.filter((e, i) => supporting.findIndex(other => other.hash === e.hash) === i);
    if (independent.length >= 2) emit('event-corroboration-v1', [event.id, ...independent.map(e => e.id)], { title: 'Event has multiple supporting sources', explanation: `${independent.length} distinct, non-derived source fingerprints explicitly support “${event.title}”. This is corroboration within this case, not proof that the event occurred.`, severity: 'INFO', confidence: 'Strong Match', supportingEvidenceIds: independent.map(e => e.id), relatedClaimIds: event.claimIds, relatedEventIds: [event.id], inputs: Object.fromEntries(independent.map(e => [e.id, e.hash!])) });
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}
export function applyAnalysis(data: Workspace, caseId: string, now: number): void {
  const current = analyze(data, caseId, now);
  const ids = new Set(current.map(r => r.id));
  data.analysisResults = [...data.analysisResults.filter(r => !ids.has(r.id)).map(r => r.caseId === caseId && r.status === 'OPEN' ? { ...r, status: 'RESOLVED' as const, updatedAt: now } : r), ...current];
  data.conflicts = data.analysisResults.filter(r => ['POSSIBLE_CONFLICT', 'AMOUNT_MISMATCH'].includes(r.resultType)).map(r => ({ id: r.id, ownerId: r.ownerId, caseId: r.caseId, createdAt: r.createdAt, updatedAt: r.updatedAt, analysisResultId: r.id, status: r.status }));
}
