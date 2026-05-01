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
  | 'ALREADY_REGISTERED'     // attempted re-register of an existing name
  | 'NOT_VAULT_LIKE'         // dir missing .obsidian or CLAUDE.md+raw+wiki
  | 'HASH_MISMATCH'          // launcher SHA-256 differs from pinned hash
  | 'AUTH_REQUIRED'          // gh auth missing or insufficient scope
  | 'PERMISSION_DENIED'      // user lacks admin on the remote repo
  | 'TOOL_MISSING'           // gh, claude, or git not found on PATH
  | 'NETWORK_TIMEOUT'        // git fetch/pull or gh API timed out
  | 'UNRECOGNIZED_INPUT'     // user-supplied input couldn't be parsed
  | 'PARTIAL_FAILURE';       // some operations in a multi-step flow failed

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
 * Codes 2–11 are reserved for vaultkit categories; 0 = success, 1 = an
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
};
