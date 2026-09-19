/**
 * Reads a stored AI suggestion payload into something a screen can render.
 *
 * The four cross-document passes — reconciliation, support strength, missing information and
 * timeline coherence — each verify every citation they return against the real segment text,
 * then persist the whole result. Until this module existed the panel read `payload.citations`,
 * a flat array none of those four passes write, so every verified quote the product had
 * computed was stored and rendered as nothing. The reasoning was real; the gauge was missing.
 *
 * Three rules hold everywhere below.
 *
 * **Nothing is trusted.** A payload is `Record<string, unknown>` loaded out of the database and
 * may have been written by an older build against an older schema. Every field is checked
 * before it is read, and anything that fails is dropped rather than coerced.
 *
 * **A citation that cannot be checked is not shown.** `resolveCitation` re-reads the source
 * text at the stored offsets and refuses a quote that no longer matches. A citation missing
 * its offsets can never pass that check, so it is discarded here instead of being rendered as
 * a quote the reader cannot open.
 *
 * **Findings are capped.** The schemas allow up to 80 entries in one pass. A reader given 80
 * rows reads none of them, so only the first few are listed and the remainder is counted in a
 * single closing line.
 */

import type { CaseCitation } from '@domain/models';
import type { Tone } from '@ui';

/** How many findings one payload may put on screen before the rest become a count. */
export const MAX_FINDINGS = 6;

/** One value as a single document records it. */
export interface ReasonedReading {
  evidenceId: string;
  value: string;
  citations: CaseCitation[];
}

/** A single thing the pass found, with the passages behind it. */
export interface ReasonedFinding {
  key: string;
  /** The claim this is about, when the pass was assessing one. Resolved by the view. */
  subjectId: string | null;
  title: string;
  status: { label: string; tone: Tone } | null;
  /** The reasoning, in the pass's own words. */
  detail: string;
  /** A short second line: what would change the answer, or where the record is held. */
  note: string;
  readings: ReasonedReading[];
  citations: CaseCitation[];
}

/** A payload turned into a verdict, a list of findings, and one line about the rest. */
export interface ReasonedPayload {
  verdict: { label: string; tone: Tone; reason: string } | null;
  findings: ReasonedFinding[];
  /** What is not listed: values that agree, dates that fit, points already covered. */
  footnote: string;
}

function textOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The object entries of an array field, with anything that is not a plain object removed. */
function listOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Verified citations out of a payload field, in the shape the citation list renders.
 *
 * A stored `VerifiedCitation` is a `CaseCitation` without a stance, so the stance is supplied
 * by the caller from the field the citation was read out of — `supportingCitations` is support
 * and `conflictingCitations` is conflict, and collapsing the two would let a card quote the
 * passage that contradicts a claim under the heading of what supports it.
 *
 * An entry without usable offsets is dropped. `resolveCitation` compares the source text at
 * those offsets against the quote, so an entry that cannot satisfy it would render as a
 * passage the reader is told they cannot open — worse than the quote being absent.
 *
 * A payload that recorded its own stance keeps it. Only the four cross-document passes store
 * bare `VerifiedCitation`s; `evidence-intelligence` stores full `CaseCitation`s that already
 * know whether they support or contradict, and overwriting that would relabel a contradicting
 * passage as context.
 */
function citationsOf(value: unknown, stance: CaseCitation['stance']): CaseCitation[] {
  return listOf(value).flatMap((entry) => {
    const evidenceId = textOf(entry.evidenceId, 120);
    const segmentId = textOf(entry.segmentId, 160);
    const quote = typeof entry.quote === 'string' ? entry.quote : '';
    const startOffset = entry.startOffset;
    const endOffset = entry.endOffset;
    if (!evidenceId || !segmentId || !quote) return [];
    if (typeof startOffset !== 'number' || typeof endOffset !== 'number') return [];
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return [];
    if (startOffset < 0 || endOffset <= startOffset) return [];
    const stored = entry.stance;
    const resolved: CaseCitation['stance'] =
      stored === 'SUPPORTS' || stored === 'CONTRADICTS' || stored === 'CONTEXT' ? stored : stance;
    return [{ evidenceId, segmentId, quote, startOffset, endOffset, stance: resolved }];
  });
}

/** Trims the list to the cap and reports how many were left off. */
function capped(findings: ReasonedFinding[]): { shown: ReasonedFinding[]; hidden: number } {
  if (findings.length <= MAX_FINDINGS) return { shown: findings, hidden: 0 };
  return { shown: findings.slice(0, MAX_FINDINGS), hidden: findings.length - MAX_FINDINGS };
}

function footnoteFrom(parts: Array<string | null>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}

const AGREEMENT: Record<string, { label: string; tone: Tone }> = {
  ALL_AGREE: { label: 'All agree', tone: 'ok' },
  PARTIAL: { label: 'Partly agree', tone: 'warn' },
  DISAGREE: { label: 'Disagree', tone: 'danger' },
  SINGLE_SOURCE: { label: 'One source only', tone: 'neutral' },
};

/**
 * The shape of a difference, in words.
 *
 * Used only when the pass did not describe the divergence itself. Naming the kind is the point
 * of the field: "same amount, three days apart" and "₹500 apart, same day" have different
 * innocent explanations, and a similarity score would rank them as near-identical.
 */
const DIVERGENCE: Record<string, string> = {
  NOTATION_ONLY: 'Written differently, but the same value.',
  SAME_VALUE_DIFFERENT_DATE: 'The same value carries two different dates.',
  DIFFERENT_AMOUNT_SAME_DATE: 'Two different amounts on the same date.',
  DIFFERENT_AMOUNT_DIFFERENT_DATE: 'The amounts and the dates both differ.',
  DIFFERENT_IDENTIFIER: 'The reference numbers do not match.',
  DIFFERENT_PARTY: 'A different party is named.',
  DIFFERENT_STATUS: 'A different status is recorded.',
  ONE_SIDED: 'Only one document records this at all.',
};

function readReconciliation(payload: Record<string, unknown>): ReasonedPayload {
  const findings: ReasonedFinding[] = [];
  let agreed = 0;

  listOf(payload.facts).forEach((fact, index) => {
    const agreement = textOf(fact.agreement, 40) || 'SINGLE_SOURCE';
    if (agreement === 'ALL_AGREE') {
      agreed += 1;
      return;
    }

    const readings = listOf(fact.readings)
      .map((reading) => ({
        evidenceId: textOf(reading.evidenceId, 120),
        value: textOf(reading.value, 160),
        citations: citationsOf(reading.citations, 'CONTEXT'),
      }))
      .filter((reading) => reading.value !== '');

    const divergenceKind = textOf(fact.divergenceKind, 60);
    findings.push({
      key: `fact:${index}`,
      subjectId: null,
      title: textOf(fact.label, 160) || 'An unnamed value',
      status: AGREEMENT[agreement] ?? null,
      detail: textOf(fact.divergence, 400) || DIVERGENCE[divergenceKind] || '',
      note: textOf(fact.note, 240),
      readings,
      citations: [],
    });
  });

  listOf(payload.unreconciled).forEach((entry, index) => {
    const observation = textOf(entry.observation, 400);
    if (!observation) return;
    findings.push({
      key: `unreconciled:${index}`,
      subjectId: null,
      title: observation,
      status: { label: 'Stands alone', tone: 'warn' },
      detail: '',
      note: '',
      readings: [],
      citations: citationsOf(entry.citations, 'CONTEXT'),
    });
  });

  const { shown, hidden } = capped(findings);
  return {
    verdict: null,
    findings: shown,
    footnote: footnoteFrom([
      hidden > 0 ? `${plural(hidden, 'further difference is', 'further differences are')} not shown.` : null,
      agreed > 0 ? `${plural(agreed, 'other value agrees', 'other values agree')} across the documents.` : null,
    ]),
  };
}

const GRADED: Record<string, { label: string; tone: Tone }> = {
  STRONGLY_SUPPORTED: { label: 'Strongly supported', tone: 'ok' },
  SUPPORTED: { label: 'Supported', tone: 'ok' },
  CONFLICTING: { label: 'Sources conflict', tone: 'danger' },
  INSUFFICIENT: { label: 'Not enough in the records', tone: 'neutral' },
  INCONCLUSIVE: { label: 'Inconclusive', tone: 'neutral' },
  REQUIRES_REVIEW: { label: 'Needs your review', tone: 'warn' },
};

/** What the support is made of. A recorded figure and someone's assertion are not equal. */
const RESTS_ON: Record<string, string> = {
  RECORDED_VALUE: 'Rests on a figure recorded in a document.',
  STATEMENT_IN_DOCUMENT: 'Rests on something a document states.',
  ABSENCE_OF_RECORD: 'Rests on something not being recorded anywhere.',
  WORDING: 'Rests on how something is worded.',
};

function readSupportStrength(payload: Record<string, unknown>): ReasonedPayload {
  const all = listOf(payload.assessments).map((entry, index): ReasonedFinding => {
    const state = textOf(entry.state, 40) || 'REQUIRES_REVIEW';
    const adjustments = Array.isArray(entry.adjustments)
      ? entry.adjustments.filter((item): item is string => typeof item === 'string')
      : [];
    const changes = textOf(entry.whatWouldChangeIt, 300);

    return {
      key: `assessment:${index}`,
      subjectId: textOf(entry.claimId, 120) || null,
      title: '',
      status: GRADED[state] ?? null,
      detail: textOf(entry.reasoning, 600),
      // `adjustments` is where verification overruled the model. That is the more important
      // of the two lines, so it wins the slot when both are present — a reader is better
      // served knowing the answer was downgraded than knowing what might raise it.
      note: adjustments.length > 0
        ? adjustments.join(' ')
        : changes
          ? `What would change this: ${changes}`
          : RESTS_ON[textOf(entry.restsOn, 60)] ?? '',
      readings: [],
      citations: [
        ...citationsOf(entry.supportingCitations, 'SUPPORTS'),
        ...citationsOf(entry.conflictingCitations, 'CONTRADICTS'),
      ],
    };
  });

  const overall = textOf(payload.overall, 40);
  const { shown, hidden } = capped(all);
  return {
    verdict: overall && GRADED[overall]
      ? {
          label: GRADED[overall].label,
          tone: GRADED[overall].tone,
          reason: textOf(payload.overallReason, 600),
        }
      : null,
    findings: shown,
    footnote: hidden > 0 ? `${plural(hidden, 'further claim is', 'further claims are')} not shown.` : '',
  };
}

const IMPACT: Record<string, { label: string; tone: Tone }> = {
  DECIDES: { label: 'Would settle it', tone: 'warn' },
  NARROWS: { label: 'Would narrow it', tone: 'neutral' },
  CORROBORATES: { label: 'Would corroborate', tone: 'neutral' },
};

/** Ordering, so the record that would settle the question is not buried under tidying. */
const IMPACT_RANK: Record<string, number> = { DECIDES: 0, NARROWS: 1, CORROBORATES: 2 };

function readMissingInformation(payload: Record<string, unknown>): ReasonedPayload {
  const all = listOf(payload.gaps)
    .map((entry, index) => {
      const impact = textOf(entry.impact, 40) || 'CORROBORATES';
      const heldBy = textOf(entry.obtainableFrom, 200);
      return {
        rank: IMPACT_RANK[impact] ?? 2,
        finding: {
          key: `gap:${index}`,
          subjectId: null,
          title: textOf(entry.missingItem, 240),
          status: IMPACT[impact] ?? null,
          detail: textOf(entry.answersQuestion, 400) || textOf(entry.absenceMeans, 400),
          note: heldBy ? `Usually held by ${heldBy}.` : '',
          readings: [],
          citations: citationsOf(entry.citations, 'CONTEXT'),
        } satisfies ReasonedFinding,
      };
    })
    .filter((entry) => entry.finding.title !== '')
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.finding);

  const covered = listOf(payload.alreadyCovered).length;
  const hardLimit = textOf(payload.hardLimit, 400);
  const { shown, hidden } = capped(all);
  return {
    verdict: hardLimit ? { label: 'One thing no document can settle', tone: 'neutral', reason: hardLimit } : null,
    findings: shown,
    footnote: footnoteFrom([
      hidden > 0 ? `${plural(hidden, 'further gap is', 'further gaps are')} not shown.` : null,
      covered > 0 ? `${plural(covered, 'point is', 'points are')} already covered by what you have.` : null,
    ]),
  };
}

const COHERENCE: Record<string, { label: string; tone: Tone }> = {
  COHERENT: { label: 'The dates fit together', tone: 'ok' },
  COHERENT_WITH_GAPS: { label: 'The dates fit, with gaps', tone: 'neutral' },
  INCOHERENT: { label: 'The order does not work', tone: 'danger' },
  UNDATED: { label: 'Too few dates to check', tone: 'neutral' },
  AMBIGUOUS_DATES: { label: 'Dates can be read two ways', tone: 'warn' },
};

const TIMELINE_PROBLEM: Record<string, { label: string; tone: Tone }> = {
  IMPOSSIBLE_ORDER: { label: 'Impossible order', tone: 'danger' },
  SAME_DAY_CONFLICT: { label: 'Same-day conflict', tone: 'warn' },
  UNEXPLAINED_GAP: { label: 'Unexplained gap', tone: 'neutral' },
  AMBIGUOUS_DATE_FORMAT: { label: 'Ambiguous date', tone: 'warn' },
  UNDATED_FACT: { label: 'Undated', tone: 'neutral' },
  DUPLICATE_EVENT: { label: 'Possible duplicate', tone: 'neutral' },
};

function readTimelineCoherence(payload: Record<string, unknown>): ReasonedPayload {
  const all = listOf(payload.problems)
    .map((entry, index): ReasonedFinding => {
      const kind = textOf(entry.kind, 60);
      return {
        key: `problem:${index}`,
        subjectId: null,
        title: textOf(entry.description, 400),
        status: TIMELINE_PROBLEM[kind] ?? null,
        detail: '',
        note: '',
        readings: [],
        citations: citationsOf(entry.citations, 'CONTEXT'),
      };
    })
    .filter((finding) => finding.title !== '');

  const coherence = textOf(payload.coherence, 40);
  const placed = listOf(payload.sequence).length;
  const ambiguous = listOf(payload.sequence).filter((entry) => entry.dateAmbiguous === true).length;
  const { shown, hidden } = capped(all);

  return {
    verdict: coherence && COHERENCE[coherence]
      ? {
          label: COHERENCE[coherence].label,
          tone: COHERENCE[coherence].tone,
          reason: textOf(payload.coherenceReason, 600),
        }
      : null,
    findings: shown,
    footnote: footnoteFrom([
      hidden > 0 ? `${plural(hidden, 'further problem is', 'further problems are')} not shown.` : null,
      placed > 0 ? `${plural(placed, 'dated fact was', 'dated facts were')} placed in order.` : null,
      // Surfaced because it is the one failure the reader can act on: a day-first/month-first
      // ambiguity is resolved by checking the original document, not by adding another one.
      ambiguous > 0
        ? `${plural(ambiguous, 'date could be read', 'dates could be read')} two ways — check the original.`
        : null,
    ]),
  };
}

/**
 * The renderable form of a suggestion payload, or `null` when the kind carries no structure.
 *
 * Only the four cross-document passes write a nested payload. Everything else either carries a
 * flat `citations` array or nothing at all, and those keep the simpler path in the panel.
 *
 * A pass that ran, found nothing and reported no verdict returns `null` too, so a card with
 * nothing to show renders its summary alone rather than an empty heading.
 */
export function readReasoning(kind: string, payload: Record<string, unknown>): ReasonedPayload | null {
  const reasoned =
    kind === 'CROSS_DOCUMENT_RECONCILIATION' ? readReconciliation(payload)
    : kind === 'SUPPORT_STRENGTH' ? readSupportStrength(payload)
    : kind === 'MISSING_INFORMATION' ? readMissingInformation(payload)
    : kind === 'TIMELINE_COHERENCE' ? readTimelineCoherence(payload)
    : null;

  if (!reasoned) return null;
  if (!reasoned.verdict && reasoned.findings.length === 0 && !reasoned.footnote) return null;
  return reasoned;
}

/**
 * Citations carried flat at the top of a payload.
 *
 * The deterministic `evidence-intelligence` pass writes this shape, and so do the older
 * per-evidence kinds. Kept beside `readReasoning` so a payload is read by exactly one of the
 * two and neither has to know about the other.
 */
export function flatCitations(payload: Record<string, unknown>): CaseCitation[] {
  return citationsOf(payload.citations, 'CONTEXT');
}
