import { describe, expect, it } from 'vitest';
import { buildSearchIndex, mapWithConcurrency, matchesSearch, sanitizeRecentSearches, searchSnippet, searchStorageKey } from '../src/services/search-index';
import { OWNER, claim, event, evidence, testCase, workspace } from './helpers';

describe('workspace search', () => {
  it('finds source text and real timeline events and participants', () => {
    const record = testCase({ participants: [{ id: 'party_1', name: 'Priya Sharma', role: 'Witness' }] });
    const file = evidence('The goods arrived on Tuesday at the northern warehouse.', { title: 'Delivery attachment' });
    const timeline = event('Delivery recorded', '2026-09-01', { description: 'Recorded at the warehouse gate.' });
    const index = buildSearchIndex(OWNER, [record], [workspace({ evidence: [file], events: [timeline], claims: [claim('Goods were delivered')] })]);
    expect(index.filter((item) => matchesSearch(item, 'northern Tuesday')).map((item) => item.recordId)).toEqual([file.id]);
    expect(index.filter((item) => matchesSearch(item, 'Priya Witness')).map((item) => item.kind)).toEqual(['Cases']);
    expect(index.filter((item) => matchesSearch(item, 'gate')).map((item) => item.kind)).toEqual(['Events']);
    expect(searchSnippet(index.find((item) => item.recordId === file.id)!, 'northern')).toContain('northern');
  });
  it('excludes foreign owners, deleted records and contents of deleted cases', () => {
    const deleted = testCase({ id: 'case_deleted', deletedAt: 1 });
    const files = [evidence('Allowed', { id: 'allowed' }), evidence('Other account', { ownerId: 'other' }), evidence('Deleted', { deletedAt: 1 }), evidence('Hidden case', { caseId: deleted.id })];
    const index = buildSearchIndex(OWNER, [testCase(), deleted, testCase({ id: 'foreign', ownerId: 'other' })], [workspace({ evidence: files })]);
    expect(index.map((item) => item.recordId)).toEqual(['case_test', 'allowed']);
  });
  it('scopes recent queries by account and rejects malformed or duplicate history', () => {
    expect(searchStorageKey('person_a')).not.toBe(searchStorageKey('person_b'));
    expect(searchStorageKey('person_a', true)).not.toBe(searchStorageKey('person_a'));
    expect(sanitizeRecentSearches([' Invoice ', null, 2, 'invoice', {}, 'x', 'Payment'])).toEqual(['Invoice', 'Payment']);
    expect(sanitizeRecentSearches(Array.from({ length: 20 }, (_, i) => `term ${i}`))).toHaveLength(8);
  });
  it('bounds database concurrency while keeping all reads in order', async () => {
    let active = 0; let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active++; peak = Math.max(active, peak);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--; return value * 2;
    });
    expect(peak).toBe(2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });
  it('surfaces failed reads rather than returning a false empty workspace', async () => {
    await expect(mapWithConcurrency([1], 2, async () => { throw new Error('Permission denied'); })).rejects.toThrow('Permission denied');
  });
});
