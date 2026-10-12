import { apiGet } from './client';

export type HealthReport = {
  ok: boolean;
  now: number;
  ai: {
    ready: boolean;
    canReadDocuments: boolean;
    canReadImages: boolean;
    canTranscribe: boolean;
  };
  gaps: string[];
};

const HEALTH_TIMEOUT_MS = 8_000;

export function getHealth(signal?: AbortSignal): Promise<HealthReport> {
  return apiGet<HealthReport>('/health', undefined, signal, HEALTH_TIMEOUT_MS);
}
