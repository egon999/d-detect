import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const SERVER_ROOT = resolve(import.meta.dirname, '..');

function inChild(
  env: Record<string, string>,
  script: string,
): { ok: true; out: string } | { ok: false; out: string } {
  const args = ['--import', 'tsx', '--input-type=module', '-e', script];
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GROQ_API_KEY: '',
    FIREBASE_WEB_API_KEY: '',
    DEV_ALLOW_DEVICE_IDENTITY: '',
    NODE_ENV: '',
    DATA_DIR: '.data-env-test',
    ...env,
  };
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: SERVER_ROOT,
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (cause) {
    const failure = cause as { stdout?: string; stderr?: string };
    return { ok: false, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const LOAD = `
  const { config, configGaps, configGapsDetail } = await import('./src/env.ts');
  console.log(JSON.stringify({
    gaps: configGaps(),
    detail: configGapsDetail(),
    hasGroqKey: config.ai.groqKey.length > 0,
    allowDeviceIdentity: config.auth.allowDeviceIdentity,
    timeoutMs: config.ai.timeoutMs,
    transcribeTimeoutMs: config.ai.transcribeTimeoutMs,
    maxConcurrency: config.ai.maxConcurrency,
    maxTextChars: config.ai.maxTextChars,
  }));
`;

type Loaded = {
  gaps: string[];
  detail: string[];
  hasGroqKey: boolean;
  allowDeviceIdentity: boolean;
  timeoutMs: number;
  transcribeTimeoutMs: number;
  maxConcurrency: number;
  maxTextChars: number;
};

function load(env: Record<string, string>): Loaded {
  const result = inChild(env, LOAD);
  assert.ok(result.ok, `importing env.ts failed: ${result.out}`);
  const line = result.out.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Loaded;
}

test('a production server that could authenticate nobody refuses to start', () => {

  const result = inChild({ NODE_ENV: 'production', DEV_ALLOW_DEVICE_IDENTITY: 'true' }, LOAD);

  assert.equal(result.ok, false, 'the server started with no way to authenticate anyone');
  assert.match(result.out, /FIREBASE_WEB_API_KEY/, 'the console message must name the variable to fix');
});

test('production forces device identity off whatever the env file says', () => {
  const live = load({
    NODE_ENV: 'production',
    DEV_ALLOW_DEVICE_IDENTITY: 'true',
    FIREBASE_WEB_API_KEY: 'fixture-not-a-secret',
    GROQ_API_KEY: 'gsk_fixtureonlynotarealkey000000000000',
  });

  assert.equal(live.allowDeviceIdentity, false, 'an x-device-id header would have been accepted as an account');
  assert.deepEqual(live.gaps, [], 'with everything configured, nothing is missing for a client to know about');
});

test('outside production the dev identity path stays available, so the app works before sign-in is wired', () => {
  const live = load({ DEV_ALLOW_DEVICE_IDENTITY: 'true' });
  assert.equal(live.allowDeviceIdentity, true);
});

test('a missing model key degrades honestly: the server boots and says reading is off', () => {
  const live = load({ FIREBASE_WEB_API_KEY: 'fixture-not-a-secret' });

  assert.equal(live.hasGroqKey, false);
  assert.equal(live.gaps.length, 1, 'a server that cannot read files must say so');
  assert.match(live.gaps[0] ?? '', /switched off|not set up|until it is set up/i);
});

test('a key from the wrong vendor is reported as missing rather than passed on to be rejected', () => {

  for (const wrong of ['xai-fixtureonlynotarealkey00000', 'sk-fixtureonlynotarealkey00000', 'AIzaFixtureOnlyNotARealKey0000000000']) {
    const live = load({ GROQ_API_KEY: wrong, FIREBASE_WEB_API_KEY: 'fixture-not-a-secret' });

    assert.equal(live.hasGroqKey, false, `a ${wrong.slice(0, 4)} key was accepted as usable`);
    assert.equal(live.gaps.length, 1);
    assert.match(
      live.detail.join(' '),
      /set but is not a usable key shape/i,
      'the operator must be told the key is present and wrong, not simply absent',
    );
  }
});

test('a usable key clears the gap entirely', () => {
  const live = load({
    GROQ_API_KEY: 'gsk_fixtureonlynotarealkey000000000000',
    FIREBASE_WEB_API_KEY: 'fixture-not-a-secret',
  });

  assert.equal(live.hasGroqKey, true);
  assert.deepEqual(live.gaps, []);
  assert.deepEqual(live.detail, []);
});

test('configGaps names no variable, no vendor and no key, because /health is unauthenticated', () => {
  const live = load({
    GROQ_API_KEY: 'gsk_fixtureonlynotarealkey000000000000',
    DEV_ALLOW_DEVICE_IDENTITY: 'false',
  });
  const text = live.gaps.join(' ');

  assert.ok(text.length > 0, 'a server with no sign-in configured must report something');
  assert.ok(!/GROQ|FIREBASE|API_KEY|gsk_|env|\.env/i.test(text), `configGaps leaked a machine detail: ${text}`);
  assert.ok(!/\b(groq|grok|gemini|openai|xai|whisper|qwen)\b/i.test(text), `configGaps named a vendor: ${text}`);
  for (const sentence of live.gaps) {
    assert.match(sentence, /^[A-Z].*\.$/s, `not a finished sentence: "${sentence}"`);
  }
});

test('no key value is echoed by either gap report, even when the key is the thing that is wrong', () => {
  const planted = 'gsk_fixtureonlynotarealkey000000000000';
  const live = load({ GROQ_API_KEY: `${planted}-but-mangled` });

  const everything = `${live.gaps.join(' ')} ${live.detail.join(' ')}`;
  assert.ok(!everything.includes(planted), `a key value was echoed: ${everything}`);
  assert.ok(!/gsk_[A-Za-z0-9]/.test(everything), `a key-shaped string was echoed: ${everything}`);
});

test('the operator report does name the variable, because it goes to a console and not to a client', () => {
  const live = load({ DEV_ALLOW_DEVICE_IDENTITY: 'false' });
  assert.match(live.detail.join(' '), /GROQ_API_KEY/);
  assert.match(live.detail.join(' '), /FIREBASE_WEB_API_KEY/);
});

test('an unusable concurrency setting is clamped rather than trusted', () => {

  assert.equal(load({ AI_MAX_CONCURRENCY: '0' }).maxConcurrency, 1);
  assert.equal(load({ AI_MAX_CONCURRENCY: '-5' }).maxConcurrency, 1);
  assert.equal(load({ AI_MAX_CONCURRENCY: '99999' }).maxConcurrency, 16);
  assert.equal(load({ AI_MAX_CONCURRENCY: 'three' }).maxConcurrency, 3, 'nonsense falls back to the default');
});

test('an unusable timeout is clamped, so a stray zero cannot fail every call instantly', () => {
  assert.equal(load({ AI_TIMEOUT_MS: '1' }).timeoutMs, 5_000);
  assert.equal(load({ AI_TIMEOUT_MS: '0' }).timeoutMs, 5_000);
  assert.equal(load({ AI_MAX_TEXT_CHARS: '5' }).maxTextChars, 1_000);
});

test('audio gets its own, longer ceiling by default: a recording is not something a person can shorten', () => {
  const live = load({});
  assert.ok(
    live.transcribeTimeoutMs > live.timeoutMs,
    'an hour of audio shares a deadline with a four-word question',
  );
});

test('.env.example documents every variable this file reads, and holds no real value', async () => {
  const { readFile } = await import('node:fs/promises');
  const example = await readFile(resolve(SERVER_ROOT, '.env.example'), 'utf8');
  const source = await readFile(resolve(SERVER_ROOT, 'src/env.ts'), 'utf8');

  const read = new Set(Array.from(source.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g), (match) => match[1] as string));
  for (const name of read) {
    assert.ok(example.includes(`${name}=`), `${name} is read by env.ts but not documented in .env.example`);
  }

  const documented = Array.from(example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm));
  for (const [, name, value] of documented) {
    assert.equal(value, '', `${String(name)} carries a value in .env.example; it must record the shape only`);
  }

  assert.ok(!/gsk_[A-Za-z0-9]/.test(example), '.env.example contains something key-shaped');
  assert.ok(!/\b(sk-|xai-|AIza)[A-Za-z0-9_-]{8,}/.test(example), '.env.example contains something key-shaped');
});

test('.env.example mentions no vendor this product does not use', () => {

  const example = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(require('node:fs').readFileSync('.env.example','utf8'))"],
    { cwd: SERVER_ROOT, encoding: 'utf8' },
  );
  assert.ok(!/\b(grok|xai|x\.ai)\b/i.test(example), '.env.example names xAI or Grok');
  assert.ok(!/\bgemini\b/i.test(example), '.env.example still documents a provider that was removed');
});
