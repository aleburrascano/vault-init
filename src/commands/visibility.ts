import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm } from '@inquirer/prompts';
import { Vault } from '../lib/vault.js';
import { renderVaultJson } from '../lib/vault-templates.js';
import { findTool } from '../lib/platform.js';
import { add, commit, pushOrPr, getRepoSlug } from '../lib/git.js';
import {
  getVisibility, isAdmin, getUserPlan,
  enablePages, setPagesVisibility, setRepoVisibility, disablePages, pagesExist, getPagesVisibility,
  repoUrl,
} from '../lib/github.js';
import { ConsoleLogger } from '../lib/logger.js';
import { VaultkitError, DEFAULT_MESSAGES } from '../lib/errors.js';
import { PROMPTS, LABELS } from '../lib/messages.js';
import { VAULT_FILES, VAULT_DIRS, WORKFLOW_FILES } from '../lib/constants.js';
import type { CommandModule, RunOptions } from '../types.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEPLOY_TMPL = join(SCRIPT_DIR, '../../lib/deploy.yml.tmpl');

export interface VisibilityOptions extends RunOptions {
  skipConfirm?: boolean;
}

export async function run(
  name: string,
  target: string,
  { cfgPath, log = new ConsoleLogger(), skipConfirm = false }: VisibilityOptions = {},
): Promise<void> {
  const validTargets = ['public', 'private', 'auth-gated'];
  if (!validTargets.includes(target)) {
    throw new VaultkitError('UNRECOGNIZED_INPUT', `Invalid mode '${target}'. Choose one of: public, private, auth-gated.`);
  }

  const vault = await Vault.tryFromName(name, cfgPath);
  if (!vault) throw new VaultkitError('NOT_REGISTERED', `"${name}" ${DEFAULT_MESSAGES.NOT_REGISTERED}`);

  if (!await findTool('gh')) {
    throw new VaultkitError('TOOL_MISSING', 'GitHub CLI (gh) is required for vaultkit visibility.');
  }

  const repoSlug = await getRepoSlug(vault.dir);
  if (!repoSlug) throw new VaultkitError('NOT_VAULT_LIKE', "Vault has no 'origin' remote — cannot determine GitHub repo.");

  const admin = await isAdmin(repoSlug).catch(() => false);
  if (!admin) throw new VaultkitError('PERMISSION_DENIED', `You don't have admin rights on ${repoSlug}.`);

  const currentVis = await getVisibility(repoSlug).catch(() => 'unknown');
  const hasPages = await pagesExist(repoSlug).catch(() => false);
  const pagesVis = hasPages ? await getPagesVisibility(repoSlug).catch(() => '?') : null;

  log.info(`Vault: ${name} (${repoSlug})`);
  log.info(`Current: repo=${currentVis}, pages=${hasPages ? (pagesVis ?? 'enabled') : 'disabled'}`);
  log.info(`Target:  ${target}`);
  log.info('');

  if (target === 'auth-gated') {
    const plan = await getUserPlan().catch(() => 'free');
    if (plan === 'free') {
      throw new Error(`auth-gated Pages requires GitHub Pro+ (your plan: ${plan}).`);
    }
  }

  const hasDeploy = existsSync(join(vault.dir, VAULT_DIRS.GITHUB_WORKFLOWS, WORKFLOW_FILES.DEPLOY));
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
    log.info(`Already ${target} — nothing to do.`);
    return;
  }

  log.info('Plan:');
  for (const a of actions) log.info(`  - ${a}`);
  log.info('');

  if (!skipConfirm) {
    const ok = await confirm({ message: PROMPTS.PROCEED, default: false });
    if (!ok) { log.info(LABELS.ABORTED); return; }
    log.info('');
  }

  let workflowAdded = false;

  if (needDeploy) {
    log.info('Adding deploy workflow...');
    const wfDir = join(vault.dir, VAULT_DIRS.GITHUB_WORKFLOWS);
    mkdirSync(wfDir, { recursive: true });
    copyFileSync(DEPLOY_TMPL, join(wfDir, WORKFLOW_FILES.DEPLOY));

    const [owner = '', repo = ''] = repoSlug.split('/');
    writeFileSync(join(vault.dir, VAULT_FILES.VAULT_JSON), renderVaultJson(owner, repo));
    workflowAdded = true;
  }

  // Execute visibility changes
  if (target === 'public') {
    if (currentVis !== 'public') {
      log.info('Setting repo to public...');
      await setRepoVisibility(repoSlug, 'public');
    }
    if (hasPages) {
      if (pagesVis !== 'public') {
        log.info('Setting Pages visibility to public...');
        await setPagesVisibility(repoSlug, 'public');
      }
    } else {
      log.info('Enabling Pages...');
      await enablePages(repoSlug);
    }
  } else if (target === 'private') {
    if (currentVis !== 'private') {
      log.info('Setting repo to private...');
      await setRepoVisibility(repoSlug, 'private');
    }
    if (hasPages) {
      log.info('Disabling Pages...');
      await disablePages(repoSlug);
    }
  } else { // auth-gated
    if (currentVis !== 'private') {
      log.info('Setting repo to private...');
      await setRepoVisibility(repoSlug, 'private');
    }
    if (hasPages) {
      if (pagesVis !== 'private') {
        log.info('Setting Pages visibility to private...');
        await setPagesVisibility(repoSlug, 'private');
      }
    } else {
      log.info('Enabling Pages with private visibility...');
      await enablePages(repoSlug);
      await setPagesVisibility(repoSlug, 'private');
    }
  }

  if (workflowAdded) {
    const filesToStage = [`${VAULT_DIRS.GITHUB_WORKFLOWS}/${WORKFLOW_FILES.DEPLOY}`, VAULT_FILES.VAULT_JSON];
    await add(vault.dir, filesToStage);
    await commit(vault.dir, 'chore: add Pages deploy workflow');
    const pushResult = await pushOrPr(vault.dir, {
      branchPrefix: 'vaultkit-pages',
      prTitle: 'chore: add Pages deploy workflow',
      prBody: 'Adds GitHub Pages deploy workflow.',
    });
    if (pushResult.mode === 'pr') {
      log.info(`Warning: Repo/Pages configured but workflow pending PR (branch: ${pushResult.branch}).`);
    }
  }

  log.info(`\n${repoUrl(repoSlug)}`);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string, string], VisibilityOptions, void> = { run };
void _module;
