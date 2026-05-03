/**
 * Accessor for the shared live-test fixture vault name.
 *
 * The vault is created once per `npm test` run by `tests/global-fixture.ts`'s
 * vitest globalSetup hook and torn down once at the end. Live `describe`
 * blocks for `connect` / `disconnect` / `visibility` reuse this single repo
 * instead of each creating + destroying their own — drops per-run live-repo
 * creates from ~5 to 3 (init's own + destroy's own + this shared fixture).
 *
 * Throws if the env var is unset, which happens when:
 * - globalSetup was skipped (Windows: `liveDescribe` blocks already skip there).
 * - globalSetup failed (gh not authed, account abuse-flagged, etc.) — in
 *   which case the suite has already aborted before any live test ran.
 *
 * Callers are gated by `liveDescribe`, so on Windows this function is
 * never reached. On non-Windows, the env var is set by globalSetup before
 * any test file imports run, so a `getFixtureName()` call inside a live
 * `it` block will return the value.
 */
export function getFixtureName(): string {
  const name = process.env.VAULTKIT_LIVE_FIXTURE_NAME;
  if (!name) {
    throw new Error(
      'VAULTKIT_LIVE_FIXTURE_NAME is not set — global-fixture setup did not run. ' +
      'On non-Windows this means globalSetup failed; on Windows liveDescribe should ' +
      'have skipped the caller before this point.',
    );
  }
  return name;
}
