import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';

import { aiStatus } from './ai/index.ts';
import { config, configGaps } from './env.ts';
import { collectAllOrphanFiles, collectOrphanFiles, fileById, fileBytes, megabytes } from './files.ts';
import { limitRequests } from './limits.ts';

import { account as accountRoutes } from './routes/account.ts';
import { assistant } from './routes/assistant.ts';
import { attention } from './routes/attention.ts';
import { cases } from './routes/cases.ts';
import { daybook } from './routes/daybook.ts';
import { insights } from './routes/insights.ts';
import { MAX_MEETING_AUDIO_BYTES, meetings, recoverStaleMeetings } from './routes/meetings.ts';
import { search } from './routes/search.ts';
import { tasks } from './routes/tasks.ts';
import { retireOrphaned } from './signals/index.ts';
import { accountOf, requireAccount } from './auth.ts';
import type { Account } from './auth.ts';

type Variables = { account: Account };

recoverStaleMeetings();
collectAllOrphanFiles();

function loggablePath(url: string): string {
  const parsed = new URL(url);
  const names = [...new Set([...parsed.searchParams.keys()])];
  if (names.length === 0) return parsed.pathname;
  return `${parsed.pathname}?${names.map((name) => `${name}=·`).join('&')}`;
}

const app = new Hono<{ Variables: Variables }>();

app.use('*', async (context, next) => {
  const startedAt = Date.now();
  await next();
  const path = loggablePath(context.req.url);
  console.log(`${context.req.method} ${path} ${context.res.status} ${Date.now() - startedAt}ms`);
});
app.use('*', async (context, next) => {
  await next();
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Referrer-Policy', 'no-referrer');
  context.header('Cache-Control', 'no-store');
});

app.use('/api/*', bodyLimit({
  maxSize: Math.max(config.maxUploadBytes, MAX_MEETING_AUDIO_BYTES) + 128 * 1024,
  onError: (context) => context.json(
    { error: `That file is too large. The limit is ${megabytes(declaredLimitFor(context.req.method, context.req.path))} MB.` },
    413,
  ),
}));

const devOrigins = Array.from({ length: 20 }, (_, index) => 8081 + index).flatMap((port) => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
]);

app.use(
  '/health',
  cors({
    origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : devOrigins,
    allowMethods: ['GET', 'OPTIONS'],
    maxAge: 600,
  }),
);

app.use(
  '/api/*',
  cors({
    origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : devOrigins,
    allowHeaders: ['authorization', 'content-type', 'x-device-id'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }),
);

app.get('/health', (context) => {
  const ai = aiStatus();
  return context.json({
    ok: true,
    now: Date.now(),
    ai: {
      ready: ai.ready,
      canReadDocuments: ai.chat.length > 0,
      canReadImages: ai.vision.length > 0,
      canTranscribe: ai.transcription.length > 0,
    },
    gaps: configGaps(),
  });
});

function declaredLimitFor(method: string, path: string): number {
  const startingAMeeting = method === 'POST' && (path === '/api/meetings' || path === '/api/meetings/');
  return startingAMeeting ? MAX_MEETING_AUDIO_BYTES : config.maxUploadBytes;
}

app.use('/api/*', async (context, next) => {
  const declared = Number.parseInt(context.req.header('content-length') ?? '', 10);
  const limit = declaredLimitFor(context.req.method, context.req.path);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HTTPException(413, {
      message: `That file is too large. The limit is ${megabytes(limit)} MB.`,
    });
  }
  await next();
});

app.use('/api/*', requireAccount);

app.use('/api/*', limitRequests);

app.use('/api/*', async (context, next) => {
  await next();
  if (context.req.method !== 'DELETE' || context.res.status >= 300) return;
  const account = context.get('account');
  if (!account) return;
  collectOrphanFiles(account.id);
  retireOrphaned(account.id);
});

app.get('/api/files/:id', (context) => {
  const account = accountOf(context);
  const file = fileById(context.req.param('id'), account.id);
  if (!file) throw new HTTPException(404, { message: 'That file does not exist.' });

  const bytes = fileBytes(file, account.id);
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  return context.newResponse(body, 200, {
    'content-type': file.mime,
    'content-length': String(file.bytes),
    'cache-control': 'private, no-store',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
    'content-security-policy': "default-src 'none'; sandbox",
  });
});

app.route('/api/daybook', daybook);
app.route('/api/daybook', assistant);
app.route('/api/meetings', meetings);
app.route('/api/insights', insights);
app.route('/api/tasks', tasks);
app.route('/api/attention', attention);
app.route('/api/cases', cases);
app.route('/api/search', search);
app.route('/api/me', accountRoutes);

app.onError((error, context) => {
  if (error instanceof HTTPException) {
    return context.json({ error: error.message }, error.status);
  }
  console.error('[detact]', error);
  return context.json({ error: 'Something went wrong on our side. Try again.' }, 500);
});

app.notFound((context) => context.json({ error: 'This part of the app is out of date. Close and open it again.' }, 404));

export { app };
