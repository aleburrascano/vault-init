import { existsSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import {
  validateName, sha256,
  renderClaudeMd, renderReadme, renderDuplicateCheckYaml,
  renderGitignore, renderGitattributes, renderIndexMd, renderLogMd,
} from '../lib/vault.js';
import { getVaultDir } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import { add, commit, pushOrPr } from '../lib/git.js';
import type { RunOptions } from '../types.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TMPL_PATH = join(SCRIPT_DIR, '../../lib/mcp-start.js.tmpl');

export interface UpdateOptions extends RunOptions {
  skipConfirm?: boolean;
}

function isDirEmpty(dir: string): boolean {
  try { return readdirSync(dir).length === 0; } catch { return true; }
}

export async function run(
  name: string,
  { cfgPath, log = console.log, skipConfirm = false }: UpdateOptions = {},
): Promise<void> {
  validateName(name);

  const dir = await getVaultDir(name, cfgPath);
  if (!dir) throw new Error(`"${name}" is not a registered vault.`);

  if (!existsSync(join(dir, '.git'))) {
    throw new Error(`${dir} is not a git repository — aborting.`);
  }

  log(`Updating ${name} at ${dir}...`);

  // Launcher refresh detection
  const launcherPath = join(dir, '.mcp-start.js');
  const beforeHash = existsSync(launcherPath) ? await sha256(launcherPath) : '';
  const tmplHash = await sha256(TMPL_PATH);
  const launcherWillChange = beforeHash !== tmplHash;

  // Layout-repair detection
  const missing: string[] = [];
  if (!existsSync(join(dir, 'CLAUDE.md'))) missing.push('CLAUDE.md');
  if (!existsSync(join(dir, 'README.md'))) missing.push('README.md');
  if (!existsSync(join(dir, 'index.md'))) missing.push('index.md');
  if (!existsSync(join(dir, 'log.md'))) missing.push('log.md');
  if (!existsSync(join(dir, '.gitignore'))) missing.push('.gitignore');
  if (!existsSync(join(dir, '.gitattributes'))) missing.push('.gitattributes');
  if (!existsSync(join(dir, '.github', 'workflows', 'duplicate-check.yml')))
    missing.push('.github/workflows/duplicate-check.yml');
  if (!existsSync(join(dir, 'raw')) || isDirEmpty(join(dir, 'raw')))
    missing.push('raw/.gitkeep');
  if (!existsSync(join(dir, 'wiki')) || isDirEmpty(join(dir, 'wiki')))
    missing.push('wiki/.gitkeep');

  // Summary
  log('');
  if (launcherWillChange) {
    log(`  .mcp-start.js: ${beforeHash || '(missing)'} → ${tmplHash}`);
  } else {
    log(`  .mcp-start.js: up to date (${beforeHash})`);
  }
  if (missing.length > 0) {
    log(`  Missing layout files (${missing.length}):`);
    for (const f of missing) log(`    - ${f}`);
  } else {
    log('  Layout: complete.');
  }

  if (!launcherWillChange && missing.length === 0) {
    log('');
    log('Already up to date. Re-pinning MCP registration anyway (idempotent).');
  }

  if (!skipConfirm) {
    log('');
    const ok = await confirm({ message: 'Proceed?', default: false });
    if (!ok) { log('Aborted.'); return; }
    log('');
  }

  // Apply: copy launcher
  copyFileSync(TMPL_PATH, launcherPath);
  const afterHash = await sha256(launcherPath);

  // Apply: create missing layout files
  const added: string[] = [];
  for (const f of missing) {
    const target = join(dir, f);
    mkdirSync(dirname(target), { recursive: true });
    switch (f) {
      case 'CLAUDE.md': writeFileSync(target, renderClaudeMd(name)); break;
      case 'README.md': writeFileSync(target, renderReadme(name, '')); break;
      case 'index.md': writeFileSync(target, renderIndexMd()); break;
      case 'log.md': writeFileSync(target, renderLogMd()); break;
      case 'raw/.gitkeep': writeFileSync(target, ''); break;
      case 'wiki/.gitkeep': writeFileSync(target, ''); break;
      case '.gitignore': writeFileSync(target, renderGitignore()); break;
      case '.gitattributes': writeFileSync(target, renderGitattributes()); break;
      case '.github/workflows/duplicate-check.yml':
        writeFileSync(target, renderDuplicateCheckYaml()); break;
    }
    added.push(f);
  }

  // Re-pin MCP
  const claudePath = await findTool('claude');
  if (claudePath) {
    log(`Re-pinning MCP registration with SHA-256 ${afterHash}...`);
    await execa(claudePath, ['mcp', 'remove', name, '--scope', 'user'], { reject: false });
    await execa(claudePath, [
      'mcp', 'add', '--scope', 'user',
      name, '--', 'node', launcherPath,
      `--expected-sha256=${afterHash}`,
    ]);
  } else {
    log('Warning: Claude Code not found — MCP re-registration skipped.');
    log(`  Once installed, run:`);
    log(`    claude mcp remove ${name} --scope user`);
    log(`    claude mcp add --scope user ${name} -- node "${launcherPath}" --expected-sha256=${afterHash}`);
  }

  const launcherChanged = afterHash !== beforeHash;
  if (!launcherChanged && added.length === 0) {
    log('');
    log('  Nothing to commit.');
    log('Done. Restart Claude Code to apply the re-pinned registration.');
    return;
  }

  // Commit
  const filesToStage: string[] = [];
  if (launcherChanged) filesToStage.push('.mcp-start.js');
  filesToStage.push(...added);

  await add(dir, filesToStage);

  const stagedResult = await execa('git', ['-C', dir, 'diff', '--cached', '--name-only'], { reject: false });
  const staged = String(stagedResult.stdout ?? '').trim();
  if (!staged) {
    log('  Nothing staged — skipping commit.');
    log('Done. Restart Claude Code to apply.');
    return;
  }

  let commitMsg: string;
  if (launcherChanged && added.length > 0) {
    commitMsg = 'chore: update .mcp-start.js + restore standard layout files';
  } else if (launcherChanged) {
    commitMsg = 'chore: update .mcp-start.js to latest vaultkit version';
  } else {
    commitMsg = 'chore: restore standard vaultkit layout files';
  }

  await commit(dir, commitMsg);
  log('');

  const pushResult = await pushOrPr(dir, {
    branchPrefix: 'vaultkit-update',
    prTitle: commitMsg,
    prBody: 'Brings the vault up to the current vaultkit standard.',
  });

  if (pushResult.mode === 'direct') {
    log('Done. Restart Claude Code to apply the update.');
  } else {
    log(`Done. Changes will take effect after the PR (branch: ${pushResult.branch}) is merged.`);
  }
}
