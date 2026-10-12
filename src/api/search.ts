import { z } from 'zod';

import { apiGet } from './client';

export type SearchResultType = 'record' | 'meeting' | 'task' | 'case';

const SearchResultSchema = z.object({
  type: z.enum(['record', 'meeting', 'task', 'case']),
  id: z.string(),
  title: z.string(),

  subtitle: z.string().nullable(),

  occurredAt: z.number().nullable(),

  amountLabel: z.string().nullable(),
});

const SearchResponseSchema = z.object({ results: z.array(SearchResultSchema) });

export type SearchResult = z.infer<typeof SearchResultSchema>;

export type SearchDestination =
  | { pathname: '/record/[id]'; params: { id: string } }
  | { pathname: '/meeting/[id]'; params: { id: string } }
  | { pathname: '/case/[id]'; params: { id: string } }
  | { pathname: '/(tabs)/tasks'; params: { focus: string } };

export function destinationFor(result: Pick<SearchResult, 'type' | 'id'>): SearchDestination {
  switch (result.type) {
    case 'record':
      return { pathname: '/record/[id]', params: { id: result.id } };
    case 'meeting':
      return { pathname: '/meeting/[id]', params: { id: result.id } };
    case 'case':
      return { pathname: '/case/[id]', params: { id: result.id } };
    case 'task':
      return { pathname: '/(tabs)/tasks', params: { focus: result.id } };
  }
}

export async function searchEverything(
  query: string,
  options: { kind?: SearchResultType; limit?: number; signal?: AbortSignal } = {},
): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const data = await apiGet<unknown>(
    '/api/search',
    { q: query, kind: options.kind, limit: options.limit },
    options.signal,
  );
  return SearchResponseSchema.parse(data).results;
}

export const SEARCH_MIN_CHARS = 2;

export type SearchPlan =
  | { action: 'idle' }
  | { action: 'wait'; query: string }
  | { action: 'run'; query: string; delayMs: number };

export const SEARCH_DEBOUNCE_SHORT_MS = 420;
export const SEARCH_DEBOUNCE_MS = 240;

export function planSearch(raw: string): SearchPlan {
  const query = raw.trim().replace(/\s+/g, ' ');
  if (query.length === 0) return { action: 'idle' };
  if (query.length < SEARCH_MIN_CHARS) return { action: 'wait', query };
  return {
    action: 'run',
    query,
    delayMs: query.length <= 3 ? SEARCH_DEBOUNCE_SHORT_MS : SEARCH_DEBOUNCE_MS,
  };
}
