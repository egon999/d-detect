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
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/scratch-probe.test.ts', 'tests/**/*.scratch.test.ts'],
    globals: false,
    maxWorkers: 4,
    testTimeout: 10000,
  },
  resolve: {
    alias: [
      // Ordered longest-prefix first: '@' would otherwise swallow '@domain'.
      { find: /^@domain\//, replacement: `${resolve('./src/domain')}/` },
      { find: /^@data\//, replacement: `${resolve('./src/data')}/` },
      { find: /^@ui\//, replacement: `${resolve('./src/ui')}/` },
      { find: /^@features\//, replacement: `${resolve('./src/features')}/` },
      { find: /^@services\//, replacement: `${resolve('./src/services')}/` },
      { find: /^@\//, replacement: `${resolve('./src')}/` },
      // Bare barrel imports. Anchored with `$` so they match the exact specifier and not
      // the prefixed forms above, which have already been rewritten by this point.
      { find: /^@ui$/, replacement: resolve('./src/ui/index.ts') },
      { find: /^@services$/, replacement: resolve('./src/services/index.ts') },
      { find: /^react-native$/, replacement: 'react-native-web' },
    ],
  },
});
