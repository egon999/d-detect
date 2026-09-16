import type { Rule, RuleFinding } from '../types';
import { evidenceLinkedTo, SUPPORTING_TYPES } from '../support';

/**
 * Suggests what documents would strengthen a specific gap in the case.
 * Keyed on document type so the advice is concrete rather than "add more evidence".
 */
const SUGGESTIONS: ReadonlyArray<{ test: RegExp; suggestion: string }> = [
  { test: /\b(paid|payment|transfer|settled|remit)\b/i, suggestion: 'a bank statement line, payment receipt or UPI/transfer confirmation' },
  { test: /\b(invoice|billed|charged)\b/i, suggestion: 'the invoice itself, or the email it was sent with' },
  { test: /\b(deliver|submitted|handed over|completed|shipped)\b/i, suggestion: 'a delivery note, handover email or timestamped file transfer' },
  { test: /\b(agreed|contract|scope|terms|signed)\b/i, suggestion: 'the signed agreement, or the message thread where terms were accepted' },
  { test: /\b(meeting|call|discussed|spoke)\b/i, suggestion: 'a calendar entry, call log or a contemporaneous note written at the time' },
];

function suggestFor(text: string): string {
  return (
    SUGGESTIONS.find((entry) => entry.test.test(text))?.suggestion ??
    'any document created at the time that mentions this event'
  );
}

/**
 * An event a claim depends on, with nothing evidencing it.
 *
 * Only fires for events the user marked as *required* by a claim. Flagging every
 * undocumented event would bury the genuinely load-bearing gaps in noise, so the
 * signal comes from the user's own model of their case.
 */
export const missingEvidenceRule: Rule = {
  id: 'missing-evidence@1',
  title: 'Missing evidence',
  description: 'An event required by a claim has no evidence attached.',
  rationale:
    'This is the rule that turns Detact from a filing cabinet into an analysis tool: ' +
    'it names the specific hole in a case and what would fill it, before someone else ' +
    'finds it.',
  resultType: 'MISSING_EVIDENCE',
  defaultSeverity: 'MEDIUM',
  priority: 85,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    for (const claim of context.claims) {
      for (const eventId of [...(claim.requiredEventIds ?? [])].sort()) {
        const event = context.eventById.get(eventId);
        if (!event) continue;

        const attached = evidenceLinkedTo(context, 'event', eventId, SUPPORTING_TYPES);
        if (attached.length > 0) continue;

        const suggestion = suggestFor(`${event.title} ${event.description} ${claim.statement}`);

        findings.push({
          key: [claim.id, eventId],
          title: `"${event.title}" has nothing to show it happened`,
          explanation:
            `The claim "${claim.statement}" depends on the event "${event.title}", but no evidence ` +
            `is attached to that event. To close this gap, add ${suggestion}, then link it to the ` +
            `event. Until then this part of the case rests on your account alone.`,
          confidence: 'NEEDS_REVIEW',
          relatedClaimIds: [claim.id],
          relatedEventIds: [eventId],
          inputs: {
            Claim: claim.statement,
            'Event with no evidence': event.title,
            'Attached evidence': '0 items',
            'Suggested document': suggestion,
          },
        });
      }
    }

    return findings;
  },
};
