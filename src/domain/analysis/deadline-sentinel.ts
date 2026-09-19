/**
 * Statutory & Regulatory Deadline Sentinel Engine.
 *
 * Monitors case-specific deadlines, statutory cure windows, and statutes of limitations.
 * Calculates exact countdown days, assigns urgency states, and suggests tactical remedies.
 */

import type { CaseEvent, Workspace } from '../models';

export type DeadlineUrgency = 'NORMAL' | 'UPCOMING' | 'URGENT' | 'CRITICAL' | 'EXPIRED';

export interface StatutoryClock {
  id: string;
  clockType: string;
  title: string;
  jurisdictionOrStatute: string;
  triggerEvent: string;
  triggerDateIso: string;
  deadlineDateIso: string;
  daysRemaining: number;
  urgency: DeadlineUrgency;
  remedyAction: string;
  statutoryReference: string;
}

export interface DeadlineSentinelSummary {
  caseId: string;
  activeClocks: StatutoryClock[];
  mostUrgentClock: StatutoryClock | null;
  expiredClocksCount: number;
  criticalClocksCount: number;
}

function calculateUrgency(daysRemaining: number): DeadlineUrgency {
  if (daysRemaining < 0) return 'EXPIRED';
  if (daysRemaining <= 3) return 'CRITICAL';
  if (daysRemaining <= 7) return 'URGENT';
  if (daysRemaining <= 21) return 'UPCOMING';
  return 'NORMAL';
}

function addDaysToIso(isoDate: string, days: number): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    const fallback = new Date();
    fallback.setDate(fallback.getDate() + days);
    return fallback.toISOString().slice(0, 10);
  }
  parsed.setDate(parsed.getDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function daysDiffFromNow(targetIso: string): number {
  const target = new Date(targetIso).getTime();
  const now = Date.now();
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

/**
 * Derives statutory and dispute limitation clocks for a given case.
 */
export function deriveDeadlineSentinel(workspace: Workspace, caseId: string): DeadlineSentinelSummary {
  const caseRecord = workspace.cases.find((c) => c.id === caseId);
  const events = workspace.events.filter((ev) => ev.caseId === caseId && !ev.deletedAt);
  const evidenceList = workspace.evidence.filter((e) => e.caseId === caseId && !e.deletedAt);

  const clocks: StatutoryClock[] = [];
  const titleLower = (caseRecord?.title ?? '').toLowerCase();
  const descLower = (caseRecord?.description ?? '').toLowerCase();

  // Find relevant trigger dates
  let breachDateIso: string | null = null;
  let noticeDateIso: string | null = null;
  let moveOutDateIso: string | null = null;
  let invoiceDateIso: string | null = null;

  for (const ev of events) {
    if (!ev.occurredAt?.iso) continue;
    const evTitle = (ev.title ?? '').toLowerCase();
    if (evTitle.includes('move') || evTitle.includes('vacate') || evTitle.includes('lease end')) {
      moveOutDateIso = ev.occurredAt.iso;
    } else if (evTitle.includes('notice') || evTitle.includes('demand') || evTitle.includes('letter')) {
      noticeDateIso = ev.occurredAt.iso;
    } else if (evTitle.includes('breach') || evTitle.includes('incident') || evTitle.includes('refusal')) {
      breachDateIso = ev.occurredAt.iso;
    } else if (evTitle.includes('invoice') || evTitle.includes('bill')) {
      invoiceDateIso = ev.occurredAt.iso;
    }
  }

  // Fallback to evidence dates
  for (const evd of evidenceList) {
    for (const d of evd.extraction?.dates ?? []) {
      if (!d.iso) continue;
      const role = (d.role ?? '').toLowerCase();
      if (role.includes('due') || role.includes('invoice')) {
        if (!invoiceDateIso) invoiceDateIso = d.iso;
      } else if (!breachDateIso) {
        breachDateIso = d.iso;
      }
    }
  }

  const defaultTrigger = breachDateIso || noticeDateIso || invoiceDateIso || new Date(caseRecord?.createdAt ?? Date.now()).toISOString().slice(0, 10);

  // 1. Tenancy / Security Deposit Return Clock (21 days)
  if (titleLower.includes('deposit') || titleLower.includes('rent') || descLower.includes('tenant') || moveOutDateIso) {
    const trigger = moveOutDateIso || defaultTrigger;
    const deadline = addDaysToIso(trigger, 21);
    const remaining = daysDiffFromNow(deadline);
    clocks.push({
      id: `clock_deposit_${caseId}`,
      clockType: 'TENANT_DEPOSIT_RETURN',
      title: 'Statutory Security Deposit Return Window',
      jurisdictionOrStatute: 'Universal Model Tenancy Code (21-Day Rule)',
      triggerEvent: 'Tenancy Termination / Key Handover',
      triggerDateIso: trigger,
      deadlineDateIso: deadline,
      daysRemaining: remaining,
      urgency: calculateUrgency(remaining),
      remedyAction: remaining <= 0 ? 'File small claims court petition for 2x bad faith penalty' : 'Issue formal 10-day pre-litigation demand letter',
      statutoryReference: 'Civ. Code § 1950.5 / Statutory 21-Day Accounting Rule',
    });
  }

  // 2. Formal Demand Notice Cure Window (14 days)
  if (noticeDateIso || clocks.length > 0) {
    const trigger = noticeDateIso || defaultTrigger;
    const deadline = addDaysToIso(trigger, 14);
    const remaining = daysDiffFromNow(deadline);
    clocks.push({
      id: `clock_cure_${caseId}`,
      clockType: 'DEMAND_CURE_PERIOD',
      title: 'Formal Demand Notice Cure Window',
      jurisdictionOrStatute: 'Pre-Action Conduct & Notice Protocol',
      triggerEvent: 'Service of Initial Demand / Notice',
      triggerDateIso: trigger,
      deadlineDateIso: deadline,
      daysRemaining: remaining,
      urgency: calculateUrgency(remaining),
      remedyAction: remaining <= 0 ? 'Escalate to formal court / arbitration proceedings' : 'Allow counterparty statutory time to remit payment',
      statutoryReference: 'Uniform Dispute Resolution & Pre-Action Protocol',
    });
  }

  // 3. Prompt Payment Act / Commercial Invoice Window (30 days)
  if (titleLower.includes('invoice') || titleLower.includes('unpaid') || titleLower.includes('contract') || invoiceDateIso) {
    const trigger = invoiceDateIso || defaultTrigger;
    const deadline = addDaysToIso(trigger, 30);
    const remaining = daysDiffFromNow(deadline);
    clocks.push({
      id: `clock_invoice_${caseId}`,
      clockType: 'PROMPT_PAYMENT_ACT',
      title: 'Commercial Prompt Payment Statute Window',
      jurisdictionOrStatute: 'Commercial Code & Prompt Payment Act',
      triggerEvent: 'Invoice Receipt / Service Delivery',
      triggerDateIso: trigger,
      deadlineDateIso: deadline,
      daysRemaining: remaining,
      urgency: calculateUrgency(remaining),
      remedyAction: remaining <= 0 ? 'Assess statutory late payment surcharge (1.5% monthly)' : 'Send overdue reminder with prompt payment citation',
      statutoryReference: 'Late Payment of Commercial Debts Act / UCC § 2-607',
    });
  }

  // 4. General Statute of Limitations for Written Contract (4 years = 1460 days)
  const contractTrigger = breachDateIso || defaultTrigger;
  const solDeadline = addDaysToIso(contractTrigger, 1460);
  const solRemaining = daysDiffFromNow(solDeadline);
  clocks.push({
    id: `clock_sol_${caseId}`,
    clockType: 'STATUTE_OF_LIMITATIONS',
    title: 'Statute of Limitations (Written Agreement)',
    jurisdictionOrStatute: 'Civil Code Limitation Period',
    triggerEvent: 'Date of First Contractual Breach',
    triggerDateIso: contractTrigger,
    deadlineDateIso: solDeadline,
    daysRemaining: solRemaining,
    urgency: calculateUrgency(solRemaining),
    remedyAction: solRemaining <= 30 ? 'IMMEDIATE FILING REQUIRED to toll statute' : 'Maintain evidence integrity and audit trail',
    statutoryReference: 'Code of Civil Procedure § 337 (4-Year Written Contract)',
  });

  // Sort clocks by days remaining (most urgent first)
  clocks.sort((a, b) => a.daysRemaining - b.daysRemaining);

  const expiredClocksCount = clocks.filter((c) => c.urgency === 'EXPIRED').length;
  const criticalClocksCount = clocks.filter((c) => c.urgency === 'CRITICAL' || c.urgency === 'URGENT').length;

  return {
    caseId,
    activeClocks: clocks,
    mostUrgentClock: clocks[0] ?? null,
    expiredClocksCount,
    criticalClocksCount,
  };
}
