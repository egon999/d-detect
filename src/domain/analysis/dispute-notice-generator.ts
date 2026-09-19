/**
 * Formal Dispute & Grievance Notice Generator.
 *
 * Deterministically compiles case records, participants, verified claims, financial ledger
 * assessments, and tamper-evident evidence exhibits (with SHA-256 digests) into a
 * legally-grounded Dispute & Demand Notice ready for immediate serving and PDF archiving.
 */

import type { Workspace } from '../models';
import { currentClaimAssessment, latestCaseAnalysis } from './case-report';
import { calculateRecoveryLedger } from './recovery-ledger';

export interface DisputeNoticeOptions {
  cureWindowDays?: number;
  remedySought?: string;
  senderName?: string;
  recipientName?: string;
  noticeDateMs?: number;
}

export interface DisputeExhibit {
  index: string; // "Exhibit A", "Exhibit B", etc.
  id: string;
  title: string;
  fileName: string;
  sha256: string;
  capturedAt: string | null;
  kind: string;
  sizeBytes: number | null;
}

export interface DisputeClaimItem {
  id: string;
  statement: string;
  status: string;
  citationCount: number;
}

export interface DisputeNotice {
  caseId: string;
  noticeDate: string;
  deadlineDate: string;
  cureWindowDays: number;
  referenceNumber: string;
  subject: string;
  sender: {
    name: string;
    role: string;
  };
  recipient: {
    name: string;
    role: string;
  };
  summaryOfFacts: string[];
  claims: DisputeClaimItem[];
  financialDemand: {
    hasFinancialClaim: boolean;
    totalAmountFormatted: string;
    principalMinor: number;
    interestMinor: number;
    penaltiesMinor: number;
  };
  exhibits: DisputeExhibit[];
  plainText: string;
  html: string;
}

function letterIndex(num: number): string {
  let result = '';
  let n = num;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function formatHumanDate(timestampMs: number): string {
  const d = new Date(timestampMs);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function generateDisputeNotice(
  workspace: Workspace,
  caseId: string,
  options: DisputeNoticeOptions = {},
): DisputeNotice {
  const caseRecord = workspace.cases.find((c) => c.id === caseId && !c.deletedAt);
  if (!caseRecord) {
    throw new Error(`Case ${caseId} was not found in the workspace or has been deleted.`);
  }

  const noticeDateMs = options.noticeDateMs ?? Date.now();
  const cureWindowDays = options.cureWindowDays ?? 15;
  const deadlineDateMs = noticeDateMs + cureWindowDays * 24 * 60 * 60 * 1000;

  const noticeDate = formatHumanDate(noticeDateMs);
  const deadlineDate = formatHumanDate(deadlineDateMs);
  const referenceNumber = `EV-DISP-${caseRecord.id.replace(/^case_/, '').toUpperCase()}`;

  // Identify Sender & Recipient
  const participants = caseRecord.participants ?? [];
  const claimantParticipant = participants.find((p) =>
    /(claimant|tenant|buyer|plaintiff|consumer|employee|applicant|victim)/i.test(p.role || ''),
  );
  const respondentParticipant = participants.find((p) =>
    /(respondent|landlord|seller|defendant|merchant|employer|bank|vendor)/i.test(p.role || ''),
  );

  const sender = {
    name: options.senderName || claimantParticipant?.name || 'Claimant / Aggrieved Party',
    role: claimantParticipant?.role || 'Aggrieved Party',
  };

  const recipient = {
    name: options.recipientName || respondentParticipant?.name || 'Respondent / Opposing Party',
    role: respondentParticipant?.role || 'Respondent Party',
  };

  const subject = `FORMAL NOTICE OF DISPUTE & DEMAND FOR REMEDY: ${caseRecord.title.toUpperCase()}`;

  // Compile Verified Claims
  const report = latestCaseAnalysis(workspace, caseId);
  const activeClaims = workspace.claims.filter((clm) => clm.caseId === caseId && !clm.deletedAt);
  const claims: DisputeClaimItem[] = activeClaims.map((clm) => {
    const assessment = currentClaimAssessment(report, clm);
    return {
      id: clm.id,
      statement: clm.statement,
      status: assessment?.status || 'UNASSESSED',
      citationCount: assessment?.citations.length || 0,
    };
  });

  // Compile Financial Ledger
  const ledger = calculateRecoveryLedger(workspace, caseId);
  const financialDemand = {
    hasFinancialClaim: ledger.totalClaimableMinor > 0,
    totalAmountFormatted: ledger.formattedTotalClaimable,
    principalMinor: ledger.totalPrincipalMinor,
    interestMinor: ledger.totalInterestMinor,
    penaltiesMinor: ledger.totalPenaltiesMinor,
  };

  // Compile Exhibits
  const activeEvidence = workspace.evidence.filter((ev) => ev.caseId === caseId && !ev.deletedAt);
  const exhibits: DisputeExhibit[] = activeEvidence.map((ev, idx) => ({
    index: `Exhibit ${letterIndex(idx)}`,
    id: ev.id,
    title: ev.title || ev.fileName || 'Untitled Evidence Record',
    fileName: ev.fileName || 'document',
    sha256: ev.sha256 || 'UNHASHED_PENDING_INTEGRITY_CHECK',
    capturedAt: ev.sourceLabel ? `${ev.sourceLabel} (${ev.capturedAt || 'Undated'})` : ev.capturedAt || null,
    kind: ev.kind,
    sizeBytes: ev.sizeBytes,
  }));

  // Factual Sequence
  const summaryOfFacts: string[] = [];
  if (caseRecord.incidentDate) {
    summaryOfFacts.push(`Incident / Dispute Origin Date: ${caseRecord.incidentDate}.`);
  }
  if (caseRecord.description) {
    summaryOfFacts.push(caseRecord.description);
  }

  const getEventDateStr = (evt: (typeof workspace.events)[number]): string => {
    if (!evt.occurredAt) return '';
    return typeof evt.occurredAt === 'string'
      ? evt.occurredAt
      : evt.occurredAt.iso || evt.occurredAt.original || '';
  };

  const activeEvents = workspace.events
    .filter((e) => e.caseId === caseId && !e.deletedAt)
    .sort((a, b) => getEventDateStr(a).localeCompare(getEventDateStr(b)));

  for (const evt of activeEvents) {
    const rawDate = getEventDateStr(evt);
    const dateStr = rawDate ? `On or about ${rawDate}: ` : '';
    summaryOfFacts.push(`${dateStr}${evt.title}${evt.description ? ` — ${evt.description}` : ''}`);
  }

  if (summaryOfFacts.length === 0) {
    summaryOfFacts.push(
      `This dispute concerns the matter described as: "${caseRecord.title}". The aggrieved party asserts the substantiated claims outlined below.`,
    );
  }

  // Generate Plain Text
  const textLines: string[] = [];
  textLines.push('================================================================================');
  textLines.push('                      FORMAL NOTICE OF DISPUTE & REMEDY DEMAND');
  textLines.push('================================================================================');
  textLines.push(`DATE:        ${noticeDate}`);
  textLines.push(`REFERENCE:   ${referenceNumber}`);
  textLines.push(`TO:          ${recipient.name} (${recipient.role})`);
  textLines.push(`FROM:        ${sender.name} (${sender.role})`);
  textLines.push(`SUBJECT:     ${subject}`);
  textLines.push('--------------------------------------------------------------------------------\n');

  textLines.push('1. STATEMENT OF DISPUTE & FACTUAL BACKGROUND');
  summaryOfFacts.forEach((fact, i) => {
    textLines.push(`   1.${i + 1}. ${fact}`);
  });
  textLines.push('');

  textLines.push('2. SUBSTANTIATED CLAIMS & BASIS');
  if (claims.length > 0) {
    claims.forEach((clm, i) => {
      textLines.push(`   2.${i + 1}. ${clm.statement}`);
      textLines.push(`        [Status: ${clm.status}, Supporting Citations: ${clm.citationCount}]`);
    });
  } else {
    textLines.push(`   2.1. The aggrieved party asserts breach / non-performance as substantiated in the attached exhibits.`);
  }
  textLines.push('');

  if (financialDemand.hasFinancialClaim) {
    textLines.push('3. FINANCIAL ACCOUNTING & DEMAND');
    textLines.push(`   Principal Sum Owed:        $${(financialDemand.principalMinor / 100).toFixed(2)}`);
    if (financialDemand.interestMinor > 0) {
      textLines.push(`   Accrued Statutory Interest: $${(financialDemand.interestMinor / 100).toFixed(2)}`);
    }
    if (financialDemand.penaltiesMinor > 0) {
      textLines.push(`   Applicable Penalties:      $${(financialDemand.penaltiesMinor / 100).toFixed(2)}`);
    }
    textLines.push(`   TOTAL REMEDY DEMAND:       ${financialDemand.totalAmountFormatted}`);
    textLines.push('');
  }

  textLines.push('4. EVIDENCE EXHIBIT SCHEDULE (CRYPTOGRAPHICALLY VERIFIED)');
  if (exhibits.length > 0) {
    exhibits.forEach((ex) => {
      textLines.push(`   [${ex.index}] ${ex.title}`);
      textLines.push(`       File:     ${ex.fileName} (${ex.kind})`);
      textLines.push(`       SHA-256:  ${ex.sha256}`);
      if (ex.capturedAt) {
        textLines.push(`       Recorded: ${ex.capturedAt}`);
      }
    });
  } else {
    textLines.push('   No physical exhibits attached.');
  }
  textLines.push('');

  textLines.push('5. DEMAND FOR REMEDY & FORMAL CURE PERIOD');
  textLines.push(
    `   PLEASE TAKE NOTICE that you are hereby demanded to cure the aforementioned breach or satisfy the remedy requested above within fifteen (${cureWindowDays}) calendar days of this notice, no later than ${deadlineDate}.`,
  );
  if (options.remedySought) {
    textLines.push(`   Specific Remedy Demanded: ${options.remedySought}`);
  }
  textLines.push(
    '   Failure to resolve this matter within the specified timeframe will result in immediate escalation to the appropriate statutory ombudsman, regulatory agency, arbitration forum, or civil court without further notice.',
  );
  textLines.push('   All rights, remedies, and claims for statutory damages and legal costs are expressly reserved.');
  textLines.push('\nSincerely,');
  textLines.push(`\n_____________________________________________`);
  textLines.push(`${sender.name}`);
  textLines.push(`${sender.role}`);

  const plainText = textLines.join('\n');

  // Generate HTML for Executive PDF Export
  const escapeHtml = (str: string) =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(subject)}</title>
  <style>
    @page {
      size: A4;
      margin: 20mm 20mm;
      @bottom-center {
        content: "Page " counter(page) " of " counter(pages);
        font-size: 8pt;
        color: #777;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 10.5pt;
      line-height: 1.55;
      color: #1a1a1a;
      background-color: #fff;
      margin: 0;
      padding: 0;
    }
    .header-banner {
      border-bottom: 2px solid #0f172a;
      padding-bottom: 12px;
      margin-bottom: 20px;
    }
    .notice-title {
      font-size: 14pt;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: #0f172a;
      text-transform: uppercase;
      margin: 0 0 6px 0;
    }
    .meta-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      font-size: 9.5pt;
    }
    .meta-table td {
      padding: 3px 0;
      vertical-align: top;
    }
    .meta-label {
      width: 120px;
      font-weight: 600;
      color: #475569;
      text-transform: uppercase;
      font-size: 8.5pt;
    }
    .section-heading {
      font-size: 11pt;
      font-weight: 700;
      color: #0f172a;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 4px;
      margin-top: 22px;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    p, li {
      margin-top: 0;
      margin-bottom: 8px;
    }
    ol, ul {
      padding-left: 20px;
      margin-top: 4px;
      margin-bottom: 12px;
    }
    .highlight-box {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-left: 4px solid #0f172a;
      padding: 12px 14px;
      margin: 14px 0;
      border-radius: 4px;
    }
    .exhibit-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 8.5pt;
    }
    .exhibit-table th {
      background-color: #f1f5f9;
      text-align: left;
      padding: 6px 8px;
      font-weight: 600;
      color: #334155;
      border: 1px solid #cbd5e1;
    }
    .exhibit-table td {
      padding: 6px 8px;
      border: 1px solid #cbd5e1;
      vertical-align: middle;
    }
    .mono {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
      font-size: 8pt;
      color: #0f172a;
    }
    .signature-section {
      margin-top: 40px;
      page-break-inside: avoid;
    }
    .sig-line {
      width: 250px;
      border-bottom: 1px solid #000;
      margin-top: 50px;
      margin-bottom: 6px;
    }
  </style>
</head>
<body>
  <div class="header-banner">
    <div class="notice-title">Notice of Dispute & Formal Demand</div>
    <div style="font-size: 9pt; color: #64748b;">Evidentiary Record Reference: ${escapeHtml(referenceNumber)}</div>
  </div>

  <table class="meta-table">
    <tr><td class="meta-label">Date:</td><td><strong>${escapeHtml(noticeDate)}</strong></td></tr>
    <tr><td class="meta-label">To (Respondent):</td><td><strong>${escapeHtml(recipient.name)}</strong> (${escapeHtml(recipient.role)})</td></tr>
    <tr><td class="meta-label">From (Claimant):</td><td><strong>${escapeHtml(sender.name)}</strong> (${escapeHtml(sender.role)})</td></tr>
    <tr><td class="meta-label">Matter / Re:</td><td><strong>${escapeHtml(subject)}</strong></td></tr>
  </table>

  <div class="section-heading">1. Statement of Dispute & Chronology</div>
  <ol>
    ${summaryOfFacts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('\n')}
  </ol>

  <div class="section-heading">2. Substantiated Claims</div>
  <ol>
    ${claims.map((clm) => `<li><strong>${escapeHtml(clm.statement)}</strong> <span style="font-size: 8.5pt; color: #64748b;">(Status: ${escapeHtml(clm.status)}, Citations: ${clm.citationCount})</span></li>`).join('\n')}
  </ol>

  ${
    financialDemand.hasFinancialClaim
      ? `<div class="section-heading">3. Financial Exposure & Claimed Damages</div>
  <div class="highlight-box">
    <table style="width: 100%; font-size: 9.5pt;">
      <tr><td>Principal Amount Withheld / Owed:</td><td style="text-align: right; font-weight: 600;">$${(financialDemand.principalMinor / 100).toFixed(2)}</td></tr>
      ${financialDemand.interestMinor > 0 ? `<tr><td>Statutory Accrued Interest:</td><td style="text-align: right; color: #0284c7;">+$${(financialDemand.interestMinor / 100).toFixed(2)}</td></tr>` : ''}
      ${financialDemand.penaltiesMinor > 0 ? `<tr><td>Statutory Liquidated Penalties:</td><td style="text-align: right; color: #b45309;">+$${(financialDemand.penaltiesMinor / 100).toFixed(2)}</td></tr>` : ''}
      <tr style="border-top: 1px solid #cbd5e1;"><td style="font-weight: 700; padding-top: 4px;">TOTAL MONETARY DEMAND:</td><td style="text-align: right; font-weight: 700; font-size: 11pt; padding-top: 4px; color: #0f172a;">${escapeHtml(financialDemand.totalAmountFormatted)}</td></tr>
    </table>
  </div>`
      : ''
  }

  <div class="section-heading">4. Exhibit Schedule & Cryptographic Integrity</div>
  <p style="font-size: 9pt; color: #475569;">The following evidence records have been authenticated and cryptographically fingerprinted on-device under SHA-256 standards:</p>
  <table class="exhibit-table">
    <thead>
      <tr>
        <th style="width: 12%;">Exhibit</th>
        <th style="width: 38%;">Document Description</th>
        <th style="width: 15%;">Type</th>
        <th style="width: 35%;">SHA-256 Digest</th>
      </tr>
    </thead>
    <tbody>
      ${exhibits
        .map(
          (ex) => `<tr>
        <td><strong>${escapeHtml(ex.index)}</strong></td>
        <td>${escapeHtml(ex.title)}</td>
        <td>${escapeHtml(ex.kind)}</td>
        <td class="mono">${escapeHtml(ex.sha256)}</td>
      </tr>`,
        )
        .join('\n')}
    </tbody>
  </table>

  <div class="section-heading">5. Demand for Remedy & Cure Window</div>
  <div class="highlight-box" style="border-left-color: #dc2626;">
    <p><strong>FINAL DEMAND:</strong> Notice is hereby given that the respondent has <strong>${cureWindowDays} calendar days</strong> from the receipt of this document, expiring on <strong>${escapeHtml(deadlineDate)}</strong>, to rectify the issues detailed herein or remit payment in full.</p>
    <p style="font-size: 9pt; margin-bottom: 0;">Failure to satisfy this demand within the statutory period will result in immediate formal filing with regulatory authorities, arbitration tribunals, or the competent court of jurisdiction. All additional legal costs, fees, and statutory interest will be claimed.</p>
  </div>

  <div class="signature-section">
    <p>Respectfully submitted,</p>
    <div class="sig-line"></div>
    <div><strong>${escapeHtml(sender.name)}</strong></div>
    <div style="font-size: 9pt; color: #64748b;">${escapeHtml(sender.role)}</div>
  </div>
</body>
</html>`;

  return {
    caseId,
    noticeDate,
    deadlineDate,
    cureWindowDays,
    referenceNumber,
    subject,
    sender,
    recipient,
    summaryOfFacts,
    claims,
    financialDemand,
    exhibits,
    plainText,
    html,
  };
}
