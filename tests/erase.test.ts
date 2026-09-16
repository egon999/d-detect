/**
 * What an erase must actually take.
 *
 * These tests exist because every failure mode here is silent. An erase that misses something
 * still shows a success message, still returns the user to the sign-in screen, and still looks
 * exactly like one that worked — the only way to find out it did not is to go looking for the
 * data afterwards, which is the one thing the person who pressed it will never do.
 *
 * So the assertions are about what is *left behind*, not about what was called.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', async () => (await import('./secure-store-double')).secureStoreDouble);

const values = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    getAllKeys: vi.fn(async () => [...values.keys()]),
    multiRemove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) values.delete(key);
    }),
  },
}));

/**
 * The filesystem stands in, because `react-native` resolves to `react-native-web` under Vitest
 * and the web branch reaches for IndexedDB, which Node does not have. Recording into `order`
 * rather than only counting calls is what lets the sequencing test below mean anything.
 */
const order = vi.hoisted(() => [] as string[]);
vi.mock('../src/services/storage/evidence-storage', () => ({
  eraseStoredEvidence: vi.fn(async () => {
    order.push('files');
  }),
  evidenceStoreUsage: vi.fn(async () => ({ usedBytes: 41_200_000, freeBytes: 8_000_000_000 })),
  deleteEvidenceFile: vi.fn(async () => {}),
}));

import type { MutationContext } from '../src/data/mutations';
import type { Repository } from '../src/data/repository';
import { emptyWorkspace, type Workspace } from '../src/domain/models';
import { resetCredentialsCacheForTests, saveKey } from '../src/services/ai/credentials';
import { eraseEverything, eraseOriginals, removeCase, storedDataSummary } from '../src/services/erase';
import { resetSecureStoreDouble, secureStoreSize } from './secure-store-double';
import {
  deleteEvidenceFile,
  eraseStoredEvidence,
  evidenceStoreUsage,
} from '../src/services/storage/evidence-storage';

/** A repository that records that it was asked, and when. */
function fakeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    kind: 'local',
    clear: vi.fn(async () => {
      order.push('records');
    }),
    listCases: vi.fn(async () => []),
    ...overrides,
  } as unknown as Repository;
}

/** A device mid-life: an account, an earlier anonymous session, and settings. */
function seedDevice(): void {
  values.set('detact:v1:user_signed_in:cases', '[{"id":"case_a"}]');
  values.set('detact:v1:user_signed_in:case:case_a', '{"claims":[]}');
  values.set('detact:v1:user_signed_in:profile', '{"id":"user_signed_in"}');
  values.set('detact:v1:device_earlier:cases', '[{"id":"case_b"}]');
  values.set('detact:v1:device_earlier:case:case_b', '{"claims":[]}');
  values.set('detact:v1:identity', '{"id":"device_earlier","email":"a@b.test"}');
  values.set('detact:v1:offline-active', 'true');
  values.set('detact:v1:draft-personal:user_signed_in', '{"name":"A Person","address":"12 Some Road"}');
  values.set('detact:v1:draft-answers:user_signed_in:case_a', '{"accountNumber":"0000111122"}');
  values.set('detact:v2:recent-searches:user_signed_in', '["unpaid invoice"]');
  values.set('detact:v2:remember-searches:user_signed_in', 'true');
  values.set('@ddetact_recent_searches', '["older unowned query"]');
  values.set('detact:v1:theme', 'dark');
  values.set('detact:v1:onboarding-seen', 'true');
}

beforeEach(() => {
  values.clear();
  order.length = 0;
  resetSecureStoreDouble();
  resetCredentialsCacheForTests();
  vi.mocked(eraseStoredEvidence).mockClear();
  vi.mocked(evidenceStoreUsage).mockClear();
  vi.mocked(deleteEvidenceFile).mockClear();
  vi.mocked(deleteEvidenceFile).mockImplementation(async () => {});
});

describe('erasing everything', () => {
  it('takes the cases of every owner the device has had, not only the signed-in one', async () => {
    seedDevice();
    await eraseEverything(fakeRepository(), 'user_signed_in');

    // `device_earlier` is the identity this phone used before anyone signed in. Its cases are
    // the user's own work and they are unreachable from any screen once the account exists —
    // leaving them is the difference between an erase and a tidy-up.
    expect([...values.keys()].filter((key) => key.includes('device_earlier'))).toEqual([]);
    expect([...values.keys()].filter((key) => key.includes('user_signed_in'))).toEqual([]);
  });

  it('takes the personal details typed into a draft letter', async () => {
    seedDevice();
    await eraseEverything(fakeRepository(), 'user_signed_in');

    // A name, a postal address and an account number. Nothing else in the app stores these,
    // and until this existed nothing removed them either.
    expect(values.has('detact:v1:draft-personal:user_signed_in')).toBe(false);
    expect(values.has('detact:v1:draft-answers:user_signed_in:case_a')).toBe(false);
  });

  it('takes the device identity, and searches written before keys carried an owner', async () => {
    seedDevice();
    await eraseEverything(fakeRepository(), 'user_signed_in');

    expect(values.has('detact:v1:identity')).toBe(false);
    expect(values.has('detact:v1:offline-active')).toBe(false);
    expect(values.has('detact:v2:recent-searches:user_signed_in')).toBe(false);
    expect(values.has('@ddetact_recent_searches')).toBe(false);
  });

  it('keeps the two settings that say nothing about a person', async () => {
    seedDevice();
    await eraseEverything(fakeRepository(), 'user_signed_in');

    // `dark` and `true`. Keeping them means the app after an erase looks like the app before
    // it, which matters for the likeliest user of this button: someone clearing a finished
    // case off their own phone, not someone leaving.
    expect(values.get('detact:v1:theme')).toBe('dark');
    expect(values.get('detact:v1:onboarding-seen')).toBe('true');
  });

  it('erases a key that a later version of the app introduced', async () => {
    seedDevice();
    values.set('detact:v3:something-nobody-has-written-yet', 'personal');
    await eraseEverything(fakeRepository(), 'user_signed_in');

    // The allow-list fails closed on purpose: an unknown key is erased rather than preserved,
    // so forgetting to think about a new key cannot leave data behind.
    expect(values.has('detact:v3:something-nobody-has-written-yet')).toBe(false);
  });

  it('empties the credential store', async () => {
    await saveKey('groq', 'gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await saveKey('grok', 'xai-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(secureStoreSize()).toBe(2);

    await eraseEverything(fakeRepository(), 'user_signed_in');

    // Keys live in the platform keystore, which `getAllKeys` cannot see. A sweep that only
    // knew about AsyncStorage would leave a working API credential on a wiped phone.
    expect(secureStoreSize()).toBe(0);
  });

  it('leaves the device untouched when the account refuses to be cleared', async () => {
    seedDevice();
    const before = new Map(values);
    const repository = fakeRepository({
      clear: vi.fn(async () => {
        throw new Error('Deleting your data is not available while the app is connected to a platform server.');
      }),
    });

    await expect(eraseEverything(repository, 'user_signed_in')).rejects.toThrow(/not available/);

    // The refusal has to cost nothing. A user whose local work was destroyed on the way to a
    // failed cloud delete would be worse off than if they had never pressed the button.
    expect([...values.entries()]).toEqual([...before.entries()]);
    expect(eraseStoredEvidence).not.toHaveBeenCalled();
  });

  it('clears records first, then the files those records point at', async () => {
    seedDevice();
    await eraseEverything(fakeRepository(), 'user_signed_in');

    // Reversed, a failure midway leaves original bytes on disk with nothing left in the app
    // that can name them — invisible to every screen, and permanent.
    expect(order).toEqual(['records', 'files']);
  });
});

describe('measuring what an erase would take', () => {
  it('reports what is there', async () => {
    const repository = fakeRepository({
      listCases: vi.fn(async () => [{ id: 'case_a' }, { id: 'case_b' }]) as unknown as Repository['listCases'],
    });

    expect(await storedDataSummary(repository, 'user_signed_in')).toEqual({
      cases: 2,
      bytes: 41_200_000,
    });
  });

  it('answers zero rather than failing when neither side can be read', async () => {
    const repository = fakeRepository({
      listCases: vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as Repository['listCases'],
    });
    vi.mocked(evidenceStoreUsage).mockRejectedValueOnce(new Error('no filesystem'));

    // The figure is decoration on a button that must work regardless. Understating what is at
    // stake is the safe direction to fail in: it never tells someone there is less to lose
    // than there is, because the confirmation falls back to naming no figures at all.
    expect(await storedDataSummary(repository, 'user_signed_in')).toEqual({ cases: 0, bytes: 0 });
  });
});

describe('shredding the originals behind a deleted record', () => {
  it('takes each distinct file once', async () => {
    expect(
      await eraseOriginals([
        'users/u/cases/c/statement.pdf',
        'users/u/cases/c/receipt.jpg',
        // Repeated because a sign-in handover re-points a file and can leave two records
        // naming one original. Deleting it twice would report a phantom failure.
        'users/u/cases/c/statement.pdf',
      ]),
    ).toBe(0);
    expect(vi.mocked(deleteEvidenceFile).mock.calls.map(([path]) => path).sort()).toEqual([
      'users/u/cases/c/receipt.jpg',
      'users/u/cases/c/statement.pdf',
    ]);
  });

  it('does nothing for records that never finished uploading', async () => {
    // A record whose write failed has no `storagePath`, and there is nothing to shred.
    expect(await eraseOriginals([null, undefined, ''])).toBe(0);
    expect(deleteEvidenceFile).not.toHaveBeenCalled();
  });

  it('counts what it could not remove instead of throwing', async () => {
    vi.mocked(deleteEvidenceFile).mockImplementation(async (path: string) => {
      if (path.endsWith('locked.pdf')) throw new Error('EACCES');
    });

    // Raising here would report a failure for a deletion that already succeeded — the record
    // was tombstoned before this ran, and a caller that rolled back would resurrect it.
    expect(await eraseOriginals(['a/ok.pdf', 'a/locked.pdf', 'a/also-ok.pdf'])).toBe(1);

    // And one bad file must not spare the others.
    expect(vi.mocked(deleteEvidenceFile).mock.calls).toHaveLength(3);
  });
});

/**
 * A workspace holding two cases, so every assertion below can also show that the case the user
 * did *not* delete keeps its documents. A delete that takes too much is the worse bug of the two.
 */
function twoCaseWorkspace(
  evidence: ReadonlyArray<{ id: string; caseId: string; storagePath: string | null; deletedAt?: number | null }>,
): Workspace {
  return {
    ...emptyWorkspace(),
    cases: [
      { id: 'case_a', title: 'Unpaid invoice', deletedAt: null },
      { id: 'case_b', title: 'Deposit dispute', deletedAt: null },
    ],
    evidence: evidence.map((item) => ({ deletedAt: null, ...item })),
  } as unknown as Workspace;
}

const context: MutationContext = { ownerId: 'user_signed_in', now: 1_700_000_000_000, nextId: () => 'aud_fixed' };

describe('removing a case', () => {
  it('shreds the originals of that case and no others', async () => {
    const repository = fakeRepository({
      commit: vi.fn(async () => {
        order.push('records');
      }) as unknown as Repository['commit'],
    });

    const survivors = await removeCase(
      repository,
      twoCaseWorkspace([
        { id: 'evd_1', caseId: 'case_a', storagePath: 'users/u/cases/case_a/statement.pdf' },
        { id: 'evd_2', caseId: 'case_a', storagePath: 'users/u/cases/case_a/receipt.jpg' },
        { id: 'evd_3', caseId: 'case_b', storagePath: 'users/u/cases/case_b/lease.pdf' },
      ]),
      context,
      'case_a',
    );

    expect(survivors).toBe(0);
    expect(vi.mocked(deleteEvidenceFile).mock.calls.map(([path]) => path).sort()).toEqual([
      'users/u/cases/case_a/receipt.jpg',
      'users/u/cases/case_a/statement.pdf',
    ]);
  });

  it('tombstones only the case, and commits before anything is shredded', async () => {
    let changesSeen: ReadonlyArray<{ collection: string; record: { id: string; deletedAt?: number | null } }> = [];
    const repository = fakeRepository({
      commit: vi.fn(async (_ownerId: string, changes: unknown) => {
        order.push('records');
        changesSeen = changes as typeof changesSeen;
      }) as unknown as Repository['commit'],
    });
    vi.mocked(deleteEvidenceFile).mockImplementation(async () => {
      order.push('files');
    });

    await removeCase(
      repository,
      twoCaseWorkspace([{ id: 'evd_1', caseId: 'case_a', storagePath: 'users/u/cases/case_a/statement.pdf' }]),
      context,
      'case_a',
    );

    // Shredding first is the version that loses data: a commit that then failed would leave the
    // case listed and openable with every document inside it pointing at bytes that are gone.
    expect(order).toEqual(['records', 'files']);

    // `deleteCase` stamps the case and writes an audit entry. It deliberately does not stamp the
    // evidence rows — they stay as history and become unreachable — which is exactly why the
    // files have to be taken here rather than left to a later record-driven sweep.
    expect(changesSeen.map((change) => change.collection).sort()).toEqual(['auditLogs', 'cases']);
    expect(changesSeen.find((change) => change.collection === 'cases')?.record.deletedAt).toBe(context.now);
  });

  it('leaves the files alone when the case could not be tombstoned', async () => {
    const repository = fakeRepository({
      commit: vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as Repository['commit'],
    });

    await expect(
      removeCase(
        repository,
        twoCaseWorkspace([{ id: 'evd_1', caseId: 'case_a', storagePath: 'users/u/cases/case_a/statement.pdf' }]),
        context,
        'case_a',
      ),
    ).rejects.toThrow('offline');

    // The case is still there, so its documents must still open. This is the assertion that
    // makes the ordering above load-bearing rather than incidental.
    expect(deleteEvidenceFile).not.toHaveBeenCalled();
  });

  it('still takes originals behind evidence the user removed earlier', async () => {
    const repository = fakeRepository({ commit: vi.fn(async () => {}) as unknown as Repository['commit'] });

    await removeCase(
      repository,
      twoCaseWorkspace([
        { id: 'evd_1', caseId: 'case_a', storagePath: 'users/u/cases/case_a/statement.pdf', deletedAt: 1_600_000_000_000 },
      ]),
      context,
      'case_a',
    );

    // The evidence screen should already have shredded this one. Records written before that
    // shred existed still have their originals, and re-attempting a file that has gone costs a
    // rejected promise the caller ignores — while skipping a present one leaves it forever.
    expect(vi.mocked(deleteEvidenceFile).mock.calls.map(([path]) => path)).toEqual([
      'users/u/cases/case_a/statement.pdf',
    ]);
  });

  it('reports survivors without failing the deletion', async () => {
    const repository = fakeRepository({ commit: vi.fn(async () => {}) as unknown as Repository['commit'] });
    vi.mocked(deleteEvidenceFile).mockImplementation(async (path: string) => {
      if (path.endsWith('locked.pdf')) throw new Error('EACCES');
    });

    // The case is gone either way. A non-zero count is a file left on disk, not a failed delete,
    // and a caller that treated it as one would tell the user their case is still there.
    expect(
      await removeCase(
        repository,
        twoCaseWorkspace([
          { id: 'evd_1', caseId: 'case_a', storagePath: 'users/u/cases/case_a/locked.pdf' },
          { id: 'evd_2', caseId: 'case_a', storagePath: 'users/u/cases/case_a/receipt.jpg' },
          { id: 'evd_3', caseId: 'case_a', storagePath: null },
        ]),
        context,
        'case_a',
      ),
    ).toBe(1);
  });
});
