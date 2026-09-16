import { describe, expect, it, vi } from 'vitest';
import { applyChanges, type Change, type Repository } from '../src/data/repository';
import { emptyWorkspace } from '../src/domain/models';
import { prepareCaseCreation, savePendingCaseCreation } from '../src/services/pending-case-creation';

function prepared() {
  let next = 0;
  return prepareCaseCreation({ ownerId: 'owner_a', now: 1000, nextId: prefix => `${prefix}_${++next}` }, 'remote', {
    title: 'Disputed payment', description: 'Compare the transaction records.', initialClaim: 'The payment completed.',
    participants: [{ id: 'participant_a', name: 'Synthetic Person', role: 'Account holder' }],
  });
}
function repository() {
  return { kind: 'remote', commit: vi.fn(async (_owner: string, _changes: readonly Change[]) => {}), loadWorkspace: vi.fn(async () => emptyWorkspace()) } as unknown as Repository;
}

describe('pending case creation', () => {
  it('prepares a detached immutable batch including the claim and audit timestamps', () => {
    const participants = [{ id: 'participant_a', name: 'Original Name', role: 'Witness' }];
    let next = 0;
    const pending = prepareCaseCreation({ ownerId: 'owner_a', now: 1234, nextId: prefix => `${prefix}_${++next}` }, 'remote', { title: 'Original dispute', initialClaim: 'The payment succeeded.', participants });
    const original = pending.changesJson;
    participants[0]!.name = 'Changed after submission';
    expect(pending.changesJson).toBe(original);
    expect(Object.isFrozen(pending)).toBe(true);
    const changes = JSON.parse(pending.changesJson) as Change[];
    expect(changes.map(change => change.collection)).toEqual(['cases', 'auditLogs', 'claims', 'auditLogs']);
    expect(changes.every(change => change.op === 'put' && change.record.createdAt === 1234 && change.record.updatedAt === 1234)).toBe(true);
    expect(pending.changesJson).toContain('Original Name');
    expect(pending.changesJson).not.toContain('Changed after submission');
  });
  it('replays byte-equivalent changes after a failed request and a later retry', async () => {
    const pending = prepared();
    const api = repository();
    const payloads: string[] = [];
    vi.mocked(api.commit).mockImplementation(async (_owner, changes) => {
      payloads.push(JSON.stringify(changes));
      if (payloads.length === 1) throw new Error('Connection lost before persistence');
      return { durability: 'SERVER' };
    });
    await expect(savePendingCaseCreation(pending, api, 'owner_a', false)).rejects.toThrow('Connection lost');
    const response = await savePendingCaseCreation(pending, api, 'owner_a', true);
    expect(response).toEqual({ caseId: pending.caseId, recovered: false });
    expect(payloads).toEqual([pending.changesJson, pending.changesJson]);
    expect(api.loadWorkspace).toHaveBeenCalledWith('owner_a', pending.caseId);
  });
  it('recovers a committed case after a lost response without overwriting later edits', async () => {
    const pending = prepared();
    const api = repository();
    let saved = emptyWorkspace();
    vi.mocked(api.commit).mockImplementation(async (_owner, changes) => {
      saved = applyChanges(saved, changes);
      throw new Error('Response lost after commit');
    });
    await expect(savePendingCaseCreation(pending, api, 'owner_a', false)).rejects.toThrow('Response lost');
    saved.cases[0]!.title = 'Edited on another screen after creation';
    saved.cases[0]!.updatedAt = 9000;
    vi.mocked(api.loadWorkspace).mockResolvedValue(saved);
    await expect(savePendingCaseCreation(pending, api, 'owner_a', true)).resolves.toEqual({ caseId: pending.caseId, recovered: true });
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(saved.cases[0]!.title).toBe('Edited on another screen after creation');
  });
  it('does not retry a write when checking the previous outcome fails', async () => {
    const api = repository();
    vi.mocked(api.loadWorkspace).mockRejectedValue(new Error('Unable to confirm saved cases'));
    await expect(savePendingCaseCreation(prepared(), api, 'owner_a', true)).rejects.toThrow('Unable to confirm');
    expect(api.commit).not.toHaveBeenCalled();
  });
  it('cannot replay another account or another backend request', async () => {
    const pending = prepared();
    const api = repository();
    await expect(savePendingCaseCreation(pending, api, 'owner_b', true)).rejects.toThrow('original account');
    await expect(savePendingCaseCreation(pending, { ...api, kind: 'local' }, 'owner_a', true)).rejects.toThrow('original workspace');
    expect(api.loadWorkspace).not.toHaveBeenCalled();
    expect(api.commit).not.toHaveBeenCalled();
  });
  it('does not recreate a case that was saved and later removed', async () => {
    const pending = prepared();
    const api = repository();
    const saved = applyChanges(emptyWorkspace(), JSON.parse(pending.changesJson) as Change[]);
    saved.cases[0]!.deletedAt = 3000;
    vi.mocked(api.loadWorkspace).mockResolvedValue(saved);
    await expect(savePendingCaseCreation(pending, api, 'owner_a', true)).rejects.toThrow('saved and later removed');
    expect(api.commit).not.toHaveBeenCalled();
  });
  it('validates before producing a pending request so invalid fields remain correctable', () => {
    expect(() => prepareCaseCreation({ ownerId: 'owner_a', now: 1000 }, 'remote', { title: ' ' })).toThrow();
    expect(prepareCaseCreation({ ownerId: 'owner_a', now: 2000 }, 'remote', { title: 'Corrected valid title' }).changesJson).toContain('Corrected valid title');
  });
});
