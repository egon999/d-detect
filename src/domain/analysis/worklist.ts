/**
 * The forward-looking worklist: everything a person still has to do, deadlines first.
 *
 * ## Why this exists as a separate module
 *
 * `attention.ts` already derives most of this, and it is deliberately built to need no clock —
 * a pure function of the workspace, so a test is a fixture and a deep-equal. That property is
 * worth keeping, and a filing deadline cannot honour it: "44 days left" is a statement about
 * today, and the answer changes overnight without any record changing.
 *
 * So the clock-dependent half lives here, `now` arrives as an argument rather than from
 * `Date.now()`, and `attention.ts` keeps its guarantee untouched. This module composes the two
 * into the single list a screen renders.
 *
 * ## What this adds that the rest of the app could not say
 *
 * A limitation window is the one thing in this app that gets worse while the user does nothing.
 * Every other row in the worklist — an unreviewed finding, a failed scan, an unsettled claim —
 * waits patiently. A window closes.
 *
 * Until this module existed, that window was computed only when someone opened the letter
 * screen of the case it belonged to. A deadline a person has to go and look for is not doing
 * the job of a deadline: the case most likely to run out of time is the one they have not
 * opened in a year, which is exactly the case whose letter screen they will not visit.
 *
 * @see attention.ts — the clock-free rows this composes with
 * @see limitation.ts — the window itself, and the citations behind it
 */

import type { Severity } from '../enums';
import type { Case, Workspace } from '../models';
import { itemsNeedingAttention, type AttentionItem } from './attention';
import type { NowDate } from './escalation';
import { filingDraftForCase } from './filing-draft';
import { describeLimitation, type LimitationWindow } from './limitation';

// ---------------------------------------------------------------------------
// Local copies of two pieces of sibling knowledge
// ---------------------------------------------------------------------------

/**
 * Severity ordering for the sort. Mirrors the private `SEVERITY_RANK` in `attention.ts`, which
 * in turn mirrors `SEVERITY_RANK` in `src/ui/semantics.ts`.
 *
 * Copied rather than exported from there for the same reason that one is copied from the UI:
 * the alternative is widening a sibling's public surface for a sort, and the ordering of four
 * severities is not knowledge that drifts. Written out explicitly, not derived from the enum's
 * declaration order, so reordering the enum cannot silently change a sort.
 */
const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };

/**
 * Whether a case's rows appear at all.
 *
 * Mirrors the suppression rule in `itemsNeedingAttention`: deleted, closed and archived cases
 * are silent. Closed and archived both mean the user has said "I am finished with this", and a
 * list that keeps raising cases someone has closed can never be emptied — which is the failure
 * mode that teaches people to ignore the list altogether.
 *
 * A deadline is not an exception to that. If someone closed the case, the app does not get to
 * override them because a calendar moved.
 */
function speaksFor(record: Case): boolean {
  return record.deletedAt === null && record.status !== 'CLOSED' && record.status !== 'ARCHIVED';
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

/**
 * How a window's state maps onto how loudly the list says so.
 *
 * `CLOSING` is `HIGH` because it is the only kind of row in this app that expires: it is both
 * important and time-bound, which is the definition of urgent.
 *
 * `CLOSED` is deliberately **not** `HIGH`, and this is the judgement most worth stating. A
 * closed window never changes again — so a `HIGH` row would sit at the top of the list forever,
 * unresolvable by anything the user does, and would train them to stop reading the list. It is
 * still worth saying once, calmly, with the route that may still be open. Hence `MEDIUM`.
 *
 * `OPEN` and `UNKNOWN` produce no row at all. An open window is not a task, and an unknown one
 * is a question the letter screen answers properly rather than a line item.
 */
function severityFor(state: LimitationWindow['state']): 'HIGH' | 'MEDIUM' | null {
  if (state === 'CLOSING') return 'HIGH';
  if (state === 'CLOSED') return 'MEDIUM';
  return null;
}

/** The row's own words, short enough to read in a list. */
function deadlineTitle(window: LimitationWindow): string {
  if (window.state === 'CLOSING') {
    const days = window.daysRemaining ?? 0;
    return `${days} ${days === 1 ? 'day' : 'days'} left to take this further`;
  }
  return 'Past the usual window to take this further';
}

/**
 * What the row says under its title.
 *
 * Leads with `describeLimitation`, so the row and the letter screen it opens give one account
 * of the date rather than two differently-worded ones, then names the provision the way that
 * screen does. The citation travels with the number deliberately: this row can appear on a
 * cross-case list far from any of the letter screen's apparatus, and a deadline a reader
 * cannot go and check is a deadline they have to take on trust.
 */
function deadlineDetail(window: LimitationWindow): string {
  const sentence = describeLimitation(window);
  if (!window.provision) return sentence;
  return `${sentence} The limit comes from ${window.provision}; these schemes are amended, so check the current rule before you rely on the date.`;
}

/**
 * A deadline row per case whose filing window is closing or has closed.
 *
 * Runs `filingDraftForCase`, which is the same call the letter screen makes, so the row and
 * the screen it opens cannot disagree about the date. That is not free — the draft re-applies
 * every confirmed correction over every extraction in the case — so this is called once per
 * case and the result is used whole.
 *
 * Only cases actually present in `workspace` produce rows. A caller holding one case's records
 * gets that case's deadline and no others, which is the honest answer rather than a silent
 * claim that nothing else is due.
 */
function deadlineRows(workspace: Readonly<Workspace>, now: NowDate): AttentionItem[] {
  const rows: AttentionItem[] = [];

  for (const record of workspace.cases) {
    if (!speaksFor(record)) continue;

    const draft = filingDraftForCase(workspace, record.id, now);
    if (!draft) continue;

    const severity = severityFor(draft.limitation.state);
    if (!severity) continue;

    rows.push({
      // Keyed on the case, not on the window: one case has one filing deadline, and a row id
      // that changed as the days counted down would remount the row every day.
      id: `deadline:${record.id}`,
      kind: 'case',
      severity,
      title: deadlineTitle(draft.limitation),
      // The same sentence the letter screen shows, from the same function, so a user reading
      // both does not get two differently-worded accounts of one date.
      detail: deadlineDetail(draft.limitation),
      // No timestamp, and `null` is the honest answer rather than a missing one. Every other
      // row in the worklist became visible when some record was written; this one became
      // visible because the calendar moved, and there is no moment on any record to point at.
      // It sorts to the end of its severity band, deterministically by id.
      at: null,
      href: `/case/${record.id}/letter`,
      caseId: record.id,
      caseTitle: record.title,
      target: { route: 'letter', caseId: record.id },
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// The worklist
// ---------------------------------------------------------------------------

/**
 * Everything outstanding across the cases in `workspace`, most urgent first.
 *
 * Deadline rows are computed here and the rest is delegated to `itemsNeedingAttention`, then
 * the whole set is sorted together — not concatenated with deadlines bolted on top. A closing
 * window outranks a failed scan on severity and should say so through the ordering rule every
 * other row obeys, rather than through its position in an array.
 *
 * Unbounded, like the function it composes. A workspace with two hundred outstanding items
 * really does have two hundred, and truncation is a presentation decision that belongs to the
 * screen.
 */
export function caseWorklist(workspace: Readonly<Workspace>, now: NowDate): AttentionItem[] {
  const deadlines = deadlineRows(workspace, now);

  /**
   * Which rows expire if nothing is done.
   *
   * Held as a set of ids rather than inferred from `at === null` or from the `deadline:` id
   * prefix. Both of those would work today and both would be accidents: a row with no
   * timestamp is not necessarily time-bound, and a comparator that reads meaning out of an
   * id string breaks the moment an id scheme changes.
   */
  const expiring = new Set(deadlines.map((row) => row.id));

  return [...deadlines, ...itemsNeedingAttention(workspace)].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;

    /**
     * Within one severity band, a row that expires outranks a row that waits.
     *
     * This is the rule that made a second sort necessary rather than reusing the one in
     * `attention.ts`. There, ordering by recency after severity is right: every row is
     * backed by a record, and the newer record is the more live concern. A deadline has no
     * record behind it, so recency ranks it last in its band — putting a window that closes
     * next week underneath every finding written since. Reversing that by handing the row a
     * fabricated timestamp would have got the order right by lying in a field, which is the
     * trade this module exists to refuse.
     */
    const byExpiry = Number(expiring.has(b.id)) - Number(expiring.has(a.id));
    if (byExpiry !== 0) return byExpiry;

    const byRecency = (b.at ?? -Infinity) - (a.at ?? -Infinity);
    // Two rows that both lack a timestamp give `-Infinity - -Infinity`, which is NaN. A
    // comparator returning NaN is non-transitive and the resulting order is engine-defined,
    // so it falls through to the id instead.
    if (byRecency !== 0 && !Number.isNaN(byRecency)) return byRecency;

    return a.id.localeCompare(b.id);
  });
}

/**
 * The deadline rows on their own, for a caller that wants to lead with them.
 *
 * Exported because "is anything running out of time" is a different question from "what is
 * outstanding", and a screen answering the first should not have to filter the second by
 * inspecting row ids.
 */
export function closingDeadlines(
  workspace: Readonly<Workspace>,
  now: NowDate,
): AttentionItem[] {
  return deadlineRows(workspace, now).sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id),
  );
}
