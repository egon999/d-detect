import { createCase, createClaim, type CaseInput, type MutationContext } from '@data/mutations';
import type { Change, Repository } from '@data/repository';
import { caseSchema, claimSchema, emptyWorkspace } from '@domain/models';

export interface PendingCaseCreation {
  readonly ownerId: string;
  readonly caseId: string;
  readonly repositoryKind: Repository['kind'];
  /** Serialize once: IDs, timestamps, participant values and audit records cannot drift on retry. */
  readonly changesJson: string;
}

export function prepareCaseCreation(
  context: MutationContext,
  repositoryKind: Repository['kind'],
  input: CaseInput & { initialClaim?: string },
): PendingCaseCreation {
  let result = createCase(emptyWorkspace(), context, input);
  const created = caseSchema.parse(result.workspace.cases[0]);
  if (input.initialClaim?.trim()) {
    const next = createClaim(result.workspace, context, created.id, { statement: input.initialClaim.trim() });
    claimSchema.parse(next.workspace.claims[0]);
    result = { workspace: next.workspace, changes: [...result.changes, ...next.changes] };
  }
  return Object.freeze({ ownerId: context.ownerId, caseId: created.id, repositoryKind, changesJson: JSON.stringify(result.changes) });
}

/** Recover a successful-but-unacknowledged creation before replaying its exact original batch. */
export async function savePendingCaseCreation(
  pending: PendingCaseCreation,
  repository: Repository,
  ownerId: string,
  recoverFirst: boolean,
): Promise<{ caseId: string; recovered: boolean }> {
  if (ownerId !== pending.ownerId) throw new Error('Sign in to the original account to confirm this case creation.');
  if (repository.kind !== pending.repositoryKind) throw new Error('Reconnect to the original workspace before confirming this case creation.');
  if (recoverFirst) {
    const workspace = await repository.loadWorkspace(ownerId, pending.caseId);
    const existing = workspace.cases.find(item => item.id === pending.caseId);
    if (existing) {
      if (existing.ownerId !== ownerId) throw new Error('The case could not be confirmed for this account.');
      if (existing.deletedAt !== null) throw new Error('This case was saved and later removed. Check your case history before creating another case.');
      return { caseId: pending.caseId, recovered: true };
    }
  }
  // The stored changes were written by this app, so a parse failure means the saved record
  // is damaged, not that the user did anything wrong. Caught rather than left to throw: an
  // uncaught SyntaxError here surfaces as a stack trace inside the recovery path, which the
  // user reached precisely because something had already gone wrong once.
  let changes: Change[];
  try {
    changes = JSON.parse(pending.changesJson) as Change[];
  } catch {
    throw new Error('This saved case could not be reopened because its stored details are damaged. Create the case again.');
  }
  await repository.commit(ownerId, changes);
  return { caseId: pending.caseId, recovered: false };
}
