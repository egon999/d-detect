import type { Rule, RuleFinding } from '../types';
import { distinctEvidenceLabels, evidenceLinkedTo, independentSources } from '../support';

/**
 * An event attested by more than one independent source.
 *
 * The event-level counterpart to `corroborated-claim`. Kept as a separate rule
 * because the two answer different questions: whether a *statement* is backed up,
 * versus whether something *happened* on the record.
 */
export const corroboratedEventRule: Rule = {
  id: 'corroborated-event@1',
  title: 'Corroborated event',
  description: 'Two or more independent evidence items attest to the same event.',
  rationale:
    'Independence is established by distinct file hashes and the absence of duplicate or ' +
    'derived-from links. Without that check, uploading the same receipt twice would make ' +
    'an event look twice as well evidenced as it is.',
  resultType: 'CORROBORATED_EVENT',
  defaultSeverity: 'INFO',
  priority: 30,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    // Named sources are counted and then listed; duplicate titles would make the list
    // appear to contradict the count. See `corroborated-claim` for the same reasoning.
    const labelOf = distinctEvidenceLabels(context.evidence);

    for (const event of context.events) {
      const supporting = evidenceLinkedTo(context, 'event', event.id, ['SUPPORTS', 'ATTACHED_TO_EVENT']);
      if (supporting.length < 2) continue;

      const independent = independentSources(context, supporting);
      if (independent.length < 2) continue;

      findings.push({
        key: [event.id, ...independent.map((item) => item.id)],
        title: `"${event.title}" is backed by ${independent.length} independent sources`,
        explanation:
          `${independent.map((item) => `"${labelOf.get(item.id) ?? item.id}"`).join(' and ')} each attest to ` +
          `"${event.title}", and none is a copy or derivative of another. Multiple independent ` +
          `records of the same event are harder to dispute than a single document. This remains ` +
          `a description of your evidence, not confirmation that the event occurred.`,
        confidence: 'STRONG_MATCH',
        relatedEventIds: [event.id],
        relatedClaimIds: event.claimIds,
        supportingEvidenceIds: independent.map((item) => item.id),
        inputs: {
          Event: event.title,
          'Independent sources': String(independent.length),
          Sources: independent.map((item) => labelOf.get(item.id) ?? item.id).join(', '),
        },
      });
    }

    return findings;
  },
};
