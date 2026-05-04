/**
 * Categorized error codes for vaultkit failures. Each code maps to a
 * distinct exit code in `bin/vaultkit.ts:wrap()`, so shell pipelines and
 * the audit log can branch on category without parsing message strings.
 *
 * Add new codes sparingly — every new code is a public contract that
 * scripted callers may come to depend on. Prefer reusing an existing
 * code over inventing a near-duplicate.
 */
export type VaultkitErrorCode =
  | 'INVALID_NAME'           // vault name failed format/length validation
  | 'NOT_REGISTERED'         // vault name not present in MCP registry
  | 'ALREADY_REGISTERED'     // re-register of existing name OR target dir already on disk
  | 'NOT_VAULT_LIKE'         // dir missing .obsidian/CLAUDE.md/raw/wiki, .git, or launcher
  | 'HASH_MISMATCH'          // launcher SHA-256 differs from pinned hash
  | 'AUTH_REQUIRED'          // gh auth missing, insufficient scope, or status check failed
  | 'PERMISSION_DENIED'      // user lacks admin on the remote OR plan tier insufficient
  | 'TOOL_MISSING'           // gh, claude, git, or Node.js (too old / install failed)
  | 'NETWORK_TIMEOUT'        // git fetch/pull or gh API timed out
  | 'UNRECOGNIZED_INPUT'     // user-supplied input (mode, URL, etc.) couldn't be parsed
  | 'PARTIAL_FAILURE'        // multi-step flow failed mid-way (e.g. pull-then-repin)
  | 'RATE_LIMITED'           // GitHub secondary rate limit; retry budget exhausted
  | 'SETUP_REQUIRED';        // vaultkit setup hasn't been run; prereqs missing at command entry

/**
 * Errors thrown intentionally by vaultkit, with a machine-readable code.
 * Plain `Error` is still appropriate for genuinely unexpected failures —
 * `wrap()` falls back to exit code 1 for non-VaultkitError throws.
 */
export class VaultkitError extends Error {
  constructor(public readonly code: VaultkitErrorCode, message: string) {
    super(message);
    this.name = 'VaultkitError';
  }
}

export function isVaultkitError(err: unknown): err is VaultkitError {
  return err instanceof VaultkitError;
}

/**
 * Maps each error code to the process exit code emitted by `wrap()`.
 * Codes 2–14 are reserved for vaultkit categories; 0 = success, 1 = an
 * unhandled/unknown error. Public contract: scripted callers may rely on
 * these specific codes.
 */
export const EXIT_CODES: Record<VaultkitErrorCode, number> = {
  INVALID_NAME: 2,
  NOT_REGISTERED: 3,
  ALREADY_REGISTERED: 4,
  NOT_VAULT_LIKE: 5,
  HASH_MISMATCH: 6,
  AUTH_REQUIRED: 7,
  PERMISSION_DENIED: 8,
  TOOL_MISSING: 9,
  NETWORK_TIMEOUT: 10,
  UNRECOGNIZED_INPUT: 11,
  PARTIAL_FAILURE: 12,
  RATE_LIMITED: 13,
  SETUP_REQUIRED: 14,
};

/**
 * Default human-readable error text per code. Use these as a base and
 * append command-specific context where helpful. Prevents wording drift
 * across the 3+ throw sites that previously phrased the same concept
 * differently (e.g. "is not a registered vault" / "is not registered").
 *
 * Convention: each phrase is a sentence fragment that completes naturally
 * after the subject (e.g. `"${name}" ${DEFAULT_MESSAGES.NOT_REGISTERED}`
 * reads as `"MyVault" is not a registered vault.`).
 */
export const DEFAULT_MESSAGES: Record<VaultkitErrorCode, string> = {
  INVALID_NAME: 'is not a valid vault name.',
  NOT_REGISTERED: 'is not a registered vault.',
  ALREADY_REGISTERED: 'is already registered.',
  NOT_VAULT_LIKE: 'does not look like a vaultkit vault.',
  HASH_MISMATCH: 'launcher SHA-256 differs from the pinned hash.',
  AUTH_REQUIRED: 'requires GitHub authentication.',
  PERMISSION_DENIED: 'requires admin permissions on the remote repo.',
  TOOL_MISSING: 'requires a CLI tool that is not installed.',
  NETWORK_TIMEOUT: 'timed out waiting for a network operation.',
  UNRECOGNIZED_INPUT: 'is not in a recognized format.',
  PARTIAL_FAILURE: 'partially failed — some operations did not complete.',
  RATE_LIMITED: 'was rate-limited by GitHub after exhausting the retry budget.',
  SETUP_REQUIRED: "vaultkit isn't set up yet. Run 'vaultkit setup' to install and authenticate the prerequisites (gh, git, etc.). Use 'vaultkit doctor' to diagnose without running setup.",
};
