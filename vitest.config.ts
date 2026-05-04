import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure unit tests against the helper code. We deliberately avoid the
    // Cloudflare vitest pool (which spins up Miniflare per test) because
    // the helpers we care about are pure; the setup cost isn't worth it
    // at this coverage size.
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
