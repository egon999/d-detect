import { apiDelete, apiGet, apiPatch } from './client';

export type StoredCategory = {
  count: number;
  bytes: number;
  sizeLabel: string;
};

export type StoredSummary = {
  entries: number;
  meetings: number;
  tasks: number;
  cases: number;
  files: number;
  bytes: number;
  sizeLabel: string;
  categories?: {
    images: StoredCategory;
    audio: StoredCategory;
    documents: StoredCategory;
  };
};

export type Me = {
  id: string;
  email: string | null;
  name: string | null;
  displayName: string | null;
  currency: string | null;
  locale: string | null;
  createdAt: number;
  stored: StoredSummary;
};

export type MePatch = Partial<{
  displayName: string | null;
  currency: string | null;
  locale: string | null;
}>;

export type MeUpdate = Me & { note: string | null };

export type AccountExportTotals = {
  entries: number;
  meetings: number;
  tasks: number;
  cases: number;
  evidencePieces: number;
  budgets: number;
  noticed: number;
  storedFiles: number;
  storedBytes: number;
  storedSizeLabel: string;
};

export type AccountExport = {
  product: string;
  downloadName: string;
  exportedAt: number;
  howToReadThis: string[];
  whatIsNotHere: string[];
  you: {
    name: string | null;
    email: string | null;
    currency: string | null;
    locale: string | null;
    accountOpenedAt: number;
  };
  entries: unknown[];
  meetings: unknown[];
  tasks: unknown[];
  cases: unknown[];
  budgets: unknown[];
  noticed: unknown[];
  storedFiles: unknown[];
  totals: AccountExportTotals;
};

export type AccountDeleted = {
  deleted: true;
  removed: {
    entries: number;
    meetings: number;
    tasks: number;
    cases: number;
    evidencePieces: number;
    budgets: number;
    noticed: number;
    files: number;
  };
  message: string;
};

export const DELETE_CONFIRMATION = 'delete my account';

export function getMe(): Promise<Me> {
  return apiGet<Me>('/api/me');
}

export function updateMe(patch: MePatch): Promise<MeUpdate> {
  return apiPatch<MeUpdate>('/api/me', patch);
}

export function exportAccount(): Promise<AccountExport> {
  return apiGet<AccountExport>('/api/me/export');
}

export function deleteAccount(typed: string): Promise<AccountDeleted> {
  return apiDelete<AccountDeleted>('/api/me', { confirm: typed });
}
