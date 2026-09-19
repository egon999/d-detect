/**
 * Financial Recovery Ledger & Damages Quantification Engine.
 *
 * Automatically itemizes financial claims, consequential damages, statutory
 * penalties, and prejudgment interest across case evidence. Produces an audit-proof
 * itemized damages schedule suitable for demand letters, mediation, and court filings.
 */

import type { AmountField, Workspace } from '../models';

export type DamageCategory =
  | 'PRINCIPAL'
  | 'CONSEQUENTIAL'
  | 'STATUTORY_PENALTY'
  | 'STATUTORY_INTEREST'
  | 'OFFSET_CREDIT';

export interface DamageLineItem {
  id: string;
  category: DamageCategory;
  title: string;
  amountMinorUnits: number;
  currency: string;
  formattedAmount: string;
  sourceEvidenceId?: string;
  sourceEvidenceTitle?: string;
  sourceQuote?: string;
  isAutomatic: boolean;
}

export interface RecoveryLedgerSummary {
  caseId: string;
  currency: string;
  totalPrincipalMinor: number;
  totalConsequentialMinor: number;
  totalPenaltiesMinor: number;
  totalInterestMinor: number;
  totalClaimableMinor: number;
  formattedTotalClaimable: string;
  daysDelinquent: number;
  annualInterestRatePercent: number;
  items: DamageLineItem[];
  itemizedScheduleText: string;
}

function formatCurrency(minorUnits: number, currency = 'USD'): string {
  const isNegative = minorUnits < 0;
  const abs = Math.abs(minorUnits);
  const units = (abs / 100).toFixed(2);
  const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : `${currency} `;
  return `${isNegative ? '-' : ''}${symbol}${units}`;
}

/**
 * Calculates the Recovery Ledger for a given case in the workspace.
 *
 * @param workspace The active workspace aggregate
 * @param caseId The case identifier
 * @param annualInterestRate The statutory interest rate (e.g., 0.10 for 10% per annum)
 */
export function calculateRecoveryLedger(
  workspace: Workspace,
  caseId: string,
  annualInterestRate = 0.10,
): RecoveryLedgerSummary {
  const caseRecord = workspace.cases.find((c) => c.id === caseId);
  const evidenceList = workspace.evidence.filter((e) => e.caseId === caseId && !e.deletedAt);
  const eventsList = workspace.events.filter((ev) => ev.caseId === caseId && !ev.deletedAt);

  const items: DamageLineItem[] = [];
  let primaryCurrency = 'USD';

  // 1. Gather all extracted amounts from evidence
  for (const evd of evidenceList) {
    if (!evd.extraction?.amounts?.length) continue;

    for (let i = 0; i < evd.extraction.amounts.length; i++) {
      const amt: AmountField = evd.extraction.amounts[i]!;
      if (!primaryCurrency && amt.currency) {
        primaryCurrency = amt.currency;
      }

      const roleLower = (amt.role ?? '').toLowerCase();
      let category: DamageCategory = 'PRINCIPAL';

      if (
        roleLower.includes('repair') ||
        roleLower.includes('fee') ||
        roleLower.includes('cost') ||
        roleLower.includes('expense') ||
        roleLower.includes('hotel') ||
        roleLower.includes('storage')
      ) {
        category = 'CONSEQUENTIAL';
      }

      items.push({
        id: `ledger_${evd.id}_${i}`,
        category,
        title: amt.role ? `${amt.role} (${evd.title})` : `Extracted Amount (${evd.title})`,
        amountMinorUnits: amt.minorUnits,
        currency: amt.currency || primaryCurrency,
        formattedAmount: formatCurrency(amt.minorUnits, amt.currency || primaryCurrency),
        sourceEvidenceId: evd.id,
        sourceEvidenceTitle: evd.title,
        sourceQuote: amt.sourceQuote,
        isAutomatic: true,
      });
    }
  }

  // 2. Compute Days Delinquent from oldest event or extracted date
  let earliestTimestamp = Date.now();
  for (const ev of eventsList) {
    if (ev.occurredAt?.iso) {
      const parsed = Date.parse(ev.occurredAt.iso);
      if (!Number.isNaN(parsed) && parsed < earliestTimestamp) {
        earliestTimestamp = parsed;
      }
    }
  }
  for (const evd of evidenceList) {
    for (const d of evd.extraction?.dates ?? []) {
      if (d.iso) {
        const parsed = Date.parse(d.iso);
        if (!Number.isNaN(parsed) && parsed < earliestTimestamp) {
          earliestTimestamp = parsed;
        }
      }
    }
  }

  const daysDelinquent = Math.max(0, Math.floor((Date.now() - earliestTimestamp) / (1000 * 60 * 60 * 24)));

  // 3. Tally Categories
  let totalPrincipalMinor = 0;
  let totalConsequentialMinor = 0;

  for (const item of items) {
    if (item.category === 'PRINCIPAL') {
      totalPrincipalMinor += item.amountMinorUnits;
    } else if (item.category === 'CONSEQUENTIAL') {
      totalConsequentialMinor += item.amountMinorUnits;
    }
  }

  // 4. Calculate Statutory Interest (simple interest = principal * rate * (days / 365))
  let totalInterestMinor = 0;
  if (totalPrincipalMinor > 0 && daysDelinquent > 0) {
    const interestDecimal = totalPrincipalMinor * annualInterestRate * (daysDelinquent / 365);
    totalInterestMinor = Math.round(interestDecimal);

    items.push({
      id: `interest_${caseId}`,
      category: 'STATUTORY_INTEREST',
      title: `Statutory Prejudgment Interest (${(annualInterestRate * 100).toFixed(1)}% p.a. for ${daysDelinquent} days)`,
      amountMinorUnits: totalInterestMinor,
      currency: primaryCurrency,
      formattedAmount: formatCurrency(totalInterestMinor, primaryCurrency),
      isAutomatic: true,
    });
  }

  // 5. Calculate Statutory Bad Faith Penalty if dispute type indicates deposit/wage withholding
  let totalPenaltiesMinor = 0;
  const isDepositOrWage =
    (caseRecord?.title ?? '').toLowerCase().includes('deposit') ||
    (caseRecord?.description ?? '').toLowerCase().includes('deposit') ||
    (caseRecord?.title ?? '').toLowerCase().includes('wage') ||
    (caseRecord?.description ?? '').toLowerCase().includes('unpaid');

  if (isDepositOrWage && totalPrincipalMinor > 0) {
    // Statutory bad faith statutory damage (1x multiplier of principal as penalty)
    totalPenaltiesMinor = totalPrincipalMinor;
    items.push({
      id: `penalty_${caseId}`,
      category: 'STATUTORY_PENALTY',
      title: 'Statutory Bad-Faith Withholding Multiplier (1x Statutory Liquidated Damages)',
      amountMinorUnits: totalPenaltiesMinor,
      currency: primaryCurrency,
      formattedAmount: formatCurrency(totalPenaltiesMinor, primaryCurrency),
      isAutomatic: true,
    });
  }

  const totalClaimableMinor =
    totalPrincipalMinor + totalConsequentialMinor + totalPenaltiesMinor + totalInterestMinor;

  // 6. Generate Court/Arbitration Ready Itemized Schedule
  const claimant = caseRecord?.participants?.find((p) => p.role?.toLowerCase().includes('claimant'))?.name;
  const lines: string[] = [
    `ITEMIZED STATEMENT OF DAMAGES & FINANCIAL RECOVERY`,
    `Case: ${caseRecord?.title ?? 'Dispute'} (ID: ${caseId})`,
    ...(claimant ? [`Claimant: ${claimant}`] : []),
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    `Days Delinquent: ${daysDelinquent} days`,
    `------------------------------------------------------------`,
  ];

  for (const item of items) {
    lines.push(
      `[${item.category}] ${item.title.padEnd(45, ' ')} : ${item.formattedAmount.padStart(12, ' ')}`,
    );
  }

  lines.push(`------------------------------------------------------------`);
  lines.push(
    `TOTAL CLAIMABLE RECOVERY: ${formatCurrency(totalClaimableMinor, primaryCurrency).padStart(34, ' ')}`,
  );

  return {
    caseId,
    currency: primaryCurrency,
    totalPrincipalMinor,
    totalConsequentialMinor,
    totalPenaltiesMinor,
    totalInterestMinor,
    totalClaimableMinor,
    formattedTotalClaimable: formatCurrency(totalClaimableMinor, primaryCurrency),
    daysDelinquent,
    annualInterestRatePercent: annualInterestRate * 100,
    items,
    itemizedScheduleText: lines.join('\n'),
  };
}
