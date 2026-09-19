import type { Rule, RuleFinding } from '../types';
import { evidenceLinkedTo } from '../support';

/**
 * A claim nobody has backed up yet.
 *
 * This is the most actionable finding in the product: it tells the user exactly where
 * their case is thin, before anyone else points it out. It is a statement about the
 * *current evidence set*, not about whether the claim is true.
 */
export const unsupportedClaimRule: Rule = {
  id: 'unsupported-claim@1',
  title: 'Unsupported claim',
  description: 'A claim has no evidence linked to it as supporting.',
  rationale:
    'Absence of linked evidence is absence of organisation, not proof that the claim is ' +
    'false. The explanation is therefore written as a prompt for action rather than a ' +
    'verdict.',
  resultType: 'UNSUPPORTED_CLAIM',
  defaultSeverity: 'MEDIUM',
  priority: 80,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    for (const claim of context.claims) {
      const supporting = evidenceLinkedTo(context, 'claim', claim.id, ['SUPPORTS', 'RELEVANT_TO_CLAIM']);
      if (supporting.length > 0) continue;

      // Evidence sitting on an event that the claim depends on still counts as
      // indirect support — flagging those claims would be misleading.
      const viaEvents = claim.requiredEventIds.some(
        (eventId) => evidenceLinkedTo(context, 'event', eventId, ['SUPPORTS', 'ATTACHED_TO_EVENT']).length > 0,
      );
      if (viaEvents) continue;

      findings.push({
        key: [claim.id],
        title: 'This claim has no supporting evidence',
        explanation: `"${claim.statement}" is not linked to any evidence.`,
        caveat:
          'That does not mean it is wrong — it means nothing in this case currently backs it ' +
          'up. Upload a document that shows it, then link that document to this claim with a ' +
          '"Supports" relationship.',
        confidence: 'NEEDS_REVIEW',
        relatedClaimIds: [claim.id],
        inputs: {
          Claim: claim.statement,
          'Supporting evidence': '0 items',
          'Required events with evidence': `0 of ${claim.requiredEventIds.length}`,
        },
      });
    }

    return findings;
  },
};
