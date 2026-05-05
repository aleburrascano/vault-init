import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Vault, isVaultLike } from '../lib/vault.js';
import { VAULT_DIRS } from '../lib/constants.js';
import { VaultkitError } from '../lib/errors.js';
import { compareSource } from '../lib/text-compare.js';
import { findTool } from '../lib/platform.js';
import { getCommitsSince } from '../lib/github/github-repo.js';
import { ConsoleLogger } from '../lib/logger.js';
import {
  loadSources,
  classifySource,
  type SourceEntry,
} from '../lib/freshness/sources.js';
import {
  formatReport,
  type CheckResult,
  type GitCheck,
} from '../lib/freshness/report.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface RefreshOptions extends RunOptions {
  /** Bypass the registry and operate on this directory. Used by CI. */
  vaultDir?: string;
}

export interface RefreshResult {
  reportPath: string | null;
  sourceCount: number;
  findingCount: number;
}

async function checkGitSource(entry: SourceEntry, slug: string): Promise<GitCheck> {
  try {
    const commits = await getCommitsSince(slug, entry.sourceDate ?? undefined);
    const subjects = commits.map(c => c.subject);
    return { kind: 'git', entry, slug, newCommits: commits.length, recentSubjects: subjects.slice(0, 5) };
  } catch (err) {
    const msg = (err as { message?: string })?.message ?? String(err);
    return { kind: 'git', entry, slug, newCommits: 0, recentSubjects: [], error: msg };
  }
}

async function checkSource(entry: SourceEntry, ghAvailable: boolean): Promise<CheckResult> {
  const cls = classifySource(entry);
  if (cls.kind === 'no-url') return { kind: 'no-url', entry };
  if (cls.kind === 'git' && ghAvailable) return checkGitSource(entry, cls.slug);
  const result = await compareSource(cls.url, entry.body);
  if (result.kind === 'compared') return { kind: 'compared', entry, similarity: result.similarity };
  return { kind: 'unfetchable', entry, reason: result.reason };
}

export async function run(
  name: string | undefined,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const log = options.log ?? new ConsoleLogger();
  let vaultDir: string;
  if (options.vaultDir) {
    // --vault-dir is direct user input. Resolve to absolute and require
    // a vault-like layout so refresh refuses to walk arbitrary paths
    // (e.g. `--vault-dir /etc`) or write a freshness report into them.
    const resolvedDir = resolve(options.vaultDir);
    if (!isVaultLike(resolvedDir)) {
      throw new VaultkitError(
        'NOT_VAULT_LIKE',
        `--vault-dir ${resolvedDir} is not a vault directory.`,
      );
    }
    vaultDir = resolvedDir;
  } else if (name) {
    const vault = await Vault.requireFromName(name);
    vaultDir = vault.dir;
  } else {
    throw new Error('vaultkit refresh: provide a vault name or --vault-dir <path>');
  }

  const sources = loadSources(vaultDir);
  log.info(`Found ${sources.length} source${sources.length === 1 ? '' : 's'} under raw/.`);
  if (sources.length === 0) {
    return { reportPath: null, sourceCount: 0, findingCount: 0 };
  }

  const ghAvailable = (await findTool('gh')) !== null;
  const checks = await Promise.all(sources.map(s => checkSource(s, ghAvailable)));

  const date = new Date().toISOString().slice(0, 10);
  const { report, findingCount } = formatReport(checks, date);

  if (findingCount === 0) {
    log.info('No upstream changes detected. Skipping report.');
    return { reportPath: null, sourceCount: sources.length, findingCount: 0 };
  }

  const reportDir = join(vaultDir, VAULT_DIRS.WIKI, '_freshness');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${date}.md`);
  writeFileSync(reportPath, report);
  log.info(`Freshness report written: ${reportPath} (${findingCount} finding${findingCount === 1 ? '' : 's'})`);

  return { reportPath, sourceCount: sources.length, findingCount };
}

const _module: CommandModule<[string | undefined], RefreshOptions, RefreshResult> = { run };
void _module;
