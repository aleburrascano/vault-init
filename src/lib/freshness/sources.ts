import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { VAULT_DIRS } from '../constants.js';

/**
 * Frontmatter parsing, source classification, and `raw/` walking — the
 * "input" half of the freshness pipeline. Pure read-only operations
 * (fs reads, regex parsing, no network); the I/O side (gh API,
 * compareSource) lives in the caller. Decoupled from `refresh.ts`
 * (per the SRP framing in ADR-0007's sister ADR — captured in
 * docs/decisions when this module ships) so each piece changes for
 * one reason.
 */

/** A single markdown source under `raw/`, with its parsed frontmatter URL/date. */
export interface SourceEntry {
  /** Vault-relative path, e.g. `raw/articles/foo.md`. Forward-slash always. */
  filePath: string;
  url: string;
  sourceDate: string | null;
  body: string;
}

/** Pure classification of a source URL — no network, no gh calls. */
export type SourceClassification =
  | { kind: 'no-url' }
  | { kind: 'git'; slug: string; url: string }
  | { kind: 'web'; url: string };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * Parse the YAML-ish frontmatter at the top of a markdown file. Returns the
 * key/value pairs (always strings; quotes stripped) and the body without the
 * frontmatter delimiter block. Tolerant of CRLF; strict about the opening
 * `---` (no permissive `+++` or trailing whitespace handling).
 */
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

/**
 * Extract a `owner/repo` slug from a GitHub URL (HTTPS / SSH / shorthand).
 * Returns null for any URL that isn't a recognizable GitHub repo URL — the
 * caller can then fall back to web-compare. Tolerant of `.git` suffix and
 * extra path/query/fragment segments.
 */
export function detectGithubSlug(url: string): string | null {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/\s]+)\/([^/\s.#?]+)/i);
  if (!m?.[1] || !m[2]) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
}

/**
 * Classify a source entry by its frontmatter URL. Pure (no I/O); decouples
 * the "what kind of upstream is this" decision from the action (`gh api` vs
 * `compareSource`). Tests can pin the decision matrix without mocking either.
 */
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

/**
 * Walk a vault's `raw/` tree, parse each markdown file's frontmatter, and
 * return the typed `SourceEntry[]`. Skips files with read errors silently
 * (a corrupt file shouldn't block the whole refresh — the report just
 * won't list it). Empty array if `raw/` doesn't exist.
 */
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
