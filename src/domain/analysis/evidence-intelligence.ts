import type { CaseCitation, Evidence, Extraction, Workspace } from '../models';
import { formatDate, normalizeDate } from '../normalize/dates';
import { formatAmount } from '../normalize/money';
import { normalizeIdentifier } from '../normalize/text';
import { quoteNamesEntity } from './report-entities';
import {
  classifyAmountDiscrepancy,
  classifyDateDiscrepancy,
  classifyStatusDiscrepancy,
  type AmountConflictClassification,
  type DateConflictClassification,
  type StatusConflictClassification,
} from './conflict-classification';
import { analyzeEvidenceIndependence } from './independence';
import { buildRuleContext } from '../rules/engine';

/**
 * A candidate assertion automatically discovered from evidence.
 *
 * Can be promoted by the user into a formal case claim with a single tap.
 */
export interface DiscoveredAssertion {
  id: string;
  statement: string;
  detail: string;
  kind: 'TRANSACTION' | 'BILLING' | 'STATUS' | 'COMMUNICATION' | 'DISCREPANCY';
  corroboration: 'CORROBORATED' | 'SINGLE_SOURCE' | 'CONTRADICTED';
  sourceEvidenceIds: string[];
  citations: CaseCitation[];
  groundingFact: string;
}

/**
 * A timeline event reconstructed directly from evidence facts.
 */
export interface ReconstructedEvent {
  id: string;
  title: string;
  description: string;
  occurredAt: string | null;
  sortKey: string;
  evidenceId: string;
  citations: CaseCitation[];
}

/**
 * An entity resolved across multiple evidence items.
 */
export interface ResolvedEntity {
  name: string;
  type: 'PERSON' | 'ORG' | 'TRANSACTION' | 'DOCUMENT' | 'LOCATION';
  occurrences: number;
  evidenceIds: string[];
  citations: CaseCitation[];
}

/**
 * An identified gap in evidence completeness with guided request for additional proof.
 */
export interface CompletenessGap {
  id: string;
  title: string;
  question: string;
  suggestedAction: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  relatedEvidenceIds: string[];
}

/**
 * Complete evidence intelligence summary for a case.
 */
export interface EvidenceIntelligenceReport {
  discoveredAssertions: DiscoveredAssertion[];
  reconstructedTimeline: ReconstructedEvent[];
  resolvedEntities: ResolvedEntity[];
  completenessGaps: CompletenessGap[];
  independence: {
    totalSources: number;
    independentSources: number;
    ratio: number;
    warnings: string[];
  };
}

/**
 * Builds a valid citation for a text match within an evidence item's segments.
 */
function buildCitationFor(
  evidence: Evidence,
  needle: string,
  stance: CaseCitation['stance'] = 'CONTEXT',
): CaseCitation | null {
  if (!evidence.extraction?.segments?.length || !needle.trim()) return null;
  const target = needle.trim().toLowerCase();

  for (const segment of evidence.extraction.segments) {
    const text = segment.text || '';
    const idx = text.toLowerCase().indexOf(target);
    if (idx >= 0) {
      const raw = text.slice(idx, Math.min(text.length, idx + 140));
      const trailWs = raw.length - raw.trimEnd().length;
      const quote = raw.slice(0, raw.length - trailWs);
      if (!quote) continue;
      const startOffset = segment.startOffset + idx;
      const endOffset = startOffset + quote.length;
      if (endOffset > startOffset) {
        return {
          evidenceId: evidence.id,
          segmentId: segment.id,
          quote,
          startOffset,
          endOffset,
          stance,
        };
      }
    }
  }

  // Fallback to first non-empty segment if exact needle is not found as a contiguous block
  for (const first of evidence.extraction.segments) {
    const raw = first.text || '';
    const leadWs = raw.length - raw.trimStart().length;
    const trailWs = raw.length - raw.trimEnd().length;
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const quote = trimmed.slice(0, Math.min(trimmed.length, 120));
      const startOffset = first.startOffset + leadWs;
      const endOffset = startOffset + quote.length;
      if (endOffset > startOffset) {
        return {
          evidenceId: evidence.id,
          segmentId: first.id,
          quote,
          startOffset,
          endOffset,
          stance,
        };
      }
    }
  }

  return null;
}

/**
 * Discovers candidate assertions from evidence items without requiring the user
 * to manually write every claim.
 */
export function discoverCandidateAssertions(evidenceList: readonly Evidence[]): DiscoveredAssertion[] {
  const assertions: DiscoveredAssertion[] = [];
  const seenKeys = new Set<string>();

  for (const item of evidenceList) {
    const ext = item.extraction;
    if (!ext) continue;

    // 1. Transaction assertions
    for (const tx of ext.transactionIds) {
      const normTx = tx.normalized;
      if (!normTx || seenKeys.has(`tx:${normTx}`)) continue;
      seenKeys.add(`tx:${normTx}`);

      const matchingAmount = ext.amounts[0];
      const matchingDate = ext.dates[0];
      const matchingParty = ext.organizations[0] || ext.parties[0];

      let statement = `Transaction reference ${tx.original} was recorded`;
      if (matchingAmount) statement += ` for ${formatAmount(matchingAmount)}`;
      if (matchingParty) statement += ` with ${matchingParty.original}`;
      if (matchingDate) statement += ` on ${formatDate(matchingDate)}`;
      statement += '.';

      const cit = buildCitationFor(item, tx.original, 'SUPPORTS');
      assertions.push({
        id: `assertion_tx_${normTx.slice(0, 20)}`,
        statement,
        detail: `Extracted from ${item.title}. Transaction reference ${tx.original}.`,
        kind: 'TRANSACTION',
        corroboration: 'SINGLE_SOURCE',
        sourceEvidenceIds: [item.id],
        citations: cit ? [cit] : [],
        groundingFact: `Transaction ID ${tx.original}`,
      });
    }

    // 2. Invoice / Billing assertions
    for (const inv of ext.invoiceNumbers) {
      const normInv = inv.normalized;
      if (!normInv || seenKeys.has(`inv:${normInv}`)) continue;
      seenKeys.add(`inv:${normInv}`);

      const matchingAmount = ext.amounts.find((a) => a.role === 'total') || ext.amounts[0];
      const matchingDate = ext.dates.find((d) => d.role === 'issued') || ext.dates[0];

      let statement = `Invoice ${inv.original} was issued`;
      if (matchingAmount) statement += ` for ${formatAmount(matchingAmount)}`;
      if (matchingDate) statement += ` on ${formatDate(matchingDate)}`;
      statement += '.';

      const cit = buildCitationFor(item, inv.original, 'SUPPORTS');
      assertions.push({
        id: `assertion_inv_${normInv.slice(0, 20)}`,
        statement,
        detail: `Extracted from ${item.title}. Invoice number ${inv.original}.`,
        kind: 'BILLING',
        corroboration: 'SINGLE_SOURCE',
        sourceEvidenceIds: [item.id],
        citations: cit ? [cit] : [],
        groundingFact: `Invoice ${inv.original}`,
      });
    }

    // 3. Stated transaction status assertions (especially FAILED / PENDING)
    if (ext.transactionStatus && ext.transactionStatus !== 'UNKNOWN') {
      const key = `status:${item.id}:${ext.transactionStatus}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        const cit = buildCitationFor(item, ext.transactionStatus, 'SUPPORTS');
        assertions.push({
          id: `assertion_status_${item.id.slice(-6)}`,
          statement: `Transaction status in "${item.title}" is recorded as ${ext.transactionStatus}.`,
          detail: `Extracted from document status indicator in "${item.title}".`,
          kind: 'STATUS',
          corroboration: ext.transactionStatus === 'FAILED' ? 'CONTRADICTED' : 'SINGLE_SOURCE',
          sourceEvidenceIds: [item.id],
          citations: cit ? [cit] : [],
          groundingFact: `Status: ${ext.transactionStatus}`,
        });
      }
    }
  }

  // Cross-check assertions across multiple sources to update corroboration
  for (const assertion of assertions) {
    if (assertion.groundingFact.startsWith('Transaction ID')) {
      const rawId = assertion.groundingFact.replace('Transaction ID ', '').trim();
      const normId = normalizeIdentifier(rawId);
      const otherSources = evidenceList.filter(
        (e) =>
          !assertion.sourceEvidenceIds.includes(e.id) &&
          e.extraction?.transactionIds.some((t) => normalizeIdentifier(t.normalized) === normId),
      );
      if (otherSources.length > 0) {
        assertion.corroboration = 'CORROBORATED';
        for (const other of otherSources) {
          assertion.sourceEvidenceIds.push(other.id);
          const cit = buildCitationFor(other, rawId, 'SUPPORTS') || buildCitationFor(other, normId, 'SUPPORTS');
          if (cit) assertion.citations.push(cit);
        }
      }
    } else if (assertion.groundingFact.startsWith('Invoice')) {
      const rawInv = assertion.groundingFact.replace('Invoice ', '').trim();
      const normInv = normalizeIdentifier(rawInv);
      const otherSources = evidenceList.filter(
        (e) =>
          !assertion.sourceEvidenceIds.includes(e.id) &&
          e.extraction?.invoiceNumbers.some((inv) => normalizeIdentifier(inv.normalized) === normInv),
      );
      if (otherSources.length > 0) {
        assertion.corroboration = 'CORROBORATED';
        for (const other of otherSources) {
          assertion.sourceEvidenceIds.push(other.id);
          const cit = buildCitationFor(other, rawInv, 'SUPPORTS') || buildCitationFor(other, normInv, 'SUPPORTS');
          if (cit) assertion.citations.push(cit);
        }
      }
    }
  }

  return assertions.slice(0, 20);
}

/**
 * Reconstructs a chronological event timeline from evidence items.
 */
export function reconstructTimelineFromEvidence(evidenceList: readonly Evidence[]): ReconstructedEvent[] {
  const events: ReconstructedEvent[] = [];
  const seen = new Set<string>();

  for (const item of evidenceList) {
    const ext = item.extraction;
    if (!ext) continue;

    // 1. Extracted document dates
    for (const date of ext.dates) {
      if (!date.iso) continue;
      const key = `${date.iso}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const roleStr = date.role ? ` · ${date.role}` : '';
      const cit = buildCitationFor(item, date.original, 'CONTEXT');
      if (!cit) continue;

      events.push({
        id: `rec_date_${item.id.slice(-4)}_${events.length}`,
        title: `${item.title}${roleStr}`,
        description: `Date recorded in "${item.title}": ${date.original}.`,
        occurredAt: date.iso,
        sortKey: date.iso,
        evidenceId: item.id,
        citations: [cit],
      });
    }

    // 2. Chat messages with timestamps
    for (const msg of ext.chatMessages.slice(0, 10)) {
      if (!msg.timestamp) continue;
      const key = `${msg.timestamp}:${msg.sender}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const cit = buildCitationFor(item, msg.content.slice(0, 40), 'CONTEXT');
      if (!cit) continue;

      events.push({
        id: `rec_msg_${item.id.slice(-4)}_${events.length}`,
        title: `Message from ${msg.sender}`,
        description: msg.content.length > 100 ? `${msg.content.slice(0, 100)}…` : msg.content,
        occurredAt: msg.timestamp,
        sortKey: msg.timestamp.slice(0, 10),
        evidenceId: item.id,
        citations: [cit],
      });
    }
  }

  events.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return events.slice(0, 50);
}

/**
 * Resolves named entities (people, orgs, transactions) across evidence items
 * with citations that strictly satisfy `quoteNamesEntity`.
 */
export function resolveEntitiesFromEvidence(
  evidenceList: readonly Evidence[],
  participants: readonly { name: string; role?: string }[] = [],
): ResolvedEntity[] {
  const entityMap = new Map<
    string,
    { name: string; type: ResolvedEntity['type']; evidenceIds: Set<string>; citations: CaseCitation[] }
  >();

  function register(name: string, type: ResolvedEntity['type'], evidence: Evidence) {
    const trimmed = name.trim();
    if (trimmed.length < 2) return;
    const norm = trimmed.toLowerCase();

    // Check existing
    let existing = entityMap.get(norm);
    if (!existing) {
      existing = { name: trimmed, type, evidenceIds: new Set(), citations: [] };
      entityMap.set(norm, existing);
    }
    existing.evidenceIds.add(evidence.id);

    // Find citation satisfying quoteNamesEntity
    if (evidence.extraction?.segments) {
      for (const seg of evidence.extraction.segments) {
        if (quoteNamesEntity(seg.text, trimmed)) {
          const idx = seg.text.toLowerCase().indexOf(trimmed.toLowerCase());
          const start = Math.max(0, idx - 20);
          const end = Math.min(seg.text.length, idx + trimmed.length + 40);
          const quote = seg.text.slice(start, end).trim();
          if (quote && quoteNamesEntity(quote, trimmed)) {
            const startOffset = seg.startOffset + start;
            const endOffset = startOffset + quote.length;
            if (endOffset > startOffset && !existing.citations.some((c) => c.quote === quote)) {
              existing.citations.push({
                evidenceId: evidence.id,
                segmentId: seg.id,
                quote,
                startOffset,
                endOffset,
                stance: 'CONTEXT',
              });
              break;
            }
          }
        }
      }
    }
  }

  // 1. Registered participants
  for (const p of participants) {
    for (const item of evidenceList) {
      register(p.name, 'PERSON', item);
    }
  }

  // 2. Extracted entities
  for (const item of evidenceList) {
    const ext = item.extraction;
    if (!ext) continue;

    for (const p of ext.people) register(p.original, 'PERSON', item);
    for (const o of ext.organizations) register(o.original, 'ORG', item);
    for (const t of ext.transactionIds) register(t.original, 'TRANSACTION', item);
    for (const inv of ext.invoiceNumbers) register(inv.original, 'DOCUMENT', item);
  }

  const result: ResolvedEntity[] = [];
  for (const [, val] of entityMap) {
    // Only return entities that have at least one verified citation
    if (val.citations.length > 0) {
      result.push({
        name: val.name,
        type: val.type,
        occurrences: val.evidenceIds.size,
        evidenceIds: [...val.evidenceIds],
        citations: val.citations.slice(0, 10),
      });
    }
  }

  result.sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));
  return result.slice(0, 40);
}

/**
 * Evaluates completeness of evidence and generates guided missing-information requests.
 */
export function evaluateEvidenceCompleteness(
  evidenceList: readonly Evidence[],
  claimsCount: number,
): CompletenessGap[] {
  const gaps: CompletenessGap[] = [];

  const hasInvoice = evidenceList.some((e) => (e.extraction?.invoiceNumbers.length ?? 0) > 0);
  const hasPayment = evidenceList.some(
    (e) => (e.extraction?.transactionIds.length ?? 0) > 0 || e.extraction?.amounts.some((a) => a.role === 'paid'),
  );
  const hasFailedStatus = evidenceList.some((e) => e.extraction?.transactionStatus === 'FAILED');
  const hasChat = evidenceList.some((e) => (e.extraction?.chatMessages.length ?? 0) > 0);

  if (hasInvoice && !hasPayment) {
    gaps.push({
      id: 'gap_missing_payment',
      title: 'Missing payment confirmation',
      question: 'An invoice is present, but no payment receipt, debit notification, or UTR confirmation has been submitted.',
      suggestedAction: 'Upload a bank statement line, payment receipt, or payment gateway confirmation showing settlement.',
      severity: 'HIGH',
      relatedEvidenceIds: evidenceList.filter((e) => (e.extraction?.invoiceNumbers.length ?? 0) > 0).map((e) => e.id),
    });
  }

  if (hasPayment && !hasInvoice) {
    gaps.push({
      id: 'gap_missing_invoice',
      title: 'Missing underlying invoice or agreement',
      question: 'A payment record is present, but no corresponding bill, invoice, or commercial contract explaining the basis of the charge has been submitted.',
      suggestedAction: 'Upload the vendor bill, contract, or email correspondence establishing the agreed amount.',
      severity: 'MEDIUM',
      relatedEvidenceIds: evidenceList.filter((e) => (e.extraction?.transactionIds.length ?? 0) > 0).map((e) => e.id),
    });
  }

  if (hasFailedStatus) {
    gaps.push({
      id: 'gap_failed_resolution',
      title: 'Unresolved failed transaction',
      question: 'At least one record indicates a transaction failure or reversal.',
      suggestedAction: 'Upload subsequent bank account reconciliation or refund confirmation to establish whether funds were returned or settled.',
      severity: 'HIGH',
      relatedEvidenceIds: evidenceList.filter((e) => e.extraction?.transactionStatus === 'FAILED').map((e) => e.id),
    });
  }

  if (hasChat && !hasPayment && !hasInvoice) {
    gaps.push({
      id: 'gap_only_chat',
      title: 'Only communication evidence present',
      question: 'The submitted evidence consists of messages without external documentary records.',
      suggestedAction: 'Upload official financial records or written agreements to corroborate statements made in messages.',
      severity: 'MEDIUM',
      relatedEvidenceIds: evidenceList.map((e) => e.id),
    });
  }

  return gaps;
}

/**
 * Runs complete evidence intelligence on a case.
 */
export function runEvidenceIntelligence(
  workspace: Workspace,
  caseId: string,
): EvidenceIntelligenceReport {
  const context = buildRuleContext(workspace, caseId);
  const evidenceList = context.evidence.filter((e) => !e.deletedAt);
  const caseRecord = workspace.cases.find((c) => c.id === caseId);
  const claims = workspace.claims.filter((c) => c.caseId === caseId && !c.deletedAt);

  const independence = analyzeEvidenceIndependence(context, evidenceList);
  const discoveredAssertions = discoverCandidateAssertions(evidenceList);
  const reconstructedTimeline = reconstructTimelineFromEvidence(evidenceList);
  const resolvedEntities = resolveEntitiesFromEvidence(evidenceList, caseRecord?.participants ?? []);
  const completenessGaps = evaluateEvidenceCompleteness(evidenceList, claims.length);

  return {
    discoveredAssertions,
    reconstructedTimeline,
    resolvedEntities,
    completenessGaps,
    independence: {
      totalSources: independence.totalSources,
      independentSources: independence.independentSourcesCount,
      ratio: independence.independenceRatio,
      warnings: independence.warnings,
    },
  };
}
