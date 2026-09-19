import { longestSilence } from '../../analysis/escalation';
import { EXTRACTION_METHOD_LABELS } from '../../enums';
import { formatDate } from '../../normalize/dates';
import { isUnconfirmedReading } from '../provenance';
import type { Rule, RuleFinding } from '../types';

/**
 * A complaint nobody has answered.
 *
 * ## Why a rule about the calendar
 *
 * Every other rule in this registry asks whether the documents agree with each other. That
 * is the right question and it is not the only one, because the most common way a consumer
 * dispute in this market is lost is not evidential at all. The complaint is filed, the
 * organisation says nothing, the person waits — reasonably, politely — and by the time
 * anyone tells them there was an ombudsman they could have approached, the year is gone. No
 * document in the case is wrong. Nothing contradicts anything. The case is simply over.
 *
 * This is the one rule that reads the case and reports the clock.
 *
 * ## What it states, and what it refuses to
 *
 * Split strictly, because this is where a helpful product becomes a harmful one:
 *
 * - **Stated as fact:** the complaint's own date, and the number of days since. Both come
 *   from the user's own document and both are printed in `inputs`, so the arithmetic can be
 *   checked against the page it came from.
 * - **Stated as attribution:** the reply window and the forum, always with the scheme that
 *   provides them named in the same sentence, and always with an instruction to check the
 *   current rules.
 * - **Never stated at all:** a deadline, a limitation date, or time remaining in one. "You
 *   have 41 days left to file" is unfalsifiable to the reader and, if the sector or the
 *   starting date is wrong, it is advice that costs someone their claim.
 *
 * The finding therefore fails safe. A reader who checks and finds the next step is not open
 * to them has spent a phone call. The opposite framing, a countdown that is wrong, loses
 * the case.
 *
 * ## Severity, and why it is not HIGH
 *
 * MEDIUM. A silence is a prompt to act, not a defect in the evidence, and it must not
 * outrank a genuine contradiction in the same list. INFO would bury it.
 *
 * ## Determinism
 *
 * `context.now` is injected by the engine, never read from a clock here. The rule is silent
 * when no clock was supplied — the derived read models build a context without one — because
 * a rule that assumed today would produce a finding about elapsed time from a date its
 * caller never gave it.
 */
export const responseOverdueRule: Rule = {
  id: 'response-overdue@1',
  title: 'Complaint with no reply',
  description:
    'A complaint in this case has gone longer without an answer than its redressal scheme ' +
    'generally allows, and nothing else in the case is dated since.',
  rationale:
    'Reasons about the calendar rather than about the documents, which no other rule does. ' +
    'A dispute is most often lost by waiting rather than by being wrong, and the reply ' +
    'window and the forum that opens after it are public facts the person holding the ' +
    'complaint has no way to know. States elapsed time as arithmetic over the user’s own ' +
    'dates, quotes the window with its scheme named, and states no deadline of any kind.',
  resultType: 'RESPONSE_OVERDUE',
  defaultSeverity: 'MEDIUM',
  priority: 65,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    // No clock, no finding. Never `Date.now()` — see the note on `RuleContext.now`.
    if (context.now === null) return findings;

    const silence = longestSilence(context.evidence, (id) => context.extractionOf(id), context.now);
    if (!silence) return findings;

    const { complaint, profile, daysElapsed } = silence;
    const on = formatDate(complaint.date);
    const reference = complaint.signal.reference;

    // The whole finding is one subtraction, and this is the number it subtracts from. If that
    // date was guessed at off a scan, the day count inherits the guess — so the rule says so
    // itself rather than presenting the arithmetic as if both ends were certain.
    //
    // The engine's quarantine does not cover this: it applies to conflict-shaped findings
    // only (see `../provenance`), and rightly so — an unconfirmed read here cannot fabricate
    // a dispute between two documents. It can only start the clock on the wrong day, which
    // is a caveat, not an accusation, and belongs in the sentence rather than in a demotion.
    const dateWasRead = isUnconfirmedReading(complaint.date.method);
    const readingCaveat = dateWasRead
      ? ` The date this count starts from was read from an image rather than from text in the ` +
        `file, so check it against the document before relying on the number of days.`
      : '';

    findings.push({
      // Keyed on the evidence item alone, deliberately. The day count changes every day and
      // keying on it would mint a new finding each morning and leave yesterday's behind, so
      // a dismissed prompt would come back tomorrow wearing a different id. Keyed this way
      // the finding is updated in place and a dismissal sticks.
      key: [complaint.evidenceId],
      title: `${daysElapsed} days since this complaint, with no reply recorded`,
      explanation:
        `"${complaint.title}" is dated ${on}${reference ? ` and carries reference ${reference}` : ''}, ` +
        `and ${daysElapsed} days have passed since. Nothing else in this case is dated after it.`,
      caveat:
        `Under ${profile.scheme}, a ${profile.sector} provider is generally expected to respond ` +
        `within ${profile.replyWindowDays} days, after which ${profile.nextStep} is usually the ` +
        `next step — you can reach it at ${profile.where}. ` +
        'Check the current rules of that scheme before acting: they are amended from time to ' +
        'time, and the time limits depend on facts this app cannot see. ' +
        'If a reply did arrive, adding it to this case will close this prompt.' +
        readingCaveat,
      confidence: 'NEEDS_REVIEW',
      supportingEvidenceIds: [complaint.evidenceId],
      // Declared even though this finding type is never quarantined, because `basis` is the
      // honest record of what the rule actually looked at: one date, on one document. If the
      // quarantine is ever widened, this rule is already accurate rather than over-broad.
      basis: [{ evidenceId: complaint.evidenceId, label: 'Date', field: complaint.date }],
      inputs: {
        Complaint: `${complaint.title} — ${on}`,
        ...(reference ? { Reference: reference } : {}),
        'Days since': String(daysElapsed),
        'Reply window quoted': `${profile.replyWindowDays} days (${profile.scheme})`,
        'Usual next step': profile.nextStep,
        // Named in the inputs, not only in the prose, so the one soft value behind the count
        // is visible in the same table as the count itself.
        //
        // The key asks where the date came from rather than "read by", because the answers are
        // themselves sentences about reading ("Read from an image") and the pair would stutter.
        // This wrote `complaint.date.method` directly, so the row said "DETERMINISTIC".
        'Where the date came from': `${EXTRACTION_METHOD_LABELS[complaint.date.method]}${
          dateWasRead ? ' — unconfirmed' : ''
        }`,
      },
    });

    return findings;
  },
};
