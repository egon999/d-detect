import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Domain logic is deliberately free of React Native and Firebase imports, so the
 * reasoning engine can be tested in a plain Node environment with no native mocks.
 */

// `fileURLToPath`, not `URL.pathname`: on Windows the latter yields "/E:/Project%20Evid/..."
// — a leading slash and percent-encoded spaces — and the aliases silently fail to resolve.
const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  /**
   * `__DEV__` is a React Native runtime global. Metro defines it in the app; Node does not.
   *
   * Without it, any test that reaches a lazily-imported Expo native module dies inside
   * `expo-modules-core` with `ReferenceError: __DEV__ is not defined` — and because that
   * throw happens during Vite's deferred evaluation of the module namespace, it does not
   * surface as a rejection the caller's `try/catch` can see. The awaiting promise simply
   * never settles, so the test times out after 5s with no stack pointing at the cause.
   *
   * That cost four separate "no key configured" tests, all of which were asserting the
   * correct thing about code that was behaving correctly.
   *
   * Defined as `false` rather than `true`: tests should exercise the production branch, and
   * a `true` here switches on development-only logging inside Expo's own modules.
   */
  define: { __DEV__: 'false' },
  /**
   * Vite reads `.env` from the project root and copies every key into `import.meta.env`,
   * which is available to any test at runtime. Pointed at that root, this repo's `.env` —
   * which holds the real Firebase project identifiers and the Google web client id — would
   * be handed to every test, and so would any `.env.local` a developer had added for
   * themselves. The values are also spliced into source by `define`, so a test that read one
   * would pass on this machine and fail in CI with a different `.env`, or worse, pass having
   * quietly asserted against a live credential.
   *
   * `envDir` is redirected to an empty directory so no `.env` file is loaded at all. A test
   * that needs a configuration value sets it itself, which is the only way the value is
   * visible in the test's own text.
   */
  envDir: 'tests/helpers/no-env',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * Any filename containing "scratch" is a throwaway probe — a file somebody writes to find out
     * what a function actually returns, with a `console.log` and an assertion that cannot fail.
     * Those are useful while they are being written and worthless afterwards, and the harm they do
     * is to the run: a probe left behind is a test that always passes, so it inflates the count and
     * teaches a reader that a green suite means less than it says. One is in the tree right now
     * (`tests/scratch-probe.test.ts`, whose only assertion is `toBeGreaterThan(-1)`).
     *
     * Matched on the whole name rather than on a `.scratch.test.ts` suffix, because the convention
     * only works if it catches what people actually type: the suffix was agreed and the file that
     * appeared was called `scratch-probe.test.ts`.
     */
    exclude: [...configDefaults.exclude, 'tests/**/*scratch*.test.ts'],
    globals: false,
    maxWorkers: 4,
    testTimeout: 20000,
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: [
      // Ordered longest-prefix first: '@' would otherwise swallow '@domain'.
      { find: /^@domain\//, replacement: `${resolve('./src/domain')}/` },
      { find: /^@data\//, replacement: `${resolve('./src/data')}/` },
      { find: /^@ui\//, replacement: `${resolve('./src/ui')}/` },
      { find: /^@features\//, replacement: `${resolve('./src/features')}/` },
      { find: /^@services\//, replacement: `${resolve('./src/services')}/` },
      { find: /^@api\//, replacement: `${resolve('./src/api')}/` },
      { find: /^@\//, replacement: `${resolve('./src')}/` },
      // Bare barrel imports. Anchored with `$` so they match the exact specifier and not
      // the prefixed forms above, which have already been rewritten by this point.
      { find: /^@ui$/, replacement: resolve('./src/ui/index.ts') },
      { find: /^@services$/, replacement: resolve('./src/services/index.ts') },
      { find: /^@api$/, replacement: resolve('./src/api/index.ts') },
      { find: /^react-native$/, replacement: 'react-native-web' },
    ],
  },
});
