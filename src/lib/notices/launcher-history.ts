/**
 * Historical SHA-256 hashes of `lib/mcp-start.js.tmpl` from prior vaultkit
 * releases. Used by `doctor` and `verify` to disambiguate a launcher SHA
 * mismatch into "user upgraded vaultkit but didn't run `update --all`"
 * (recoverable, expected after a breaking-change release) vs. "the
 * launcher's bytes don't match any version we ever shipped" (treat as a
 * possible tamper).
 *
 * Add a new entry on every release that ships a different
 * `lib/mcp-start.js.tmpl`. The label should name the version that *last*
 * shipped this SHA — i.e. users still pinned to this hash are running
 * that version's launcher. Per ADR-0001, every template change is a
 * breaking-change release event, so the table grows ~once per breaking
 * release.
 *
 * The current template's SHA is computed at runtime via
 * `sha256(getLauncherTemplate())` — there is no constant for it here, by
 * design: the active SHA cannot drift from `lib/mcp-start.js.tmpl`'s
 * actual bytes because the value is derived, not declared.
 */
export const HISTORICAL_LAUNCHER_SHAS: Record<string, string> = {
  // SHAs computed from git blob bytes (raw, no text conversion).
  'c39dd42a64c910db0d91d7109233c9069eb28d5302161ee25caa5ad1f89f5cda': 'v1.3.0',
  'fc9b413e691871ac634e486924963e83d38fb11d28a47cebe78973ff05b259cf': 'v1.4.1',
  '45da4485c6ec6ea225776f07a84993a2e7655de4457c9ab3fa7fe6d8162f2911': 'pre-2.8.0',
  // SHAs computed from `git show | sha256sum` (with platform line-ending
  // conversion). Included because users on Windows whose `npm publish`
  // worked through a CRLF-converting pipe would have pinned these
  // values instead. Mapping the same release to both possible bytes keeps
  // the disambiguation correct regardless of how the published file was
  // line-ending-normalized.
  '1ba6e0e8b07896d4d1eb8711eae4913b5341dd5c3501bc45b0db7b44625e0c4e': 'v1.3.0',
  'cb8b749ca4ea1388978093b7b6a40af0ddecc9fcabd22a9b4755db3c7761abff': 'v1.4.1',
  '800f6bd71843a0ef4ea78110a0a639d68f0567220c6d7c5577a6df4b7cc7caaf': 'pre-2.8.0',
};

export type LauncherShaClassification = 'match' | 'historical' | 'unknown';

/**
 * Classify an on-disk launcher SHA against the current expected SHA and
 * the historical-SHA table. Returns:
 *
 * - `'match'`     — on-disk matches expected (no mismatch to disambiguate)
 * - `'historical'`— matches a known prior shipped version (likely outdated
 *                   after a vaultkit upgrade; remediable via
 *                   `vaultkit doctor --fix --all`)
 * - `'unknown'`   — matches no known shipped version (treat as possible
 *                   tampering; user should inspect / re-trust)
 */
export function classifyLauncherSha(
  onDiskSha: string,
  expectedSha: string,
): LauncherShaClassification {
  if (onDiskSha === expectedSha) return 'match';
  if (Object.prototype.hasOwnProperty.call(HISTORICAL_LAUNCHER_SHAS, onDiskSha)) return 'historical';
  return 'unknown';
}

/**
 * Returns the version label for a known historical SHA, or `null` when
 * the SHA is unknown. Convenience wrapper around the lookup so callers
 * can present a human-readable version string in messages.
 */
export function historicalVersionLabel(onDiskSha: string): string | null {
  return HISTORICAL_LAUNCHER_SHAS[onDiskSha] ?? null;
}
