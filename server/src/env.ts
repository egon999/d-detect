import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, '..');

const envFile = resolve(SERVER_ROOT, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function str(name: string, fallback = ''): string {
  return (process.env[name] ?? '').trim() || fallback;
}

function int(name: string, fallback: number): number {
  const parsed = Number.parseInt(str(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = str(name).toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function bounded(name: string, fallback: number, low: number, high: number): number {
  const raw = Number.parseInt(str(name), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, low), high);
}

function providerKey(name: string): string {
  const value = str(name);
  if (value === '') return '';

  if (value.startsWith('gsk_')) return value;
  if (/^(xai-|sk-|AIza)/.test(value)) return '';
  return value;
}

export const config = {
  port: int('PORT', 8787),
  host: str('HOST', '127.0.0.1'),

  dataDir: resolve(SERVER_ROOT, str('DATA_DIR', '.data')),

  allowedOrigins: str('ALLOWED_ORIGINS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),

  maxUploadBytes: int('MAX_UPLOAD_BYTES', 25 * 1024 * 1024),

  ai: {

    groqKey: providerKey('GROQ_API_KEY'),
    groqTextModel: str('GROQ_TEXT_MODEL', 'openai/gpt-oss-120b'),
    groqVisionModel: str('GROQ_VISION_MODEL', 'qwen/qwen3.8-27b'),
    groqAudioModel: str('GROQ_AUDIO_MODEL', 'whisper-large-v3-turbo'),

    timeoutMs: bounded('AI_TIMEOUT_MS', 90_000, 5_000, 600_000),

    transcribeTimeoutMs: bounded('AI_TRANSCRIBE_TIMEOUT_MS', 300_000, 5_000, 900_000),

    maxConcurrency: bounded('AI_MAX_CONCURRENCY', 3, 1, 16),

    maxTextChars: bounded('AI_MAX_TEXT_CHARS', 24_000, 1_000, 200_000),

    logCalls: bool('AI_LOG_CALLS', false),
  },

  auth: {

    firebaseWebApiKey: str('FIREBASE_WEB_API_KEY'),

    allowDeviceIdentity:
      process.env.NODE_ENV === 'production' ? false : bool('DEV_ALLOW_DEVICE_IDENTITY', true),
  },
} as const;

const authImpossible = !config.auth.firebaseWebApiKey && !config.auth.allowDeviceIdentity;

if (process.env.NODE_ENV === 'production' && authImpossible) {
  throw new Error(
    'FIREBASE_WEB_API_KEY is not set and DEV_ALLOW_DEVICE_IDENTITY is off: no request could be authenticated. ' +
      'Set FIREBASE_WEB_API_KEY on the server before starting it in production.',
  );
}

export function configGaps(): string[] {
  const gaps: string[] = [];
  if (!config.ai.groqKey) {
    gaps.push('Reading files, transcription and analysis are switched off on this server until it is set up.');
  }
  if (!config.auth.firebaseWebApiKey && !config.auth.allowDeviceIdentity) {
    gaps.push('Signing in is switched off on this server.');
  }
  return gaps;
}

export function configGapsDetail(): string[] {
  const gaps: string[] = [];
  if (!config.ai.groqKey) {
    const present = (process.env.GROQ_API_KEY ?? '').trim().length > 0;
    gaps.push(
      present
        ? 'GROQ_API_KEY is set but is not a usable key shape — reading files, transcription and analysis are all offline.'
        : 'GROQ_API_KEY is not set — reading files, transcription and analysis are all offline.',
    );
  }
  if (authImpossible) {
    gaps.push('FIREBASE_WEB_API_KEY is not set and DEV_ALLOW_DEVICE_IDENTITY is off — nothing can authenticate.');
  }
  return gaps;
}
