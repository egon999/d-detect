/**
 * Case workspace store.
 *
 * Binds the `Repository` port to React. One hook per concern, all built on the same three
 * ideas:
 *
 *   - **Reads are subscribed, not polled.** The adapter pushes; this re-renders. So a case
 *     open on two devices converges, and a write from a background job appears without a
 *     pull-to-refresh.
 *   - **Writes go through mutations.** `commit` is never called from a screen. A screen
 *     calls `mutate(runCaseAnalysis)`, which runs the pure mutation to produce the next
 *     workspace *and* the changes, applies the workspace locally so the UI updates
 *     immediately, then persists. The optimistic state and the stored state come from the
 *     same function, so they cannot disagree.
 *   - **Errors are values.** A failed write resolves to a `{ ok: false, error }` result
 *     rather than throwing into a render, so a screen decides how to surface it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { reconcileInterruptedEvidence, type Mutation, type MutationContext } from '@data/mutations';
import type { CommitDurability, Repository } from '@data/repository';
import { emptyWorkspace, type Case, type Workspace } from '@domain/models';
import { workspaceForCase } from '@data/repository';
import { useRepository } from './repository-provider';

// ---------------------------------------------------------------------------
// Case list
// ---------------------------------------------------------------------------

export interface CaseListState {
  cases: Case[];
  /** True only before the list has ever arrived for this owner. Drives skeletons. */
  loading: boolean;
  /** True while a `reload` is in flight over content that is still on screen. */
  refreshing: boolean;
  error: Error | null;
  reload: () => void;
}

/**
 * Subscribes to the case list.
 *
 * `loading` is only true before the first emission *for the current owner*. A subsequent
 * update never flips it back, because replacing a populated list with a spinner on every
 * background refresh is the single most common way an app feels unstable.
 *
 * ## Why the guard is a ref keyed on the owner, and not a boolean
 *
 * The paragraph above described the intent from the day this was written, and the code did not
 * honour it: `reload` bumps a nonce that the effect depends on, so every pull-to-refresh
 * re-entered the effect and set `loading` back to true. Both tab screens gate their entire
 * body on that flag, so refreshing the two screens the product opens on threw away the content
 * the user was looking at and painted grey skeletons over it — the exact failure the comment
 * promised would not happen.
 *
 * A plain `hasLoaded` boolean would fix the refresh and break account switching: the skeleton
 * would be suppressed while the incoming owner's list is still empty, so the previous account's
 * screen would sit there showing "No cases yet" — a worse lie than a spinner. Keying the ref on
 * the owner id distinguishes the two: a nonce bump keeps the list, a different owner does not.
 */
export function useCaseList(ownerId: string | null): CaseListState {
  const { repository, ready } = useRepository();
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  /** The owner whose list has already arrived. Null until the first emission. */
  const settledFor = useRef<string | null>(null);

  useEffect(() => {
    if (!ownerId || !ready) {
      setCases([]);
      setError(null);
      setLoading(false);
      setRefreshing(false);
      settledFor.current = null;
      return;
    }

    if (settledFor.current === ownerId) setRefreshing(true);
    else setLoading(true);
    setError(null);

    const unsubscribe = repository.watchCases(
      ownerId,
      (next) => {
        settledFor.current = ownerId;
        setCases(next);
        setError(null);
        setLoading(false);
        setRefreshing(false);
      },
      (caught) => {
        setError(caught);
        setLoading(false);
        setRefreshing(false);
      },
    );

    return unsubscribe;
  }, [repository, ownerId, ready, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  const visibleCases = useMemo(() => ownerId ? cases.filter((item) => item.ownerId === ownerId) : [], [cases, ownerId]);
  return { cases: visibleCases, loading, refreshing, error, reload };
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface WorkspaceState {
  workspace: Workspace;
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  reload: () => void;
}

/**
 * The `owner:case` pairs whose interrupted records have already been reset in this process.
 *
 * ## Why once per process, and why at the first load of a case
 *
 * Nothing here processes evidence in the background: `requestEvidenceProcessing` runs inline,
 * in the screen that started it. So a killed or crashed app leaves `UPLOADING` and `PROCESSING`
 * rows describing work that will never resume — spinners that spin until the case is deleted.
 * {@link reconcileInterruptedEvidence} resets them, and the only question is when to run it.
 *
 * On *every* load is wrong, and dangerously so: a live transcription can run for minutes, and
 * any pull-to-refresh or navigation during it would reset the row it is about to write to.
 *
 * The first load of a case in a given process is the one moment that is provably safe. Nothing
 * in this process has started work on that case yet — the screen is only now opening it — so
 * everything found mid-flight belongs to a process that is gone. A later refresh, with a real
 * transcription running, finds the pair already in this set and leaves it alone.
 *
 * Keyed on the owner too, so signing in as a different account still reconciles.
 */
const reconciled = new Set<string>();

type WorkspaceListener = (workspace: Workspace) => void;
const activeWorkspaceListeners = new Map<string, Set<WorkspaceListener>>();

function notifyWorkspaceOptimistic(key: string, next: Workspace) {
  const listeners = activeWorkspaceListeners.get(key);
  if (listeners) {
    for (const listener of listeners) {
      listener(next);
    }
  }
}

/**
 * Subscribes to one case's workspace.
 *
 * `caseId` may be null while a route is still resolving its params; the hook then reports
 * an empty workspace rather than flashing a skeleton for a case that does not exist yet.
 *
 * ## Why the guard is a ref keyed on the case, and not a boolean
 *
 * Same defect, same fix as `useCaseList` above, and it mattered more here: this hook feeds every
 * screen inside a case — the overview, the evidence list, the claims, the connections, the
 * timeline, the history. `reload` bumps a nonce the effect depends on, so a pull-to-refresh on
 * any of them re-entered the effect, set `loading` back to true, and replaced the case a user was
 * reading with skeletons. Worse than on the list screens, because a case screen is where someone
 * is part-way through comparing two documents, and the scroll position goes with the content.
 *
 * The key is `owner:case` rather than the owner alone, because navigating between two cases must
 * still show a skeleton: the outgoing case's evidence rows would otherwise sit under the incoming
 * case's title until the first emission arrived, which reads as the wrong documents being
 * attached to the wrong case — the one mistake this product cannot make.
 */
export function useWorkspace(ownerId: string | null, caseId: string | null): WorkspaceState {
  const { repository, ready } = useRepository();
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  /** The `owner:case` pair whose workspace has already arrived. Null until the first emission. */
  const settledFor = useRef<string | null>(null);

  useEffect(() => {
    if (!ownerId || !caseId || !ready) {
      setWorkspace(emptyWorkspace());
      setError(null);
      setLoading(false);
      setRefreshing(false);
      settledFor.current = null;
      return;
    }

    const key = `${ownerId}:${caseId}`;
    if (settledFor.current === key) setRefreshing(true);
    else setLoading(true);
    setError(null);

    let listeners = activeWorkspaceListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      activeWorkspaceListeners.set(key, listeners);
    }
    const optimisticListener: WorkspaceListener = (optimistic) => {
      setWorkspace(optimistic);
    };
    listeners.add(optimisticListener);

    const unsubscribe = repository.watchWorkspace(
      ownerId,
      caseId,
      (next) => {
        settledFor.current = key;
        setWorkspace(next);
        setError(null);
        setLoading(false);
        setRefreshing(false);
        if (!reconciled.has(key)) {
          if (reconciled.size > 200) reconciled.clear();
          reconciled.add(key);
          // Scoped to this case, not to `next`. Some adapters deliver owner-wide rows on a
          // case subscription, and resetting another case's records — one of which could be
          // mid-transcription in this very process — would be exactly the bug this guard
          // exists to prevent.
          //
          // Marked before the write, not after: a failed commit must not leave this retrying
          // on every emission. The subscription will deliver the reset rows, so nothing is
          // set from here — and on failure the rows stay as they were, which is the state the
          // user was already seeing.
          const mutation = reconcileInterruptedEvidence(
            workspaceForCase(next, caseId),
            mutationContext(ownerId),
          );
          if (mutation) void repository.commit(ownerId, mutation.changes).catch(() => {});
        }
      },
      (caught) => {
        setError(caught);
        setLoading(false);
        setRefreshing(false);
      },
    );

    return () => {
      unsubscribe();
      const currentListeners = activeWorkspaceListeners.get(key);
      if (currentListeners) {
        currentListeners.delete(optimisticListener);
        if (currentListeners.size === 0) {
          activeWorkspaceListeners.delete(key);
        }
      }
    };
  }, [repository, ownerId, caseId, ready, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  const visibleWorkspace = useMemo(() => {
    if (!ownerId || !caseId || !workspace.cases.some((item) => item.id === caseId && item.ownerId === ownerId)) return emptyWorkspace();
    return workspaceForCase(workspace, caseId);
  }, [workspace, ownerId, caseId]);
  return { workspace: visibleWorkspace, loading, refreshing, error, reload };
}

// ---------------------------------------------------------------------------
// Mutation dispatch
// ---------------------------------------------------------------------------

export type MutationResult =
  | { ok: true; durability?: CommitDurability }
  | { ok: false; error: Error };

export interface Mutator {
  /**
   * Runs a pure mutation against the live workspace and persists the result.
   *
   * `apply` receives the latest workspace (kept in a ref, so a burst of taps does not
   * operate on a stale copy) and returns the mutation. The returned value may be read by
   * the caller — `runCaseAnalysis` returns finding counts, for example.
   */
  mutate: <T extends Mutation>(apply: (workspace: Workspace) => T) => Promise<MutationResult & { value?: T }>;
  /** True while at least one write is in flight. Drives button spinners. */
  busy: boolean;
}

/**
 * Wraps `repository.commit` with the optimistic-apply step.
 *
 * The workspace ref is the important detail. React state updates are batched, so two
 * taps in the same tick would both read the same pre-first-write workspace and the second
 * would silently discard the first. The ref is advanced synchronously inside `mutate`, so
 * the second call sees the first call's result.
 */
export function useMutator(
  ownerId: string | null,
  caseId: string | null,
  workspace: Workspace,
  onApplied?: (workspace: Workspace) => void,
): Mutator {
  const { repository } = useRepository();
  const workspaceRef = useRef(workspace);
  const [inFlight, setInFlight] = useState(0);

  // Kept in sync with the subscription, which is the authority once a write completes.
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  const mutate = useCallback(
    async <T extends Mutation>(apply: (current: Workspace) => T): Promise<MutationResult & { value?: T }> => {
      if (!ownerId) {
        return { ok: false, error: new Error('Not signed in.') };
      }

      // `apply` is inside a try because it throws. It builds the change set by calling into
      // `@data/mutations`, where sixteen `requireRecord` sites raise "<kind> <id> is not in
      // this workspace" for a record the edit names and the workspace does not hold. That is
      // reachable in ordinary use: `useWorkspace` collapses to `emptyWorkspace()` when the
      // open case is absent, so a case deleted on another device while a detail screen is
      // open makes the next edit on that screen throw.
      //
      // Left outside, the throw rejected the promise `mutate` hands back — past every
      // `if (result.ok)` a screen wrote, into a `void`-ed handler with no `.catch`. Silence in
      // production, a full-screen LogBox in development, and in neither case the `{ ok: false }`
      // this module's contract promises.
      let mutation: T;
      try {
        mutation = apply(workspaceRef.current);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }

      // Only past the throw is the optimistic workspace adopted. A failed `apply` must leave
      // the ref exactly as it was, or a screen would render a workspace no mutation produced.
      const previousWorkspace = workspaceRef.current;
      workspaceRef.current = mutation.workspace;
      onApplied?.(mutation.workspace);
      if (ownerId && caseId) {
        notifyWorkspaceOptimistic(`${ownerId}:${caseId}`, mutation.workspace);
      }

      if (mutation.changes.length === 0) return { ok: true, value: mutation };

      setInFlight((count) => count + 1);
      try {
        const outcome = await repository.commit(ownerId, mutation.changes);
        return { ok: true, durability: outcome?.durability, value: mutation };
      } catch (error) {
        // Roll back optimistic state on commit failure so the UI and subsequent mutations
        // do not operate on unpersisted/rejected state.
        workspaceRef.current = previousWorkspace;
        onApplied?.(previousWorkspace);
        if (ownerId && caseId) {
          notifyWorkspaceOptimistic(`${ownerId}:${caseId}`, previousWorkspace);
        }
        const caught = error instanceof Error ? error : new Error(String(error));
        return { ok: false, error: caught, value: mutation };
      } finally {
        setInFlight((count) => Math.max(0, count - 1));
      }
    },
    [repository, ownerId, caseId, onApplied],
  );

  return useMemo(() => ({ mutate, busy: inFlight > 0 }), [mutate, inFlight]);
}

// ---------------------------------------------------------------------------
// Case-scoped selectors
// ---------------------------------------------------------------------------

/** Everything belonging to one case, already filtered. */
export function useCaseData(workspace: Workspace, caseId: string | null) {
  return useMemo(
    () => (caseId ? workspaceForCase(workspace, caseId) : emptyWorkspace()),
    [workspace, caseId],
  );
}

/** The `Case` record itself, or null when it has not loaded or has been deleted. */
export function useCaseRecord(workspace: Workspace, caseId: string | null): Case | null {
  return useMemo(() => {
    if (!caseId) return null;
    return workspace.cases.find((record) => record.id === caseId) ?? null;
  }, [workspace.cases, caseId]);
}

/** The mutation context for a user action. One action, one timestamp. */
export function mutationContext(ownerId: string, now: number = Date.now()): MutationContext {
  return { ownerId, now };
}
