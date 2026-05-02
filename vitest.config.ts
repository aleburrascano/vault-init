import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,ts}'],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 60_000,
    // Live tests mutate ~/.claude.json and create real GitHub repos — must
    // run sequentially. Always-on as of v2.5.0 (no env-var gate).
    fileParallelism: false,
    // Sweep any vk-live-* registry entries that survived per-test cleanup
    // (e.g. when a hook crashed or the process was killed). Last line of
    // defense — per-test cleanup is primary.
    globalSetup: ['tests/global-teardown.ts'],
  },
});
