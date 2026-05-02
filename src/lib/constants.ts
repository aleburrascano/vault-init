/**
 * Domain-meaningful literal constants for vaultkit. Names that recur
 * across multiple files (vault file paths, layout directories, the
 * vault-name length limit) live here so a single edit changes them
 * everywhere — and so a typo in one site can't silently desync from
 * the rest of the codebase.
 *
 * Not in this file (deliberately):
 *  - Git refs (`'main'`, `'origin'`, `'@{u}'`) — Git spec terms.
 *  - One-shot external URLs (`https://cli.github.com`) — extracting
 *    them obscures intent at the call site.
 *  - Configurable timeouts (already env-overridable).
 */

/** Filenames that appear inside every vault directory. */
export const VAULT_FILES = {
  /** Per-vault MCP launcher script. SHA-256 pinned in `~/.claude.json`. */
  LAUNCHER: '.mcp-start.js',
  /** Vault-scoped Claude Code instructions. */
  CLAUDE_MD: 'CLAUDE.md',
  /** Public-facing vault README. */
  README: 'README.md',
  /** Wiki landing page. */
  INDEX: 'index.md',
  /** Append-only operations log. */
  LOG: 'log.md',
  /** Standard ignore patterns for vaultkit-managed vaults. */
  GITIGNORE: '.gitignore',
  /** Line-ending normalization for cross-platform vault sharing. */
  GITATTRIBUTES: '.gitattributes',
  /** GitHub Pages / Quartz config — written when publish mode != private. */
  VAULT_JSON: '_vault.json',
  /** Marker that a directory is an Obsidian vault. */
  OBSIDIAN_DIR: '.obsidian',
  /** Git repository metadata directory (presence check for `hasGitRepo`). */
  GIT_DIR: '.git',
  /** Project-scoped Claude Code settings (model + permissions defaults for refresh sessions). */
  CLAUDE_SETTINGS: '.claude/settings.json',
  /** PR description scaffold for collaborator session-config disclosure. */
  PR_TEMPLATE: '.github/pull_request_template.md',
} as const;

/** Top-level subdirectories of a vaultkit vault. */
export const VAULT_DIRS = {
  /** Immutable source material — read, never edit. */
  RAW: 'raw',
  /** Authored knowledge pages. */
  WIKI: 'wiki',
  /** GitHub Actions workflows directory. */
  GITHUB_WORKFLOWS: '.github/workflows',
} as const;

/** Filenames inside `.github/workflows/`. */
export const WORKFLOW_FILES = {
  /** Quartz / Pages deploy workflow (publish mode != private). */
  DEPLOY: 'deploy.yml',
  /** PR-time guard against duplicate filenames in raw/. */
  DUPLICATE_CHECK: 'duplicate-check.yml',
  /** Scheduled freshness report — runs `vaultkit refresh` weekly and opens a PR. */
  FRESHNESS: 'freshness.yml',
} as const;

/** Validation constraints on vault identifiers. */
export const VAULT_CONSTRAINTS = {
  /** Max length for a vault name (matches the doctor + validateName checks). */
  NAME_MAX_LENGTH: 64,
  /** Allowed characters in a vault name. */
  NAME_PATTERN: /^[a-zA-Z0-9_-]+$/,
} as const;

/**
 * Valid publish modes for `vaultkit init` and `vaultkit visibility`.
 * Single source of truth shared by the type, the runtime validator, and
 * the user-facing error message ("Choose one of: private, public,
 * auth-gated"). Adding a new mode is one edit here.
 */
export const PUBLISH_MODES = ['private', 'public', 'auth-gated'] as const;
export type PublishMode = typeof PUBLISH_MODES[number];

export function isPublishMode(value: string): value is PublishMode {
  return (PUBLISH_MODES as readonly string[]).includes(value);
}
