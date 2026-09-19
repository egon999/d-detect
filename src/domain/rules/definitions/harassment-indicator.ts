import type { Rule, RuleFinding } from '../types';
import { distinctEvidenceLabels } from '../support';

export const harassmentIndicatorRule: Rule = {
  id: 'harassment-indicator@1',
  title: 'Harassment or threatening language detected',
  description: 'Chat transcripts or message screenshots contain hostile, defamatory, or threatening dialogue.',
  rationale:
    'In communication and interpersonal harassment disputes, extracted chat records reveal hostile ' +
    'or coercive statements between parties that warrant immediate forensic scrutiny.',
  resultType: 'HARASSMENT_INDICATOR',
  defaultSeverity: 'HIGH',
  priority: 92,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    const labelOf = distinctEvidenceLabels(context.evidence);

    for (const item of context.evidence) {
      const extraction = context.extractionOf(item.id);
      if (!extraction) continue;

      const suspiciousMessages = (extraction.chatMessages ?? []).filter((m) => m.suspicious);
      if (suspiciousMessages.length > 0) {
        const label = labelOf.get(item.id) ?? item.id;
        const senders = Array.from(new Set(suspiciousMessages.map((m) => m.sender))).join(', ');
        const count = suspiciousMessages.length;

        // One quote, truncated on a word boundary so the excerpt does not end mid-word.
        // The full text stays in the evidence itself; this is a pointer to it, not a
        // substitute for reading it.
        const first = suspiciousMessages[0]!.content.trim();
        const sampleQuote = first.length > 80 ? `${first.slice(0, 80).replace(/\s+\S*$/, '')}…` : first;

        findings.push({
          key: [item.id, 'harassment', String(count)],
          title: `Threatening wording found in "${label}"`,
          explanation:
            `${count} message${count === 1 ? '' : 's'} from ${senders} in "${label}" ` +
            `use wording flagged as coercive or threatening — for example: "${sampleQuote}".`,
          caveat:
            'Flagging is based on wording alone and carries no finding about intent. The same ' +
            'words can be a quotation, a joke, or a description of something someone else ' +
            'said. Read the surrounding conversation before treating it as harassment.',
          severity: 'HIGH',
          // Wording matching is a keyword test, not a judgement about what was meant, so
          // this is reported for a person to confirm rather than as an established match.
          confidence: 'NEEDS_REVIEW',
          inputs: {
            'Messages flagged': String(count),
            Sender: senders,
            Document: label,
          },
          supportingEvidenceIds: [item.id],
          relatedClaimIds: context.claims.map((c) => c.id),
          relatedEventIds: [],
        });
      }
    }

    return findings;
  },
};
