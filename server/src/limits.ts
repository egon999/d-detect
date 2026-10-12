import { createMiddleware } from 'hono/factory';

import { accountOf, type Account } from './auth.ts';
import { db } from './db.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_counters (
    user_id    TEXT    NOT NULL,
    surface    TEXT    NOT NULL,
    window_key TEXT    NOT NULL,
    spent      INTEGER NOT NULL,
    resets_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, surface, window_key)
  );
  CREATE INDEX IF NOT EXISTS usage_counters_expiry ON usage_counters(user_id, resets_at);
`);

const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Span = 'hour' | 'day';

function windowOf(span: Span, now: number): { key: string; resetsAt: number } {
  const width = span === 'hour' ? HOUR_MS : DAY_MS;
  const startedAt = Math.floor((now + INDIA_OFFSET_MS) / width) * width;
  return { key: `${span}:${startedAt}`, resetsAt: startedAt + width - INDIA_OFFSET_MS };
}

function startOfIndianDay(now: number): number {
  return windowOf('day', now).resetsAt - DAY_MS;
}

function clockInIndia(at: number): string {
  const shifted = new Date(at + INDIA_OFFSET_MS);
  const hours = shifted.getUTCHours();
  const minutes = shifted.getUTCMinutes();
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  const suffix = hours < 12 ? 'am' : 'pm';
  return minutes === 0 ? `${hour} ${suffix}` : `${hour}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function comeBack(span: Span, resetsAt: number): string {
  return span === 'hour' ? `after ${clockInIndia(resetsAt)}` : 'tomorrow';
}

function recently(span: Span): string {
  return span === 'hour' ? 'in the last hour' : 'today';
}

function at(method: string, template: string): Endpoint {
  const pattern = new RegExp(`^${template.replace(/:[A-Za-z]+/g, '[^/]+')}/?$`);
  return { method, template, matches: (verb, path) => verb === method && pattern.test(path) };
}

type Endpoint = {
  method: string;
  template: string;
  matches: (method: string, path: string) => boolean;
};

type Ceiling = { span: Span; most: number; why: string };

type Surface = {

  key: string;
  endpoints: Endpoint[];
  ceilings: Ceiling[];

  losesAnUpload: boolean;
  sentence: (span: Span, resetsAt: number) => string;
};

const SURFACES: Surface[] = [
  {

    key: 'capture',
    endpoints: [
      at('POST', '/api/daybook/capture'),
      at('POST', '/api/daybook/records'),
      at('POST', '/api/daybook/records/:id/retry'),
      at('POST', '/api/daybook/records/:id/answer'),
      at('POST', '/api/cases/:id/items'),
      at('POST', '/api/cases/:id/items/:itemId/retry'),
    ],
    ceilings: [
      {
        span: 'hour',
        most: 60,

        why: 'above the busiest plausible human session, below any loop',
      },
      {
        span: 'day',
        most: 300,

        why: 'five hours at the hourly pace; the figure that protects the shared key',
      },
    ],
    losesAnUpload: true,
    sentence: (span, resetsAt) =>
      `You've saved a lot in the ${span === 'hour' ? 'last hour' : 'day so far'}. This one has not been saved — `
      + `add it again ${comeBack(span, resetsAt)}.`,
  },
  {
    key: 'ask',
    endpoints: [at('POST', '/api/daybook/ask')],
    ceilings: [
      {
        span: 'hour',
        most: 20,

        why: 'one every three minutes, faster than an answer can be read',
      },
    ],
    losesAnUpload: false,
    sentence: (span, resetsAt) =>
      `You've asked a lot of questions ${recently(span)}. Ask again ${comeBack(span, resetsAt)}.`,
  },
  {
    key: 'analyze',
    endpoints: [at('POST', '/api/cases/:id/analyze')],
    ceilings: [
      {
        span: 'hour',
        most: 10,

        why: 'the most expensive call here, and re-running it unchanged answers the same',
      },
    ],
    losesAnUpload: false,
    sentence: (span, resetsAt) =>
      `This case has been looked at a lot ${recently(span)}. Try again ${comeBack(span, resetsAt)}.`,
  },
  {
    key: 'advice',
    endpoints: [at('POST', '/api/insights/advice')],
    ceilings: [
      {
        span: 'hour',
        most: 10,

        why: 'a guess: the figures it reads barely move inside an hour',
      },
    ],
    losesAnUpload: false,
    sentence: (span, resetsAt) =>
      `Advice has been written a few times ${recently(span)}. Ask for it again ${comeBack(span, resetsAt)}.`,
  },
  {
    key: 'meeting',
    endpoints: [at('POST', '/api/meetings'), at('POST', '/api/meetings/:id/retry')],
    ceilings: [
      {
        span: 'hour',
        most: 5,

        why: 'more recordings than an hour can contain',
      },
    ],
    losesAnUpload: true,
    sentence: (span, resetsAt) =>
      `You've added a lot of recordings ${recently(span)}. This one has not been saved — `
      + `add it again ${comeBack(span, resetsAt)}.`,
  },
  {
    key: 'look',
    endpoints: [at('POST', '/api/attention/refresh')],
    ceilings: [
      {
        span: 'hour',
        most: 6,

        why: 'a guess: one press can cost a call per record, and nothing new appears faster',
      },
    ],
    losesAnUpload: false,
    sentence: (span, resetsAt) =>
      `Your bills were just looked through. Try again ${comeBack(span, resetsAt)}.`,
  },
];

const AUDIO_MINUTES_A_DAY = 60;

function audioMinutesToday(userId: string, now: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(duration_ms), 0) AS ms FROM meetings WHERE user_id = ? AND created_at >= ?`,
    )
    .get(userId, startOfIndianDay(now)) as { ms: number };
  return row.ms / 60_000;
}

export const MAX_ACCOUNT_BYTES = 2 * 1024 * 1024 * 1024;

export function storedBytes(userId: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM files WHERE user_id = ?')
    .get(userId) as { bytes: number };
  return row.bytes;
}

export function wouldOverrunStorage(userId: string, extra: number): boolean {
  return storedBytes(userId) + extra > MAX_ACCOUNT_BYTES;
}

export const NO_ROOM_LEFT =
  'There is no room left in your account for new files. Delete a recording or a bill you no '
  + 'longer need, and save this again.';

type Reservation = { surface: Surface; windowKeys: string[] };
type Refusal = { sentence: string; retryAt: number };

function reserve(surface: Surface, userId: string, now: number): Reservation | Refusal {
  db.prepare('DELETE FROM usage_counters WHERE user_id = ? AND resets_at <= ?').run(userId, now);

  const taken: string[] = [];
  for (const ceiling of surface.ceilings) {
    const { key, resetsAt } = windowOf(ceiling.span, now);
    const windowKey = `${surface.key}:${key}`;
    const result = db
      .prepare(
        `INSERT INTO usage_counters (user_id, surface, window_key, spent, resets_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(user_id, surface, window_key)
         DO UPDATE SET spent = spent + 1 WHERE spent < ?`,
      )
      .run(userId, surface.key, windowKey, resetsAt, ceiling.most);

    if (result.changes === 0) {

      release({ surface, windowKeys: taken }, userId);
      return { sentence: surface.sentence(ceiling.span, resetsAt), retryAt: resetsAt };
    }
    taken.push(windowKey);
  }

  return { surface, windowKeys: taken };
}

function release(reservation: Reservation, userId: string): void {
  const statement = db.prepare(
    `UPDATE usage_counters SET spent = spent - 1
     WHERE user_id = ? AND surface = ? AND window_key = ? AND spent > 0`,
  );
  for (const windowKey of reservation.windowKeys) {
    statement.run(userId, reservation.surface.key, windowKey);
  }
}

function isRefusal(value: Reservation | Refusal): value is Refusal {
  return 'sentence' in value;
}

function surfaceFor(method: string, path: string): Surface | null {
  for (const surface of SURFACES) {
    if (surface.endpoints.some((endpoint) => endpoint.matches(method, path))) return surface;
  }
  return null;
}

const REFUNDABLE = (status: number): boolean => status >= 400 && status < 500;

function meteringIsOff(): boolean {
  return process.env.DETACT_RATE_LIMITS === 'off' && process.env.NODE_TEST_CONTEXT !== undefined;
}

export const limitRequests = createMiddleware<{ Variables: { account: Account } }>(
  async (context, next) => {
    if (meteringIsOff()) return next();

    const surface = surfaceFor(context.req.method, context.req.path);
    if (!surface) return next();

    const account: Account = accountOf(context);
    const now = Date.now();

    if (surface.key === 'meeting' && audioMinutesToday(account.id, now) >= AUDIO_MINUTES_A_DAY) {
      const resetsAt = startOfIndianDay(now) + DAY_MS;
      return context.json(
        {
          error:
            'You\'ve added more than an hour of recordings today. This one has not been saved — '
            + `add it again ${comeBack('day', resetsAt)}.`,
          retryAt: resetsAt,
        },
        429,
        { 'retry-after': String(Math.ceil((resetsAt - now) / 1000)) },
      );
    }

    const outcome = reserve(surface, account.id, now);
    if (isRefusal(outcome)) {
      return context.json({ error: outcome.sentence, retryAt: outcome.retryAt }, 429, {
        'retry-after': String(Math.max(1, Math.ceil((outcome.retryAt - now) / 1000))),
      });
    }

    await next();
    if (REFUNDABLE(context.res.status)) release(outcome, account.id);
  },
);

export function meteredEndpoints(): Array<{ method: string; template: string; key: string }> {
  return SURFACES.flatMap((surface) =>
    surface.endpoints.map((endpoint) => ({
      method: endpoint.method,
      template: endpoint.template,
      key: surface.key,
    })),
  );
}
