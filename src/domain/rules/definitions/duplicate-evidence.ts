import type { Rule, RuleFinding } from '../types';
import { distinctEvidenceLabels, evidencePairs } from '../support';

/**
 * Exact duplicate detection.
 *
 * The *only* basis for calling two items duplicates is byte equality of the source
 * file, established by SHA-256. Two invoices with the same number are "related"
 * (see `related-identifiers`), not duplicates — one might be a revision of the other.
 */
export const duplicateEvidenceRule: Rule = {
  id: 'duplicate-evidence@1',
  title: 'Duplicate evidence',
  description: 'Two evidence items have identical file contents.',
  rationale:
    'Identical files are one source counted twice. Treating them as two would inflate ' +
    'how well-corroborated a claim appears. This rule proves duplication by hash and ' +
    'nothing else.',
  resultType: 'DUPLICATE_EVIDENCE',
  defaultSeverity: 'LOW',
  priority: 70,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];
    const hashed = context.evidence.filter((item) => item.sha256);

    // This rule needs distinct labels more than any other: the two items it reports are the
    // same file, so they very often carry the same title too. `"Screenshot" and "Screenshot"
    // are byte-for-byte identical` tells the reader nothing about which two entries to go
    // and look at, which is the one thing the finding exists to tell them.
    const labelOf = distinctEvidenceLabels(hashed);

    for (const [first, second] of evidencePairs(hashed)) {
      if (first.sha256 !== second.sha256) continue;

      const firstLabel = labelOf.get(first.id) ?? first.id;
      const secondLabel = labelOf.get(second.id) ?? second.id;

      findings.push({
        key: [first.id, second.id],
        title: 'Identical files uploaded twice',
        explanation:
          `"${firstLabel}" and "${secondLabel}" are byte-for-byte identical ` +
          `(same SHA-256 fingerprint). They are one source, not two, so they cannot corroborate ` +
          `each other. Keep whichever has the better context and unlink or delete the other.`,
        confidence: 'EXACT_MATCH',
        supportingEvidenceIds: [first.id, second.id],
        inputs: {
          'First item': firstLabel,
          'Second item': secondLabel,
          // Reported in full, not truncated. This digest is the entire basis for calling
          // the two items duplicates, and a reader who wants to check that claim against
          // the files themselves needs the whole value to do it.
          'SHA-256': first.sha256!,
        },
      });
    }

    return findings;
  },
};
