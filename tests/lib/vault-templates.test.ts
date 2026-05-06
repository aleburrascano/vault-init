import { describe, it, expect } from 'vitest';
import {
  renderClaudeMd,
  renderReadme,
  renderDuplicateCheckYaml,
  renderVaultJson,
  renderGitignore,
  renderGitattributes,
  renderIndexMd,
  renderLogMd,
} from '../../src/lib/templates/vault-templates.js';

/**
 * Drift guard for the static-content builders. These templates ship into
 * every newly-initialized vault — a regression here propagates silently to
 * every subsequent `vaultkit init`. Asserts interpolation correctness and
 * structural anchors rather than full text, so harmless wording tweaks
 * don't require test updates.
 */

describe('renderClaudeMd', () => {
  it('produces a non-empty string', () => {
    expect(renderClaudeMd('MyVault').length).toBeGreaterThan(0);
  });

  it('interpolates the vault name into the title heading', () => {
    expect(renderClaudeMd('MyVault')).toContain('# CLAUDE.md — MyVault');
    expect(renderClaudeMd('other-vault')).toContain('# CLAUDE.md — other-vault');
  });

  it('contains the canonical operational section headings', () => {
    const out = renderClaudeMd('x');
    expect(out).toContain('## Layers');
    expect(out).toContain('## Page conventions');
    expect(out).toContain('## Operations');
    expect(out).toContain('### Ingest');
    expect(out).toContain('### Query');
    expect(out).toContain('## Session start');
  });

  it('references the raw/ and wiki/ layer paths', () => {
    const out = renderClaudeMd('x');
    expect(out).toContain('raw/');
    expect(out).toContain('wiki/');
    expect(out).toContain('index.md');
    expect(out).toContain('log.md');
  });
});

describe('renderReadme', () => {
  it('produces a non-empty string', () => {
    expect(renderReadme('MyVault').length).toBeGreaterThan(0);
  });

  it('uses the vault name as the H1 title', () => {
    expect(renderReadme('MyVault')).toMatch(/^# MyVault\n/);
    expect(renderReadme('other-vault')).toMatch(/^# other-vault\n/);
  });

  it('shows the live-site line when siteUrl is provided', () => {
    const out = renderReadme('MyVault', 'me.github.io/MyVault');
    expect(out).toContain('**Site**: https://me.github.io/MyVault');
  });

  it('shows the notes-only note when siteUrl is empty', () => {
    const out = renderReadme('MyVault', '');
    expect(out).toContain('Notes-only vault');
    expect(out).not.toContain('**Site**: https://');
  });

  it('defaults siteUrl to empty (notes-only) when omitted', () => {
    const out = renderReadme('MyVault');
    expect(out).toContain('Notes-only vault');
  });

  it('links back to the vaultkit project', () => {
    expect(renderReadme('x')).toContain('https://github.com/aleburrascano/vaultkit');
  });

  it('includes a Contributing section', () => {
    expect(renderReadme('x')).toContain('## Contributing');
  });
});

describe('renderDuplicateCheckYaml', () => {
  it('produces a non-empty string', () => {
    expect(renderDuplicateCheckYaml().length).toBeGreaterThan(0);
  });

  it('declares a GitHub Actions workflow shape', () => {
    const out = renderDuplicateCheckYaml();
    expect(out).toContain('name: Duplicate Source Check');
    expect(out).toContain('on:');
    expect(out).toContain('pull_request:');
    expect(out).toContain('jobs:');
    expect(out).toContain('runs-on: ubuntu-latest');
  });

  it('scopes the trigger to raw/** paths', () => {
    expect(renderDuplicateCheckYaml()).toContain("'raw/**'");
  });

  it('exits non-zero on duplicate detection', () => {
    expect(renderDuplicateCheckYaml()).toContain('exit 1');
  });
});

describe('renderVaultJson', () => {
  it('produces parseable JSON', () => {
    expect(() => JSON.parse(renderVaultJson('me', 'MyVault'))).not.toThrow();
  });

  it('uses the repo name as the page title', () => {
    const parsed = JSON.parse(renderVaultJson('me', 'MyVault')) as { pageTitle: string };
    expect(parsed.pageTitle).toBe('MyVault');
  });

  it('builds the canonical github.io baseUrl with trailing slash', () => {
    const parsed = JSON.parse(renderVaultJson('octocat', 'cookbook')) as { baseUrl: string };
    expect(parsed.baseUrl).toBe('https://octocat.github.io/cookbook/');
  });

  it('emits pretty-printed JSON (2-space indent)', () => {
    expect(renderVaultJson('a', 'b')).toContain('\n  ');
  });

  it('exposes only the documented fields (pageTitle, baseUrl)', () => {
    const parsed = JSON.parse(renderVaultJson('me', 'v')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['baseUrl', 'pageTitle']);
  });
});

describe('renderGitignore', () => {
  it('produces a non-empty string', () => {
    expect(renderGitignore().length).toBeGreaterThan(0);
  });

  it('ignores .quartz/, .obsidian/, and .DS_Store', () => {
    const out = renderGitignore();
    expect(out).toContain('.quartz/');
    expect(out).toContain('.obsidian/');
    expect(out).toContain('.DS_Store');
  });
});

describe('renderGitattributes', () => {
  it('produces a non-empty string', () => {
    expect(renderGitattributes().length).toBeGreaterThan(0);
  });

  it('declares the global text=auto rule', () => {
    expect(renderGitattributes()).toContain('* text=auto');
  });

  it('forces LF line endings on the canonical text file types', () => {
    const out = renderGitattributes();
    for (const ext of ['js', 'ts', 'json', 'yml', 'md']) {
      expect(out, `missing eol=lf rule for *.${ext}`).toMatch(new RegExp(`\\*\\.${ext} text eol=lf`));
    }
  });
});

describe('renderIndexMd', () => {
  it('produces a non-empty string', () => {
    expect(renderIndexMd().length).toBeGreaterThan(0);
  });

  it('starts with the # Index heading', () => {
    expect(renderIndexMd()).toMatch(/^# Index\n/);
  });

  it('declares the three canonical section headings', () => {
    const out = renderIndexMd();
    expect(out).toContain('## Topics');
    expect(out).toContain('## Concepts');
    expect(out).toContain('## Sources');
  });
});

describe('renderLogMd', () => {
  it('produces a non-empty string', () => {
    expect(renderLogMd().length).toBeGreaterThan(0);
  });

  it('starts with the # Log heading', () => {
    expect(renderLogMd()).toMatch(/^# Log\n/);
  });
});
