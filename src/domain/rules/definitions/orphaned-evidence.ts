import type { Rule, RuleFinding } from '../types';
import { distinctEvidenceLabels } from '../support';

/**
 * Evidence that has been uploaded and then left unconnected.
 *
 * The counterpart to `unsupported-claim`, approached from the other end of the graph. A
 * claim with no evidence is visible — it sits in the claims list with an UNSUPPORTED
 * badge. A *document* with no claim is invisible: it appears in the evidence list looking
 * exactly like every other item, contributes to nothing, and is silently excluded from
 * every other rule in the registry, because they all traverse relationships.
 *
 * That is the failure mode this catches. Someone uploads eleven documents, links six, and
 * the analysis runs cleanly over the six — reporting nothing at all about the five that
 * were the reason they opened the app.
 *
 * `RELATED_TO` counts as a connection here even though no other rule treats it as
 * support. The question is "has anyone said what this document is for", not "does it
 * prove anything", and a deliberate RELATED_TO link is an answer to the first question.
 */
export const orphanedEvidenceRule: Rule = {
  id: 'orphaned-evidence@1',
  title: 'Evidence not linked to anything',
  description: 'An evidence item has no relationship to any claim, event or other document.',
  rationale:
    'Every other rule reaches evidence by following relationships, so an unlinked ' +
    'document is excluded from the entire analysis while still appearing in the evidence ' +
    'list as though it had been considered. This rule exists so that exclusion is stated ' +
    'rather than silent. It is not a judgement on the document — only a note that nothing ' +
    'has been said about what it is for yet.',
  resultType: 'UNLINKED_EVIDENCE',
  defaultSeverity: 'MEDIUM',
  priority: 60,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    // One finding is raised per unlinked document, so the label is how a reader knows
    // which file to go and link. Two files called "Screenshot" would produce two
    // findings a reader cannot tell apart.
    const labelOf = distinctEvidenceLabels(context.evidence);

    // With nothing to link *to*, "unlinked" is not a meaningful observation — it is just
    // what a case looks like before any structure has been added. Reporting it on an
    // empty case would greet a new user with a finding for every file they uploaded.
    if (context.claims.length === 0 && context.events.length === 0) return findings;

    const unlinked = context.evidence.filter(
      (item) =>
        context.linksFrom('evidence', item.id).length === 0 &&
        context.linksTo('evidence', item.id).length === 0,
    );

    if (unlinked.length === 0) return findings;

    // One finding per document rather than one listing them all. A user resolves these by
    // linking documents one at a time, and a single finding that stays open until the
    // last one is connected gives no sense of progress.
    for (const item of unlinked) {
      const label = labelOf.get(item.id) ?? item.id;
      const extraction = context.extractionOf(item.id);
      const hasText = extraction !== null && extraction.sourceText.trim().length > 0;

      // A document whose contents were read is a stronger loss than one that is a bare
      // filename: there are extracted dates and amounts sitting there, unused.
      const signals = extraction
        ? extraction.dates.length + extraction.amounts.length + extraction.invoiceNumbers.length
        : 0;

      findings.push({
        key: [item.id],
        title: `"${label}" is not linked to anything`,
        explanation:
          `"${label}" has been added to this case but is not connected to any claim, event or ` +
          `other document, so nothing has been checked about it.`,
        caveat:
          'Every analysis in this app works by following those connections — an unlinked ' +
          'document is stored, and that is all. ' +
          (signals > 0
            ? `${signals} dated or numeric value${signals === 1 ? '' : 's'} were read from it ` +
              `and are currently unused. Linking it to a claim or an event brings those into ` +
              `the analysis.`
            : hasText
              ? 'Its text was read but no dates, amounts or reference numbers were recognised. ' +
                'Link it to a claim or event to record what it is for.'
              : 'No text was read from it either, so it currently contributes nothing but its ' +
                'filename. Link it to a claim or event, and add what it shows.'),
        severity: signals > 0 ? 'MEDIUM' : 'LOW',
        confidence: 'EXACT_MATCH',
        supportingEvidenceIds: [item.id],
        inputs: {
          Document: label,
          'Values read from it': String(signals),
          'Links to claims or events': '0',
        },
      });
    }

    return findings;
  },
};
