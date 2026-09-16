import type { DateField } from '../../models';
import { datesConflict, formatDate } from '../../normalize/dates';
import { DATE_CONFLICT_CATEGORY_LABELS, classifyDateDiscrepancy } from '../../analysis/conflict-classification';
import type { Rule, RuleFinding } from '../types';
import { distinctEvidenceLabels, evidenceLinkedTo, SUPPORTING_TYPES } from '../support';

/**
 * Chooses the one date in a document that plausibly dates the event it is attached to.
 *
 * Conservative on purpose. An invoice carries an issue date, a due date and often a
 * printed date; comparing all of them against another document's dates would generate
 * a conflict for almost every pair. A source is only allowed to "vote" on an event
 * date when its intent is unambiguous:
 *
 * - a date explicitly labelled with a role in the source, or
 * - exactly one day-precision date in the whole document.
 *
 * Anything else abstains rather than guesses.
 */
function anchorDate(dates: readonly DateField[]): DateField | null {
  const roleOrder = ['issued', 'paid', 'delivered'] as const;
  for (const role of roleOrder) {
    const matches = dates.filter((date) => date.role === role && date.iso);
    if (matches.length === 1) return matches[0]!;
  }
  const dayPrecision = dates.filter((date) => date.precision === 'DAY' && date.iso);
  return dayPrecision.length === 1 ? dayPrecision[0]! : null;
}

/**
 * Sources disagree about when an event happened.
 *
 * Named "possible conflict" throughout, never "conflict": two different dates on two
 * documents very often describe two different stages of the same process (work
 * delivered on one date, invoiced on another). The rule surfaces the disagreement and
 * names both sources; deciding what it means is the user's job.
 */
export const eventDateConflictRule: Rule = {
  id: 'event-date-conflict@1',
  title: 'Possible date conflict',
  description: 'Evidence attached to one event reports different dates.',
  rationale:
    'Dates are compared at the coarser of the two precisions, so "March 2024" never ' +
    'contradicts "15 March 2024". Where a source date was itself ambiguous (03/04/2024), ' +
    'the finding is downgraded and says so, because the disagreement may be a parsing ' +
    'artefact rather than a real discrepancy.',
  resultType: 'POSSIBLE_CONFLICT',
  defaultSeverity: 'HIGH',
  priority: 95,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    // Distinct across the case, so a document keeps one name in every finding. Without this,
    // two sources both titled "Screenshot" produce `"Screenshot" gives 12 March while
    // "Screenshot" gives 15 March` and an `inputs` map holding only one of the two dates —
    // in the finding whose entire job is to show the reader both.
    const labelOf = distinctEvidenceLabels(context.evidence);
    const label = (id: string): string => labelOf.get(id) ?? id;

    for (const event of context.events) {
      const sources = evidenceLinkedTo(context, 'event', event.id, SUPPORTING_TYPES);
      if (sources.length < 2) continue;

      const dated = sources
        .map((item) => {
          const extraction = context.extractionOf(item.id);
          const date = extraction ? anchorDate(extraction.dates) : null;
          return date ? { item, date } : null;
        })
        .filter((entry): entry is { item: (typeof sources)[number]; date: DateField } => entry !== null);

      if (dated.length < 2) continue;

      // Report each disagreeing pair separately so a user can review and dismiss one
      // without hiding the others.
      for (let i = 0; i < dated.length; i += 1) {
        for (let j = i + 1; j < dated.length; j += 1) {
          const first = dated[i]!;
          const second = dated[j]!;
          if (!datesConflict(first.date, second.date)) continue;

          const ambiguous = first.date.ambiguous || second.date.ambiguous;
          const classification = classifyDateDiscrepancy(first.date, second.date, {
            labelA: label(first.item.id),
            labelB: label(second.item.id),
          });

          findings.push({
            key: [event.id, first.item.id, second.item.id],
            title: `Sources disagree on the date of "${event.title}"`,
            explanation:
              `"${label(first.item.id)}" gives ${formatDate(first.date)} while ` +
              `"${label(second.item.id)}" gives ${formatDate(second.date)} for the event ` +
              `"${event.title}". ` +
              (ambiguous
                ? 'At least one of these was written in a format where the day and month ' +
                  'could be read either way, so this may be a formatting difference rather than ' +
                  'a real disagreement. Open both sources and confirm the intended dates.'
                : `${classification.explanation} Open both sources before changing the event date.`),
            severity: ambiguous ? 'MEDIUM' : classification.material ? 'HIGH' : 'MEDIUM',
            confidence: 'NEEDS_REVIEW',
            supportingEvidenceIds: [first.item.id, second.item.id],
            relatedEventIds: [event.id],
            relatedClaimIds: event.claimIds,
            inputs: {
              Event: event.title,
              [label(first.item.id)]: `${formatDate(first.date)} (from "${first.date.original}")`,
              [label(second.item.id)]: `${formatDate(second.date)} (from "${second.date.original}")`,
              Discrepancy: DATE_CONFLICT_CATEGORY_LABELS[classification.category],
              ...(ambiguous ? { Note: 'One or both source dates were ambiguous day/month order' } : {}),
            },
            // The two dates and nothing else. If either was read off an image and never
            // confirmed, the engine marks this provisional and names exactly these two
            // values — rather than every field in both documents.
            basis: [
              { evidenceId: first.item.id, label: 'Date', field: first.date },
              { evidenceId: second.item.id, label: 'Date', field: second.date },
            ],
          });
        }
      }
    }

    return findings;
  },
};
