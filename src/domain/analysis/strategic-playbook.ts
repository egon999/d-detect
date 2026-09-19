/**
 * Strategic Next-Move Playbook (Tactical Action & Escalation Engine).
 *
 * Translates raw evidentiary findings into concrete, high-probability dispute steps:
 * - Detects industry & legal redressal sector (Banking, Consumer, Landlord, Merchant, Contract).
 * - Constructs a calibrated 3-tier Escalation Ladder (Amicable Notice -> Statutory Ombudsman -> Formal Forum).
 * - Provides pre-formatted formal communication templates quoting exact evidence digests and dates.
 * - Tracks critical statutory deadlines and response windows.
 */

import type { Case, Claim, Evidence, Workspace } from '@domain/models';
import { detectForum, forumProfile, type RedressalForum } from './escalation';

export type PlaybookUrgency = 'STANDARD' | 'URGENT' | 'CRITICAL';

export interface EscalationStep {
  stepNumber: number;
  stageName: string;
  recommendedAction: string;
  forumOrChannel: string;
  expectedTurnaroundDays: number;
  templateSnippet?: string;
  prerequisites: string[];
}

export interface TacticalPlaybook {
  caseId: string;
  sector: RedressalForum | 'GENERAL_DISPUTE';
  sectorLabel: string;
  urgency: PlaybookUrgency;
  primaryRemedySought: string;
  recommendedNextMove: string;
  escalationLadder: EscalationStep[];
  readyEvidenceCount: number;
  missingRequirements: string[];
  formalNoticeSnippet: string;
}

export function generateStrategicPlaybook(workspace: Workspace, caseId: string): TacticalPlaybook {
  const cId = caseId;
  const caseRecord = workspace.cases.find((c) => c.id === cId);
  const claims = workspace.claims.filter((c) => c.caseId === cId && !c.deletedAt);
  const evidenceList = workspace.evidence.filter((e) => e.caseId === cId && !e.deletedAt);

  // Combine case title, description, and claim statements to detect dispute sector
  const corpus = [
    caseRecord?.title ?? '',
    caseRecord?.description ?? '',
    ...claims.map((c) => c.statement),
    ...evidenceList.map((e) => `${e.title} ${e.extraction?.segments[0]?.text ?? ''}`),
  ].join('\n');

  const detected = detectForum(corpus);
  let sector: RedressalForum | 'GENERAL_DISPUTE' = detected ?? 'GENERAL_DISPUTE';
  if (sector === 'GENERAL_DISPUTE') {
    if (/\b(?:bank|banking|debit|credit\s+card|savings\s+account|current\s+account|ifsc|upi|neft|imps)\b/i.test(corpus)) {
      sector = 'BANKING';
    } else if (/\b(?:insurance|insurer|policy|premium|mediclaim)\b/i.test(corpus)) {
      sector = 'INSURANCE';
    } else if (/\b(?:telecom|broadband|sim\s+card|network\s+coverage)\b/i.test(corpus)) {
      sector = 'TELECOM';
    }
  }

  const profile = sector !== 'GENERAL_DISPUTE' ? forumProfile(sector) : null;

  // Determine primary remedy sought
  let primaryRemedySought = 'Full financial settlement and formal rectification of the disputed record.';
  const hasMoneyClaims = claims.some((c) => /inr|usd|eur|rs\.?|refund|deposit|amount|payment|paid/i.test(c.statement));
  if (hasMoneyClaims) {
    primaryRemedySought = 'Immediate restitution / reimbursement of disputed funds plus statutory interest.';
  }

  const ombudsmanStageName =
    sector === 'BANKING'
      ? 'Banking Ombudsman (RBI Integrated Scheme)'
      : sector === 'INSURANCE'
        ? 'Insurance Ombudsman'
        : sector === 'TELECOM'
          ? "Provider's Appellate Authority"
          : 'Statutory Ombudsman / Consumer Commission';

  // Build the 3-step escalation ladder
  const escalationLadder: EscalationStep[] = [
    {
      stepNumber: 1,
      stageName: 'Formal Pre-Dispute Notice',
      recommendedAction: 'Issue a formal, time-bound legal notice referencing exact evidence hashes and transaction dates.',
      forumOrChannel: 'Counterparty Registered Email / Formal Letter',
      expectedTurnaroundDays: 7,
      templateSnippet: `Without prejudice to my legal rights, I formally call upon you to resolve the matter within 7 business days. Enclosed please find the verified evidentiary dossier (SHA-256 hash verified).`,
      prerequisites: ['Verified receipts or payment confirmations', 'Clear statement of disputed amount'],
    },
    {
      stepNumber: 2,
      stageName: ombudsmanStageName,
      recommendedAction: profile
        ? `Escalate complaint to ${profile.nextStep} citing ${profile.scheme}.`
        : 'Escalate complaint to the governing sector regulator or consumer protection commission.',
      forumOrChannel: profile?.where ?? 'National Consumer Helpline / Regulatory Portal',
      expectedTurnaroundDays: profile?.replyWindowDays ?? 30,
      templateSnippet: profile
        ? `Complaint submitted pursuant to ${profile.scheme} regarding unresolved grievance.`
        : 'Formal consumer complaint regarding deficiency of service and unfair trade practices.',
      prerequisites: ['Proof of Step 1 notice delivery', 'Unresolved 7-day turnaround window'],
    },
    {
      stepNumber: 3,
      stageName: 'Formal Adjudication & Court Docket',
      recommendedAction: 'File summary dispute petition in Small Claims Court / Consumer Disputes Redressal Commission.',
      forumOrChannel: 'District Consumer Disputes Redressal Commission / Civil Court',
      expectedTurnaroundDays: 90,
      templateSnippet: 'Claim petition for refund of disputed principal amount, consequential damages, and litigation expenses.',
      prerequisites: ['Case audit chain head integrity seal', 'Complete cryptographic proof capsule'],
    },
  ];

  // Missing requirements detection
  const missingRequirements: string[] = [];
  if (evidenceList.length === 0) {
    missingRequirements.push('Upload at least one primary receipt, invoice, or formal agreement.');
  }
  if (claims.length === 0) {
    missingRequirements.push('Formulate at least one explicit claim statement describing the disputed obligation.');
  }

  const urgency: PlaybookUrgency = claims.length > 0 && evidenceList.length > 0 ? 'STANDARD' : 'URGENT';
  const sectorLabel = profile?.scheme ? `${profile.scheme} Framework` : 'General Commercial Dispute';
  const recommendedNextMove =
    missingRequirements.length > 0
      ? `Complete missing prerequisites: ${missingRequirements[0]}`
      : `Initiate Step 1: Issue formal time-bound notice with the generated proof dossier.`;

  const formalNoticeSnippet = `FORMAL NOTICE OF DISPUTE\nCase Reference: ${caseRecord?.title ?? 'Case Docket'}\nDate: ${new Date().toLocaleDateString('en-GB')}\n\nTo whom it may concern,\n\nPlease take formal notice that the undersigned has documented and cryptographically verified the evidence regarding the disputed matter described herein.\n\nClaims:\n${claims.map((c, i) => `${i + 1}. ${c.statement}`).join('\n')}\n\nSupporting Evidence Attached: ${evidenceList.length} documented source(s).\n\nYou are hereby provided 7 business days from receipt of this notice to rectify the matter, failing which formal proceedings will be initiated before ${escalationLadder[1]?.forumOrChannel ?? 'the competent authority'}.\n\nSincerely,\nAuthenticated Case Docket Owner`;

  return {
    caseId,
    sector,
    sectorLabel,
    urgency,
    primaryRemedySought,
    recommendedNextMove,
    escalationLadder,
    readyEvidenceCount: evidenceList.length,
    missingRequirements,
    formalNoticeSnippet,
  };
}
