/**
 * Repeated user-facing strings — prompt text and frequently-used log
 * labels. Every entry here appears in 2+ command files. One-shot prompts
 * stay inline at their call site (extracting them forces meaningless
 * names like `INSTALL_GH_WINGET` for a single use).
 *
 * Why centralize these specifically:
 *  - Reword once → all surfaces update atomically.
 *  - Future i18n: a message catalog is the bridge to translatable text.
 *  - Audit: a typo or capitalization drift across 5 commands becomes
 *    immediately visible when the strings live next to each other.
 */

/** Interactive prompt messages passed to `@inquirer/prompts`. */
export const PROMPTS = {
  /** Asks the user to type the vault name to confirm a destructive op. */
  TYPE_NAME_TO_CONFIRM: 'Type the vault name to confirm:',
  /** Variant used by `destroy` — explicit about the action. */
  TYPE_NAME_TO_CONFIRM_DELETION: 'Type the vault name to confirm deletion:',
  /** Generic confirmation before applying a multi-step plan. */
  PROCEED: 'Proceed?',
  /** Confirmation before auto-installing the Claude Code CLI. */
  INSTALL_CLAUDE: 'Claude Code CLI not found. Install it now?',
  /** Confirmation before registering the vault as an MCP server. */
  REGISTER_AS_MCP: 'Register as MCP server?',
} as const;

/** Recurring single-line log labels. */
export const LABELS = {
  /** Printed when a confirmation prompt declines. */
  ABORTED: 'Aborted.',
  /** Printed by `pull`/`status`/`doctor` when the registry has no entries. */
  NO_VAULTS_REGISTERED: 'No vaults registered.',
} as const;
