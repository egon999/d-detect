/**
 * Moving a case off the device, and what the move is allowed to destroy.
 *
 * The assertions here are about what is *left behind*, for the same reason `erase.test.ts`
 * is written that way: every failure mode on this path is silent. The screen shows the same
 * success either way, and the only copy of an unmoved case is the one being deleted — so a
 * test that checked the moved case arrived, and stopped there, would have passed against the
 * defect this file exists to pin down. `clearDeviceCases` deleted the whole device owner
 * prefix from a button that names one case, which on a phone used anonymously more than once
 * took every other case on it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Device storage, as a map. `createAsyncStorageStore` is the one file in the data layer that
 * imports a React Native module, and `migration.ts` builds its own `LocalRepository` on top
 * of it — so standing in at this level is what lets the real adapter, the real key layout and
 * the real service run unchanged in Node.
 */
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
    multiGet: vi.fn(async (keys: readonly string[]) =>
      keys.map((key) => [key, values.get(key) ?? null] as [string, string | null]),
    ),
    multiSet: vi.fn(async (entries: ReadonlyArray<readonly [string, string]>) => {
      for (const [key, value] of entries) values.set(key, value);
    }),
    multiRemove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) values.delete(key);
    }),
  },
}));

/**
 * The file move is recorded rather than performed: under Vitest `react-native` resolves to
 * `react-native-web`, whose branch of `moveEvidenceFile` reaches for IndexedDB. The recording
 * is the point — where the bytes end up is what the outcome copy now claims, so the test can
 * hold the copy to it.
 *
 * Spread from the original so that an import added to `evidence-storage` later does not turn
 * this factory into a module missing half its exports.
 */
const moves = vi.hoisted(() => [] as Array<[string, string]>);
vi.mock('../src/services/storage/evidence-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/storage/evidence-storage')>()),
  moveEvidenceFile: vi.fn(async (from: string, to: string) => {
    moves.push([from, to]);
    return true;
  }),
}));

import { createAsyncStorageStore } from '@data/local/async-storage-store';
import { LocalRepository } from '@data/local/local-repository';
import { put } from '@data/repository';
import {
  clearDeviceCase,
  handOverDeviceCase,
  listDeviceCases,
  loadDeviceCase,
} from '@services/migration';
import { claim, evidence, event, resetIds, testCase } from './helpers';

const DEVICE = 'user_device';
const ACCOUNT = 'user_account';
const MOVED = 'case_moved';
const KEPT = 'case_kept';
const NOW = 9_000;

/** Text unique to each case, so "gone" can be asserted against the bytes in the store. */
const TEXT: Record<string, string> = {
  [MOVED]: 'Invoice INR 45,000.00 dated 04 January 2026 from Orbit Traders.',
  [KEPT]: 'Salary slip for December 2025, net pay INR 61,240.00, Meridian Systems.',
};

/** The path shape `evidenceStoragePath` produces, which is the only shape the planner rewrites. */
const storedAt = (ownerId: string, caseId: string, evidenceId: string) =>
  `users/${ownerId}/cases/${caseId}/${evidenceId}/original.pdf`;

/** Writes one case into device storage the way the app does — through the local adapter. */
async function writeDeviceCase(caseId: string): Promise<void> {
  const repository = new LocalRepository(createAsyncStorageStore());
  const scoped = { ownerId: DEVICE, caseId };
  const evidenceId = `evd_${caseId}`;

  await repository.commit(DEVICE, [
    put('cases', testCase({ id: caseId, ownerId: DEVICE, title: `Case ${caseId}` })),
    put(
      'evidence',
      evidence(TEXT[caseId] ?? '', {
        ...scoped,
        id: evidenceId,
        storagePath: storedAt(DEVICE, caseId, evidenceId),
      }),
    ),
    put('claims', claim(`Claim in ${caseId}`, { ...scoped, id: `clm_${caseId}` })),
    put('events', event(`Event in ${caseId}`, '2026-01-04', { ...scoped, id: `evt_${caseId}` })),
  ]);
}

/** Everything device storage currently holds, as one string. */
const storedBytes = () => [...values.values()].join('\n');

beforeEach(async () => {
  values.clear();
  moves.length = 0;
  resetIds();
  await writeDeviceCase(MOVED);
  await writeDeviceCase(KEPT);
});

describe('clearDeviceCase', () => {
  it('removes the named case and leaves every other case on the device intact', async () => {
    await clearDeviceCase(DEVICE, MOVED);

    const remaining = await listDeviceCases(ACCOUNT);
    expect(remaining.map((item) => item.record.id)).toEqual([KEPT]);

    // Not just absent from the list: the records themselves, and the text read out of the
    // document, are out of the store. A soft delete would pass the assertion above.
    const cleared = await loadDeviceCase(DEVICE, MOVED);
    expect(cleared.cases).toEqual([]);
    expect(cleared.evidence).toEqual([]);
    expect(cleared.claims).toEqual([]);
    expect(cleared.events).toEqual([]);
    expect(storedBytes()).not.toContain(TEXT[MOVED]);

    const kept = await loadDeviceCase(DEVICE, KEPT);
    expect(kept.cases.map((item) => item.id)).toEqual([KEPT]);
    expect(kept.evidence.map((item) => item.id)).toEqual([`evd_${KEPT}`]);
    expect(kept.claims).toHaveLength(1);
    expect(kept.events).toHaveLength(1);
    expect(kept.evidence[0]?.extraction?.sourceText).toContain(TEXT[KEPT]);
  });

  it('leaves a case belonging to another device owner alone', async () => {
    // Deleting by workspace rather than by key prefix has to stay scoped by owner as well as
    // by case: two anonymous sessions on the same phone can hold cases under the same id.
    const other = 'user_device_2';
    const repository = new LocalRepository(createAsyncStorageStore());
    await repository.commit(other, [put('cases', testCase({ id: MOVED, ownerId: other }))]);

    await clearDeviceCase(DEVICE, MOVED);

    expect((await repository.listCases(other)).map((item) => item.id)).toEqual([MOVED]);
  });
});

describe('handOverDeviceCase with clearDeviceCopy', () => {
  it('moves one case into the account and clears only that case from the device', async () => {
    const account = new LocalRepository(createAsyncStorageStore());
    const workspace = await loadDeviceCase(DEVICE, MOVED);

    const outcome = await handOverDeviceCase({
      repository: account,
      toOwnerId: ACCOUNT,
      deviceOwnerId: DEVICE,
      caseId: MOVED,
      workspace,
      clearDeviceCopy: true,
      now: NOW,
    });

    expect(outcome).toEqual({ caseId: MOVED, filesMoved: 1, filesMissing: 0 });
    expect((await account.listCases(ACCOUNT)).map((item) => item.id)).toEqual([MOVED]);

    // The whole of the defect, in one assertion: the case the user never touched is still
    // there, with its records, after the case they did move had its device copy removed.
    const remaining = await listDeviceCases(ACCOUNT);
    expect(remaining.map((item) => item.record.id)).toEqual([KEPT]);
    expect((await loadDeviceCase(DEVICE, KEPT)).evidence).toHaveLength(1);
    expect(storedBytes()).toContain(TEXT[KEPT]);
  });

  it('moves the original between two paths on this device and uploads nothing', async () => {
    // What the outcome copy in `app/previous-cases.tsx` now says, held to the code: the
    // record crosses into the account, the bytes do not leave the handset. Both paths are
    // private store keys under `users/{ownerId}/…`, and neither is a URL.
    const account = new LocalRepository(createAsyncStorageStore());
    const workspace = await loadDeviceCase(DEVICE, MOVED);

    await handOverDeviceCase({
      repository: account,
      toOwnerId: ACCOUNT,
      deviceOwnerId: DEVICE,
      caseId: MOVED,
      workspace,
      now: NOW,
    });

    expect(moves).toEqual([
      [storedAt(DEVICE, MOVED, `evd_${MOVED}`), storedAt(ACCOUNT, MOVED, `evd_${MOVED}`)],
    ]);
  });
});
