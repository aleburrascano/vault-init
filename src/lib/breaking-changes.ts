/**
 * Vaultkit's per-vault registry schema version + the table of breaking
 * changes between versions. Per ADR-0015, this is the single source of
 * truth that future detection paths (`doctor`, `post-upgrade-check`,
 * `preflight-launcher`, error hints in `mcp.ts`) consult to figure out
 * what migrations a given vault needs and which command remedies them.
 *
 * Adding a breaking change is a two-step operation:
 *
 * 1. Bump {@link CURRENT_SCHEMA_VERSION}.
 * 2. Append a {@link BreakingChange} entry to {@link BREAKING_CHANGES}
 *    describing what changed between the previous version and the new
 *    one — affected component, severity, the remedy command, and a
 *    one-line human label.
 *
 * Detection paths walk {@link migrationsNeeded} once per vault to know
 * which entries apply; they never branch on `vaultSchemaVersion ===
 * specificNumber`. That keeps each detection path constant-size as the
 * table grows.
 *
 * The current state of the table is intentionally empty — vaultkit just
 * introduced the schema-version mechanism, so there are no historical
 * entries to model. The first entry will land alongside the next
 * launcher-template-breaking release (or any other vault-side change
 * worth flagging through this surface). See ADR-0015 for the policy.
 */

/** Current schema version for newly-registered or freshly-updated vaults. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Severity controls whether `doctor` and `post-upgrade-check` treat the migration as warn or fail. */
export type BreakingChangeSeverity = 'warn' | 'fail';

/** Component the breaking change touches — drives which detection paths surface it. */
export type BreakingChangeComponent = 'launcher' | 'registry' | 'layout' | 'mcp-server' | 'other';

/**
 * Structured descriptor for a single breaking change. Detection paths
 * read these fields to render consistent messaging across `doctor`,
 * `post-upgrade-check`, `preflight-launcher`, and any future surface
 * that needs to nudge users toward a migration.
 */
export interface BreakingChange {
  /**
   * The schema version a vault must be at OR ABOVE for this entry to be
   * irrelevant. Vaults whose `schemaVersion` is `< toSchemaVersion` need
   * this migration applied.
   */
  toSchemaVersion: number;
  /** What part of the vault is affected. */
  component: BreakingChangeComponent;
  /** Whether this should fail `doctor` (incrementing its issue count) or just warn. */
  severity: BreakingChangeSeverity;
  /** Verbatim command to run to migrate (e.g. `'vaultkit update --all'`). */
  remedyCommand: string;
  /** One-line human-readable label for the change (e.g. `'launcher template changed in 2.8.0'`). */
  humanLabel: string;
}

/**
 * Chronological list of breaking changes between schema versions.
 * Append-only — entries that have shipped are public contract for
 * detection paths and migration messaging. Never reorder or rewrite
 * past entries; supersede via a new entry instead.
 *
 * Empty at the time of introduction — the first entry will land with
 * the next breaking release. This is by design: the goal of this
 * release is to ship the *infrastructure*, not to retroactively model
 * the pre-2.8.0 → 2.8.0 transition (which is already handled by the
 * SHA-classification path in `launcher-history.ts`).
 */
export const BREAKING_CHANGES: readonly BreakingChange[] = [];

/**
 * Returns the breaking changes that apply to a vault registered at the
 * given schema version. A vault with `schemaVersion === null` (legacy
 * registration, pre-schemaVersion-introduction) gets every entry — its
 * version is treated as 0 for comparison purposes.
 *
 * Detection paths call this once per vault and render the returned
 * descriptors into messaging. Order in the result mirrors the order in
 * {@link BREAKING_CHANGES}.
 */
export function migrationsNeeded(
  vaultSchemaVersion: number | null | undefined,
): BreakingChange[] {
  const v = vaultSchemaVersion ?? 0;
  return BREAKING_CHANGES.filter(c => v < c.toSchemaVersion);
}
