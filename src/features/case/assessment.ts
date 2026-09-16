/**
 * How a graded assessment reads.
 *
 * `ClaimAssessment.status` is the closest thing this product has to an answer, and it is
 * deliberately not an answer: six values, none of which is TRUE or FALSE. This module is the
 * one place that decides what each of them looks like and what caveat travels with it, so a
 * status cannot mean "settled" on the case screen and "problem" on the claim screen.
 *
 * ## Why this is not in `@ui/semantics`
 *
 * `semantics.ts` maps `@domain/enums` members — enums shared by the rule engine, the
 * repository and every screen. `ClaimAssessment.status` is not one of those: it is a field on
 * a saved AI report, and its six values exist nowhere else in the domain. Adding it to the
 * shared semantics file would put a report-shaped vocabulary in the module that other agents
 * are extending for engine enums. `compare.tsx` sets the precedent for a screen-local map
 * with a written reason; this is the same call, hoisted to a feature module because three
 * screens need it rather than one.
 *
 * ## Why there is no single "support score"
 *
 * A five-step rail from "unsupported" to "supported" was the first design, and it is a lie.
 * `CONTRADICTED` is not *less supported* than `PARTIALLY_SUPPORTED` — it is a different
 * finding, reached from evidence rather than from the absence of it, and a reader who sees it
 * one notch lower on a bar will read "weaker case" when the truth is "the sources say
 * otherwise". So the status is presented as a word with its own colour and its own caveat,
 * and the only thing that is ever counted is how many claims sit in each state.
 */

import type { IconName, Tone } from '@ui';
import { resolveCitation } from '@domain/analysis/case-report';
import type { CaseCitation, ClaimAssessment, Workspace } from '@domain/models';

export type AssessmentStatus = ClaimAssessment['status'];

export interface AssessmentReading {
  tone: Tone;
  icon: IconName;
  /**
   * One clause naming what the status does *not* establish.
   *
   * Every one of these is a limit, not an elaboration. The status word is the shortest thing
   * on the plate and the easiest to over-read; this is the sentence that stops "Supported"
   * from being received as "proven".
   */
  caveat: string;
}

/**
 * Tone, glyph and caveat per status. Labels come from `ASSESSMENT_LABELS` in
 * `@domain/analysis/case-report` and are deliberately not restated here — the wording is the
 * domain's, and a second copy would let one screen say "Partly supported" while another says
 * "Partially supported" about the same record.
 *
 * `DISPUTED` is `warn` and `CONTRADICTED` is `danger`, which is the one place tone carries a
 * judgement: red is reserved for "a source says otherwise", amber for "the sources disagree
 * with each other". Both are things to look at; only one of them has a direction.
 *
 * `UNRESOLVED` and `INSUFFICIENT_EVIDENCE` are both `neutral` on purpose. Neither is a
 * failure — an undocumented claim is an ordinary state of an early case — and giving either
 * of them a colour would put a case with nothing uploaded yet on the same visual footing as
 * one with a real conflict in it.
 */
export const ASSESSMENT_READING: Record<AssessmentStatus, AssessmentReading> = {
  SUPPORTED: {
    tone: 'ok',
    icon: 'check-decagram',
    caveat: 'The cited passages agree with the claim. Agreement between records is not proof.',
  },
  PARTIALLY_SUPPORTED: {
    tone: 'info',
    icon: 'circle-half-full',
    caveat: 'Part of the claim is evidenced here. The rest is not covered either way.',
  },
  CONTRADICTED: {
    tone: 'danger',
    icon: 'close-circle',
    caveat: 'At least one cited source says otherwise. A source can be mistaken or incomplete.',
  },
  DISPUTED: {
    tone: 'warn',
    icon: 'call-split',
    caveat: 'Sources point both ways and none of them settles it.',
  },
  INSUFFICIENT_EVIDENCE: {
    tone: 'neutral',
    icon: 'file-question-outline',
    caveat: 'Nothing in this case bears on the claim yet — neither for it nor against it.',
  },
  UNRESOLVED: {
    tone: 'neutral',
    icon: 'help-circle-outline',
    caveat: 'The sources were read but no position on the claim could be reached.',
  },
};

/**
 * Ranking used for counting and for the ledger's ordering, never for sorting the claims
 * themselves.
 *
 * The claim list stays in the order the user wrote it: that list is their agenda, and
 * resorting it by the app's opinion of severity would put the app's judgement above the
 * user's framing on the one screen whose premise is that it does not conclude.
 */
export const ASSESSMENT_RANK: Record<AssessmentStatus, number> = {
  CONTRADICTED: 0,
  DISPUTED: 1,
  PARTIALLY_SUPPORTED: 2,
  SUPPORTED: 3,
  INSUFFICIENT_EVIDENCE: 4,
  UNRESOLVED: 5,
};

// ---------------------------------------------------------------------------
// Citation basis
// ---------------------------------------------------------------------------

export interface CitationBasis {
  /** Citations whose quoted text still matches the stored source, character for character. */
  passages: number;
  /** Distinct evidence records behind those passages. */
  documents: number;
  /**
   * Citations that no longer resolve.
   *
   * Counted and shown rather than dropped. A citation stops resolving when the evidence was
   * deleted, reprocessed, or corrected so the quoted offsets no longer hold — all of which
   * mean the assessment was reached from something that is no longer there. Hiding that
   * would leave a stale verdict looking fully grounded.
   */
  stale: number;
}

/**
 * Counts what an assessment actually rests on, right now.
 *
 * Deliberately re-checks every citation against the current workspace instead of trusting
 * the stored count. `resolveCitation` compares the quoted substring to the live source text,
 * so a document a person has since corrected will drop out of `passages` here — which is the
 * correct behaviour for a screen that claims to show the grounds rather than a record of what
 * the grounds once were.
 *
 * Independence is not measured. Three passages from one document is a weaker basis than three
 * from three, and `documents` is reported separately for exactly that reason — but two files
 * exported from the same phone are not independent either, and nothing here can tell.
 */
export function citationBasis(
  workspace: Workspace,
  citations: readonly CaseCitation[],
): CitationBasis {
  const documents = new Set<string>();
  let passages = 0;
  let stale = 0;

  for (const citation of citations) {
    const resolved = resolveCitation(workspace, citation);
    if (!resolved) {
      stale += 1;
      continue;
    }
    passages += 1;
    documents.add(resolved.evidence.id);
  }

  return { passages, documents: documents.size, stale };
}

// ---------------------------------------------------------------------------
// Case-level tally
// ---------------------------------------------------------------------------

export interface AssessmentTally {
  /** Claims with a current assessment, by status, highest-attention first. */
  entries: Array<{ status: AssessmentStatus; count: number }>;
  /** Claims whose text has changed since the last run, or that were never assessed. */
  unassessed: number;
  assessed: number;
}

/**
 * Groups statuses for the case totals.
 *
 * Statuses with a count of zero are omitted rather than shown as `0`. A row reading
 * "Contradicted 0" invites the reading "nothing contradicts this case", which is a claim
 * about the evidence that nothing here has established — the absence of a finding is not a
 * finding.
 */
export function tallyAssessments(
  statuses: ReadonlyArray<AssessmentStatus | null>,
): AssessmentTally {
  const counts = new Map<AssessmentStatus, number>();
  let unassessed = 0;

  for (const status of statuses) {
    if (status === null) {
      unassessed += 1;
      continue;
    }
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  const entries = [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => ASSESSMENT_RANK[a.status] - ASSESSMENT_RANK[b.status]);

  return { entries, unassessed, assessed: statuses.length - unassessed };
}
