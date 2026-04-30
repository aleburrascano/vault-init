import { execa, type Options } from 'execa';
import { findTool } from './platform.js';
import type { GitPushResult, GitPullResult, GitStatus, GitPushOrPrResult } from '../types.js';

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

  const timestamp = Date.now();
  const branch = `${branchPrefix}-${timestamp}`;

  await execa('git', ['-C', dir, 'branch', branch]);
  await execa('git', ['-C', dir, 'reset', '--hard', '@{u}'], { reject: false });
  await execa('git', ['-C', dir, 'checkout', branch]);
  await execa('git', ['-C', dir, 'push', '-u', 'origin', branch]);

  const gh = await findTool('gh');
  if (gh) {
    await execa(gh, [
      'pr', 'create',
      '--title', prTitle,
      '--body', prBody,
      '--base', 'main',
      '--head', branch,
    ], { cwd: dir, reject: false });
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
