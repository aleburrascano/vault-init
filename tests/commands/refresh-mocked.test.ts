import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { silent } from '../helpers/logger.js';

vi.mock('../../src/lib/github/gh-retry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/github/gh-retry.js')>();
  return { ...real, ghJson: vi.fn(), gh: vi.fn() };
});
vi.mock('../../src/lib/text-compare.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/text-compare.js')>();
  return { ...real, compareSource: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});

import { ghJson } from '../../src/lib/github/gh-retry.js';
import { compareSource } from '../../src/lib/text-compare.js';
import { findTool } from '../../src/lib/platform.js';

let tmp: string;
function makeMinimalVault(): string {
  // CLAUDE.md + raw/ + wiki/ satisfies isVaultLike (per src/lib/vault.ts).
  writeFileSync(join(tmp, 'CLAUDE.md'), '');
  mkdirSync(join(tmp, 'raw'), { recursive: true });
  mkdirSync(join(tmp, 'wiki'), { recursive: true });
  return tmp;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-refresh-mocked-'));
  vi.mocked(ghJson).mockReset();
  vi.mocked(compareSource).mockReset();
  vi.mocked(findTool).mockReset();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('run() orchestration — happy git path', () => {
  it('writes a freshness report with the commits-since-clip section when ghJson returns new commits', async () => {
    const vaultDir = makeMinimalVault();
    writeFileSync(
      join(vaultDir, 'raw', 'paper.md'),
      '---\nsource: https://github.com/octocat/Hello-World\nsource_date: 2026-04-01\n---\nbody text',
    );

    vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
    vi.mocked(ghJson).mockResolvedValue(JSON.stringify([
      { commit: { message: 'fix: typo\n\nbody' } },
      { commit: { message: 'feat: new section' } },
    ]));

    const { run } = await import('../../src/commands/refresh.js');
    const result = await run(undefined, { vaultDir, log: silent });

    // ghJson called with the expected `gh api repos/<slug>/commits` argv —
    // pins that the slug from detectGithubSlug reaches the API call as
    // a single argv element (not concatenated, not shell-expanded).
    expect(vi.mocked(ghJson)).toHaveBeenCalledTimes(1);
    const ghArgs = vi.mocked(ghJson).mock.calls[0] as readonly string[];
    expect(ghArgs[0]).toBe('api');
    expect(ghArgs[1]).toBe('repos/octocat/Hello-World/commits');
    expect(ghArgs).toContain('per_page=30'); // sourceDate present → 30, not 10

    // findingCount counts SOURCES with findings, not commits within a
    // source. One paper.md with N new commits = 1 finding.
    expect(result.sourceCount).toBe(1);
    expect(result.findingCount).toBe(1);
    expect(result.reportPath).not.toBeNull();
    expect(existsSync(result.reportPath as string)).toBe(true);
    const report = readFileSync(result.reportPath as string, 'utf8');
    expect(report).toContain('octocat/Hello-World');
    expect(report).toContain('fix: typo');
    expect(report).toContain('feat: new section');
    // Newline-bearing commit subjects must be sliced to first line only.
    expect(report).not.toContain('\n\nbody'); // multi-line body omitted
  });

  it('uses per_page=10 when sourceDate is absent (no since= filter)', async () => {
    const vaultDir = makeMinimalVault();
    writeFileSync(
      join(vaultDir, 'raw', 'paper.md'),
      '---\nsource: https://github.com/octocat/Hello-World\n---\nbody',
    );
    vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
    vi.mocked(ghJson).mockResolvedValue('[]');

    const { run } = await import('../../src/commands/refresh.js');
    await run(undefined, { vaultDir, log: silent });

    const ghArgs = vi.mocked(ghJson).mock.calls[0] as readonly string[];
    expect(ghArgs).toContain('per_page=10');
    expect(ghArgs.every(a => !String(a).startsWith('since='))).toBe(true);
  });
});

describe('run() orchestration — no findings', () => {
  it('does NOT write a report when every git source returns empty commits', async () => {
    const vaultDir = makeMinimalVault();
    writeFileSync(
      join(vaultDir, 'raw', 'paper.md'),
      '---\nsource: https://github.com/octocat/Hello-World\n---\nbody',
    );
    vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
    vi.mocked(ghJson).mockResolvedValue('[]');

    const { run } = await import('../../src/commands/refresh.js');
    const result = await run(undefined, { vaultDir, log: silent });

    expect(result.findingCount).toBe(0);
    expect(result.reportPath).toBeNull();
    // wiki/_freshness/ MUST NOT be created on quiet weeks (no PR noise).
    expect(existsSync(join(vaultDir, 'wiki', '_freshness'))).toBe(false);
  });
});

describe('run() orchestration — SSRF guard observable through refresh', () => {
  it('routes a non-git URL through compareSource and surfaces unfetchable outcomes in manual-review', async () => {
    const vaultDir = makeMinimalVault();
    writeFileSync(
      join(vaultDir, 'raw', 'note.md'),
      '---\nsource: http://localhost:8080/admin\n---\nbody',
    );
    vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
    // text-compare's _rejectInternalUrl flagged the URL → unfetchable.
    // Refresh's job is to surface this in the report's manual-review
    // section, NOT to retry or escalate.
    vi.mocked(compareSource).mockResolvedValue({ kind: 'unfetchable', reason: 'internal URL rejected' });

    const { run } = await import('../../src/commands/refresh.js');
    const result = await run(undefined, { vaultDir, log: silent });

    // ghJson MUST NOT be invoked for a non-github URL (would be wasted RTT).
    expect(vi.mocked(ghJson)).not.toHaveBeenCalled();
    // compareSource was called with the literal frontmatter URL — proves the
    // URL went into the SSRF-guarded helper, not bypassed via some other path.
    expect(vi.mocked(compareSource)).toHaveBeenCalledWith(
      'http://localhost:8080/admin',
      expect.any(String),
    );

    expect(result.findingCount).toBe(1);
    expect(result.reportPath).not.toBeNull();
    const report = readFileSync(result.reportPath as string, 'utf8');
    expect(report).toContain("couldn't auto-check");
    expect(report).toContain('http://localhost:8080/admin');
    expect(report).toContain('internal URL rejected');
  });
});

describe('run() orchestration — ghAvailable=false routes git sources through compareSource', () => {
  it('falls back to compareSource for github URLs when gh is not on PATH', async () => {
    const vaultDir = makeMinimalVault();
    writeFileSync(
      join(vaultDir, 'raw', 'paper.md'),
      '---\nsource: https://github.com/octocat/Hello-World\n---\nbody',
    );
    // gh not available → ghAvailable=false, classifySource still says 'git'
    // but checkSource's `cls.kind === 'git' && ghAvailable` gate forces
    // the fallback to compareSource (refresh.ts:158-165).
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(compareSource).mockResolvedValue({ kind: 'compared', similarity: 0.4 });

    const { run } = await import('../../src/commands/refresh.js');
    const result = await run(undefined, { vaultDir, log: silent });

    expect(vi.mocked(ghJson)).not.toHaveBeenCalled();
    expect(vi.mocked(compareSource)).toHaveBeenCalledTimes(1);
    expect(result.findingCount).toBe(1); // 0.4 < SIMILARITY_THRESHOLD → drifted
  });
});

describe('run() orchestration — ghJson failures surface as manual-review entries', () => {
  it('catches RATE_LIMITED from ghJson and routes the source to manual-review', async () => {
    const vaultDir = makeMinimalVault();
    writeFileSync(
      join(vaultDir, 'raw', 'paper.md'),
      '---\nsource: https://github.com/octocat/Hello-World\n---\nbody',
    );
    vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
    // checkGitSource at refresh.ts:152-155 catches gh errors (incl.
    // VaultkitError('RATE_LIMITED')) and surfaces them as
    // `{kind:'git', error: msg}`. Without this catch, run() crashes
    // mid-Promise.all when one source rate-limits — losing all in-flight
    // results from sibling sources.
    const { VaultkitError } = await import('../../src/lib/errors.js');
    vi.mocked(ghJson).mockRejectedValue(
      new VaultkitError('RATE_LIMITED', 'GitHub secondary rate limit exhausted'),
    );

    const { run } = await import('../../src/commands/refresh.js');
    const result = await run(undefined, { vaultDir, log: silent });

    expect(result.findingCount).toBe(1); // routed to manual-review, NOT crashed
    expect(result.reportPath).not.toBeNull();
    const report = readFileSync(result.reportPath as string, 'utf8');
    expect(report).toContain("couldn't auto-check");
    expect(report).toContain('rate limit');
  });

  it('does NOT cascade one source failure to siblings (Promise.all behavior)', async () => {
    const vaultDir = makeMinimalVault();
    writeFileSync(
      join(vaultDir, 'raw', 'a.md'),
      '---\nsource: https://github.com/octocat/Hello-World\n---\nbody-a',
    );
    writeFileSync(
      join(vaultDir, 'raw', 'b.md'),
      '---\nsource: https://github.com/octocat/Spoon-Knife\n---\nbody-b',
    );
    vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
    // First call succeeds, second errors. Both are awaited via Promise.all.
    const { VaultkitError } = await import('../../src/lib/errors.js');
    vi.mocked(ghJson)
      .mockResolvedValueOnce(JSON.stringify([{ commit: { message: 'recent change' } }]))
      .mockRejectedValueOnce(new VaultkitError('RATE_LIMITED', 'rate limited'));

    const { run } = await import('../../src/commands/refresh.js');
    const result = await run(undefined, { vaultDir, log: silent });

    expect(result.sourceCount).toBe(2);
    expect(result.findingCount).toBe(2); // 1 git change + 1 errored-git in manual-review
    const report = readFileSync(result.reportPath as string, 'utf8');
    expect(report).toContain('## Sources auto-checked (git)');
    expect(report).toContain("couldn't auto-check");
  });
});

describe('run() orchestration — log message pluralization', () => {
  it('uses singular forms when N=1 ("1 source", "1 finding")', async () => {
    const vaultDir = makeMinimalVault();
    writeFileSync(
      join(vaultDir, 'raw', 'paper.md'),
      '---\nsource: https://github.com/octocat/Hello-World\n---\nbody',
    );
    vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
    vi.mocked(ghJson).mockResolvedValue(JSON.stringify([{ commit: { message: 'change' } }]));

    const lines: string[] = [];
    const log = {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      debug: (_m: string) => { /* drop */ },
    };
    const { run } = await import('../../src/commands/refresh.js');
    await run(undefined, { vaultDir, log });

    expect(lines.some(l => /Found 1 source under raw\//.test(l))).toBe(true);
    expect(lines.some(l => /\(1 finding\)/.test(l))).toBe(true);
  });

  it('uses plural forms when N>1 ("2 sources", "2 findings")', async () => {
    const vaultDir = makeMinimalVault();
    writeFileSync(join(vaultDir, 'raw', 'a.md'),
      '---\nsource: https://github.com/octocat/Hello-World\n---\na');
    writeFileSync(join(vaultDir, 'raw', 'b.md'),
      '---\nsource: https://github.com/octocat/Spoon-Knife\n---\nb');
    vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
    vi.mocked(ghJson).mockResolvedValue(JSON.stringify([{ commit: { message: 'c' } }]));

    const lines: string[] = [];
    const log = {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      debug: (_m: string) => { /* drop */ },
    };
    const { run } = await import('../../src/commands/refresh.js');
    await run(undefined, { vaultDir, log });

    expect(lines.some(l => /Found 2 sources under raw\//.test(l))).toBe(true);
    expect(lines.some(l => /\(2 findings\)/.test(l))).toBe(true);
  });
});
