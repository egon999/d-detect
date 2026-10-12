import { z } from 'zod';

import { apiGet, apiPost } from './client';

export type AttentionKind = 'commitment' | 'renewal' | 'anomaly';
export type AttentionStatus = 'open' | 'done' | 'dismissed';

export type AttentionState = 'open' | 'handled' | 'dismissed';

const AttentionSourceSchema = z.object({
  kind: z.enum(['record', 'meeting']),
  id: z.string(),
  title: z.string(),
});

const AttentionItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['commitment', 'renewal', 'anomaly']),

  rule: z.string(),
  title: z.string(),
  detail: z.string(),

  quote: z.string().nullable(),
  dueAt: z.number().nullable(),
  amountMinor: z.number().nullable(),
  currency: z.string().nullable(),

  amountLabel: z.string().nullable(),
  sources: z.array(AttentionSourceSchema),
  status: z.enum(['open', 'done', 'dismissed']),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
});

const LastLookSchema = z.object({
  at: z.number(),
  found: z.number(),
  read: z.number(),
  completed: z.boolean(),
});

const AttentionSchema = z.object({
  signals: z.array(AttentionItemSchema),
  counts: z.object({ commitment: z.number(), renewal: z.number(), anomaly: z.number() }),
  total: z.number(),
  state: z.enum(['open', 'handled', 'dismissed']).default('open'),

  looking: z.boolean().default(false),

  startedAt: z.number().nullable().default(null),
  lastLook: LastLookSchema.nullable().default(null),
});

const AttentionLookSchema = z.object({

  started: z.boolean(),
  looking: z.boolean().default(false),
  startedAt: z.number().nullable().default(null),
  lastLook: LastLookSchema.nullable().default(null),
});

export type AttentionSource = z.infer<typeof AttentionSourceSchema>;
export type AttentionItem = z.infer<typeof AttentionItemSchema>;
export type AttentionLastLook = z.infer<typeof LastLookSchema>;
export type Attention = z.infer<typeof AttentionSchema>;
export type AttentionLook = z.infer<typeof AttentionLookSchema>;

export async function getAttention(options: { state?: AttentionState } = {}): Promise<Attention> {
  const data = await apiGet<unknown>('/api/attention', options.state ? { state: options.state } : undefined);
  return AttentionSchema.parse(data);
}

export async function refreshAttention(): Promise<AttentionLook> {
  const data = await apiPost<unknown>('/api/attention/refresh');
  return AttentionLookSchema.parse(data);
}

export async function getAttentionItem(id: string): Promise<AttentionItem> {
  const data = await apiGet<{ signal: unknown }>(`/api/attention/${id}`);
  return AttentionItemSchema.parse(data.signal);
}

export async function resolveAttentionItem(id: string, status: AttentionStatus | 'open'): Promise<AttentionItem> {
  const data = await apiPost<{ signal: unknown }>(`/api/attention/${id}/resolve`, { status });
  return AttentionItemSchema.parse(data.signal);
}

export function attentionIsCitable(item: Pick<AttentionItem, 'sources'>): boolean {
  return item.sources.length > 0;
}

export function attentionPollDelayMs(watchedMs: number): number {
  const watched = Number.isFinite(watchedMs) && watchedMs > 0 ? watchedMs : 0;
  if (watched < 15_000) return 3_000;
  if (watched < 60_000) return 6_000;
  if (watched < 3 * 60_000) return 15_000;
  return 30_000;
}

export const ATTENTION_LOOK_CEILING_MS = 13 * 60_000;
