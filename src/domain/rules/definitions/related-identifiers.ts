import type { Rule, RuleFinding } from '../types';
import { distinctEvidenceLabels, identifierGroups } from '../support';

/**
 * Shared reference numbers.
 *
 * When several documents quote the same normalized invoice, order or transaction
 * reference, they are about the same transaction. That is a strong, deterministic
 * link — but explicitly *not* corroboration: an invoice and the reminder email that
 * quotes it both originate from the same party.
 */
export const relatedIdentifiersRule: Rule = {
  id: 'related-identifiers@1',
  title: 'Shared reference number',
  description: 'Several evidence items quote the same normalized reference number.',
  rationale:
    'Reference numbers are written inconsistently (INV-2024/018 vs inv2024018), so they ' +
    'are compared in normalized form. One finding is raised per reference number rather ' +
    'than per pair of documents. A shared reference connects subject matter only; it ' +
    'does not make the documents independent sources.',
  resultType: 'RELATED_EVIDENCE',
  defaultSeverity: 'INFO',
  priority: 40,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    // Documents quoting one reference are frequently exports of the same thing and so
    // frequently share a title; the finding names each of them, so they must be distinct.
    const labelOf = distinctEvidenceLabels(context.evidence);

    for (const group of identifierGroups(context)) {
      const labels = group.items.map((item) => labelOf.get(item.id) ?? item.id);

      findings.push({
        // Keyed by the reference itself, not by the documents, so adding a seventh
        // document to an existing thread updates this finding instead of replacing it.
        key: [group.field, group.value],
        title: `${group.items.length} documents share ${group.label} ${group.value}`,
        explanation:
          `${labels.map((label) => `"${label}"`).join(', ')} all reference ${group.value}. ` +
          `They describe the same transaction, which is why they appear connected in the ` +
          `graph. Note that a shared reference does not make them independent sources — ` +
          `several may originate from the same party.`,
        confidence: 'EXACT_MATCH',
        supportingEvidenceIds: group.items.map((item) => item.id),
        inputs: {
          [`Shared ${group.label}`]: group.value,
          Documents: labels.join(', '),
        },
      });
    }

    return findings;
  },
};
