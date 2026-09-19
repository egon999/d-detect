/**
 * Settlement Negotiation & Risk-Adjusted Valuation Matrix.
 *
 * Translates evidence corroboration ratios and financial damage schedules into
 * realistic, probabilistic pre-trial settlement ranges (Floor, Target, Ceiling),
 * tactical leverage points, and ready-to-use negotiation counter-offers.
 */

import { calculateRecoveryLedger, type RecoveryLedgerSummary } from './recovery-ledger';
import type { Workspace } from '../models';

export interface SettlementMatrixResult {
  caseId: string;
  currency: string;
  winProbabilityPercent: number;
  walkAwayFloorMinor: number;
  formattedWalkAwayFloor: string;
  targetSettlementMinor: number;
  formattedTargetSettlement: string;
  trialCeilingMinor: number;
  formattedTrialCeiling: string;
  tacticalPosture: 'AGGRESSIVE' | 'BALANCED' | 'CONCILIATORY';
  tacticalRecommendation: string;
  leveragePoints: string[];
  negotiationScript: string;
}

function formatCurrency(minorUnits: number, currency = 'USD'): string {
  const abs = Math.abs(minorUnits);
  const units = (abs / 100).toFixed(2);
  const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : `${currency} `;
  return `${symbol}${units}`;
}

/**
 * Evaluates the Settlement Matrix and risk-adjusted recovery for a case.
 */
export function evaluateSettlementMatrix(
  workspace: Workspace,
  caseId: string,
): SettlementMatrixResult {
  const ledger = calculateRecoveryLedger(workspace, caseId);
  const claims = workspace.claims.filter((c) => c.caseId === caseId && !c.deletedAt);
  const analysis = workspace.caseAnalyses
    .filter((a) => a.caseId === caseId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  const currency = ledger.currency;
  const principal = ledger.totalPrincipalMinor || 10000; // fallback $100.00 if unstated
  const totalClaimable = ledger.totalClaimableMinor || principal;

  // 1. Calculate Win Probability based on claim assessments and findings
  let corroboratedCount = 0;
  let contradictedCount = 0;

  for (const clm of claims) {
    const assessment = analysis?.claims?.find((a) => a.claimId === clm.id);
    if (assessment?.status === 'SUPPORTED' || clm.state === 'SUPPORTED') {
      corroboratedCount += 1;
    } else if (assessment?.status === 'CONTRADICTED' || clm.state === 'CONTRADICTED') {
      contradictedCount += 1;
    }
  }

  const contradictionsTotal = (analysis?.contradictions?.length ?? 0) + contradictedCount;

  let baseWinRate = 60;
  if (claims.length > 0) {
    baseWinRate = Math.round((corroboratedCount / claims.length) * 40 + 40);
  }
  if (contradictionsTotal > 0) {
    baseWinRate = Math.max(25, baseWinRate - contradictionsTotal * 15);
  }

  const winProbabilityPercent = Math.min(95, Math.max(20, baseWinRate));

  // 2. Valuation Brackets
  // Floor: 85% of direct principal damages (bare minimum cash acceptable)
  const walkAwayFloorMinor = Math.round(principal * 0.85);

  // Target: 100% of principal + 50% of consequential costs + 30% of statutory interest
  const targetSettlementMinor = Math.min(
    totalClaimable,
    Math.round(principal + ledger.totalConsequentialMinor * 0.75 + ledger.totalInterestMinor * 0.5),
  );

  // Ceiling: 100% of all damages, statutory penalties, and interest
  const trialCeilingMinor = totalClaimable;

  // 3. Posture & Recommendation
  let tacticalPosture: 'AGGRESSIVE' | 'BALANCED' | 'CONCILIATORY' = 'BALANCED';
  if (winProbabilityPercent >= 75) {
    tacticalPosture = 'AGGRESSIVE';
  } else if (winProbabilityPercent < 50) {
    tacticalPosture = 'CONCILIATORY';
  }

  const leveragePoints: string[] = [];
  if (corroboratedCount > 0) {
    leveragePoints.push(`${corroboratedCount} core claim(s) backed by direct documentary corroboration.`);
  }
  if (ledger.totalPenaltiesMinor > 0) {
    leveragePoints.push(
      `Statutory bad-faith multiplier exposure (${formatCurrency(ledger.totalPenaltiesMinor, currency)}) creates strong counterparty risk at trial.`,
    );
  }
  if (ledger.daysDelinquent > 14) {
    leveragePoints.push(`${ledger.daysDelinquent} days of delinquency provides justification for prejudgment interest.`);
  }
  if (leveragePoints.length === 0) {
    leveragePoints.push('Written paper trail and timeline integrity establish prima facie entitlement.');
  }

  let tacticalRecommendation = '';
  if (tacticalPosture === 'AGGRESSIVE') {
    tacticalRecommendation = `Your documentary evidence is dominant (${winProbabilityPercent}% win confidence). Refuse discounts below ${formatCurrency(targetSettlementMinor, currency)}. Give the counterparty a strict 72-hour window before proceeding to formal small-claims or arbitration filing.`;
  } else if (tacticalPosture === 'BALANCED') {
    tacticalRecommendation = `Strong position on direct damages (${winProbabilityPercent}% win confidence). Aim to settle at ${formatCurrency(targetSettlementMinor, currency)}. Be prepared to concede minor fees to secure immediate payment and avoid court time.`;
  } else {
    tacticalRecommendation = `Unresolved gaps exist in the documentary record. Prioritize securing an amicable agreement around ${formatCurrency(walkAwayFloorMinor, currency)} to eliminate litigation exposure.`;
  }

  // 4. Negotiation Counter-Offer Script
  const negotiationScript = `Dear [Counterparty],\n\nIn the interest of resolving this matter amicably without formal court intervention, I am prepared to accept a settlement of ${formatCurrency(targetSettlementMinor, currency)} in full and final satisfaction of all claims, provided payment is remitted by [Date within 5 days].\n\nPlease be advised that if this matter proceeds to formal adjudication, my claim will seek the full statutory ceiling of ${formatCurrency(trialCeilingMinor, currency)}, including accrued interest and statutory penalties pursuant to applicable law.\n\nPlease confirm agreement by return.\n\nSincerely,\n[Your Name]`;

  return {
    caseId,
    currency,
    winProbabilityPercent,
    walkAwayFloorMinor,
    formattedWalkAwayFloor: formatCurrency(walkAwayFloorMinor, currency),
    targetSettlementMinor,
    formattedTargetSettlement: formatCurrency(targetSettlementMinor, currency),
    trialCeilingMinor,
    formattedTrialCeiling: formatCurrency(trialCeilingMinor, currency),
    tacticalPosture,
    tacticalRecommendation,
    leveragePoints,
    negotiationScript,
  };
}
