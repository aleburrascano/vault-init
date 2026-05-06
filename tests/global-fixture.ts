import { silent } from './helpers/logger.js';

/**
 * Vitest globalSetup hook: creates a single `vk-live-shared-*` GitHub
 * repo + local vault that the `connect` / `disconnect` / `visibility`
 * live blocks reuse instead of each creating their own.
 *
 * Per-run cost: 1 create at suite start, 1 destroy at suite end, vs. the
 * previous 3 creates + 3 destroys (one per fixture-sharing test). The
 * `init` and `destroy` live blocks remain self-contained because the
 * test IS the create / delete path — coupling that coverage to fixture
 * lifecycle would muddy what the test actually validates.
 *
 * Skip rules:
 * - Windows: `liveDescribe` already skips fixture-using blocks here, so
 *   creating the fixture would be wasted work.
 * - GH_TOKEN unset (no keyring auth either): we don't pre-detect this
 *   case — we let `init.run()` throw its own clear error, which surfaces
 *   the actual prereq problem instead of inventing a layer that would
 *   drift from `liveDescribe`'s gates.
 *
 * Failure mode: if `init.run()` throws (abuse-flag, network, auth
 * missing) we re-throw and let vitest abort the suite. Retrying on a
 * flagged PAT would deepen the flag, and silently skipping would let
 * downstream tests fail with confusing "fixture not found" errors.
 */

const fixtureName = `vk-live-shared-${process.pid}-${Date.now()}`;

export async function setup(): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  const { run: initRun } = await import('../src/commands/init.js');
  await initRun(fixtureName, { publishMode: 'private', skipInstallCheck: true, log: silent });
  process.env.VAULTKIT_LIVE_FIXTURE_NAME = fixtureName;
}

export async function teardown(): Promise<void> {
  if (process.platform === 'win32') return;
  if (!process.env.VAULTKIT_LIVE_FIXTURE_NAME) return;
  // 3.0: `destroy` was merged into `remove --delete-repo`.
  const { run: removeRun } = await import('../src/commands/remove.js');
  await removeRun(fixtureName, {
    deleteRepo: true,
    skipConfirm: true,
    skipMcp: true,
    confirmName: fixtureName,
    log: silent,
  }).catch(() => {
    // Best-effort. The workflow's post-test orphan sweep (across both
    // PATs) and `tests/global-teardown.ts`'s registry sweep are the
    // second-line defenses. Don't retry — on a flagged PAT, retries
    // deepen the flag.
  });
}
