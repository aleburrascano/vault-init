import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseFrontmatter,
  detectGithubSlug,
  classifySource,
  loadSources,
} from '../../src/lib/freshness/sources.js';
import {
  formatReport,
  SIMILARITY_THRESHOLD,
} from '../../src/lib/freshness/report.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-refresh-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
  it('extracts simple key:value pairs', () => {
    const out = parseFrontmatter('---\ntitle: Hello\nsource: https://x.com\n---\nbody here');
    expect(out.fm).toEqual({ title: 'Hello', source: 'https://x.com' });
    expect(out.body).toBe('body here');
  });

  it('strips quotes around values', () => {
    const out = parseFrontmatter('---\nsource: "https://x.com"\nauthor: \'Alice\'\n---\n');
    expect(out.fm.source).toBe('https://x.com');
    expect(out.fm.author).toBe('Alice');
  });

  it('returns empty fm when no frontmatter', () => {
    const out = parseFrontmatter('Just body, no frontmatter\n');
    expect(out.fm).toEqual({});
    expect(out.body).toBe('Just body, no frontmatter\n');
  });

  it('handles CRLF line endings', () => {
    const out = parseFrontmatter('---\r\nsource: https://x.com\r\n---\r\nbody');
    expect(out.fm.source).toBe('https://x.com');
    expect(out.body).toBe('body');
  });

  it('does NOT strip a UTF-8 BOM at the start of the file (regex is anchored at ^---)', () => {
    // Files saved by Notepad / PowerShell on Windows commonly include a BOM.
    // The current regex `^---\r?\n([\s\S]*?)\r?\n---\r?\n/` is anchored at
    // `^---` and does NOT match a leading BOM. Pin this so the unanchored-
    // BOM behavior is a deliberate choice — if BOM tolerance is added, this
    // test surfaces the change in the diff.
    const out = parseFrontmatter('﻿---\nsource: https://x.com\n---\nbody');
    expect(out.fm).toEqual({});
    expect(out.body).toBe('﻿---\nsource: https://x.com\n---\nbody');
  });

  it('returns empty fm when frontmatter has no closing newline after ---', () => {
    // Common with ad-hoc clipboard-pasted clips that lack a final newline.
    // The regex requires `\r?\n` after the closing `---`, so this case
    // does NOT match → fm={} body=full. Pin the current behavior.
    const out = parseFrontmatter('---\nsource: https://x.com\n---');
    expect(out.fm).toEqual({});
    expect(out.body).toBe('---\nsource: https://x.com\n---');
  });

  it('returns empty fm when frontmatter delimiters touch without a body separator', () => {
    // `---\n---\n` lacks the inner `\n` separator the regex needs (the
    // pattern `\n---\n` requires content before it). Pin no-match.
    const out = parseFrontmatter('---\n---\nbody');
    expect(out.fm).toEqual({});
    expect(out.body).toBe('---\n---\nbody');
  });
});

describe('detectGithubSlug', () => {
  it('extracts owner/repo from https URL', () => {
    expect(detectGithubSlug('https://github.com/aleburrascano/vaultkit')).toBe('aleburrascano/vaultkit');
  });

  it('strips trailing .git', () => {
    expect(detectGithubSlug('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('extracts from SSH form', () => {
    expect(detectGithubSlug('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  it('returns null for non-github URLs', () => {
    expect(detectGithubSlug('https://example.com/foo')).toBeNull();
    expect(detectGithubSlug('https://gitlab.com/owner/repo')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(detectGithubSlug('')).toBeNull();
  });

  it('handles deep paths', () => {
    expect(detectGithubSlug('https://github.com/owner/repo/blob/main/README.md')).toBe('owner/repo');
  });

  it('strips query strings and fragments via the regex stop chars', () => {
    // The regex's repo-capture class is [^/\s.#?]+ — any of /, ., #, ? terminates
    // the repo name, so query strings and fragments don't leak into the slug.
    expect(detectGithubSlug('https://github.com/owner/repo?tab=readme')).toBe('owner/repo');
    expect(detectGithubSlug('https://github.com/owner/repo#installation')).toBe('owner/repo');
    expect(detectGithubSlug('https://github.com/owner/repo?tab=readme#installation')).toBe('owner/repo');
  });

  it('matches case-insensitively (per the /i flag)', () => {
    // Real-world URLs are lowercase, but pin the documented case-insensitivity
    // so a future regex change without /i surfaces explicitly.
    expect(detectGithubSlug('https://GITHUB.COM/owner/repo')).toBe('owner/repo');
  });

  it('matches the FIRST github.com substring when multiple appear', () => {
    // Defense-in-depth: a URL containing two github.com sequences (e.g. via
    // an open redirect or fragment) should extract the first match. Pinning
    // current behavior so an attacker-supplied URL with `?next=https://github.com/evil/repo`
    // can't smuggle through.
    expect(
      detectGithubSlug('https://example.com/r?next=https://github.com/evil/payload'),
    ).toBe('evil/payload');
    // Subdomain match: gist.github.com matches the regex (no host-anchor).
    // This pins current behavior — if anchoring is added later, this test
    // surfaces the change.
    expect(detectGithubSlug('https://gist.github.com/owner/repo')).toBe('owner/repo');
  });

  it('rejects whitespace in the owner segment but truncates whitespace in the repo segment', () => {
    // Owner segment uses [^/\s]+ — whitespace in owner is fatal (no match).
    expect(detectGithubSlug('https://github.com/own er/repo')).toBeNull();
    // Repo segment uses [^/\s.#?]+ — whitespace stops the match early but
    // the prefix-match still produces a valid slug. Pin this behavior.
    expect(detectGithubSlug('https://github.com/owner/re po')).toBe('owner/re');
  });

  it('passes shell-meta characters through verbatim (relies on execa argv form for safety)', () => {
    // The repo class [^/\s.#?]+ excludes /, whitespace, ., #, ? — but does
    // NOT exclude ', ", ;, &, $, `. A URL with shell-meta in the repo name
    // produces a slug containing those chars verbatim, which then becomes
    // the path segment in `gh api repos/<slug>/commits` (refresh.ts:139).
    // execa's array form is shell-safe (no /bin/sh), but pin this so a
    // regression to `execa.command()` (string form) breaks loudly.
    // Repo capture continues until /, whitespace, or one of . # ? — so the
    // shell-meta chars survive into the slug. Pin the actual values:
    expect(detectGithubSlug("https://github.com/owner/repo'; ls")).toBe("owner/repo';");
    expect(detectGithubSlug('https://github.com/owner/repo$VAR')).toBe('owner/repo$VAR');
    expect(detectGithubSlug('https://github.com/owner/repo;rm')).toBe('owner/repo;rm');
  });

  it('preserves embedded basic-auth credentials in the matched slug-host substring (latent leak risk)', () => {
    // A URL with `user:pass@github.com/owner/repo` matches because the regex
    // doesn't anchor on host. The slug returned is just `owner/repo`, but
    // the credential-bearing URL string is what gets written into the
    // freshness report (refresh.ts:191 logs `Source URL: ${g.entry.url}`).
    // This pins the slug-extraction behavior and flags the credential leak
    // as a known property of the entry.url surface — addressing the leak
    // requires sanitizing entry.url at format-report time, not here.
    expect(detectGithubSlug('https://user:pass@github.com/owner/repo')).toBe('owner/repo');
  });
});

describe('loadSources', () => {
  it('returns empty array when raw/ does not exist', () => {
    expect(loadSources(tmp)).toEqual([]);
  });

  it('walks raw/ recursively and parses frontmatter', () => {
    mkdirSync(join(tmp, 'raw', 'articles'), { recursive: true });
    mkdirSync(join(tmp, 'raw', 'papers'), { recursive: true });
    writeFileSync(join(tmp, 'raw', 'articles', 'one.md'),
      '---\nsource: https://github.com/owner/repo\nsource_date: 2026-04-01\n---\nbody one');
    writeFileSync(join(tmp, 'raw', 'papers', 'two.md'),
      '---\nsource: https://arxiv.org/abs/1234\n---\nbody two');
    writeFileSync(join(tmp, 'raw', 'articles', 'noFrontmatter.md'), 'just body');

    const sources = loadSources(tmp);
    expect(sources.length).toBe(3);
    const byPath = Object.fromEntries(sources.map(s => [s.filePath, s]));
    expect(byPath['raw/articles/one.md']?.url).toBe('https://github.com/owner/repo');
    expect(byPath['raw/articles/one.md']?.sourceDate).toBe('2026-04-01');
    expect(byPath['raw/articles/one.md']?.body).toBe('body one');
    expect(byPath['raw/papers/two.md']?.url).toBe('https://arxiv.org/abs/1234');
    expect(byPath['raw/articles/noFrontmatter.md']?.url).toBe('');
  });

  it('skips non-markdown files', () => {
    mkdirSync(join(tmp, 'raw'), { recursive: true });
    writeFileSync(join(tmp, 'raw', 'image.png'), 'binary');
    writeFileSync(join(tmp, 'raw', 'note.md'), '---\nsource: https://x.com\n---\nbody');
    const sources = loadSources(tmp);
    expect(sources.length).toBe(1);
    expect(sources[0]?.filePath).toBe('raw/note.md');
  });

  it('uses forward-slash paths regardless of platform', () => {
    mkdirSync(join(tmp, 'raw', 'a', 'b'), { recursive: true });
    writeFileSync(join(tmp, 'raw', 'a', 'b', 'deep.md'), '---\nsource: x\n---\nbody');
    const sources = loadSources(tmp);
    expect(sources[0]?.filePath).toBe('raw/a/b/deep.md');
  });
});

describe('loadSources — symlink safety', () => {
  it('does NOT follow symlinks pointing OUT of the vault (relies on Dirent.isFile() being lstat-based)', () => {
    // Defensive pin: walkMarkdown branches on `entry.isDirectory()` and
    // `entry.isFile()`. Both come from readdirSync's Dirent which is
    // populated via lstat (not stat), so a symlink is neither — meaning
    // the loop SKIPS symlinks regardless of what they point at. A future
    // refactor that switches to readdirSync({recursive: true}) or that
    // calls statSync on entries would silently start following links,
    // and a malicious vault with `raw/leak → /etc` could get the contents
    // of system files into the freshness report.
    const escapeDir = mkdtempSync(join(tmpdir(), 'vk-refresh-escape-'));
    writeFileSync(join(escapeDir, 'leaked.md'),
      '---\nsource: https://example.com\n---\nleaked content from outside vault');

    mkdirSync(join(tmp, 'raw'), { recursive: true });
    // Real-world content lives alongside the symlink — should still load.
    writeFileSync(join(tmp, 'raw', 'real.md'),
      '---\nsource: https://github.com/owner/repo\n---\nreal vault content');

    try {
      // junction works for directories on Windows without elevated perms;
      // 'dir' tells Node to use SYMLINK_TYPE_DIR on Windows / a directory
      // symlink on POSIX. EPERM happens on Windows without Developer Mode.
      symlinkSync(escapeDir, join(tmp, 'raw', 'escape'), 'junction');
    } catch (err) {
      if ((err as { code?: string }).code === 'EPERM' || (err as { code?: string }).code === 'EEXIST') {
        rmSync(escapeDir, { recursive: true, force: true });
        return; // skip the test on systems where we can't create the link
      }
      rmSync(escapeDir, { recursive: true, force: true });
      throw err;
    }

    const sources = loadSources(tmp);
    rmSync(escapeDir, { recursive: true, force: true });

    // The symlink's target file MUST NOT appear among loaded sources.
    expect(sources.find(s => s.body.includes('leaked content from outside vault'))).toBeUndefined();
    // The legitimate raw/real.md MUST still be loaded.
    expect(sources.find(s => s.body.includes('real vault content'))).toBeDefined();
  });
});

describe('classifySource — pure URL classifier', () => {
  const entry = (url: string) => ({ filePath: 'raw/x.md', url, sourceDate: null, body: '' });

  it('returns no-url when entry has no URL', () => {
    expect(classifySource(entry(''))).toEqual({ kind: 'no-url' });
  });

  it('classifies a github.com URL as git with the parsed slug', () => {
    expect(classifySource(entry('https://github.com/owner/repo'))).toEqual({
      kind: 'git',
      slug: 'owner/repo',
      url: 'https://github.com/owner/repo',
    });
  });

  it('strips .git suffix when classifying', () => {
    expect(classifySource(entry('https://github.com/owner/repo.git'))).toEqual({
      kind: 'git',
      slug: 'owner/repo',
      url: 'https://github.com/owner/repo.git',
    });
  });

  it('classifies a non-github URL as web', () => {
    expect(classifySource(entry('https://arxiv.org/abs/1234.5678'))).toEqual({
      kind: 'web',
      url: 'https://arxiv.org/abs/1234.5678',
    });
  });

  it('classifies a github sub-page (issues / wiki) as git when the slug parses', () => {
    expect(classifySource(entry('https://github.com/owner/repo/issues/42'))).toEqual({
      kind: 'git',
      slug: 'owner/repo',
      url: 'https://github.com/owner/repo/issues/42',
    });
  });
});

describe('formatReport', () => {
  const today = '2026-05-02';

  it('emits "no changes" report when there are no findings', () => {
    const { report, findingCount } = formatReport([], today);
    expect(findingCount).toBe(0);
    expect(report).toContain('No upstream changes detected');
  });

  it('counts changed git sources as findings', () => {
    const { findingCount, report } = formatReport([
      {
        kind: 'git',
        entry: { filePath: 'raw/x.md', url: 'https://github.com/o/r', sourceDate: '2026-04-01', body: '' },
        slug: 'o/r',
        newCommits: 3,
        recentSubjects: ['Add feature', 'Fix bug'],
      },
    ], today);
    expect(findingCount).toBe(1);
    expect(report).toContain('## Sources auto-checked (git)');
    expect(report).toContain('o/r');
    expect(report).toContain('New commits since clip: 3');
    expect(report).toContain('- Add feature');
  });

  it('skips git sources with no new commits and no error', () => {
    const { findingCount } = formatReport([
      {
        kind: 'git',
        entry: { filePath: 'raw/x.md', url: 'https://github.com/o/r', sourceDate: null, body: '' },
        slug: 'o/r',
        newCommits: 0,
        recentSubjects: [],
      },
    ], today);
    expect(findingCount).toBe(0);
  });

  it('treats text-compare similarity below threshold as a finding', () => {
    const { findingCount, report } = formatReport([
      {
        kind: 'compared',
        entry: { filePath: 'raw/y.md', url: 'https://example.com/article', sourceDate: null, body: '' },
        similarity: 0.7,
      },
    ], today);
    expect(findingCount).toBe(1);
    expect(report).toContain('## Sources auto-checked (text-only compare)');
    expect(report).toContain('70%');
  });

  it('does not report compared sources above the similarity threshold', () => {
    const { findingCount } = formatReport([
      {
        kind: 'compared',
        entry: { filePath: 'raw/y.md', url: 'https://example.com', sourceDate: null, body: '' },
        similarity: 0.99,
      },
    ], today);
    expect(findingCount).toBe(0);
  });

  it('treats similarity exactly at the threshold (0.95) as NOT drifted (strict-less-than)', () => {
    // The check at refresh.ts:175 is `c.similarity < SIMILARITY_THRESHOLD`,
    // strict less-than. A future flip to `<=` would silently start
    // reporting sources at exactly 0.95 as drifted. Pin the boundary.
    const { findingCount } = formatReport([
      {
        kind: 'compared',
        entry: { filePath: 'raw/y.md', url: 'https://example.com', sourceDate: null, body: '' },
        similarity: SIMILARITY_THRESHOLD,
      },
    ], today);
    expect(findingCount).toBe(0);
  });

  it('treats similarity exactly 1.0 as NOT drifted', () => {
    // Identical content. Must not be reported.
    const { findingCount } = formatReport([
      {
        kind: 'compared',
        entry: { filePath: 'raw/y.md', url: 'https://example.com', sourceDate: null, body: '' },
        similarity: 1.0,
      },
    ], today);
    expect(findingCount).toBe(0);
  });

  it('routes unfetchables to manual-review', () => {
    const { report, findingCount } = formatReport([
      {
        kind: 'unfetchable',
        entry: { filePath: 'raw/p.md', url: 'https://medium.com/x', sourceDate: null, body: '' },
        reason: 'HTTP 402',
      },
    ], today);
    expect(findingCount).toBe(1);
    expect(report).toContain("couldn't auto-check");
    expect(report).toContain('HTTP 402');
  });

  it('routes errored git checks to manual-review', () => {
    const { report } = formatReport([
      {
        kind: 'git',
        entry: { filePath: 'raw/q.md', url: 'https://github.com/o/r', sourceDate: null, body: '' },
        slug: 'o/r',
        newCommits: 0,
        recentSubjects: [],
        error: 'HTTP 404',
      },
    ], today);
    expect(report).toContain('manual review');
    expect(report).toContain('HTTP 404');
  });

  it('reports sources without a URL in their own section', () => {
    const { report, findingCount } = formatReport([
      { kind: 'no-url', entry: { filePath: 'raw/missing.md', url: '', sourceDate: null, body: '' } },
    ], today);
    expect(findingCount).toBe(1);
    expect(report).toContain('## Sources without a URL in frontmatter');
    expect(report).toContain('raw/missing.md');
  });

  it('uses the date verbatim in the heading', () => {
    const { report } = formatReport([], '2099-12-31');
    expect(report.startsWith('# Freshness report — 2099-12-31')).toBe(true);
  });

  it('includes the patch-flow guidance footer when there are findings', () => {
    const { report } = formatReport([
      {
        kind: 'git',
        entry: { filePath: 'raw/x.md', url: 'https://github.com/o/r', sourceDate: null, body: '' },
        slug: 'o/r',
        newCommits: 1,
        recentSubjects: [],
      },
    ], today);
    expect(report).toContain('"Wiki Style & Refresh Policy"');
    expect(report).toContain('WebFetch');
  });

  it('OMITS the patch-flow footer on the no-findings path (no PR noise)', () => {
    // The early return at refresh.ts:182-184 emits a minimal report with
    // ONLY the header + "no upstream changes" line. The patch-flow footer
    // (Wiki Style policy + WebFetch hint) MUST NOT appear, otherwise
    // quiet-week PRs would carry noise that humans treat as actionable.
    const { report } = formatReport([], today);
    expect(report).not.toContain('Wiki Style & Refresh Policy');
    expect(report).not.toContain('WebFetch');
  });

  it('emits all four sections in order when every CheckResult kind is present', () => {
    // No existing test exercises >1 section type per call. A future
    // refactor that re-orders sections (e.g. moves no-URL above git)
    // would pass every per-section test today. Pin canonical order:
    // git → compared → manual-review (unfetchable + errored-git) → no-url.
    const { report, findingCount } = formatReport([
      {
        kind: 'git',
        entry: { filePath: 'raw/g.md', url: 'https://github.com/o/r', sourceDate: null, body: '' },
        slug: 'o/r',
        newCommits: 1,
        recentSubjects: ['Add feature'],
      },
      {
        kind: 'compared',
        entry: { filePath: 'raw/c.md', url: 'https://example.com', sourceDate: null, body: '' },
        similarity: 0.5,
      },
      {
        kind: 'unfetchable',
        entry: { filePath: 'raw/u.md', url: 'https://paywall.example.com', sourceDate: null, body: '' },
        reason: 'HTTP 402',
      },
      { kind: 'no-url', entry: { filePath: 'raw/n.md', url: '', sourceDate: null, body: '' } },
    ], today);

    expect(findingCount).toBe(4);

    const idxGit = report.indexOf('## Sources auto-checked (git)');
    const idxCompared = report.indexOf('## Sources auto-checked (text-only compare)');
    const idxManual = report.indexOf("## Sources couldn't auto-check");
    const idxNoUrl = report.indexOf('## Sources without a URL');

    expect(idxGit).toBeGreaterThan(-1);
    expect(idxCompared).toBeGreaterThan(idxGit);
    expect(idxManual).toBeGreaterThan(idxCompared);
    expect(idxNoUrl).toBeGreaterThan(idxManual);
  });
});

describe('SIMILARITY_THRESHOLD', () => {
  it('is exposed for callers that want to mirror the report logic', () => {
    expect(SIMILARITY_THRESHOLD).toBeGreaterThan(0);
    expect(SIMILARITY_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe('run --vault-dir validation', () => {
  it('rejects --vault-dir pointing at a non-vault directory', async () => {
    // tmp is a fresh mkdtemp with no CLAUDE.md, no .obsidian/, no raw/wiki —
    // not a vault. Without validation, refresh would happily walk it and
    // mkdir <tmp>/wiki/_freshness. With validation, it should refuse before
    // any file operation.
    const { run } = await import('../../src/commands/refresh.js');
    const { silent } = await import('../helpers/logger.js');
    await expect(
      run(undefined, { vaultDir: tmp, log: silent }),
    ).rejects.toThrow(/NOT_VAULT_LIKE|not a vault/);
  });

  it('accepts --vault-dir pointing at a vault-like directory', async () => {
    // Minimal vault layout: CLAUDE.md + raw/ + wiki/ satisfies isVaultLike.
    writeFileSync(join(tmp, 'CLAUDE.md'), '');
    mkdirSync(join(tmp, 'raw'), { recursive: true });
    mkdirSync(join(tmp, 'wiki'), { recursive: true });
    const { run } = await import('../../src/commands/refresh.js');
    const { silent } = await import('../helpers/logger.js');
    const result = await run(undefined, { vaultDir: tmp, log: silent });
    expect(result.sourceCount).toBe(0);
    expect(result.reportPath).toBeNull();
  });

  it('rejected --vault-dir does NOT create a wiki/_freshness directory inside the target', async () => {
    // The previous test asserts the throw on a non-vault dir. This pins the
    // accompanying invariant: NO filesystem side effect happens before the
    // rejection. Without this, a regression that runs `mkdirSync(<bad>/wiki/_freshness)`
    // before validating would let `vaultkit refresh --vault-dir /etc` create
    // /etc/wiki/_freshness even when the run() call ultimately throws.
    const { existsSync } = await import('node:fs');
    const { run } = await import('../../src/commands/refresh.js');
    const { silent } = await import('../helpers/logger.js');
    await expect(run(undefined, { vaultDir: tmp, log: silent })).rejects.toThrow();
    expect(existsSync(join(tmp, 'wiki', '_freshness'))).toBe(false);
    expect(existsSync(join(tmp, 'wiki'))).toBe(false);
  });

  it('rejects literal `~/...` paths (resolve() does NOT expand the tilde)', async () => {
    // A user passing `--vault-dir ~/Documents/MyVault` expects shell expansion,
    // but the shell may not have expanded if the arg was quoted, or the call
    // came from a config file. resolve() treats `~` as a literal path segment
    // → NOT_VAULT_LIKE. Pin this so refresh fails loud, not silently walks
    // a directory named literally `~` in cwd.
    const { run } = await import('../../src/commands/refresh.js');
    const { silent } = await import('../helpers/logger.js');
    await expect(
      run(undefined, { vaultDir: '~/non-existent-vault-' + Date.now(), log: silent }),
    ).rejects.toThrow(/NOT_VAULT_LIKE|not a vault/);
  });
});

// ── LIVE: refresh writes a freshness report (local-only via makeLocalVault) ──
//
// Plain `describe` (not liveDescribe) — this block does NOT create a GitHub
// repo, only makes a single read-only `gh api repos/octocat/Hello-World/commits`
// call. Both Ubuntu and Windows CI legs run it. Total cost: zero vk-live-*
// repo creates, one gh-API read per CI run (negligible against 5000/hr/PAT).

describe('live: refresh writes freshness report (local-only via makeLocalVault)', { timeout: 30_000 }, () => {
  const liveName = `vk-live-refresh-${Date.now()}`;
  let liveVault: { vaultDir: string; cleanup: () => Promise<void> } | null = null;

  beforeAll(async () => {
    const { makeLocalVault } = await import('../helpers/local-vault.js');
    liveVault = await makeLocalVault({ name: liveName, withRemote: false });
    // Pre-populate raw/foo.md citing a stable public repo. octocat/Hello-World
    // has had commits historically (used in GitHub tutorials), so the
    // `gh api .../commits` call returns a non-empty array → findingCount > 0
    // → freshness report MUST be written.
    writeFileSync(
      join(liveVault.vaultDir, 'raw', 'tutorial.md'),
      '---\nsource: https://github.com/octocat/Hello-World\n---\nbody text',
    );
  });

  afterAll(async () => {
    if (liveVault) await liveVault.cleanup().catch(() => {});
  });

  it('writes wiki/_freshness/<today>.md when a real public repo has commits', async () => {
    const { run } = await import('../../src/commands/refresh.js');
    const { silent: liveSilent } = await import('../helpers/logger.js');

    const result = await run(liveName, { log: liveSilent });

    expect(result.sourceCount).toBe(1);
    expect(result.findingCount).toBeGreaterThan(0);
    expect(result.reportPath).not.toBeNull();

    const today = new Date().toISOString().slice(0, 10);
    const expectedPath = join(liveVault!.vaultDir, 'wiki', '_freshness', `${today}.md`);
    expect(result.reportPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const report = readFileSync(expectedPath, 'utf8');
    expect(report).toContain(`# Freshness report — ${today}`);
    expect(report).toContain('octocat/Hello-World');
    // Patch-flow footer points at the wiki style section in CLAUDE.md
    expect(report).toContain('Wiki Style & Refresh Policy');
  });
});
