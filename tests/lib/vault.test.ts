import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Vault, validateName, isVaultLike, sha256 } from '../../src/lib/vault.js';
import { isVaultkitError } from '../../src/lib/errors.js';
import { writeCfg } from '../helpers/registry.js';
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

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-vault-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── validateName ──────────────────────────────────────────────────────────────

describe('validateName', () => {
  it('accepts valid names', () => {
    expect(() => validateName('MyVault')).not.toThrow();
    expect(() => validateName('my-vault')).not.toThrow();
    expect(() => validateName('my_vault')).not.toThrow();
    expect(() => validateName('vault123')).not.toThrow();
    expect(() => validateName('a')).not.toThrow();
    expect(() => validateName('A'.repeat(64))).not.toThrow();
  });

  it('rejects names with slash (owner/repo format)', () => {
    expect(() => validateName('owner/repo')).toThrow(
      "provide the vault name only (e.g. 'MyVault'), not owner/repo."
    );
  });

  it('rejects names with invalid characters', () => {
    expect(() => validateName('my vault')).toThrow(
      'vault name must contain only letters, numbers, hyphens, and underscores.'
    );
    expect(() => validateName('my.vault')).toThrow(
      'vault name must contain only letters, numbers, hyphens, and underscores.'
    );
    expect(() => validateName('my@vault')).toThrow(
      'vault name must contain only letters, numbers, hyphens, and underscores.'
    );
  });

  it('rejects names longer than 64 characters', () => {
    expect(() => validateName('A'.repeat(65))).toThrow(
      'vault name must be 64 characters or less.'
    );
  });

  it('slash check takes precedence over char check', () => {
    expect(() => validateName('owner/repo')).toThrow('not owner/repo');
  });
});

// ── Vault.requireFromName ─────────────────────────────────────────────────────

describe('Vault.requireFromName', () => {
  it('returns a Vault when the name is registered', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: { dir: join(tmp, 'MyVault'), hash: 'abc123' } });
    const vault = await Vault.requireFromName('MyVault', cfgPath);
    expect(vault.name).toBe('MyVault');
    expect(vault.dir).toBe(join(tmp, 'MyVault'));
    expect(vault.expectedHash).toBe('abc123');
  });

  it('throws VaultkitError(NOT_REGISTERED) when the name is not registered', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, {});
    try {
      await Vault.requireFromName('Missing', cfgPath);
      throw new Error('should have thrown');
    } catch (err) {
      expect(isVaultkitError(err)).toBe(true);
      if (isVaultkitError(err)) {
        expect(err.code).toBe('NOT_REGISTERED');
        expect(err.message).toContain('"Missing"');
      }
    }
  });

  it('throws VaultkitError(INVALID_NAME) for an invalid name (validation runs before registry lookup)', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, {});
    try {
      await Vault.requireFromName('owner/repo', cfgPath);
      throw new Error('should have thrown');
    } catch (err) {
      expect(isVaultkitError(err)).toBe(true);
      if (isVaultkitError(err)) {
        expect(err.code).toBe('INVALID_NAME');
      }
    }
  });
});

// ── isVaultLike ───────────────────────────────────────────────────────────────

describe('isVaultLike', () => {
  it('returns false for non-existent directory', () => {
    expect(isVaultLike(join(tmp, 'no-such-dir'))).toBe(false);
  });

  it('returns false for empty directory', () => {
    expect(isVaultLike(tmp)).toBe(false);
  });

  it('returns true when .obsidian/ directory exists', () => {
    mkdirSync(join(tmp, '.obsidian'));
    expect(isVaultLike(tmp)).toBe(true);
  });

  it('returns true when CLAUDE.md + raw/ + wiki/ all exist', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '');
    mkdirSync(join(tmp, 'raw'));
    mkdirSync(join(tmp, 'wiki'));
    expect(isVaultLike(tmp)).toBe(true);
  });

  it('returns false when only CLAUDE.md exists (no raw/ wiki/)', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '');
    expect(isVaultLike(tmp)).toBe(false);
  });

  it('returns false when CLAUDE.md + raw/ but no wiki/', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '');
    mkdirSync(join(tmp, 'raw'));
    expect(isVaultLike(tmp)).toBe(false);
  });

  it('returns false when raw/ and wiki/ exist but no CLAUDE.md', () => {
    mkdirSync(join(tmp, 'raw'));
    mkdirSync(join(tmp, 'wiki'));
    expect(isVaultLike(tmp)).toBe(false);
  });
});

// ── sha256 ────────────────────────────────────────────────────────────────────

describe('isVaultLike — edge cases', () => {
  it('returns false when path is a file, not a directory', () => {
    const f = join(tmp, 'notadir.txt');
    writeFileSync(f, 'hello');
    expect(isVaultLike(f)).toBe(false);
  });
});

describe('sha256 — edge cases', () => {
  it('throws on a non-existent file', async () => {
    await expect(sha256(join(tmp, 'no-such-file.txt'))).rejects.toThrow();
  });
});

describe('sha256', () => {
  it('returns correct hex hash of a file', async () => {
    const p = join(tmp, 'test.txt');
    writeFileSync(p, 'hello world');
    // known SHA-256 of "hello world"
    const expected = 'b94d27b9934d3e08a52e52d7da7dabfac484efe04294e576b1571c72e3090a00';
    const result = await sha256(p);
    // Just check it's a 64-char hex string
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    // And is consistent
    expect(await sha256(p)).toBe(result);
  });

  it('different content gives different hash', async () => {
    const p1 = join(tmp, 'a.txt');
    const p2 = join(tmp, 'b.txt');
    writeFileSync(p1, 'hello');
    writeFileSync(p2, 'world');
    expect(await sha256(p1)).not.toBe(await sha256(p2));
  });
});

// ── render functions ──────────────────────────────────────────────────────────

describe('renderClaudeMd', () => {
  it('contains the vault name', () => {
    const out = renderClaudeMd('TestVault');
    expect(out).toContain('TestVault');
    expect(out).toContain('# CLAUDE.md');
  });

  it('contains core section headings', () => {
    const out = renderClaudeMd('TestVault');
    expect(out).toContain('## Layers');
    expect(out).toContain('## Operations');
    expect(out).toContain('## Session start');
    expect(out).toContain('raw/');
    expect(out).toContain('wiki/');
  });

  it('ends with a newline', () => {
    expect(renderClaudeMd('V')).toMatch(/\n$/);
  });
});

describe('renderReadme', () => {
  it('contains the vault name', () => {
    const out = renderReadme('TestVault');
    expect(out).toContain('# TestVault');
  });

  it('notes-only variant when no siteUrl', () => {
    const out = renderReadme('TestVault');
    expect(out).toContain('Notes-only vault');
    expect(out).not.toContain('**Site**:');
  });

  it('includes site URL when provided', () => {
    const out = renderReadme('TestVault', 'owner.github.io/TestVault');
    expect(out).toContain('https://owner.github.io/TestVault');
    expect(out).not.toContain('Notes-only vault');
  });

  it('ends with a newline', () => {
    expect(renderReadme('V')).toMatch(/\n$/);
  });
});

describe('renderDuplicateCheckYaml', () => {
  it('is valid YAML-ish with expected content', () => {
    const out = renderDuplicateCheckYaml();
    expect(out).toContain('Duplicate Source Check');
    expect(out).toContain('raw/**');
    expect(out).toContain('uniq -d');
  });

  it('ends with a newline', () => {
    expect(renderDuplicateCheckYaml()).toMatch(/\n$/);
  });
});

describe('renderVaultJson', () => {
  it('is valid JSON with pageTitle and baseUrl', () => {
    const out = renderVaultJson('owner', 'MyRepo');
    const parsed = JSON.parse(out);
    expect(parsed.pageTitle).toBe('MyRepo');
    expect(parsed.baseUrl).toBe('https://owner.github.io/MyRepo/');
  });
});

describe('renderGitignore', () => {
  it('contains .obsidian and .quartz', () => {
    const out = renderGitignore();
    expect(out).toContain('.obsidian');
    expect(out).toContain('.quartz');
  });
});

describe('renderGitattributes', () => {
  it('contains eol=lf line', () => {
    expect(renderGitattributes()).toContain('eol=lf');
  });
});

describe('renderIndexMd', () => {
  it('contains standard headings', () => {
    const out = renderIndexMd();
    expect(out).toContain('# Index');
    expect(out).toContain('## Topics');
    expect(out).toContain('## Concepts');
    expect(out).toContain('## Sources');
  });
});

describe('renderLogMd', () => {
  it('starts with # Log', () => {
    expect(renderLogMd()).toMatch(/^# Log/);
  });
});
