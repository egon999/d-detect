import { userProfileSchema, workspaceSchema, type Case, type UserProfile, type Workspace } from '@domain/models';
import { apiJson } from '@services/api-client';
import { assertOwnership, workspaceForCase, type Change, type CommitOutcome, type Repository, type Unsubscribe } from '../repository';

/** Persistent platform data over authenticated HTTP. Polls observe durable worker updates. */
export class RemoteRepository implements Repository {
  readonly kind = 'remote' as const;
  private readonly refreshers = new Set<() => void>();
  private readonly pendingLoads = new Map<string, Promise<Workspace>>();

  async loadProfile(userId: string): Promise<UserProfile | null> {
    const result = await apiJson('/api/profile', {}, userId);
    if (result === null) return null;
    return userProfileSchema.parse(result);
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    const value = userProfileSchema.parse(profile);
    await apiJson('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }, value.ownerId);
  }

  private async load(ownerId: string): Promise<Workspace> {
    const pending = this.pendingLoads.get(ownerId);
    if (pending) return pending;
    const request = apiJson('/api/workspace', {}, ownerId).then(data => {
      const parsed = workspaceSchema.safeParse(data);
      if (!parsed.success) throw new Error('The case data could not be read. Please refresh or contact support.');
      for (const records of Object.values(parsed.data)) {
        if (records.some(record => record.ownerId !== ownerId)) throw new Error('The workspace contains records from another account.');
      }
      return parsed.data;
    }).finally(() => { this.pendingLoads.delete(ownerId); });
    this.pendingLoads.set(ownerId, request);
    return request;
  }

  async listCases(ownerId: string): Promise<Case[]> {
    return (await this.load(ownerId)).cases.filter(item => item.deletedAt === null).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async loadAllWorkspace(ownerId: string): Promise<Workspace> {
    return this.load(ownerId);
  }

  async loadWorkspace(ownerId: string, caseId: string): Promise<Workspace> {
    return workspaceForCase(await this.load(ownerId), caseId);
  }

  /** Always `SERVER`: the write is over HTTP, so a resolved response *is* the acknowledgement. */
  async commit(ownerId: string, changes: readonly Change[]): Promise<CommitOutcome> {
    if (!changes.length) return { durability: 'SERVER' };
    assertOwnership(ownerId, changes);
    await apiJson('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) }, ownerId);
    for (const refresh of this.refreshers) refresh();
    return { durability: 'SERVER' };
  }

  /**
   * Not available over HTTP: the platform API exposes no endpoint that erases an account,
   * and there is no way to assemble one from `/api/commit` — that route takes named records,
   * while `/api/workspace` hides anything soft-deleted, so a loop built on the two would
   * report success having left the discarded cases behind. Refusing is the honest answer;
   * the account screen surfaces this message rather than showing a wipe that did not happen.
   */
  async clear(_ownerId: string): Promise<void> {
    throw new Error('Deleting your data is not available while the app is connected to a platform server.');
  }

  private watch<T>(load: () => Promise<T>, onChange: (value: T) => void, onError?: (error: Error) => void): Unsubscribe {
    let active = true;
    let loading = false;
    let lastValue = '';
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!active || loading) return;
      if (timer) clearTimeout(timer);
      loading = true;
      void load().then(value => {
        if (!active) return;
        const serialized = JSON.stringify(value);
        if (serialized !== lastValue || failed) { lastValue = serialized; failed = false; onChange(value); }
      }).catch(error => {
        failed = true;
        if (active) onError?.(error instanceof Error ? error : new Error('Case data could not be refreshed.'));
      }).finally(() => {
        loading = false;
        if (active) timer = setTimeout(refresh, 3_000);
      });
    };
    this.refreshers.add(refresh);
    refresh();
    return () => { active = false; if (timer) clearTimeout(timer); this.refreshers.delete(refresh); };
  }

  watchWorkspace(ownerId: string, caseId: string, onChange: (workspace: Workspace) => void, onError?: (error: Error) => void): Unsubscribe {
    return this.watch(() => this.loadWorkspace(ownerId, caseId), onChange, onError);
  }

  watchCases(ownerId: string, onChange: (cases: Case[]) => void, onError?: (error: Error) => void): Unsubscribe {
    return this.watch(() => this.listCases(ownerId), onChange, onError);
  }
}
