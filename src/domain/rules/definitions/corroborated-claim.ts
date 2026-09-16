import type { Rule, RuleFinding } from '../types';
import { distinctEvidenceLabels, evidenceLinkedTo, independentSources } from '../support';

/**
 * A claim backed by more than one independent source.
 *
 * Reported as good news rather than a problem, which matters: the Analysis Center
 * should show a user where their case is *strong*, not only where it is weak.
 *
 * "Independent" is doing real work here — see `independentSources`. Two copies of the
 * same PDF, or a screenshot of an email plus the email itself, do not corroborate.
 */
export const corroboratedClaimRule: Rule = {
  id: 'corroborated-claim@1',
  title: 'Corroborated claim',
  description: 'Two or more independent evidence items support the same claim.',
  rationale:
    'Corroboration is measured within this case only. It means several distinct sources ' +
    'agree, which is a reason for confidence — not proof that the underlying event ' +
    'occurred, and not a legal finding of any kind.',
  resultType: 'CORROBORATED_CLAIM',
  defaultSeverity: 'INFO',
  priority: 30,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    // This rule counts sources — "3 independent sources" — and then lists them. Two of them
    // sharing a title would show a reader a shorter list than the number they were just
    // given, which reads as a miscount rather than as a naming collision.
    const labelOf = distinctEvidenceLabels(context.evidence);

    for (const claim of context.claims) {
      const supporting = evidenceLinkedTo(context, 'claim', claim.id, ['SUPPORTS']);
      if (supporting.length < 2) continue;

      const independent = independentSources(context, supporting);
      if (independent.length < 2) continue;

      // A live contradiction means the claim is contested, not corroborated; that case
      // is reported by the claim-state machine instead.
      const contradicting = evidenceLinkedTo(context, 'claim', claim.id, ['CONTRADICTS']);
      if (contradicting.length > 0) continue;

      findings.push({
        key: [claim.id, ...independent.map((item) => item.id)],
        title: `${independent.length} independent sources support this claim`,
        explanation:
          `"${claim.statement}" is supported by ${independent.length} separate sources: ` +
          `${independent.map((item) => `"${labelOf.get(item.id) ?? item.id}"`).join(', ')}. ` +
          `They are counted as independent because they are not copies of one another and ` +
          `no duplicate or derived-from link connects them. This is the strongest position a ` +
          `claim can hold in this case; it is still a statement about your evidence, not a ` +
          `verified fact.`,
        confidence: 'STRONG_MATCH',
        relatedClaimIds: [claim.id],
        supportingEvidenceIds: independent.map((item) => item.id),
        inputs: {
          Claim: claim.statement,
          'Independent sources': String(independent.length),
          Sources: independent.map((item) => labelOf.get(item.id) ?? item.id).join(', '),
        },
      });
    }

    return findings;
  },
};
