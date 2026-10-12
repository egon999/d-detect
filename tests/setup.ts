/**
 * Runs before every test file. Two jobs, both about stopping a test from depending on
 * something outside the repository.
 *
 * ## No test in this suite may make a network call
 *
 * The app's domain and API layers are pure, and every assertion in `tests/` is written against
 * functions that take their inputs as arguments. Nothing here needs a socket, so a socket
 * opening means something has gone wrong — a fixture that fell through to a live base URL, a
 * lazily imported module that reached for a real endpoint, or a new test that quietly decided
 * to hit a dev server. On a machine with a server on 127.0.0.1:8787 that would pass, on a
 * machine without one it would fail with a connection error that reads like a product bug,
 * and against a real endpoint it would spend a quota. Replacing `fetch` with a refusal makes
 * the failure name itself.
 *
 * A test that genuinely needs to exercise a fetch call stubs `globalThis.fetch` itself, which
 * is the point — the substitution is then in the test's own text where a reader can see it.
 * Nothing in this suite does that today; this file is what will make the first one obvious.
 *
 * ## The real environment must not be reachable either
 *
 * `envDir` in `vitest.config.mts` stops Vite loading a `.env`, but the ambient process
 * environment is still visible — `import.meta.env` in a Vite-processed test exposes the whole
 * of it, which is how a real `GROQ_API_KEY` or `OPENAI_API_KEY` sitting in a developer's shell
 * would become readable from an assertion. Vite's own `.env` handling is the documented path
 * for that, so the guard is narrow: assert the keys this project actually uses are absent, so
 * that a config change which starts loading them again fails here rather than in CI.
 */

const NETWORK_REFUSED =
  'A test in tests/ reached for the network. Every function under test takes its inputs as ' +
  'arguments, so nothing here needs a socket. If this test is genuinely about a fetch call, ' +
  'stub globalThis.fetch inside the test so the substitution is visible where it is read. ' +
  'Otherwise the code under test has grown an import that talks to something.';

/** Keys that belong to the operator's machine and must never reach a test through `.env`. */
const LOCAL_CONFIG_KEYS = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_API_BASE_URL',
] as const;

/**
 * The ambient environment, as Vite exposes it.
 *
 * `import.meta.env` is Vite's, not the runtime's, and its type lives in `vite/client` — which
 * this project deliberately does not add to `tsconfig.json`, because that file types the Expo
 * app and pulling Vite's globals into it would let app code reference things no Metro bundle
 * has. So the shape is asserted here, at the one place that reads it, rather than everywhere.
 * `?? {}` because a runner that does not define it at all must leave this guard passing, not
 * throw on the way in: the guard is here to catch a config change that re-exposes real keys.
 */
const viteEnv = ((import.meta as unknown as { env?: Record<string, unknown> }).env ?? {});

for (const key of LOCAL_CONFIG_KEYS) {
  const leaked = viteEnv[key];
  if (leaked !== undefined) {
    throw new Error(
      `${key} is visible to the test suite, which means a .env file is being loaded again. ` +
        'Check `envDir` in vitest.config.mts still points at tests/helpers/no-env.',
    );
  }
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`${NETWORK_REFUSED}\n  Requested: ${String(input)}`);
}) as typeof globalThis.fetch;

if (!(globalThis as any).expo) {
  class MockEventEmitter {
    addListener() {
      return { remove: () => {} };
    }
    removeListener() {}
    emit() {}
  }
  (globalThis as any).expo = {
    EventEmitter: MockEventEmitter,
    modules: {},
  };
}
