import type { Severity } from '../enums';
import type { Case, Claim, Evidence, Workspace } from '../models';

/**
 * "Needs attention" derivation.
 *
 * A **derived read model**, in the same family as `timeline.ts` and `graph.ts`: every row
 * returned here is computed from stored records on demand and nothing about it is
 * persisted. There is therefore no notification table that can drift out of sync with the
 * case, and no "unread" flag that claims something happened when it did not.
 *
 * That property is the whole reason this module exists. The notifications screen used to
 * render a hard-coded array — four rows about files and cases that were not in anyone's
 * data. A list that invents its own contents is worse than an empty one in a product whose
 * entire proposition is that it does not assert things it cannot show you. Everything below
 * is a statement the workspace can already back up.
 *
 * ## What counts as needing attention
 *
 * Six conditions, chosen because each one names something a *person* has to resolve and
 * the machine cannot:
 *
 *   1. An **open finding**. The rule engine flagged something and nobody has reviewed,
 *      dismissed or resolved it.
 *   2. **Evidence the pipeline handed back** — `FAILED` or `REVIEW_REQUIRED`. Both mean
 *      processing stopped short of a result the app is willing to stand behind.
 *   3. **Evidence nothing has read yet** — `QUEUED`. The original is stored and no
 *      extraction has been attempted on it. Nothing will attempt one either: there is no
 *      background worker, so this waits on a person pressing Process and on nothing else.
 *   4. **Evidence with no readable text.** A file was uploaded and stored, extraction
 *      finished, and nothing came out of it. The document exists but cannot support or
 *      contradict anything, which is easy to miss precisely because nothing failed.
 *   5. **A claim the evidence does not settle** — `UNSUPPORTED` or `MIXED_REVIEW`.
 *   6. **A case whose analysis is behind its contents** — never run, or run before the
 *      last edit.
 *
 * Deliberately *not* included: `UPLOADING` and `PROCESSING`. Not because they "resolve on
 * their own" — that was the old reason given here, and it was never true of an app with no
 * background worker, where `requestEvidenceProcessing` runs inline in the screen that
 * started it and stops when that screen does. They are excluded because a row still in
 * either state belongs to a run in the *current* process, and the leftovers of any other
 * process are not left lying there to be found: `reconcileInterruptedEvidence` rewrites them
 * at the first load of a case — `UPLOADING` with no stored original to `FAILED`, `PROCESSING`
 * back to `QUEUED` — and both of those are on the list above.
 *
 * ## Why this module imports nothing
 *
 * Only types, from two sibling modules in the same layer. No `@ui`, no repository, no
 * React, no `Date.now()`. Two consequences that are both intentional:
 *
 *   - It is a pure function of its argument, so a test is `itemsNeedingAttention(fixture)`
 *     and a deep-equal. No mocks, no clock, no renderer.
 *   - It cannot pull React Native into a Node test run, which importing `@ui` for
 *     `SEVERITY_RANK` or `needsHumanAction` would do. The duplication of those two small
 *     pieces of knowledge below is the price of the layering, and it is marked where it
 *     occurs so the two copies are kept in step. `graph.ts` makes the same trade with its
 *     own local severity rank.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which kind of record produced a row. Drives the icon and the wording on screen. */
export type AttentionKind = 'finding' | 'evidence' | 'claim' | 'case';

/**
 * Where a row goes when it is tapped, as data rather than as a string.
 *
 * `href` below is the same destination written out, and it is genuinely derived — but
 * Expo Router runs with `typedRoutes`, so navigation has to satisfy a generated union of
 * literal pathnames that only exists in the app project. A domain module cannot import
 * that union without acquiring an expo-router dependency, which would undo everything the
 * file header just claimed.
 *
 * So the destination is expressed twice, on purpose: as `href` for display, logging and
 * equality, and as this discriminated union so the screen can switch on `route` and hand
 * the router a literal pathname it can check. The compiler then guarantees a `claim` row
 * carries the `claimId` its route needs, instead of that being a runtime hope.
 */
export type AttentionTarget =
  | { route: 'case'; caseId: string }
  | { route: 'claim'; caseId: string; claimId: string }
  | { route: 'evidence'; caseId: string; evidenceId: string }
  /**
   * No row built by this module carries a `letter` target — `worklist.ts` does, and it
   * produces `AttentionItem`s of its own that render through the same screen. The member
   * lives here rather than in a widened type there so that a screen switching on `route`
   * has one union to be exhaustive over.
   */
  | { route: 'letter'; caseId: string };

export interface AttentionItem {
  /**
   * Stable and derived, never random.
   *
   * The screen re-derives this list on every load, so an id built from `newId()` would be
   * different each time and the list would reshuffle under a reader's finger. The id is a
   * kind prefix plus the source record's id, which is exactly what makes it stable — and
   * the prefix is what keeps a claim and an evidence item from colliding as React keys if
   * a store ever reused an id across collections.
   */
  id: string;
  kind: AttentionKind;
  /**
   * How urgently a person should look.
   *
   * Chosen so the UI's existing `SEVERITY_TONE` reproduces the tone the source record
   * already has elsewhere in the app — a `FAILED` evidence item is `danger` on its own
   * screen and `HIGH`/`danger` here, a `MIXED_REVIEW` claim is `warn` in both places. Two
   * screens colouring the same record differently is how a status colour stops carrying
   * information.
   */
  severity: Severity;
  /** The record's own words. Never a sentence composed about a record. */
  title: string;
  /** One or two sentences saying what is unresolved. Sourced from the record where it has one. */
  detail: string;
  /**
   * When this became something to look at, in epoch milliseconds, read off the source
   * record. `null` is a real answer rather than a missing one: a case that has never been
   * analysed has no "last analysed" moment, and printing a relative time for it would be
   * inventing one.
   */
  at: number | null;
  /**
   * The route this row opens, as a path. Interpolating ids is safe because `ID_PATTERN`
   * (see `ids.ts`) forbids slashes, so an id can never smuggle in an extra path segment.
   */
  href: string;
  caseId: string;
  /**
   * The case's title, or `null` when the workspace passed in does not carry the case
   * record. Null rather than a placeholder: a row that says "Investigation" when it does
   * not know the case name is a small lie of exactly the kind this module exists to avoid.
   */
  caseTitle: string | null;
  target: AttentionTarget;
}

// ---------------------------------------------------------------------------
// Local copies of two pieces of UI knowledge
// ---------------------------------------------------------------------------

/**
 * Severity ordering for the sort. Mirrors `SEVERITY_RANK` in `src/ui/semantics.ts`
 * — lower is more urgent — and is declared here rather than imported because `domain/`
 * must not depend on `ui/`. Written out explicitly instead of derived from the enum's
 * declaration order, so reordering the enum cannot silently change a sort.
 */
const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };

/**
 * How long a case may lag its analysis before it counts as stale.
 *
 * The analysis run is itself the thing that writes `lastAnalyzedAt`, and it bumps the
 * case a few milliseconds either side of it. Without a tolerance every freshly analysed
 * case would immediately report itself out of date. Matches the tolerance the case card
 * uses for the same judgement.
 */
const STALENESS_TOLERANCE_MS = 2_000;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Everything in the workspace that a person still has to deal with, most urgent first.
 *
 * Iterates the workspace's arrays directly rather than going through `buildRuleContext`.
 * That helper is per-case and *throws* when the case is absent from the workspace, which
 * makes it the wrong tool for a function that is handed several cases' worth of records
 * and must not blow up the notifications screen because one shard was mid-write.
 *
 * The result is unbounded by design. A case with two hundred unreviewed findings really
 * does have two hundred things needing attention, and a domain function that quietly
 * truncated would be lying to whichever caller most needed the truth. Capping is a
 * presentation decision and belongs to the screen.
 */
export function itemsNeedingAttention(workspace: Readonly<Workspace>): AttentionItem[] {
  const caseById = new Map<string, Case>();
  /**
   * Cases whose rows are suppressed entirely: deleted, closed or archived.
   *
   * Closed and archived both mean the user has said "I am finished with this". Surfacing
   * an archived case's open findings would make the list impossible to ever empty, which
   * is the failure mode that trains people to ignore a notification list altogether.
   *
   * Suppression is keyed off records that are *present*. A row whose case is simply
   * missing from this workspace is kept, because absence is not evidence of archival and
   * dropping a real finding is the worse error of the two.
   */
  const suppressed = new Set<string>();

  for (const record of workspace.cases) {
    caseById.set(record.id, record);
    if (record.deletedAt !== null || record.status === 'CLOSED' || record.status === 'ARCHIVED') {
      suppressed.add(record.id);
    }
  }

  const items: AttentionItem[] = [];
  const titleOf = (caseId: string) => caseById.get(caseId)?.title ?? null;

  // -- 1. Open findings ------------------------------------------------------
  //
  // `AnalysisResult` is the one entity in the model with no `deletedAt`: findings are
  // reviewed, dismissed or resolved, never deleted, so `status` is the only filter there
  // is. `OPEN` is precisely "no human has looked at this yet".
  for (const result of workspace.analysisResults) {
    if (result.status !== 'OPEN' || suppressed.has(result.caseId)) continue;

    items.push({
      id: `finding:${result.id}`,
      kind: 'finding',
      severity: result.severity,
      title: result.title,
      detail: result.explanation,
      // `updatedAt` rather than `createdAt`: findings have deterministic ids, so a re-run
      // over unchanged data rewrites the same document. This is therefore "as of the last
      // analysis, this still holds", which is the more useful thing to rank recency by.
      at: result.updatedAt,
      // Findings are rendered inline on the case screen — there is no per-finding route on
      // disk — so this opens the case rather than a URL that does not exist.
      href: `/case/${result.caseId}`,
      caseId: result.caseId,
      caseTitle: titleOf(result.caseId),
      target: { route: 'case', caseId: result.caseId },
    });
  }

  // -- 2, 3 & 4. Evidence ----------------------------------------------------
  for (const item of workspace.evidence) {
    if (item.deletedAt !== null || suppressed.has(item.caseId)) continue;

    const row = evidenceRow(item);
    if (row) items.push({ ...row, caseTitle: titleOf(item.caseId) });
  }

  // -- 5. Unsettled claims ---------------------------------------------------
  for (const claim of workspace.claims) {
    if (claim.deletedAt !== null || suppressed.has(claim.caseId)) continue;

    const row = claimRow(claim);
    if (row) items.push({ ...row, caseTitle: titleOf(claim.caseId) });
  }

  // -- 6. Cases whose analysis is behind ------------------------------------
  for (const record of workspace.cases) {
    if (suppressed.has(record.id)) continue;

    const row = caseRow(record, workspace);
    if (row) items.push(row);
  }

  return sortByUrgency(items);
}

/**
 * The evidence rules, as one function so that no two of them can fire for the same item.
 * They are mutually exclusive by construction — "needs a person" covers `FAILED` and
 * `REVIEW_REQUIRED`, "never read" covers `QUEUED`, and "read, and nothing came out" only
 * considers the states that come *after* a successful extraction — and keeping them in one
 * place is what keeps that true.
 */
function evidenceRow(item: Evidence): Omit<AttentionItem, 'caseTitle'> | null {
  const href = `/case/${item.caseId}/evidence/${item.id}`;
  const target: AttentionTarget = {
    route: 'evidence',
    caseId: item.caseId,
    evidenceId: item.id,
  };
  const base = { kind: 'evidence' as const, title: item.title, at: item.updatedAt, href, caseId: item.caseId, target };

  // Mirrors `needsHumanAction` in `src/ui/semantics.ts`. Two states, and they are not the
  // same problem: one is a job that stopped, the other is a result nobody trusts yet.
  if (item.state === 'FAILED') {
    return {
      ...base,
      id: `evidence-failed:${item.id}`,
      severity: 'HIGH',
      // The recorded reason, or an admission that none was recorded. Not a guess at one.
      detail: item.failureReason ?? 'Processing failed and no reason was recorded.',
    };
  }

  if (item.state === 'REVIEW_REQUIRED') {
    return {
      ...base,
      id: `evidence-review:${item.id}`,
      severity: 'MEDIUM',
      detail: 'Extraction finished, but what was read needs a person to confirm it.',
    };
  }

  // Declared ahead of the two rules that share it: both turn on whether anything has been
  // read out of this record, and differ only in what that answer means.
  const textRead = item.extraction !== null && item.extraction.sourceText.trim().length > 0;

  /**
   * A document the app has never looked at.
   *
   * `QUEUED` was excluded from this module along with the other in-flight states, on the
   * reasoning that there was no text *yet*. There is no "yet". Nothing here processes
   * evidence in the background — `requestEvidenceProcessing` runs inline, in the screen
   * that started it — so a `QUEUED` row is a stored document that will sit unread until a
   * person opens it and presses Process. Excluding it meant the one kind of outstanding
   * work that cannot progress without the user was the one kind this list never mentioned.
   *
   * `!textRead` as well as the state, because the sentence below is a claim about the
   * record's contents and so has to read them: `reconcileInterruptedEvidence` demotes an
   * interrupted re-read to `QUEUED`, and that record still carries the reading its earlier
   * run produced. It is queued, but it is not unread, and must not be told that it is.
   *
   * No `hasFile` gate, unlike the rule below. That one asks whether a document yielded
   * text and so must never be put to a NOTE; this one asks only whether anything has been
   * read out of the record, which is a fair question to put to a typed statement that was
   * queued and never extracted.
   */
  if (item.state === 'QUEUED' && !textRead) {
    return {
      ...base,
      id: `evidence-unread:${item.id}`,
      /**
       * INFO, which `SEVERITY_TONE` renders neutral — the tone `PROCESSING_TONE` already
       * gives `QUEUED` everywhere else the app draws this record. Nothing has gone wrong
       * and no colour here may imply otherwise: this is a task nobody has done yet, not a
       * problem with the document.
       */
      severity: 'INFO',
      detail:
        'Nothing has been read from this yet, so it cannot support or contradict anything. ' +
        'Process it on this device to read its contents into the case.',
    };
  }

  /**
   * A stored file that yielded no text.
   *
   * Gated three ways, because a false positive here is a row telling a user to fix
   * something that is not broken:
   *
   *   - Only settled states, so this row means "extraction ran and produced nothing"
   *     rather than "extraction has not run" — which is the rule above, and a very
   *     different thing to tell someone about their document.
   *   - Only items with a file. A NOTE carries its content in `note` and has no document
   *     to read, so it can never satisfy this and must not be asked to.
   *   - Empty after trimming, so a file that extracted to whitespace is caught too.
   */
  const settled = item.state === 'EXTRACTED' || item.state === 'ANALYZED' || item.state === 'CONFIRMED';
  const hasFile = item.fileName !== null || item.storagePath !== null;

  if (settled && hasFile && !textRead) {
    return {
      ...base,
      id: `evidence-no-text:${item.id}`,
      // Low, not high. Nothing has gone wrong — the app simply has a document it cannot
      // reason about, and saying so loudly would imply an error the user did not make.
      severity: 'LOW',
      detail:
        'The file is stored but no text was read from it, so it cannot support or contradict ' +
        'anything yet. A scan or photo may need re-uploading at a higher quality.',
    };
  }

  return null;
}

/**
 * The claim rules.
 *
 * Wording taken from the traces `claim-state.ts` produces when it reaches each state, so
 * the explanation a user reads here is the same explanation the engine recorded — not a
 * second, looser paraphrase of it written for a notification list.
 */
function claimRow(claim: Claim): Omit<AttentionItem, 'caseTitle'> | null {
  if (claim.state !== 'UNSUPPORTED' && claim.state !== 'MIXED_REVIEW') return null;

  const mixed = claim.state === 'MIXED_REVIEW';

  return {
    id: `claim:${claim.id}`,
    kind: 'claim',
    /**
     * `MIXED_REVIEW` is MEDIUM and `UNSUPPORTED` is INFO, which through `SEVERITY_TONE`
     * come out as `warn` and `neutral` — exactly what `CLAIM_STATE_TONE` already assigns
     * them. The reasoning is the same in both places: a claim with evidence on both sides
     * is a question awaiting a decision, while a claim with nothing linked to it yet is a
     * perfectly ordinary state that says nothing about whether the claim is true. Neither
     * is an error, and neither gets to be red.
     */
    severity: mixed ? 'MEDIUM' : 'INFO',
    title: claim.statement,
    detail: mixed
      ? 'Evidence both supports and contradicts this claim, so it needs a person to decide.'
      : 'Nothing is linked to this claim yet. This says nothing about whether it is true.',
    at: claim.updatedAt,
    href: `/case/${claim.caseId}/claim/${claim.id}`,
    caseId: claim.caseId,
    target: { route: 'claim', caseId: claim.caseId, claimId: claim.id },
  };
}

/**
 * The case rule: analysis that is behind the case's contents.
 *
 * Worth surfacing because it is the one condition that makes *every other row stale*. A
 * finding list computed before the last three uploads is not wrong so much as it is out of
 * date, and a user has no way to tell the difference by looking at it.
 */
function caseRow(record: Case, workspace: Readonly<Workspace>): AttentionItem | null {
  const base = {
    kind: 'case' as const,
    // Low severity throughout. Nothing is in conflict; the app is simply behind, and an
    // urgent-looking row for "press the analyse button" would devalue the rows above it.
    severity: 'LOW' as const,
    title: record.title,
    href: `/case/${record.id}`,
    caseId: record.id,
    caseTitle: record.title,
    target: { route: 'case' as const, caseId: record.id },
  };

  if (record.lastAnalyzedAt === null) {
    // An empty case does not need analysing, and telling a user to analyse the case they
    // created thirty seconds ago is the sort of nagging that gets a list ignored.
    const hasContent =
      workspace.claims.some((claim) => claim.caseId === record.id && claim.deletedAt === null) ||
      workspace.evidence.some((item) => item.caseId === record.id && item.deletedAt === null);
    if (!hasContent) return null;

    return {
      ...base,
      id: `case-unanalysed:${record.id}`,
      detail:
        'This case has evidence and claims in it but analysis has never been run, so there ' +
        'are no findings for it yet.',
      // Genuinely unknown rather than missing: there is no last-analysed moment to show.
      at: null,
    };
  }

  if (record.updatedAt > record.lastAnalyzedAt + STALENESS_TOLERANCE_MS) {
    return {
      ...base,
      id: `case-stale:${record.id}`,
      detail: 'The case has changed since analysis last ran, so its findings may be out of date.',
      // The last run, not the last edit: the row is about how old the analysis is.
      at: record.lastAnalyzedAt,
    };
  }

  return null;
}

/**
 * Most urgent first, then most recent, then by id.
 *
 * The id tiebreak is not cosmetic. Two findings written by the same analysis run share a
 * millisecond, and without a final deterministic comparison their relative order would
 * depend on the array order the storage adapter happened to return — so the list would
 * shuffle between two visits that changed nothing.
 *
 * Undated rows sort to the end of their severity band. "No analysis has ever run" is the
 * oldest possible state, so treating it as infinitely old is both correct and stable.
 */
function sortByUrgency(items: AttentionItem[]): AttentionItem[] {
  return items.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;

    const byRecency = (b.at ?? -Infinity) - (a.at ?? -Infinity);
    // Both null produces NaN from `-Infinity - -Infinity`, which sorts unpredictably.
    if (byRecency !== 0 && !Number.isNaN(byRecency)) return byRecency;

    return a.id.localeCompare(b.id);
  });
}
