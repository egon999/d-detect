import type { Rule, RuleFinding } from '../types';
import {
  distinctEvidenceLabels,
  evidenceLinkedTo,
  independentSources,
  quoteShort,
} from '../support';

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
        title: `${quoteShort(event.title, 48)} is backed by ${independent.length} independent sources`,
        // Named in `inputs.Sources`, not here. Spelling the titles out in the sentence as well
        // printed the same list twice on one card and grew the observation with every extra
        // document — see `corroborated-claim` for the same change and the reasoning behind it.
        explanation:
          `${independent.length} separate sources attest to ${quoteShort(event.title)}, ` +
          `and none is a copy or derivative of another.`,
        caveat:
          'Several independent records of the same event are harder to dispute than a single ' +
          'document. This remains a description of what has been filed here, not confirmation ' +
          'that the event occurred.',
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
