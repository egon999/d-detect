import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { values.delete(key); }),
  },
}));

import { clearSearchHistory, loadSearchHistory, rememberSearch, setRememberSearches } from '../src/services/preferences';

beforeEach(() => values.clear());
describe('persisted search privacy', () => {
  it('never loads one account query history into another account', async () => {
    await rememberSearch('account-a', 'private payment');
    await rememberSearch('account-b', 'different case');
    expect(await loadSearchHistory('account-a')).toEqual(['private payment']);
    expect(await loadSearchHistory('account-b')).toEqual(['different case']);
  });
  it('turning memory off clears stored queries and prevents new recording', async () => {
    await rememberSearch('account-a', 'sensitive claim');
    await setRememberSearches('account-a', false);
    expect(await rememberSearch('account-a', 'next query')).toEqual([]);
    expect(await loadSearchHistory('account-a')).toEqual([]);
    await setRememberSearches('account-a', true);
    expect(await loadSearchHistory('account-a')).toEqual([]);
  });
  it('clearing own history preserves another account and removes unowned legacy queries', async () => {
    values.set('@ddetact_recent_searches', '["unowned"]');
    await rememberSearch('account-a', 'first query');
    await rememberSearch('account-b', 'second query');
    await clearSearchHistory('account-a');
    expect(await loadSearchHistory('account-a')).toEqual([]);
    expect(await loadSearchHistory('account-b')).toEqual(['second query']);
    expect(values.has('@ddetact_recent_searches')).toBe(false);
  });
});
