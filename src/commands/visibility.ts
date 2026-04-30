import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { validateName, renderVaultJson } from '../lib/vault.js';
import { getVaultDir } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import { add, commit, pushOrPr } from '../lib/git.js';
import {
  getVisibility, isAdmin, getUserPlan,
  enablePages, setPagesVisibility, disablePages, pagesExist, getPagesVisibility,
} from '../lib/github.js';
import type { RunOptions } from '../types.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEPLOY_TMPL = join(SCRIPT_DIR, '../../lib/deploy.yml.tmpl');

export interface VisibilityOptions extends RunOptions {
  skipConfirm?: boolean;
}

async function resolveRepoSlug(dir: string): Promise<string | null> {
  const result = await execa('git', ['-C', dir, 'remote', 'get-url', 'origin'], { reject: false });
  if (result.exitCode !== 0) return null;
  const url = String(result.stdout ?? '').trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?\/?$/);
  return m?.[1] ?? null;
}

export async function run(
  name: string,
  target: string,
  { cfgPath, log = console.log, skipConfirm = false }: VisibilityOptions = {},
): Promise<void> {
  validateName(name);

  const validTargets = ['public', 'private', 'auth-gated'];
  if (!validTargets.includes(target)) {
    throw new Error(`Invalid mode '${target}'. Choose one of: public, private, auth-gated.`);
  }

  const dir = await getVaultDir(name, cfgPath);
  if (!dir) throw new Error(`"${name}" is not a registered vault.`);

  const gh = await findTool('gh');
  if (!gh) throw new Error('GitHub CLI (gh) is required for vaultkit visibility.');

  const repoSlug = await resolveRepoSlug(dir);
  if (!repoSlug) throw new Error("Vault has no 'origin' remote — cannot determine GitHub repo.");

  const admin = await isAdmin(repoSlug).catch(() => false);
  if (!admin) throw new Error(`You don't have admin rights on ${repoSlug}.`);

  const currentVis = await getVisibility(repoSlug).catch(() => 'unknown');
  const hasPages = await pagesExist(repoSlug).catch(() => false);
  const pagesVis = hasPages ? await getPagesVisibility(repoSlug).catch(() => '?') : null;

  log(`Vault: ${name} (${repoSlug})`);
  log(`Current: repo=${currentVis}, pages=${hasPages ? (pagesVis ?? 'enabled') : 'disabled'}`);
  log(`Target:  ${target}`);
  log('');

  if (target === 'auth-gated') {
    const plan = await getUserPlan().catch(() => 'free');
    if (plan === 'free') {
      throw new Error(`auth-gated Pages requires GitHub Pro+ (your plan: ${plan}).`);
    }
  }

  const hasDeploy = existsSync(join(dir, '.github', 'workflows', 'deploy.yml'));
  const needDeploy = (target === 'public' || target === 'auth-gated') && !hasDeploy;

  // Build action plan
  const actions: string[] = [];
  if (needDeploy) actions.push('add .github/workflows/deploy.yml + _vault.json');
  if (target === 'public') {
    if (currentVis !== 'public') actions.push('flip repo to public');
    if (hasPages) {
      if (pagesVis !== 'public') actions.push('set Pages visibility to public');
    } else {
      actions.push('enable Pages (workflow source)');
    }
  } else if (target === 'private') {
    if (currentVis !== 'private') actions.push('flip repo to private');
    if (hasPages) actions.push('disable Pages site');
  } else { // auth-gated
    if (currentVis !== 'private') actions.push('flip repo to private');
    if (hasPages) {
      if (pagesVis !== 'private') actions.push('set Pages visibility to private');
    } else {
      actions.push('enable Pages + set visibility to private');
    }
  }

  if (actions.length === 0) {
    log(`Already ${target} — nothing to do.`);
    return;
  }

  log('Plan:');
  for (const a of actions) log(`  - ${a}`);
  log('');

  if (!skipConfirm) {
    const ok = await confirm({ message: 'Proceed?', default: false });
    if (!ok) { log('Aborted.'); return; }
    log('');
  }

  let workflowAdded = false;

  if (needDeploy) {
    log('Adding deploy workflow...');
    const wfDir = join(dir, '.github', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    copyFileSync(DEPLOY_TMPL, join(wfDir, 'deploy.yml'));

    const [owner = '', repo = ''] = repoSlug.split('/');
    writeFileSync(join(dir, '_vault.json'), renderVaultJson(owner, repo));
    workflowAdded = true;
  }

  // Execute visibility changes
  if (target === 'public') {
    if (currentVis !== 'public') {
      log('Setting repo to public...');
      await execa(gh, ['repo', 'edit', repoSlug, '--visibility', 'public', '--accept-visibility-change-consequences'], { reject: false });
    }
    if (hasPages) {
      if (pagesVis !== 'public') {
        log('Setting Pages visibility to public...');
        await setPagesVisibility(repoSlug, 'public');
      }
    } else {
      log('Enabling Pages...');
      await enablePages(repoSlug);
    }
  } else if (target === 'private') {
    if (currentVis !== 'private') {
      log('Setting repo to private...');
      await execa(gh, ['repo', 'edit', repoSlug, '--visibility', 'private', '--accept-visibility-change-consequences'], { reject: false });
    }
    if (hasPages) {
      log('Disabling Pages...');
      await disablePages(repoSlug);
    }
  } else { // auth-gated
    if (currentVis !== 'private') {
      log('Setting repo to private...');
      await execa(gh, ['repo', 'edit', repoSlug, '--visibility', 'private', '--accept-visibility-change-consequences'], { reject: false });
    }
    if (hasPages) {
      if (pagesVis !== 'private') {
        log('Setting Pages visibility to private...');
        await setPagesVisibility(repoSlug, 'private');
      }
    } else {
      log('Enabling Pages with private visibility...');
      await enablePages(repoSlug);
      await setPagesVisibility(repoSlug, 'private');
    }
  }

  if (workflowAdded) {
    const filesToStage = ['.github/workflows/deploy.yml', '_vault.json'];
    await add(dir, filesToStage);
    await commit(dir, 'chore: add Pages deploy workflow');
    const pushResult = await pushOrPr(dir, {
      branchPrefix: 'vaultkit-pages',
      prTitle: 'chore: add Pages deploy workflow',
      prBody: 'Adds GitHub Pages deploy workflow.',
    });
    if (pushResult.mode === 'pr') {
      log(`Warning: Repo/Pages configured but workflow pending PR (branch: ${pushResult.branch}).`);
    }
  }

  log(`\nhttps://github.com/${repoSlug}`);
}
