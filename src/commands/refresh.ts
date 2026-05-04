import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { Vault, isVaultLike } from '../lib/vault.js';
import { VAULT_DIRS } from '../lib/constants.js';
import { VaultkitError } from '../lib/errors.js';
import { compareSource } from '../lib/text-compare.js';
import { findTool } from '../lib/platform.js';
import { getCommitsSince } from '../lib/github-repo.js';
import { ConsoleLogger } from '../lib/logger.js';
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

interface SourceEntry {
  /** Vault-relative path, e.g. `raw/articles/foo.md`. Forward-slash always. */
  filePath: string;
  url: string;
  sourceDate: string | null;
  body: string;
}

interface GitCheck {
  kind: 'git';
  entry: SourceEntry;
  slug: string;
  newCommits: number;
  recentSubjects: string[];
  error?: string;
}

interface ComparedCheck {
  kind: 'compared';
  entry: SourceEntry;
  similarity: number;
}

interface UnfetchableCheck {
  kind: 'unfetchable';
  entry: SourceEntry;
  reason: string;
}

interface NoUrlCheck {
  kind: 'no-url';
  entry: SourceEntry;
}

type CheckResult = GitCheck | ComparedCheck | UnfetchableCheck | NoUrlCheck;

export const SIMILARITY_THRESHOLD = 0.95;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { fm: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv?.[1] !== undefined && kv[2] !== undefined) {
      fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: content.slice(m[0].length) };
}

export function detectGithubSlug(url: string): string | null {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/\s]+)\/([^/\s.#?]+)/i);
  if (!m?.[1] || !m[2]) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
}

/**
 * Pure classification of a source entry's URL. Decouples the "what kind
 * of upstream is this" decision from the I/O paths that act on it
 * (`checkGitSource` for git, `compareSource` for web). Tests can pin the
 * decision matrix without mocking the network or `gh`.
 */
export type SourceClassification =
  | { kind: 'no-url' }
  | { kind: 'git'; slug: string; url: string }
  | { kind: 'web'; url: string };

export function classifySource(entry: SourceEntry): SourceClassification {
  if (!entry.url) return { kind: 'no-url' };
  const slug = detectGithubSlug(entry.url);
  if (slug) return { kind: 'git', slug, url: entry.url };
  return { kind: 'web', url: entry.url };
}

function* walkMarkdown(rootDir: string, currentRel: string = ''): Generator<{ rel: string; full: string }> {
  let entries;
  try {
    entries = readdirSync(currentRel ? join(rootDir, currentRel) : rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walkMarkdown(rootDir, childRel);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield { rel: childRel, full: join(rootDir, childRel) };
    }
  }
}

export function loadSources(vaultDir: string): SourceEntry[] {
  const rawRoot = join(vaultDir, VAULT_DIRS.RAW);
  if (!existsSync(rawRoot)) return [];
  const sources: SourceEntry[] = [];
  for (const file of walkMarkdown(rawRoot)) {
    let content: string;
    try { content = readFileSync(file.full, 'utf8'); } catch { continue; }
    const { fm, body } = parseFrontmatter(content);
    const url = fm.source ?? fm.url ?? fm.source_path ?? '';
    const sourceDate = fm.source_date ?? fm.created ?? fm.clipped ?? null;
    sources.push({
      filePath: posix.join(VAULT_DIRS.RAW, file.rel),
      url,
      sourceDate,
      body,
    });
  }
  return sources;
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

export function formatReport(checks: CheckResult[], date: string): { report: string; findingCount: number } {
  const gits = checks.filter((c): c is GitCheck => c.kind === 'git');
  const compareds = checks.filter((c): c is ComparedCheck => c.kind === 'compared');
  const unfetchables = checks.filter((c): c is UnfetchableCheck => c.kind === 'unfetchable');
  const noUrls = checks.filter((c): c is NoUrlCheck => c.kind === 'no-url');

  const changedGits = gits.filter(g => !g.error && g.newCommits > 0);
  const erroredGits = gits.filter(g => g.error);
  const driftedCompares = compareds.filter(c => c.similarity < SIMILARITY_THRESHOLD);

  const findingCount =
    changedGits.length + driftedCompares.length + unfetchables.length + erroredGits.length + noUrls.length;

  const lines: string[] = [`# Freshness report — ${date}`, ''];

  if (findingCount === 0) {
    lines.push('No upstream changes detected. All sources unchanged.', '');
    return { report: lines.join('\n'), findingCount };
  }

  if (changedGits.length > 0) {
    lines.push('## Sources auto-checked (git)', '');
    for (const g of changedGits) {
      lines.push(`### ${g.slug}`);
      lines.push(`- Source URL: ${g.entry.url}`);
      lines.push(`- Local file: \`${g.entry.filePath}\``);
      if (g.entry.sourceDate) lines.push(`- Last clipped: ${g.entry.sourceDate}`);
      lines.push(`- New commits since clip: ${g.newCommits}`);
      if (g.recentSubjects.length > 0) {
        lines.push('- Recent commits:');
        for (const s of g.recentSubjects) lines.push(`  - ${s}`);
      }
      lines.push('');
    }
  }

  if (driftedCompares.length > 0) {
    lines.push('## Sources auto-checked (text-only compare)', '');
    for (const c of driftedCompares) {
      lines.push(`### ${c.entry.url}`);
      lines.push(`- Local file: \`${c.entry.filePath}\``);
      if (c.entry.sourceDate) lines.push(`- Last clipped: ${c.entry.sourceDate}`);
      lines.push(`- Similarity: ${(c.similarity * 100).toFixed(0)}% (likely changed)`);
      lines.push('');
    }
  }

  if (unfetchables.length + erroredGits.length > 0) {
    lines.push("## Sources couldn't auto-check (manual review)", '');
    for (const u of unfetchables) {
      lines.push(`- \`${u.entry.filePath}\` → ${u.entry.url} (${u.reason})`);
    }
    for (const g of erroredGits) {
      lines.push(`- \`${g.entry.filePath}\` → ${g.slug} (gh API: ${g.error})`);
    }
    lines.push('');
  }

  if (noUrls.length > 0) {
    lines.push('## Sources without a URL in frontmatter', '');
    for (const n of noUrls) {
      lines.push(`- \`${n.entry.filePath}\` (no \`source\`/\`url\`/\`source_path\` field)`);
    }
    lines.push('');
  }

  lines.push('---', '');
  lines.push('When patching, follow the "Wiki Style & Refresh Policy" section in CLAUDE.md.');
  lines.push('Scope edits to wiki pages whose `sources:` frontmatter cites the affected source.');
  lines.push('For sources in the "manual review" section, use WebFetch in your Obsidian session and patch only on meaningful semantic difference.');
  lines.push('');

  return { report: lines.join('\n'), findingCount };
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
