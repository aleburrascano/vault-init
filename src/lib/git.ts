import { execa, type Options } from 'execa';
import { findTool } from './platform.js';
import { VaultkitError } from './errors.js';
import type { GitPushResult, GitPullResult, GitStatus, GitPushOrPrResult } from '../types.js';

/**
 * Recognize the GitHub "account abuse-flagged" failure mode in git/gh
 * stderr. When GitHub disables a freshly-created repo (typical aftermath
 * of secondary-rate-limit / abuse detection on the test PAT account),
 * the next git push/pull/clone returns 403 with this exact phrasing.
 *
 * Mirrors the pattern in `src/lib/github.ts:_classifyGhFailure` so both
 * paths surface the same actionable error.
 */
function isAccountFlaggedStderr(stderr: string): boolean {
  return /Repository '[^']+' is disabled\.|Please ask the owner to check their account\./i.test(stderr);
}

function throwAccountFlagged(operation: string): never {
  throw new VaultkitError(
    'AUTH_REQUIRED',
    `GitHub disabled the test repo — the account is likely abuse-flagged.\n` +
      `  Wait 24-72h for the flag to clear, or rotate VAULTKIT_TEST_GH_TOKEN to a fresh PAT account.\n` +
      `  (operation: ${operation})`,
  );
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

async function git(args: string[], dir: string, opts: Options = {}): Promise<GitResult> {
  const result = await execa('git', args, { cwd: dir, reject: false, ...opts });
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    exitCode: result.exitCode ?? 1,
    timedOut: result.timedOut ?? false,
  };
}

export async function init(dir: string): Promise<void> {
  const result = await execa('git', ['init', '-b', 'main', dir], { reject: false });
  if (result.exitCode !== 0) {
    // Older git doesn't support -b; fall back
    await execa('git', ['init', dir]);
  }
}

/**
 * Renames the current branch (`git branch -M <name>`). Used by `init`
 * after `git init` on git versions where `init -b main` wasn't honored.
 * `reject: false` matches the historical inline call — older git still
 * exits 0 here even if there's no commit yet.
 */
export async function setDefaultBranch(dir: string, branch: string): Promise<void> {
  await execa('git', ['-C', dir, 'branch', '-M', branch], { reject: false });
}

/**
 * Adds a named remote (`git remote add <name> <url>`). Used by `init`
 * to wire up `origin` after the GitHub repo is created.
 */
export async function addRemote(dir: string, name: string, url: string): Promise<void> {
  await execa('git', ['-C', dir, 'remote', 'add', name, url]);
}

export async function add(dir: string, files: string | string[]): Promise<void> {
  const fileArgs = Array.isArray(files) ? files : [files];
  await execa('git', ['-C', dir, 'add', ...fileArgs]);
}

export async function commit(dir: string, message: string): Promise<void> {
  await execa('git', ['-C', dir, 'commit', '-m', message]);
}

export async function push(dir: string): Promise<GitPushResult> {
  const result = await git(['push'], dir);
  return { success: result.exitCode === 0, stderr: result.stderr ?? '' };
}

/**
 * Push the local branch to `origin` immediately after the remote was created.
 * Retries any non-zero exit with exponential backoff (1s/2s/4s, 4 attempts).
 * GitHub has eventual consistency between `gh repo create` returning and the
 * new repo's git endpoints accepting pushes; the race surfaces through many
 * shapes — `Repository not found`, `RPC failed; HTTP 404`, `unexpected
 * disconnect`, `the remote end hung up`, etc. Rather than enumerate, treat
 * any failure on the first push as transient. Real misconfigurations
 * (wrong creds, missing branch) still surface after the retry budget.
 * Used by `init` after `[4/6] Creating GitHub repo`.
 */
export async function pushNewRepo(dir: string, branch: string = 'main'): Promise<void> {
  const args = ['-C', dir, 'push', '-u', 'origin', branch];
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    const result = await execa('git', args, { reject: false });
    if (result.exitCode === 0) return;
    const stderr = String(result.stderr ?? '');
    // Account abuse-flag (freshly-created repo disabled before push could
    // reach it). Won't recover in seconds — surface immediately as
    // AUTH_REQUIRED instead of burning the retry budget. See git.ts:isAccountFlaggedStderr.
    if (isAccountFlaggedStderr(stderr)) throwAccountFlagged(`git push origin/${branch}`);
    if (attempt >= delays.length) {
      throw new Error(`git push to origin/${branch} failed after ${delays.length + 1} attempts: ${stderr.trim() || `exit ${result.exitCode}`}`);
    }
    await new Promise<void>(r => setTimeout(r, delays[attempt] ?? 0));
  }
}

export interface PullOptions {
  timeout?: number;
  ffOnly?: boolean;
}

export async function pull(dir: string, { timeout = 30000, ffOnly = true }: PullOptions = {}): Promise<GitPullResult> {
  const headBefore = (await git(['rev-parse', 'HEAD'], dir)).stdout?.trim();

  const args = ['pull'];
  if (ffOnly) args.push('--ff-only');

  let result;
  try {
    result = await execa('git', args, {
      cwd: dir,
      reject: false,
      timeout,
    });
  } catch (err) {
    const e = err as { timedOut?: boolean; code?: string; message?: string };
    if (e.timedOut || e.code === 'ETIMEDOUT') {
      return { success: false, upToDate: false, timedOut: true, stderr: '' };
    }
    return { success: false, upToDate: false, timedOut: false, stderr: String(e.message ?? '') };
  }

  if (result.timedOut) {
    return { success: false, upToDate: false, timedOut: true, stderr: '' };
  }

  if (result.exitCode !== 0) {
    return { success: false, upToDate: false, timedOut: false, stderr: result.stderr ?? '' };
  }

  const headAfter = (await git(['rev-parse', 'HEAD'], dir)).stdout?.trim();
  const upToDate = headBefore === headAfter;

  return { success: true, upToDate, timedOut: false, stderr: result.stderr ?? '' };
}

export async function getStatus(dir: string): Promise<GitStatus> {
  const [branchRes, statusRes, remoteRes, logRes] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
    git(['status', '--porcelain'], dir),
    git(['remote', 'get-url', 'origin'], dir),
    git(['log', '-1', '--format=%h %s'], dir),
  ]);

  const branch = branchRes.stdout?.trim() ?? '';
  const dirty = (statusRes.stdout ?? '').trim().length > 0;
  const remote = remoteRes.exitCode === 0 ? (remoteRes.stdout?.trim() ?? null) : null;
  const lastCommit = logRes.exitCode === 0 ? (logRes.stdout?.trim() ?? null) : null;

  let ahead = 0;
  let behind = 0;
  if (remote) {
    const aheadRes = await git(['rev-list', '--count', 'origin/main..HEAD'], dir);
    const behindRes = await git(['rev-list', '--count', 'HEAD..origin/main'], dir);
    ahead = parseInt(aheadRes.stdout?.trim() ?? '0', 10) || 0;
    behind = parseInt(behindRes.stdout?.trim() ?? '0', 10) || 0;
  }

  return { branch, dirty, ahead, behind, lastCommit, remote };
}

export interface PushOrPrOptions {
  branchPrefix: string;
  prTitle: string;
  prBody: string;
}

export async function pushOrPr(dir: string, { branchPrefix, prTitle, prBody }: PushOrPrOptions): Promise<GitPushOrPrResult> {
  const directResult = await push(dir);
  if (directResult.success) return { mode: 'direct' };
  // `push()` already absorbed exit codes via reject:false. If the direct
  // push failed because the remote disabled the repo (abuse-flag), bail
  // out before we burn time creating a PR branch that will fail the same
  // way.
  if (isAccountFlaggedStderr(directResult.stderr)) throwAccountFlagged('git push origin/main');

  const timestamp = Date.now();
  const branch = `${branchPrefix}-${timestamp}`;

  await execa('git', ['-C', dir, 'branch', branch]);
  await execa('git', ['-C', dir, 'reset', '--hard', '@{u}'], { reject: false });
  await execa('git', ['-C', dir, 'checkout', branch]);

  // Branch push: small retry budget for transient races (eventual-consistency
  // RPC failures, ECONN*); fatal-on-first-detection for the abuse-flag case.
  const pushArgs = ['-C', dir, 'push', '-u', 'origin', branch];
  const pushDelays = [1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    const result = await execa('git', pushArgs, { reject: false });
    if (result.exitCode === 0) break;
    const stderr = String(result.stderr ?? '');
    if (isAccountFlaggedStderr(stderr)) throwAccountFlagged(`git push origin/${branch}`);
    if (attempt >= pushDelays.length) {
      throw new Error(`git push to origin/${branch} failed after ${pushDelays.length + 1} attempts: ${stderr.trim() || `exit ${result.exitCode}`}`);
    }
    await new Promise<void>(r => setTimeout(r, pushDelays[attempt] ?? 0));
  }

  const gh = await findTool('gh');
  if (gh) {
    const prResult = await execa(gh, [
      'pr', 'create',
      '--title', prTitle,
      '--body', prBody,
      '--base', 'main',
      '--head', branch,
    ], { cwd: dir, reject: false });
    if (prResult.exitCode !== 0 && isAccountFlaggedStderr(String(prResult.stderr ?? ''))) {
      throwAccountFlagged(`gh pr create --head ${branch}`);
    }
  }

  return { mode: 'pr', branch };
}

export async function archiveZip(dir: string, outputPath: string): Promise<void> {
  await execa('git', ['-C', dir, 'archive', '--format=zip', `--output=${outputPath}`, 'HEAD']);
}

export interface CloneOptions {
  useGh?: boolean;
}

export async function clone(repo: string, dest: string, { useGh = true }: CloneOptions = {}): Promise<void> {
  const gh = useGh ? await findTool('gh') : null;
  if (gh) {
    await execa(gh, ['repo', 'clone', repo, dest]);
  } else {
    await execa('git', ['clone', repo, dest]);
  }
}

/**
 * Resolves the GitHub `owner/repo` slug from the `origin` remote of a
 * local git checkout. Returns null if there is no origin or the URL is
 * not a recognised GitHub form. Pure read; never throws.
 *
 * Uses the `-C dir` argv form (rather than the internal `git()` helper's
 * `cwd:` option) to match the inline implementation that previously
 * lived in destroy.ts and visibility.ts — preserves test argv mocks.
 */
export async function getRepoSlug(dir: string): Promise<string | null> {
  const result = await execa('git', ['-C', dir, 'remote', 'get-url', 'origin'], { reject: false });
  if (result.exitCode !== 0) return null;
  const url = String(result.stdout ?? '').trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?\/?$/);
  return m?.[1] ?? null;
}
