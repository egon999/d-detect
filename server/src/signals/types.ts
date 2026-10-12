export type SignalKind = 'commitment' | 'renewal' | 'anomaly';

export const RECOMPUTED_RULES = [
  'duplicate_charge',
  'recurring_missing',
  'recurring_amount_changed',
  'unfinished_entries',
  'unread_captures',
  'meeting_untouched',
] as const;

export type RecomputedRule = (typeof RECOMPUTED_RULES)[number];

export const RULES_BY_DETECTOR = {
  money: ['duplicate_charge', 'recurring_missing', 'recurring_amount_changed'],
  pending: ['unfinished_entries', 'unread_captures'],
  meetings: ['meeting_untouched'],
} as const satisfies Record<string, readonly RecomputedRule[]>;

export type DetectorGroup = keyof typeof RULES_BY_DETECTOR;

export interface SignalSource {
  kind: 'record' | 'meeting';
  id: string;
}

export interface Draft {
  kind: SignalKind;

  rule: string;
  title: string;
  detail: string;

  quote?: string | null;
  dueAt?: number | null;

  amountMinor?: number | null;
  currency?: string | null;

  sources: SignalSource[];

  fingerprint: string;
}

export interface Signal {
  id: string;
  kind: SignalKind;
  rule: string;
  title: string;
  detail: string;
  quote: string | null;
  dueAt: number | null;
  amountMinor: number | null;
  currency: string | null;
  amountLabel: string | null;
  sources: SignalSource[];
  status: 'open' | 'done' | 'dismissed';
  createdAt: number;
  resolvedAt: number | null;
}
