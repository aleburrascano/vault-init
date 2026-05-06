import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VAULT_FILES, VAULT_DIRS, WORKFLOW_FILES } from '../constants.js';
import {
  renderClaudeMd,
  renderReadme,
  renderIndexMd,
  renderLogMd,
  renderGitignore,
  renderGitattributes,
  renderDuplicateCheckYaml,
  renderFreshnessYml,
  renderPrTemplate,
  renderClaudeSettings,
} from './vault-templates.js';

/**
 * Per-call context for rendering layout files. Different commands
 * supply different fields:
 *   - `init` provides `siteUrl` when publish mode != private.
 *   - `update` always passes `siteUrl: ''` (it doesn't know publish state).
 */
export interface LayoutContext {
  name: string;
  siteUrl?: string;
}

/** Sub-path of the duplicate-check workflow, used both as a file path and a switch-case key. */
export const DUPLICATE_CHECK_WORKFLOW_PATH = `${VAULT_DIRS.GITHUB_WORKFLOWS}/${WORKFLOW_FILES.DUPLICATE_CHECK}`;

/** Sub-path of the freshness workflow (Topic 2). Same dual-use as DUPLICATE_CHECK_WORKFLOW_PATH. */
export const FRESHNESS_WORKFLOW_PATH = `${VAULT_DIRS.GITHUB_WORKFLOWS}/${WORKFLOW_FILES.FRESHNESS}`;

/** Marker files that ensure `raw/` and `wiki/` are tracked even when empty. */
export const RAW_GITKEEP = `${VAULT_DIRS.RAW}/.gitkeep`;
export const WIKI_GITKEEP = `${VAULT_DIRS.WIKI}/.gitkeep`;

/**
 * Canonical layout files in deterministic creation order. Each entry is
 * a vault-relative path. Used by both `init` (full creation) and `update`
 * (gap repair).
 */
export const CANONICAL_LAYOUT_FILES: readonly string[] = [
  VAULT_FILES.CLAUDE_MD,
  VAULT_FILES.README,
  VAULT_FILES.INDEX,
  VAULT_FILES.LOG,
  VAULT_FILES.GITIGNORE,
  VAULT_FILES.GITATTRIBUTES,
  VAULT_FILES.CLAUDE_SETTINGS,
  VAULT_FILES.PR_TEMPLATE,
  DUPLICATE_CHECK_WORKFLOW_PATH,
  FRESHNESS_WORKFLOW_PATH,
  RAW_GITKEEP,
  WIKI_GITKEEP,
];

/** Render the canonical content for a given vault-relative path. */
export function renderLayoutFile(path: string, ctx: LayoutContext): string {
  switch (path) {
    case VAULT_FILES.CLAUDE_MD:           return renderClaudeMd(ctx.name);
    case VAULT_FILES.README:              return renderReadme(ctx.name, ctx.siteUrl ?? '');
    case VAULT_FILES.INDEX:               return renderIndexMd();
    case VAULT_FILES.LOG:                 return renderLogMd();
    case VAULT_FILES.GITIGNORE:           return renderGitignore();
    case VAULT_FILES.GITATTRIBUTES:       return renderGitattributes();
    case VAULT_FILES.CLAUDE_SETTINGS:     return renderClaudeSettings();
    case VAULT_FILES.PR_TEMPLATE:         return renderPrTemplate();
    case DUPLICATE_CHECK_WORKFLOW_PATH:   return renderDuplicateCheckYaml();
    case FRESHNESS_WORKFLOW_PATH:         return renderFreshnessYml();
    case RAW_GITKEEP:                     return '';
    case WIKI_GITKEEP:                    return '';
    default: throw new Error(`renderLayoutFile: unknown layout path "${path}"`);
  }
}

function isDirEmpty(dir: string): boolean {
  try { return readdirSync(dir).length === 0; } catch { return true; }
}

/** Returns the subset of `CANONICAL_LAYOUT_FILES` that are missing from disk. */
export function detectLayoutGaps(vaultDir: string): string[] {
  const missing: string[] = [];
  for (const file of CANONICAL_LAYOUT_FILES) {
    const full = join(vaultDir, file);
    if (file === RAW_GITKEEP) {
      if (!existsSync(join(vaultDir, VAULT_DIRS.RAW)) || isDirEmpty(join(vaultDir, VAULT_DIRS.RAW))) {
        missing.push(file);
      }
    } else if (file === WIKI_GITKEEP) {
      if (!existsSync(join(vaultDir, VAULT_DIRS.WIKI)) || isDirEmpty(join(vaultDir, VAULT_DIRS.WIKI))) {
        missing.push(file);
      }
    } else if (!existsSync(full)) {
      missing.push(file);
    }
  }
  return missing;
}

/** Default raw/ and wiki/ subdirectories created on init. Empty in update. */
const RAW_SUBDIRS = ['articles', 'books', 'papers', 'notes', 'transcripts', 'assets'];
const WIKI_SUBDIRS = ['concepts', 'topics', 'people', 'sources'];

/** Create the directory tree for a fresh vault (called from `init`). */
export function createDirectoryTree(vaultDir: string): void {
  for (const sub of RAW_SUBDIRS) mkdirSync(join(vaultDir, VAULT_DIRS.RAW, sub), { recursive: true });
  for (const sub of WIKI_SUBDIRS) mkdirSync(join(vaultDir, VAULT_DIRS.WIKI, sub), { recursive: true });
  mkdirSync(join(vaultDir, VAULT_DIRS.GITHUB_WORKFLOWS), { recursive: true });
}

/** Write the named files using `renderLayoutFile`. Used by both init and update. */
export function writeLayoutFiles(vaultDir: string, ctx: LayoutContext, files: readonly string[]): void {
  for (const file of files) {
    const target = join(vaultDir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderLayoutFile(file, ctx));
  }
}
