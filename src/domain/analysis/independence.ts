import type { Evidence, Extraction } from '../models';
import type { RuleContext } from '../rules/types';
import { normalizeText } from '../normalize/text';

/**
 * Grounds on which one evidence item is classified as derivative of another.
 */
export type DependencyReason =
  | 'BYTE_IDENTICAL'
  | 'TEXT_DUPLICATE'
  | 'SUBSTRING_EXCERPT'
  | 'SHARED_TRANSACTION_RECORD'
  | 'EXPLICIT_LINK';

export interface DerivativeGroup {
  /** The primary or original source retained as independent. */
  anchorEvidenceId: string;
  /** Sources identified as duplicates or derivatives of the anchor. */
  derivativeEvidenceIds: string[];
  reason: DependencyReason;
  explanation: string;
}

export interface EvidenceIndependenceAnalysis {
  totalSources: number;
  independentSourcesCount: number;
  /** Proportion of sources that are genuinely independent (0.0 to 1.0). */
  independenceRatio: number;
  derivativeGroups: DerivativeGroup[];
  independentEvidenceIds: string[];
  warnings: string[];
}

const DEPENDENT_LINK_TYPES = new Set(['DUPLICATE_OF', 'DERIVED_FROM']);

/**
 * Extracts and normalizes text representation of an evidence item for content comparison.
 */
function cleanContent(item: Evidence): string {
  const raw = item.extraction?.sourceText?.trim() || '';
  if (!raw) return '';
  return normalizeText(raw).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/**
 * Computes word-level Jaccard similarity between two normalized strings.
 */
function tokenJaccard(a: string, b: string): number {
  const wordsA = new Set(a.split(' ').filter((w) => w.length >= 3));
  const wordsB = new Set(b.split(' ').filter((w) => w.length >= 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection += 1;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Checks whether two evidence extractions share the exact same transaction anchor.
 */
function shareTransactionAnchor(extA?: Extraction | null, extB?: Extraction | null): boolean {
  if (!extA || !extB) return false;
  const txA = extA.transactionIds.map((t) => t.normalized).filter(Boolean);
  const txB = extB.transactionIds.map((t) => t.normalized).filter(Boolean);
  if (txA.length === 0 || txB.length === 0) return false;

  const sharedTx = txA.some((id) => txB.includes(id));
  if (!sharedTx) return false;

  // If they share a transaction ID AND have identical dates and amounts, they observe the same transaction
  const amountsA = extA.amounts.map((a) => a.minorUnits);
  const amountsB = extB.amounts.map((b) => b.minorUnits);
  const sharedAmount = amountsA.some((amt) => amountsB.includes(amt));

  const datesA = extA.dates.map((d) => d.iso).filter(Boolean);
  const datesB = extB.dates.map((d) => d.iso).filter(Boolean);
  const sharedDate = datesA.some((date) => datesB.includes(date));

  return sharedTx && sharedAmount && sharedDate;
}

/**
 * Analyzes evidence independence across a set of sources.
 *
 * Prevents multiple screenshots, copies, or crops of the same document from
 * artificially inflating corroboration metrics.
 */
export function analyzeEvidenceIndependence(
  context: RuleContext,
  items: readonly Evidence[],
): EvidenceIndependenceAnalysis {
  const totalSources = items.length;
  if (totalSources <= 1) {
    return {
      totalSources,
      independentSourcesCount: totalSources,
      independenceRatio: 1.0,
      derivativeGroups: [],
      independentEvidenceIds: items.map((e) => e.id),
      warnings: [],
    };
  }

  const present = new Set(items.map((i) => i.id));
  const droppedToAnchor = new Map<string, { anchorId: string; reason: DependencyReason; explanation: string }>();

  // 1. Explicit link dependencies (DUPLICATE_OF, DERIVED_FROM)
  for (const item of items) {
    for (const link of context.linksFrom('evidence', item.id)) {
      if (DEPENDENT_LINK_TYPES.has(link.type) && link.to.kind === 'evidence' && present.has(link.to.id)) {
        droppedToAnchor.set(item.id, {
          anchorId: link.to.id,
          reason: 'EXPLICIT_LINK',
          explanation: `Marked as ${link.type === 'DUPLICATE_OF' ? 'a duplicate' : 'derived from'} an earlier record`,
        });
      }
    }
  }

  // 2. Exact byte hash equality
  const byHash = new Map<string, Evidence[]>();
  for (const item of items) {
    if (droppedToAnchor.has(item.id) || !item.sha256) continue;
    const list = byHash.get(item.sha256) ?? [];
    list.push(item);
    byHash.set(item.sha256, list);
  }

  for (const [, group] of byHash) {
    if (group.length <= 1) continue;
    // Keep the earliest created or alphabetically first ID
    const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const anchor = sorted[0]!;
    for (let i = 1; i < sorted.length; i += 1) {
      const copy = sorted[i]!;
      droppedToAnchor.set(copy.id, {
        anchorId: anchor.id,
        reason: 'BYTE_IDENTICAL',
        explanation: `Byte-for-byte identical file (same SHA-256 fingerprint)`,
      });
    }
  }

  // 3. Extracted text equivalence and substantial substring containment
  const contentMap = new Map<string, string>();
  for (const item of items) {
    if (droppedToAnchor.has(item.id)) continue;
    const content = cleanContent(item);
    if (content.length >= 25) {
      contentMap.set(item.id, content);
    }
  }

  const survivingIds = items.map((i) => i.id).filter((id) => !droppedToAnchor.has(id));

  for (let i = 0; i < survivingIds.length; i += 1) {
    const idA = survivingIds[i]!;
    if (droppedToAnchor.has(idA)) continue;
    const textA = contentMap.get(idA);
    const itemA = items.find((it) => it.id === idA)!;

    for (let j = i + 1; j < survivingIds.length; j += 1) {
      const idB = survivingIds[j]!;
      if (droppedToAnchor.has(idB)) continue;
      const textB = contentMap.get(idB);
      const itemB = items.find((it) => it.id === idB)!;

      // Text duplicate
      if (textA && textB) {
        if (textA === textB) {
          // Exactly identical extracted text
          const anchor = itemA.createdAt <= itemB.createdAt ? itemA : itemB;
          const derivative = anchor === itemA ? itemB : itemA;
          droppedToAnchor.set(derivative.id, {
            anchorId: anchor.id,
            reason: 'TEXT_DUPLICATE',
            explanation: `Identical text content to "${anchor.title}" (duplicate capture or re-extracted text)`,
          });
          if (derivative === itemA) break;
          continue;
        }

        // Substring / cropped excerpt (one text is substantially contained in the other)
        const [longer, shorter] = textA.length >= textB.length ? [itemA, itemB] : [itemB, itemA];
        const textLonger = contentMap.get(longer.id)!;
        const textShorter = contentMap.get(shorter.id)!;

        if (
          textShorter.length >= 40 &&
          textLonger.includes(textShorter) &&
          textShorter.length >= 0.65 * textLonger.length
        ) {
          droppedToAnchor.set(shorter.id, {
            anchorId: longer.id,
            reason: 'SUBSTRING_EXCERPT',
            explanation: `Text excerpt substantially contained within "${longer.title}"`,
          });
          if (shorter === itemA) break;
          continue;
        }

        // High word jaccard similarity (> 0.85) for documents with >= 40 chars
        if (textA.length >= 40 && textB.length >= 40 && tokenJaccard(textA, textB) >= 0.88) {
          const anchor = itemA.createdAt <= itemB.createdAt ? itemA : itemB;
          const derivative = anchor === itemA ? itemB : itemA;
          droppedToAnchor.set(derivative.id, {
            anchorId: anchor.id,
            reason: 'TEXT_DUPLICATE',
            explanation: `Substantially identical text (>88% word overlap) to "${anchor.title}"`,
          });
          if (derivative === itemA) break;
          continue;
        }
      }

      // Shared transaction record co-occurrence
      if (shareTransactionAnchor(itemA.extraction, itemB.extraction)) {
        const anchor = itemA.createdAt <= itemB.createdAt ? itemA : itemB;
        const derivative = anchor === itemA ? itemB : itemA;
        droppedToAnchor.set(derivative.id, {
          anchorId: anchor.id,
          reason: 'SHARED_TRANSACTION_RECORD',
          explanation: `Shared transaction identifier, date, and amount with "${anchor.title}" (multiple captures of one event)`,
        });
        if (derivative === itemA) break;
        continue;
      }
    }
  }

  // Resolve transitive anchor chains (path compression)
  function getRootAnchorId(id: string): string {
    let curr = id;
    const visited = new Set<string>();
    while (droppedToAnchor.has(curr)) {
      if (visited.has(curr)) break;
      visited.add(curr);
      curr = droppedToAnchor.get(curr)!.anchorId;
    }
    return curr;
  }

  for (const [, entry] of droppedToAnchor) {
    entry.anchorId = getRootAnchorId(entry.anchorId);
  }

  // Aggregate derivative groups
  const groupsByAnchor = new Map<string, { reason: DependencyReason; explanation: string; derivativeIds: string[] }>();
  for (const [derivativeId, { anchorId, reason, explanation }] of droppedToAnchor) {
    const existing = groupsByAnchor.get(anchorId);
    if (existing) {
      existing.derivativeIds.push(derivativeId);
    } else {
      groupsByAnchor.set(anchorId, { reason, explanation, derivativeIds: [derivativeId] });
    }
  }

  const derivativeGroups: DerivativeGroup[] = [];
  for (const [anchorId, val] of groupsByAnchor) {
    derivativeGroups.push({
      anchorEvidenceId: anchorId,
      derivativeEvidenceIds: val.derivativeIds,
      reason: val.reason,
      explanation: val.explanation,
    });
  }

  const independentEvidenceIds = items.map((i) => i.id).filter((id) => !droppedToAnchor.has(id));
  const independentSourcesCount = independentEvidenceIds.length;
  const independenceRatio = totalSources === 0 ? 1.0 : Number((independentSourcesCount / totalSources).toFixed(2));

  const warnings: string[] = [];
  if (totalSources > independentSourcesCount) {
    const discounted = totalSources - independentSourcesCount;
    warnings.push(
      `${discounted} ${discounted === 1 ? 'source is' : 'sources are'} discounted as duplicate or derivative captures, leaving ${independentSourcesCount} independent ${independentSourcesCount === 1 ? 'source' : 'sources'} for corroboration.`,
    );
  }

  return {
    totalSources,
    independentSourcesCount,
    independenceRatio,
    derivativeGroups,
    independentEvidenceIds,
    warnings,
  };
}

/**
 * Filters a list of evidence items down to strictly independent sources.
 */
export function filterIndependentSources(
  context: RuleContext,
  items: readonly Evidence[],
): Evidence[] {
  const analysis = analyzeEvidenceIndependence(context, items);
  const allowed = new Set(analysis.independentEvidenceIds);
  return items.filter((item) => allowed.has(item.id));
}
