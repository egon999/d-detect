/**
 * Conversational Evidence Prover Assistant.
 *
 * Provides purposeful evidence reasoning: cross-examination, contradiction hunting,
 * and claim support verification grounded strictly in active case evidence.
 *
 * Implements deterministic rule evaluation with zero credit consumption and zero network
 * dependencies, as well as seamless integration with personal session proxy acceleration.
 */

import type { CaseEvent, Claim, Evidence, EvidenceRelationship, Workspace } from '@domain/models';
import { amountsMateriallyDiffer, formatAmount } from '@domain/normalize/money';
import { normalizeDate } from '@domain/normalize/dates';
import type { GeminiProxyConfig } from './credentials';
import { queryGeminiProxy } from './gemini-proxy';

export interface EvidenceContext {
  caseId?: string;
  evidence: readonly Evidence[];
  claims: readonly Claim[];
  events?: readonly CaseEvent[];
  relationships?: readonly EvidenceRelationship[];
  workspace?: Workspace;
}

export interface ContradictionSummary {
  id?: string;
  title: string;
  explanation: string;
  evidenceIds: string[];
  claimIds?: string[];
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface ProverResponse {
  answer: string;
  supportingEvidenceIds: string[];
  contradictionsFound: ContradictionSummary[];
  confidence: number;
  source: 'proxy' | 'deterministic';
  model?: string;
  durationMs?: number;
}

/**
 * Extracts distinct alphanumeric search tokens (>= 4 chars) from a text string.
 */
function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !['this', 'that', 'with', 'from', 'have', 'were', 'been', 'which', 'about'].includes(w));
}

/**
 * Deterministic evidence prover engine:
 * Evaluates claims against active evidence items, scans for contradictions in dates,
 * amounts, and statements, and produces structured conversational responses.
 */
export function evaluateDeterministicProver(prompt: string, context: EvidenceContext): ProverResponse {
  const started = Date.now();
  const activeEvidence = (context.evidence || []).filter((e) => !e.deletedAt);
  const activeClaims = (context.claims || []).filter((c) => !c.deletedAt);
  const activeRelationships = context.relationships || [];

  const contradictions: ContradictionSummary[] = [];
  const supportingEvidenceIds = new Set<string>();

  // 1. Hunt for Monetary Contradictions across evidence items
  for (let i = 0; i < activeEvidence.length; i++) {
    const e1 = activeEvidence[i]!;
    const amounts1 = e1.extraction?.amounts || [];

    for (let j = i + 1; j < activeEvidence.length; j++) {
      const e2 = activeEvidence[j]!;
      const amounts2 = e2.extraction?.amounts || [];

      for (const a1 of amounts1) {
        for (const a2 of amounts2) {
          if (a1.currency === a2.currency && amountsMateriallyDiffer(a1, a2)) {
            // Check if both refer to payment/invoice/settlement or shared context
            contradictions.push({
              id: `cnt_money_${e1.id}_${e2.id}`,
              title: `Monetary amount discrepancy: ${formatAmount(a1)} vs ${formatAmount(a2)}`,
              explanation: `Document "${e1.title}" specifies ${formatAmount(a1)}, which conflicts with ${formatAmount(a2)} recorded in "${e2.title}".`,
              evidenceIds: [e1.id, e2.id],
              severity: 'HIGH',
            });
          }
        }
      }
    }
  }

  // 2. Check for Amount discrepancies between Claims and Evidence
  for (const claim of activeClaims) {
    const claimLower = claim.statement.toLowerCase();
    for (const ev of activeEvidence) {
      const amounts = ev.extraction?.amounts || [];
      for (const amt of amounts) {
        const formatted = formatAmount(amt).toLowerCase();
        const amtValueStr = amt.original.toLowerCase();
        // If claim mentions money but differs from evidence amount in a related context
        const claimMentionsAmount = claimLower.includes('inr') || claimLower.includes('rs') || claimLower.includes('₹') || /\b\d{3,}\b/.test(claimLower);
        if (claimMentionsAmount && !claimLower.includes(formatted) && !claimLower.includes(amtValueStr)) {
          // Check if this evidence was linked or mentions similar keywords
          const claimWords = extractKeywords(claim.statement);
          const evText = (ev.title + ' ' + (ev.extraction?.sourceText || ev.note)).toLowerCase();
          const matchesWord = claimWords.some((w) => evText.includes(w));
          if (matchesWord && amounts.length > 0) {
            contradictions.push({
              id: `cnt_claim_amt_${claim.id}_${ev.id}`,
              title: `Claim monetary discrepancy against ${ev.title}`,
              explanation: `Claim "${claim.statement}" asserts monetary terms that differ from ${formatAmount(amt)} evidenced in "${ev.title}".`,
              evidenceIds: [ev.id],
              claimIds: [claim.id],
              severity: 'HIGH',
            });
          }
        }
      }
    }
  }

  // 3. Scan for Explicit Relationship Contradictions
  for (const rel of activeRelationships) {
    if (rel.type === 'CONTRADICTS') {
      contradictions.push({
        id: `cnt_rel_${rel.id}`,
        title: rel.note || 'Documented contradiction between case elements',
        explanation: rel.note || `Evidence relationship records a direct contradiction between "${rel.from.id}" and "${rel.to.id}".`,
        evidenceIds: [rel.from.id, rel.to.id],
        severity: rel.material ? 'HIGH' : 'MEDIUM',
      });
    }
  }

  // 4. Scan for Transaction Status Conflicts
  for (const ev of activeEvidence) {
    const status = ev.extraction?.transactionStatus;
    if (status === 'FAILED' || status === 'CANCELLED') {
      contradictions.push({
        id: `cnt_status_${ev.id}`,
        title: `Transaction marked as ${status} in ${ev.title}`,
        explanation: `Evidence "${ev.title}" records transaction status as ${status}, challenging assertions of completed settlement.`,
        evidenceIds: [ev.id],
        severity: 'CRITICAL',
      });
    }
  }

  // 5. Scan for Evidence Disputed Points
  for (const ev of activeEvidence) {
    const disputed = ev.extraction?.disputedPoints || [];
    for (const pt of disputed) {
      contradictions.push({
        id: `cnt_dispute_${ev.id}_${contradictions.length}`,
        title: `Disputed point in ${ev.title}`,
        explanation: `Evidence "${ev.title}" notes dispute: "${pt}".`,
        evidenceIds: [ev.id],
        severity: 'MEDIUM',
      });
    }
  }

  // 6. Verify Claim Support from Evidence
  const supportedClaims: { claim: Claim; evidenceIds: string[] }[] = [];
  const unsupportedClaims: Claim[] = [];

  for (const claim of activeClaims) {
    const claimKeywords = extractKeywords(claim.statement);
    const matchedEvidenceForClaim: string[] = [];

    // Check relationship links
    for (const rel of activeRelationships) {
      if (rel.type === 'SUPPORTS' && rel.to.id === claim.id) {
        matchedEvidenceForClaim.push(rel.from.id);
        supportingEvidenceIds.add(rel.from.id);
      }
    }

    // Keyword & entity matching
    for (const ev of activeEvidence) {
      const evFullText = [
        ev.title,
        ev.note,
        ev.extraction?.sourceText || '',
        ev.extraction?.summary || '',
        ...(ev.extraction?.parties || []).map((p) => p.normalized),
      ]
        .join(' ')
        .toLowerCase();

      const matchedCount = claimKeywords.filter((kw) => evFullText.includes(kw)).length;
      if (claimKeywords.length > 0 && matchedCount >= Math.min(2, claimKeywords.length)) {
        matchedEvidenceForClaim.push(ev.id);
        supportingEvidenceIds.add(ev.id);
      }
    }

    if (matchedEvidenceForClaim.length > 0) {
      supportedClaims.push({ claim, evidenceIds: Array.from(new Set(matchedEvidenceForClaim)) });
    } else {
      unsupportedClaims.push(claim);
    }
  }

  // 7. Conversational Answer Synthesis based on User Prompt
  const promptLower = prompt.toLowerCase();
  const lines: string[] = [];

  lines.push('### Evidence Prover Assessment');
  lines.push(`Evaluated ${activeEvidence.length} active evidence record(s) against ${activeClaims.length} claim(s).`);

  if (promptLower.includes('contradict') || promptLower.includes('disput') || promptLower.includes('conflict') || promptLower.includes('mismatch')) {
    lines.push('\n**Contradiction Analysis:**');
    if (contradictions.length === 0) {
      lines.push('No direct factual contradictions or discrepancies were detected across the current evidence items.');
    } else {
      lines.push(`Identified ${contradictions.length} contradiction(s) requiring examination:`);
      for (const c of contradictions) {
        lines.push(`- **${c.title}** (${c.severity ?? 'MEDIUM'}): ${c.explanation}`);
      }
    }
  } else if (promptLower.includes('claim') || promptLower.includes('cross-examin') || promptLower.includes('support') || promptLower.includes('verif')) {
    lines.push('### Claim Verification & Cross-Examination');
    if (supportedClaims.length > 0) {
      lines.push('**Corroborated Claims:**');
      for (const item of supportedClaims) {
        lines.push(`- Claim "${item.claim.statement}" is supported by evidence: [${item.evidenceIds.join(', ')}].`);
      }
    }
    if (unsupportedClaims.length > 0) {
      lines.push('**Evidentiary Vulnerabilities (Unsupported Claims):**');
      for (const c of unsupportedClaims) {
        lines.push(`- Claim "${c.statement}" currently has no direct corroborating documentation in the record.`);
      }
    }
    if (contradictions.length > 0) {
      lines.push(`\n**Cross-Examination Vulnerabilities:** ${contradictions.length} documented discrepancy points identified.`);
    }
  } else if (promptLower.includes('amount') || promptLower.includes('money') || promptLower.includes('paid') || promptLower.includes('inr') || promptLower.includes('fee')) {
    lines.push('### Monetary & Financial Analysis');
    let foundAmounts = false;
    for (const ev of activeEvidence) {
      const amounts = ev.extraction?.amounts || [];
      if (amounts.length > 0) {
        foundAmounts = true;
        lines.push(`- **${ev.title}**: ${amounts.map((a) => formatAmount(a)).join(', ')}`);
      }
    }
    if (!foundAmounts) {
      lines.push('No extracted monetary amounts were identified in the active evidence record.');
    }
    const moneyContradictions = contradictions.filter((c) => c.title.includes('Monetary') || c.title.includes('amount'));
    if (moneyContradictions.length > 0) {
      lines.push('\n**Financial Discrepancies:**');
      for (const mc of moneyContradictions) {
        lines.push(`- ${mc.explanation}`);
      }
    }
  } else if (promptLower.includes('date') || promptLower.includes('when') || promptLower.includes('timeline')) {
    lines.push('### Timeline & Chronology Analysis');
    const datedItems: { title: string; date: string; evId: string }[] = [];
    for (const ev of activeEvidence) {
      const dates = ev.extraction?.dates || [];
      for (const d of dates) {
        datedItems.push({ title: ev.title, date: d.iso || d.original, evId: ev.id });
      }
    }
    if (datedItems.length > 0) {
      datedItems.sort((a, b) => a.date.localeCompare(b.date));
      for (const item of datedItems) {
        lines.push(`- [${item.date}] ${item.title} (${item.evId})`);
      }
    } else {
      lines.push('No normalized timeline dates were identified in the current evidence record.');
    }
  } else {
    // General synthesis
    lines.push('### Evidence Prover Assessment');
    lines.push(`Evaluated ${activeEvidence.length} active evidence record(s) against ${activeClaims.length} claim(s).`);
    if (supportedClaims.length > 0) {
      lines.push(`- ${supportedClaims.length} claim(s) corroborated by documented evidence.`);
    }
    if (unsupportedClaims.length > 0) {
      lines.push(`- ${unsupportedClaims.length} claim(s) currently lack direct corroborating evidence.`);
    }
    if (contradictions.length > 0) {
      lines.push(`- ${contradictions.length} factual contradiction(s) or disputed point(s) detected.`);
    } else {
      lines.push('- No internal factual contradictions detected across active documents.');
    }
  }

  // 8. Confidence Calculation
  let confidence = 0.92;
  if (activeEvidence.length === 0) {
    confidence = 0.15;
  } else {
    if (contradictions.length > 0) {
      confidence = Math.max(0.4, confidence - contradictions.length * 0.12);
    }
    if (unsupportedClaims.length > 0) {
      confidence = Math.max(0.45, confidence - unsupportedClaims.length * 0.08);
    }
  }

  return {
    answer: lines.join('\n'),
    supportingEvidenceIds: Array.from(supportingEvidenceIds),
    contradictionsFound: contradictions,
    confidence: Number(confidence.toFixed(2)),
    source: 'deterministic',
    durationMs: Date.now() - started,
  };
}

/**
 * Convenience alias for deterministic reasoning fallback.
 */
export function deterministicReasoning(context: EvidenceContext, prompt?: string): ProverResponse {
  return evaluateDeterministicProver(prompt ?? 'Assess evidence support and contradictions', context);
}

/**
 * Main query entry point for the Evidence Prover Reasoning Assistant.
 * Routes to personal Gemini session proxy if configured and enabled;
 * seamlessly and silently falls back to deterministic rule reasoning if session
 * is expired, unreachable, or unconfigured.
 */
export async function queryEvidenceProver(
  prompt: string,
  context: EvidenceContext,
  proxyConfig?: GeminiProxyConfig,
): Promise<ProverResponse> {
  if (proxyConfig?.enabled && (proxyConfig.proxyUrl || proxyConfig.sessionCookie)) {
    try {
      const response = await queryGeminiProxy(prompt, context, proxyConfig);
      return response;
    } catch {
      // Non-throwing silent fallback
      return evaluateDeterministicProver(prompt, context);
    }
  }
  return evaluateDeterministicProver(prompt, context);
}
