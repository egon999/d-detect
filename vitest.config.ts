import { defineConfig } from 'vitest/config';

/**
 * Domain logic is deliberately free of React Native and Firebase imports, so the
 * reasoning engine can be tested in a plain Node environment with no native mocks.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      '@domain': new URL('./src/domain', import.meta.url).pathname,
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
