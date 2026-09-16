import { EVIDENCE_KIND_LABELS, PROCESSING_STATE_LABELS } from '../enums';
import type { CaseCitation, CaseAnalysis, Workspace } from '../models';
import {
  ASSESSMENT_LABELS,
  currentClaimAssessment,
  latestCaseAnalysis,
  reportIsStale,
  resolveCitation,
} from './case-report';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

/**
 * A stored timestamp as a person would write it.
 *
 * `toISOString()` was printing `2026-09-14T18:22:31.000Z` into a document meant to be read
 * by someone with no reason to know what a `Z` means. The report is printed, so the date is
 * spelled out; the locale is fixed to `en-GB` rather than left to the device, because this
 * string is generated once and must read the same wherever it was produced.
 */
function formatMoment(value: number): string {
  return new Date(value).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

/**
 * The printable case report.
 *
 * ## What this document is for
 *
 * It is a record of what was submitted and what the app made of it, meant to be read by
 * someone who was not present when the evidence was gathered — a supervisor, an adviser,
 * opposing counsel. That reader has no access to the app, so the report has to stand alone.
 *
 * ## Why internal identifiers are not printed
 *
 * An earlier version printed the case id, the assessment id, each evidence id and each
 * citation's segment id. Those are storage keys. They are not stable across a re-import,
 * they mean nothing outside the database, and a document that names its own tables reads
 * as a debug dump rather than a finding. The anchors a reader can actually use are kept:
 * the source title, the passage quoted in full, the moment it was read, and the SHA-256 of
 * the original file — that last one is the only identifier that exists outside the app, and
 * it is printed whole because a truncated hash cannot be used to check anything.
 *
 * The same reasoning removes the character offsets. "characters 1184–1226" is an index into
 * a string the reader does not have; the quotation below it is the thing they can verify.
 *
 * ## Why nothing here is a verdict
 *
 * Every section states what the records show, names the passages it was read from, and says
 * what remains unresolved. The closing section says plainly what the report does not
 * establish. A hash proves the bytes received are the bytes reported; it does not prove the
 * document is genuine and it does not prove the events happened.
 */
export function buildCaseReportHtml(workspace: Workspace, caseId: string, exportedAt: number): string {
  const record = workspace.cases.find((item) => item.id === caseId && !item.deletedAt);
  if (!record) throw new Error('This case is not available for export.');

  const report = latestCaseAnalysis(workspace, caseId);
  const evidence = workspace.evidence.filter((item) => item.caseId === caseId && !item.deletedAt);
  const claims = workspace.claims.filter((item) => item.caseId === caseId && !item.deletedAt);

  const citations = (items: readonly CaseCitation[]): string =>
    items
      .map((citation) => {
        const source = evidence.find((item) => item.id === citation.evidenceId);

        // A citation is re-checked against the stored source every time it is shown, not
        // trusted because it was once written down. If the passage can no longer be found
        // in the source text — the document was reprocessed, or replaced — the report says
        // so rather than presenting the stored quotation as if it still stood.
        if (!source || !resolveCitation(workspace, citation)) {
          return `<blockquote>${escapeHtml(citation.quote)}<footer>Quotation as stored. The source it was read from is no longer available or has changed, so this passage cannot currently be checked.</footer></blockquote>`;
        }

        return `<blockquote>${escapeHtml(citation.quote)}<footer>${escapeHtml(source.title)}</footer></blockquote>`;
      })
      .join('');

  const claimSections = claims
    .map((claim) => {
      const assessment = currentClaimAssessment(report, claim);
      const parts = [
        `<h3>${escapeHtml(claim.statement)}</h3>`,
        `<strong>${assessment ? ASSESSMENT_LABELS[assessment.status] : 'Not assessed for this version of the claim'}</strong>`,
        `<p>${escapeHtml(assessment?.explanation ?? claim.detail)}</p>`,
      ];

      if (assessment) {
        parts.push(citations(assessment.citations));

        if (assessment.missingInformation.length) {
          parts.push(
            `<p><strong>What is still missing</strong></p><p>${escapeHtml(assessment.missingInformation.join('\n'))}</p>`,
          );
        }
        if (assessment.limitations.length) {
          parts.push(
            `<p><strong>What this does not settle</strong></p><p>${escapeHtml(assessment.limitations.join('\n'))}</p>`,
          );
        }
      }

      return `<article>${parts.join('')}</article>`;
    })
    .join('');

  const findingSections = report
    ? (['Agreement', 'Contradiction'] as const)
        .map((label) => {
          const findings = label === 'Agreement' ? report.agreements : report.contradictions;
          return findings
            .map(
              (finding) =>
                `<article><strong>${label}</strong><p>${escapeHtml(finding.statement)}</p>${citations(finding.citations)}</article>`,
            )
            .join('');
        })
        .join('')
    : '';

  const timelineSection = report
    ? report.timeline
        .map(
          (item) =>
            `<article><small>${escapeHtml(item.occurredAt || 'Time not established')}</small><p>${escapeHtml(item.description)}</p>${citations(item.citations)}</article>`,
        )
        .join('')
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(record.title)}</title><style>
    body{font:14px/1.6 system-ui,sans-serif;color:#17212e;margin:36px;max-width:1000px}h1{font-size:28px}h2{margin-top:32px}h3{font-size:17px}article{break-inside:avoid;border-top:1px solid #ccd2da;padding:14px 0}blockquote{border-left:3px solid #64748b;margin:12px 0;padding:8px 16px;white-space:pre-wrap}footer,small{color:#526070;font-size:12px}p{white-space:pre-wrap}code{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{padding:8px;text-align:left;border-bottom:1px solid #ddd;vertical-align:top} @media print{body{margin:12mm}}
    </style></head><body>
    <h1>${escapeHtml(record.title)}</h1>
    <small>Prepared ${escapeHtml(formatMoment(exportedAt))}</small>
    <p>${escapeHtml(record.description)}</p>
    <p>Category: ${escapeHtml(record.category || 'Unspecified')} · Reported incident period: ${escapeHtml(record.incidentDate || 'Unknown')}</p>

    <h2>Claims and saved assessments</h2>
    ${report && reportIsStale(workspace, report) ? '<p><strong>The case has changed since this assessment was made. The conclusions below describe an earlier state of the evidence.</strong></p>' : ''}
    ${
      report
        ? `<p>${escapeHtml(report.summary)}</p><small>${
            report.coverage.processedEvidence === report.coverage.totalEvidence
              ? `All ${report.coverage.totalEvidence} sources included`
              : `${report.coverage.processedEvidence} of ${report.coverage.totalEvidence} sources included`
          }${report.coverage.truncated ? ' · Coverage is incomplete' : ''}</small>`
        : '<p>No saved assessment. The statements below have not been checked against the evidence.</p>'
    }
    ${claimSections || '<p>No claims have been recorded for this case.</p>'}

    ${report ? `<h2>Agreements and contradictions</h2>${findingSections || '<p>No agreements or contradictions were recorded.</p>'}<h2>Sequence of events</h2>${timelineSection || '<p>No dated events were recorded.</p>'}<h2>Limits of this assessment</h2><p>${escapeHtml(report.limitations.join('\n'))}</p>` : ''}

    <h2>Evidence index</h2>
    ${evidence
      .map(
        (item) => `<article>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(EVIDENCE_KIND_LABELS[item.kind])} · ${escapeHtml(PROCESSING_STATE_LABELS[item.state])} · Provided as: ${escapeHtml(item.sourceLabel || 'Not specified')}</p>
      <small>${escapeHtml(item.fileName || 'Typed statement')} · Captured: ${escapeHtml(item.capturedAt || 'Not stated')}</small>
      <p>Original file fingerprint (SHA-256): <code>${escapeHtml(item.sha256 || 'No original file — this is a typed statement')}</code></p>
    </article>`,
      )
      .join('')}

    <h2>What this report establishes</h2>
    <p>This report describes the records that were submitted and how this app read them. It does not establish that the events described occurred.</p>
    <p>An assessment states what the submitted records support, contradict or leave unresolved. Machine reading — optical character recognition and audio transcription — can be wrong, and any passage quoted above should be checked against the original file before it is relied on.</p>
    <p>The fingerprint recorded against each source identifies the bytes this app received. It does not certify that the document is genuine, nor that it came from the person it names. A document can be authentic and still be mistaken, and it can be entirely fabricated while hashing consistently.</p>
    <p>Source identity, authenticity, missing context and any legal conclusion require independent review. Original files are held separately and are not reproduced in this report.</p>
    </body></html>`;
}
