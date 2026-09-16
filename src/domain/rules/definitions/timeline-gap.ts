import { daysBetween, formatDate } from '../../normalize/dates';
import type { CaseEvent, DateField } from '../../models';
import type { Rule, RuleFinding } from '../types';
import { evidenceLinkedTo, SUPPORTING_TYPES } from '../support';

/**
 * How long a silence has to be before it is worth mentioning.
 *
 * Chosen, not tuned. Sixty days is roughly two billing cycles: long enough that nothing
 * ordinary — an invoice, a reply, a payment run — explains it, and short enough to catch
 * the gap that actually matters in a payment dispute, where one side stops responding.
 * Below this the rule stays quiet rather than narrating a normal week.
 */
const GAP_THRESHOLD_DAYS = 60;

/**
 * A story needs a beginning and an end before a hole in the middle means anything.
 * With two events there is no middle, only a gap between the only two things known.
 */
const MIN_EVENTS = 3;

interface DatedEvent {
  event: CaseEvent;
  date: DateField;
  /** Whether any evidence is attached to this event at all. */
  evidenced: boolean;
}

/**
 * An unexplained silence in the sequence of events.
 *
 * This is the one rule that reasons about what is **absent**, which is why it exists: a
 * reviewer reading a timeline forwards notices the documents that are there and rarely
 * notices the four months where nothing is. The rule reads the same timeline and reports
 * the hole.
 *
 * It is framed as a question, never a conclusion. A long quiet period is completely
 * ordinary — work in progress, a payment term, a holiday, a case that simply paused — and
 * it is equally often the point where the records stop being complete. Which of those it
 * is cannot be decided from dates alone, so the finding says what it found and asks.
 *
 * Only day-precision dates take part. "March 2024" to "July 2024" could be a gap of
 * anywhere between three and five months, and inventing a number from that would be
 * exactly the kind of false precision this app is built to avoid.
 */
export const timelineGapRule: Rule = {
  id: 'timeline-gap@1',
  title: 'Gap in the timeline',
  description: 'A long period inside the case has no dated event recorded in it.',
  rationale:
    'Reasons about what is missing rather than what is present, which no other rule in ' +
    'the registry does. A quiet stretch is not a finding about the dispute — it is a ' +
    'finding about the *records*: either nothing happened, or something happened and was ' +
    'never documented. Only day-precision dates are used, because the length of a gap ' +
    'between two month-precision dates is not knowable.',
  resultType: 'TIMELINE_GAP',
  defaultSeverity: 'LOW',
  priority: 50,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    const dated: DatedEvent[] = context.events
      .map((event) => {
        const date = event.occurredAt;
        if (!date || !date.iso || date.precision !== 'DAY') return null;
        const sources = evidenceLinkedTo(context, 'event', event.id, SUPPORTING_TYPES);
        return { event, date, evidenced: sources.length > 0 };
      })
      .filter((entry): entry is DatedEvent => entry !== null)
      .sort((a, b) => (a.date.iso ?? '').localeCompare(b.date.iso ?? '') || a.event.id.localeCompare(b.event.id));

    if (dated.length < MIN_EVENTS) return findings;

    for (let i = 0; i < dated.length - 1; i += 1) {
      const before = dated[i]!;
      const after = dated[i + 1]!;

      const days = daysBetween(before.date, after.date);
      if (days === null || days < GAP_THRESHOLD_DAYS) continue;

      // A gap between two events that are themselves undocumented is a weaker
      // observation — the records are thin on both sides, so the silence says less.
      const bothEvidenced = before.evidenced && after.evidenced;

      findings.push({
        key: [before.event.id, after.event.id],
        title: `${days} days with nothing recorded`,
        explanation:
          `Nothing is recorded between "${before.event.title}" on ${formatDate(before.date)} and ` +
          `"${after.event.title}" on ${formatDate(after.date)} — a gap of ${days} days. ` +
          (bothEvidenced
            ? 'Both surrounding events have evidence attached, so the records are otherwise ' +
              'complete here. If something happened during this period, the document that ' +
              'shows it has not been added yet.'
            : 'At least one of the surrounding events has no evidence attached, so this part ' +
              'of the case is thinly documented in general.') +
          ' A quiet period may be entirely normal — work in progress, a payment term, or a ' +
          'pause. This is a prompt to check, not a problem.',
        severity: bothEvidenced ? 'LOW' : 'INFO',
        confidence: 'NEEDS_REVIEW',
        relatedEventIds: [before.event.id, after.event.id],
        relatedClaimIds: [...new Set([...before.event.claimIds, ...after.event.claimIds])].sort(),
        inputs: {
          'Last recorded': `${before.event.title} — ${formatDate(before.date)}`,
          'Next recorded': `${after.event.title} — ${formatDate(after.date)}`,
          'Days between': String(days),
          Threshold: `${GAP_THRESHOLD_DAYS} days`,
        },
      });
    }

    return findings;
  },
};
