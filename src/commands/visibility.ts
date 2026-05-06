import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { Vault } from '../lib/vault.js';
import { renderVaultJson } from '../lib/templates/vault-templates.js';
import { findTool } from '../lib/platform.js';
import { getDeployTemplate } from '../lib/templates/template-paths.js';
import { add, commit, pushOrPr, getRepoSlug } from '../lib/git.js';
import { getVisibility, isAdmin, setRepoVisibility, repoUrl } from '../lib/github/github-repo.js';
import { enablePages, setPagesVisibility, disablePages, pagesExist, getPagesVisibility } from '../lib/github/github-pages.js';
import { requireAuthGatedEligible } from '../lib/github/github-auth.js';
import { ConsoleLogger, type Logger } from '../lib/logger.js';
import { VaultkitError } from '../lib/errors.js';
import { PROMPTS, LABELS } from '../lib/messages.js';
import { VAULT_FILES, VAULT_DIRS, WORKFLOW_FILES, PUBLISH_MODES, isPublishMode, type PublishMode } from '../lib/constants.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface VisibilityOptions extends RunOptions {
  skipConfirm?: boolean;
}

/**
 * Discriminated union of atomic operations that change a vault's
 * publish visibility. Adding a new mode (or a new primitive operation)
 * means: extend this union, extend `describeAction` and `executeAction`,
 * and add a branch to `_buildVisibilityPlan`. The compiler enforces
 * exhaustiveness via the `never` check in each switch.
 */
export type VisibilityAction =
  | { kind: 'addDeployWorkflow' }
  | { kind: 'setRepoVisibility'; target: 'public' | 'private' }
  | { kind: 'enablePages' }
  | { kind: 'disablePages' }
  | { kind: 'setPagesVisibility'; target: 'public' | 'private' };

interface VisibilityState {
  target: PublishMode;
  currentVis: string;
  hasPages: boolean;
  pagesVis: string | null;
  needDeploy: boolean;
}

/**
 * Pure planner. Given the current repo + Pages state and a target mode,
 * returns the ordered list of atomic actions that move the repo into
 * that state. Empty list = already at target. Exported with underscore
 * prefix for unit testing only.
 */
export function _buildVisibilityPlan(state: VisibilityState): VisibilityAction[] {
  const actions: VisibilityAction[] = [];
  if (state.needDeploy) actions.push({ kind: 'addDeployWorkflow' });

  switch (state.target) {
    case 'public':
      if (state.currentVis !== 'public') actions.push({ kind: 'setRepoVisibility', target: 'public' });
      if (state.hasPages) {
        if (state.pagesVis !== 'public') actions.push({ kind: 'setPagesVisibility', target: 'public' });
      } else {
        actions.push({ kind: 'enablePages' });
      }
      break;
    case 'private':
      if (state.currentVis !== 'private') actions.push({ kind: 'setRepoVisibility', target: 'private' });
      if (state.hasPages) actions.push({ kind: 'disablePages' });
      break;
    case 'auth-gated':
      if (state.currentVis !== 'private') actions.push({ kind: 'setRepoVisibility', target: 'private' });
      if (state.hasPages) {
        if (state.pagesVis !== 'private') actions.push({ kind: 'setPagesVisibility', target: 'private' });
      } else {
        actions.push({ kind: 'enablePages' });
        actions.push({ kind: 'setPagesVisibility', target: 'private' });
      }
      break;
  }

  return actions;
}

function describeAction(action: VisibilityAction): string {
  switch (action.kind) {
    case 'addDeployWorkflow': return 'add .github/workflows/deploy.yml + _vault.json';
    case 'setRepoVisibility': return `flip repo to ${action.target}`;
    case 'enablePages': return 'enable Pages (workflow source)';
    case 'disablePages': return 'disable Pages site';
    case 'setPagesVisibility': return `set Pages visibility to ${action.target}`;
  }
}

interface ExecuteCtx {
  repoSlug: string;
  vaultDir: string;
  log: Logger;
}

async function executeAction(action: VisibilityAction, ctx: ExecuteCtx): Promise<void> {
  const { repoSlug, vaultDir, log } = ctx;
  switch (action.kind) {
    case 'addDeployWorkflow': {
      log.info('Adding deploy workflow...');
      const wfDir = join(vaultDir, VAULT_DIRS.GITHUB_WORKFLOWS);
      mkdirSync(wfDir, { recursive: true });
      copyFileSync(getDeployTemplate(), join(wfDir, WORKFLOW_FILES.DEPLOY));
      const [owner, repo, ...rest] = repoSlug.split('/');
      if (!owner || !repo || rest.length > 0) {
        throw new VaultkitError('UNRECOGNIZED_INPUT', `Malformed repo slug '${repoSlug}'; expected 'owner/repo'.`);
      }
      writeFileSync(join(vaultDir, VAULT_FILES.VAULT_JSON), renderVaultJson(owner, repo));
      return;
    }
    case 'setRepoVisibility':
      log.info(`Setting repo to ${action.target}...`);
      await setRepoVisibility(repoSlug, action.target);
      return;
    // Pages-related actions match init.ts:setupGitHubPages: warn + manual
    // hint on failure rather than aborting the whole command. The
    // visibility flip itself is the user's primary intent; Pages is
    // secondary, and on Free-tier accounts a private→public flip can
    // surface an "Your current plan does not support GitHub Pages"
    // 422 from Pages-auth's stale visibility cache (see
    // gh-retry.ts:_classifyGhFailure for the propagation-race retry).
    // Failing the whole command would leave the repo correctly flipped
    // but the user staring at an error — better to log the gap and
    // give them the manual recovery URL.
    case 'enablePages':
      log.info('Enabling Pages...');
      try {
        await enablePages(repoSlug);
      } catch (err) {
        log.warn(`  Could not auto-enable GitHub Pages: ${err instanceof Error ? err.message : String(err)}`);
        log.info(`  Enable manually: ${repoUrl(repoSlug, 'settings/pages')}`);
      }
      return;
    case 'disablePages':
      log.info('Disabling Pages...');
      try {
        await disablePages(repoSlug);
      } catch (err) {
        log.warn(`  Could not auto-disable GitHub Pages: ${err instanceof Error ? err.message : String(err)}`);
        log.info(`  Disable manually: ${repoUrl(repoSlug, 'settings/pages')}`);
      }
      return;
    case 'setPagesVisibility':
      log.info(`Setting Pages visibility to ${action.target}...`);
      try {
        await setPagesVisibility(repoSlug, action.target);
      } catch (err) {
        log.warn(`  Could not set Pages visibility to ${action.target}: ${err instanceof Error ? err.message : String(err)}`);
        log.info(`  Set manually: ${repoUrl(repoSlug, 'settings/pages')}`);
      }
      return;
  }
}

export async function run(
  name: string,
  target: string,
  { cfgPath, log = new ConsoleLogger(), skipConfirm = false }: VisibilityOptions = {},
): Promise<void> {
  if (!isPublishMode(target)) {
    throw new VaultkitError('UNRECOGNIZED_INPUT', `Invalid mode '${target}'. Choose one of: ${PUBLISH_MODES.join(', ')}.`);
  }

  const vault = await Vault.requireFromName(name, cfgPath);

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
    await requireAuthGatedEligible();
  }

  const hasDeploy = existsSync(join(vault.dir, VAULT_DIRS.GITHUB_WORKFLOWS, WORKFLOW_FILES.DEPLOY));
  const needDeploy = (target === 'public' || target === 'auth-gated') && !hasDeploy;

  const actions = _buildVisibilityPlan({ target, currentVis, hasPages, pagesVis, needDeploy });

  if (actions.length === 0) {
    log.info(`Already ${target} — nothing to do.`);
    return;
  }

  log.info('Plan:');
  for (const a of actions) log.info(`  - ${describeAction(a)}`);
  log.info('');

  if (!skipConfirm) {
    const ok = await confirm({ message: PROMPTS.PROCEED, default: false });
    if (!ok) { log.info(LABELS.ABORTED); return; }
    log.info('');
  }

  for (const action of actions) {
    await executeAction(action, { repoSlug, vaultDir: vault.dir, log });
  }

  if (actions.some(a => a.kind === 'addDeployWorkflow')) {
    const filesToStage = [`${VAULT_DIRS.GITHUB_WORKFLOWS}/${WORKFLOW_FILES.DEPLOY}`, VAULT_FILES.VAULT_JSON];
    await add(vault.dir, filesToStage);
    await commit(vault.dir, 'chore: add Pages deploy workflow');
    const pushResult = await pushOrPr(vault.dir, {
      branchPrefix: 'vaultkit-pages',
      prTitle: 'chore: add Pages deploy workflow',
      prBody: 'Adds GitHub Pages deploy workflow.',
    });
    if (pushResult.mode === 'pr') {
      log.warn(`Repo/Pages configured but workflow pending PR (branch: ${pushResult.branch}).`);
    }
  }

  log.info(`\n${repoUrl(repoSlug)}`);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string, string], VisibilityOptions, void> = { run };
void _module;
