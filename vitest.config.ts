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
    // globalSetup files run setup in array order, teardown in REVERSE
    // array order. Order here is intentional:
    //  - global-teardown (no setup export): teardown sweeps surviving
    //    vk-live-* registry entries — the safety net for whatever the
    //    per-test afterAll + fixture teardown didn't catch. Runs LAST in
    //    reverse order, so it sees a registry that destroy has already
    //    cleaned up under the happy path.
    //  - global-fixture: setup() creates the shared vk-live-shared-* repo
    //    + registry entry; teardown() destroys both. Runs FIRST in
    //    reverse-order teardown so destroy's registry lookup succeeds
    //    before global-teardown's sweep would otherwise strip the entry.
    globalSetup: ['tests/global-teardown.ts', 'tests/global-fixture.ts'],
  },
});
