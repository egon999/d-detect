import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const directory = mkdtempSync(join(tmpdir(), 'detact-limits-'));
process.env.DATA_DIR = directory;
process.env.GROQ_API_KEY = 'test-fixture-only';
process.env.FIREBASE_WEB_API_KEY = '';

const { db, ensureUser } = await import('./db.ts');
const { limitRequests, meteredEndpoints, storedBytes, wouldOverrunStorage, MAX_ACCOUNT_BYTES } =
  await import('./limits.ts');
const { storeUpload, UploadRefused } = await import('./files.ts');

const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';

const app = new Hono<{ Variables: { account: { id: string; email: null; name: null } } }>();

app.use('/api/*', async (context, next) => {
  const owner = context.req.header('x-test-owner');
  if (owner) context.set('account', { id: owner, email: null, name: null });
  await next();
});
app.use('/api/*', limitRequests);

let behaviour: 'ok' | 'refuses' | 'breaks' = 'ok';

for (const { method, template } of meteredEndpoints()) {
  const path = template.replace(/:[A-Za-z]+/g, 'x');
  app.on(method, path, (context) => {
    if (behaviour === 'refuses') throw new HTTPException(400, { message: 'Give the record a title.' });
    if (behaviour === 'breaks') throw new Error('a provider answered badly');
    return context.json({ ok: true });
  });
}

app.patch('/api/tasks/:id', (context) => context.json({ ok: true }));
app.onError((error, context) => {
  if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
  return context.json({ error: 'Something went wrong on our side. Try again.' }, 500);
});

type Answer = { status: number; body: Record<string, unknown>; retryAfter: string | null };

async function hit(path: string, owner: string, method = 'POST'): Promise<Answer> {
  const response = await app.request(path, { method, headers: { 'x-test-owner': owner } });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    retryAfter: response.headers.get('retry-after'),
  };
}

async function untilRefused(path: string, owner: string, give_up = 400): Promise<Answer & { allowed: number }> {
  for (let allowed = 0; allowed < give_up; allowed += 1) {
    const answer = await hit(path, owner);
    if (answer.status === 429) return { ...answer, allowed };
  }
  throw new Error(`${path} was never refused in ${give_up} attempts`);
}

const SELLING = /\b(limit|limits|limited|quota|rate|throttl\w*|tier|plan|plans|upgrade|premium|free\b.*\bplan)\b/i;

const MACHINE = /gsk_|\b(groq|openai|gemini|whisper|sqlite|errno|E[A-Z]{3,})\b|[A-Za-z]:[\\/]|\bat \w+ \(/;

beforeEach(() => {
  behaviour = 'ok';
  db.exec('DELETE FROM usage_counters; DELETE FROM meetings; DELETE FROM files; DELETE FROM users;');
  ensureUser(OWNER_A, null, null);
  ensureUser(OWNER_B, null, null);
});

after(() => {
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-limits-'));
  rmSync(directory, { recursive: true, force: true });
});

describe('one account cannot spend the shared key dry', () => {

  const SPENDS_THE_KEY: Array<[string, string]> = [
    ['POST', '/api/daybook/capture'],
    ['POST', '/api/daybook/records'],
    ['POST', '/api/daybook/records/:id/retry'],
    ['POST', '/api/daybook/records/:id/answer'],
    ['POST', '/api/daybook/ask'],
    ['POST', '/api/cases/:id/items'],
    ['POST', '/api/cases/:id/items/:itemId/retry'],
    ['POST', '/api/cases/:id/analyze'],
    ['POST', '/api/insights/advice'],
    ['POST', '/api/meetings'],
    ['POST', '/api/meetings/:id/retry'],
    ['POST', '/api/attention/refresh'],
  ];

  test('every endpoint that spends the shared key has a ceiling', () => {
    const metered = new Set(meteredEndpoints().map(({ method, template }) => `${method} ${template}`));
    const unmetered = SPENDS_THE_KEY.filter(([method, path]) => !metered.has(`${method} ${path}`));
    assert.deepEqual(
      unmetered.map(([method, path]) => `${method} ${path}`),
      [],
      'these endpoints call a model with nothing stopping a loop',
    );
  });

  test('a capture loop is stopped at sixty in an hour', async () => {
    const refused = await untilRefused('/api/daybook/capture', OWNER_A);
    assert.equal(refused.allowed, 60, `${refused.allowed} captures went through before the gate closed`);
    assert.equal(refused.status, 429);
  });

  test('the ceiling covers every way of spending the same thing, not one route', async () => {

    for (let i = 0; i < 59; i += 1) assert.equal((await hit('/api/daybook/capture', OWNER_A)).status, 200);
    assert.equal((await hit('/api/daybook/records/x/retry', OWNER_A)).status, 200);
    assert.equal((await hit('/api/cases/x/items', OWNER_A)).status, 429);
  });

  test('each of the other ceilings is reachable at the figure it claims', async () => {
    const expected: Array<[string, number]> = [
      ['/api/daybook/ask', 20],
      ['/api/cases/x/analyze', 10],
      ['/api/insights/advice', 10],
      ['/api/meetings', 5],
      ['/api/attention/refresh', 6],
    ];
    for (const [path, most] of expected) {
      const refused = await untilRefused(path, OWNER_A);
      assert.equal(refused.allowed, most, `${path} allowed ${refused.allowed}, not ${most}`);
    }
  });

  test('an unmetered write is not touched', async () => {
    for (let i = 0; i < 80; i += 1) {
      assert.equal((await hit('/api/tasks/x', OWNER_A, 'PATCH')).status, 200);
    }
  });

  test('one account reaching a ceiling leaves everybody else alone', async () => {
    await untilRefused('/api/daybook/ask', OWNER_A);
    assert.equal((await hit('/api/daybook/ask', OWNER_A)).status, 429);
    assert.equal((await hit('/api/daybook/ask', OWNER_B)).status, 200, 'B paid for A');
  });

  test('a restart does not hand out a fresh allowance', async () => {
    for (let i = 0; i < 20; i += 1) assert.equal((await hit('/api/daybook/ask', OWNER_A)).status, 200);
    assert.equal((await hit('/api/daybook/ask', OWNER_A)).status, 429);

    const spent = db
      .prepare(`SELECT spent FROM usage_counters WHERE user_id = ? AND surface = 'ask'`)
      .get(OWNER_A) as { spent: number } | undefined;
    assert.equal(spent?.spent, 20, 'the tally is not on disk, so a restart would clear it');
  });
});

describe('a refusal is a sentence about coming back', () => {
  test('it names a clock time and never sells anything', async () => {
    const refused = await untilRefused('/api/daybook/ask', OWNER_A);
    const sentence = String(refused.body.error ?? '');

    assert.match(sentence, /after \d{1,2}(:\d{2})? (am|pm)\.$/, `no clock time in: ${sentence}`);
    assert.doesNotMatch(sentence, SELLING, `a ceiling read like a sales pitch: ${sentence}`);
    assert.doesNotMatch(sentence, MACHINE, `a ceiling leaked something internal: ${sentence}`);
    assert.doesNotMatch(sentence, /\d+\s+(left|remaining|of\s+\d+)/i, `a count was offered: ${sentence}`);
  });

  test('every ceiling in the table refuses in the same voice', async () => {
    for (const path of [
      '/api/daybook/capture',
      '/api/daybook/ask',
      '/api/cases/x/analyze',
      '/api/insights/advice',
      '/api/meetings',
      '/api/attention/refresh',
    ]) {
      const refused = await untilRefused(path, OWNER_A);
      const sentence = String(refused.body.error ?? '');
      assert.ok(sentence.length > 0, `${path} refused with no sentence`);
      assert.match(sentence, /[.!]$/, `${path} did not finish its sentence: ${sentence}`);
      assert.doesNotMatch(sentence, SELLING, `${path} read like a sales pitch: ${sentence}`);
      assert.doesNotMatch(sentence, MACHINE, `${path} leaked something internal: ${sentence}`);
      assert.match(sentence, /after \d|tomorrow/, `${path} did not say when to come back: ${sentence}`);
    }
  });

  test('a refusal that drops a file says so', async () => {
    for (const path of ['/api/daybook/capture', '/api/meetings']) {
      const refused = await untilRefused(path, OWNER_A);
      assert.match(
        String(refused.body.error ?? ''),
        /has not been saved/,
        `${path} let the person think their file was kept`,
      );
    }
  });

  test('it carries the machine instant too, so a client can use the person\'s own clock', async () => {
    const refused = await untilRefused('/api/daybook/ask', OWNER_A);
    const retryAt = refused.body.retryAt;
    assert.equal(typeof retryAt, 'number');
    assert.ok((retryAt as number) > Date.now(), 'the time to come back is in the past');
    assert.ok((retryAt as number) <= Date.now() + 60 * 60 * 1000, 'an hourly window reset more than an hour out');
    assert.ok(Number(refused.retryAfter) > 0, 'no Retry-After for a client that honours it');
  });
});

describe('a ceiling does not charge for work nobody did', () => {

  test('a 4xx is handed back', async () => {
    behaviour = 'refuses';
    for (let i = 0; i < 200; i += 1) {
      assert.equal((await hit('/api/daybook/capture', OWNER_A)).status, 400);
    }
    behaviour = 'ok';
    assert.equal((await hit('/api/daybook/capture', OWNER_A)).status, 200, 'refusals ate the allowance');
  });

  test('a 500 is not handed back', async () => {
    behaviour = 'breaks';
    for (let i = 0; i < 60; i += 1) {
      assert.equal((await hit('/api/daybook/capture', OWNER_A)).status, 500);
    }
    behaviour = 'ok';
    assert.equal((await hit('/api/daybook/capture', OWNER_A)).status, 429, 'a broken call was free');
  });

  test('being refused does not itself spend anything', async () => {
    await untilRefused('/api/daybook/ask', OWNER_A);
    for (let i = 0; i < 50; i += 1) assert.equal((await hit('/api/daybook/ask', OWNER_A)).status, 429);
    const spent = db
      .prepare(`SELECT spent FROM usage_counters WHERE user_id = ? AND surface = 'ask'`)
      .get(OWNER_A) as { spent: number };
    assert.equal(spent.spent, 20, 'a refused request was counted as a spent one');
  });
});

describe('recorded audio is measured, not counted', () => {
  function aMeeting(owner: string, minutes: number, createdAt = Date.now()): void {
    const id = `mtg_${Math.random().toString(36).slice(2, 12)}`;
    db.prepare(
      `INSERT INTO meetings (id, user_id, title, duration_ms, status, started_at, created_at, updated_at)
       VALUES (?, ?, 'A meeting', ?, 'transcribed', ?, ?, ?)`,
    ).run(id, owner, minutes * 60_000, createdAt, createdAt, createdAt);
  }

  test('an hour of recordings today closes the door, whatever the count was', async () => {
    aMeeting(OWNER_A, 61);
    const refused = await hit('/api/meetings', OWNER_A);
    assert.equal(refused.status, 429, 'an hour of audio did not register');
    assert.match(String(refused.body.error ?? ''), /more than an hour of recordings today/);
    assert.match(String(refused.body.error ?? ''), /tomorrow\.$/, 'a daily window should say tomorrow');
    assert.match(String(refused.body.error ?? ''), /has not been saved/);
  });

  test('under an hour of recordings is still welcome', async () => {
    aMeeting(OWNER_A, 30);
    aMeeting(OWNER_A, 20);
    assert.equal((await hit('/api/meetings', OWNER_A)).status, 200);
  });

  test('yesterday\'s recordings do not count against today', async () => {
    aMeeting(OWNER_A, 300, Date.now() - 48 * 60 * 60 * 1000);
    assert.equal((await hit('/api/meetings', OWNER_A)).status, 200, 'an old meeting was charged to today');
  });

  test('one account\'s recordings are not charged to another', async () => {
    aMeeting(OWNER_B, 300);
    assert.equal((await hit('/api/meetings', OWNER_A)).status, 200);
  });
});

describe('stored files have a ceiling, and it is the figure the person is shown', () => {

  function png(size: number, seed = 1): Uint8Array {
    const bytes = new Uint8Array(size);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    bytes[size - 1] = seed % 256;
    return bytes;
  }

  test('the cap counts exactly what the account screen counts', () => {
    storeUpload(OWNER_A, png(4096), 'image/png', 'bill.png');
    storeUpload(OWNER_A, png(8192), 'image/png', 'other.png');

    const onTheScreen = (
      db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM files WHERE user_id = ?').get(OWNER_A) as {
        bytes: number;
      }
    ).bytes;

    assert.equal(storedBytes(OWNER_A), onTheScreen);
    assert.equal(onTheScreen, 4096 + 8192);
  });

  test('a file that would not fit is refused before anything is written', () => {

    db.prepare(
      `INSERT INTO files (id, user_id, sha256, mime, bytes, original_name, stored_path, created_at)
       VALUES ('file_big', ?, 'f', 'image/png', ?, 'big.png', 'nowhere', ?)`,
    ).run(OWNER_A, MAX_ACCOUNT_BYTES, Date.now());

    assert.ok(wouldOverrunStorage(OWNER_A, 1));
    assert.throws(
      () => storeUpload(OWNER_A, png(4096), 'image/png', 'bill.png'),
      (error: unknown) => {
        assert.ok(error instanceof UploadRefused, 'the refusal was not the showable kind');
        assert.equal(error.reason, 'no_room');
        assert.doesNotMatch(error.message, SELLING, `storage refusal sold something: ${error.message}`);
        assert.doesNotMatch(error.message, MACHINE, `storage refusal leaked: ${error.message}`);

        assert.match(error.message, /[Dd]elete/);
        return true;
      },
    );

    const written = db.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id = ?').get(OWNER_A) as { n: number };
    assert.equal(written.n, 1, 'the refused upload still wrote a row');
  });

  test('a full account can still re-upload bytes it already holds', () => {
    const first = storeUpload(OWNER_A, png(4096), 'image/png', 'bill.png');

    db.prepare(
      `INSERT INTO files (id, user_id, sha256, mime, bytes, original_name, stored_path, created_at)
       VALUES ('file_big', ?, 'f', 'image/png', ?, 'big.png', 'nowhere', ?)`,
    ).run(OWNER_A, MAX_ACCOUNT_BYTES, Date.now());

    const again = storeUpload(OWNER_A, png(4096), 'image/png', 'bill.png');
    assert.equal(again.id, first.id, 'a re-upload of stored bytes was refused for want of room');
  });

  test('one account filling up does not refuse another', () => {
    db.prepare(
      `INSERT INTO files (id, user_id, sha256, mime, bytes, original_name, stored_path, created_at)
       VALUES ('file_big', ?, 'f', 'image/png', ?, 'big.png', 'nowhere', ?)`,
    ).run(OWNER_A, MAX_ACCOUNT_BYTES, Date.now());

    assert.ok(wouldOverrunStorage(OWNER_A, 1));
    assert.ok(!wouldOverrunStorage(OWNER_B, 4096));
    assert.doesNotThrow(() => storeUpload(OWNER_B, png(4096), 'image/png', 'bill.png'));
  });
});

describe('the gate is mounted, and can only be stood down by a test runner', () => {

  test('the real server runs every API request through the gate, below the thing that names the account', async () => {
    const { app: server } = await import('./app.ts');
    const { requireAccount } = await import('./auth.ts');
    const mounted = (server as unknown as {
      routes: Array<{ path: string; method: string; handler: unknown }>;
    }).routes;

    const gate = mounted.findIndex((route) => route.handler === limitRequests);
    const identity = mounted.findIndex((route) => route.handler === requireAccount);

    assert.notEqual(gate, -1, 'app.ts does not mount limitRequests — the shared key is unmetered');
    assert.notEqual(identity, -1, 'app.ts does not mount requireAccount');
    assert.equal(mounted[gate]?.path, '/api/*', 'the gate is mounted somewhere other than /api/*');

    assert.ok(identity < gate, 'the gate runs before the account is known, so it can only throw');
  });

  test('the stand-down flag alone does not disarm a server', async () => {
    const marker = process.env.NODE_TEST_CONTEXT;
    process.env.DETACT_RATE_LIMITS = 'off';
    delete process.env.NODE_TEST_CONTEXT;
    try {
      const refused = await untilRefused('/api/daybook/ask', OWNER_A);
      assert.equal(refused.status, 429, 'a flag in the environment switched off a real ceiling');
    } finally {
      delete process.env.DETACT_RATE_LIMITS;
      if (marker !== undefined) process.env.NODE_TEST_CONTEXT = marker;
    }
  });

  test('a test runner that asks to be unmetered is unmetered', async () => {
    assert.ok(process.env.NODE_TEST_CONTEXT !== undefined, 'this suite is not under node --test');
    process.env.DETACT_RATE_LIMITS = 'off';
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const answer = await hit('/api/daybook/ask', OWNER_B);
        assert.equal(answer.status, 200, `refused on attempt ${attempt + 1} with the gate stood down`);
      }
    } finally {
      delete process.env.DETACT_RATE_LIMITS;
    }
  });
});
