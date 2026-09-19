import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/services/api-client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/services/api-client')>()), apiJson: api }));
import { RemoteRepository } from '../src/data/remote/remote-repository';
import { emptyWorkspace } from '../src/domain/models';
import { testCase, evidence } from './helpers';
beforeEach(() => { api.mockReset(); });
describe('remote persistent repository', () => {
  it('loads every owner case once for account search and activity', async () => {
    api.mockResolvedValue({ ...emptyWorkspace(), cases: [testCase(), testCase({ id: 'case_other' })] });
    const result = await new RemoteRepository().loadAllWorkspace('user_test');
    expect(result.cases).toHaveLength(2);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/workspace', {}, 'user_test');
  });
  it('only returns records of the selected case from authenticated owner data', async () => {
    api.mockResolvedValue({ ...emptyWorkspace(), cases: [testCase(), testCase({ id: 'case_other' })], evidence: [evidence('first'), evidence('second', { caseId: 'case_other' })] });
    const result = await new RemoteRepository().loadWorkspace('user_test', 'case_test');
    expect(result.cases).toHaveLength(1);
    expect(result.evidence).toHaveLength(1);
    expect(api).toHaveBeenCalledWith('/api/workspace', {}, 'user_test');
  });
  it('rejects a server response containing another owner before publishing it', async () => {
    api.mockResolvedValue({ ...emptyWorkspace(), cases: [testCase({ ownerId: 'user_other' })] });
    await expect(new RemoteRepository().listCases('user_test')).rejects.toThrow('another account');
  });
  it('shares concurrent owner reads but does not reuse stale data after completion', async () => {
    api.mockResolvedValue(emptyWorkspace());
    const repository = new RemoteRepository();
    await Promise.all([repository.listCases('user_test'), repository.loadWorkspace('user_test', 'case_test')]);
    expect(api).toHaveBeenCalledTimes(1);
    await repository.listCases('user_test');
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('sends one atomic commit and does not report success after server rejection', async () => {
    const changes = [{ op: 'put' as const, collection: 'cases' as const, record: testCase() }];
    api.mockRejectedValue(new Error('server rejected'));
    await expect(new RemoteRepository().commit('user_test', changes)).rejects.toThrow('server rejected');
    expect(api).toHaveBeenCalledTimes(1);
    expect(JSON.parse(api.mock.calls[0]![1].body)).toEqual({ changes });
  });
  it('rejects foreign writes before transport', async () => {
    await expect(new RemoteRepository().commit('user_test', [{ op: 'put', collection: 'cases', record: testCase({ ownerId: 'user_other' }) }])).rejects.toThrow('Refusing');
    expect(api).not.toHaveBeenCalled();
  });
  it('stops publishing when a screen unsubscribes during an in-flight read', async () => {
    let release!: (value: unknown) => void;
    api.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const callback = vi.fn();
    const unsubscribe = new RemoteRepository().watchCases('user_test', callback);
    unsubscribe();
    release(emptyWorkspace());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(callback).not.toHaveBeenCalled();
  });
});
