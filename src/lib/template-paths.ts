import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for the byte-immutable template paths under
 * `lib/`. Each function resolves to `<repo>/lib/<file>.tmpl` in dev and
 * `<install>/dist/lib/<file>.tmpl` post-build, because
 * [scripts/post-build.mjs](../../scripts/post-build.mjs) keeps the
 * `'../../lib/...'` relative offset constant from compiled output.
 *
 * Split out from `platform.ts` so its two unrelated reasons-to-change
 * are separated: this module changes when the build pipeline / template
 * set changes; `platform.ts` changes when a new OS or external tool is
 * supported.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the byte-immutable launcher template
 * (`lib/mcp-start.js.tmpl`). Single source of truth — `init.ts` and
 * `update.ts` should call this rather than recomputing the path.
 */
export function getLauncherTemplate(): string {
  return join(SCRIPT_DIR, '../../lib/mcp-start.js.tmpl');
}

/**
 * Absolute path to the GitHub Pages deploy workflow template
 * (`lib/deploy.yml.tmpl`). Used by `init.ts` (initial vault scaffolding)
 * and `visibility.ts` (when toggling a vault to a publishing mode that
 * needs the workflow).
 */
export function getDeployTemplate(): string {
  return join(SCRIPT_DIR, '../../lib/deploy.yml.tmpl');
}

/**
 * Absolute path to the freshness GitHub Action template
 * (`lib/freshness.yml.tmpl`). Scheduled weekly run that invokes
 * `vaultkit refresh --vault-dir .` and opens a PR with the report.
 */
export function getFreshnessTemplate(): string {
  return join(SCRIPT_DIR, '../../lib/freshness.yml.tmpl');
}

/**
 * Absolute path to the PR description scaffold
 * (`lib/pr-template.md.tmpl`). Asks contributors to declare the
 * Claude Code session config they used (model, thinking, effort)
 * when applying a freshness report.
 */
export function getPrTemplate(): string {
  return join(SCRIPT_DIR, '../../lib/pr-template.md.tmpl');
}

/**
 * Absolute path to the project-scoped Claude Code settings template
 * (`lib/claude-settings.json.tmpl`). Pins recommended model defaults
 * for refresh sessions where the vault directory is the cwd.
 */
export function getClaudeSettingsTemplate(): string {
  return join(SCRIPT_DIR, '../../lib/claude-settings.json.tmpl');
}

