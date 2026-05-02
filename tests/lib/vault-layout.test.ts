import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CANONICAL_LAYOUT_FILES,
  DUPLICATE_CHECK_WORKFLOW_PATH,
  FRESHNESS_WORKFLOW_PATH,
  RAW_GITKEEP,
  WIKI_GITKEEP,
  createDirectoryTree,
  detectLayoutGaps,
  renderLayoutFile,
  writeLayoutFiles,
} from '../../src/lib/vault-layout.js';
import { VAULT_DIRS, VAULT_FILES } from '../../src/lib/constants.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-layout-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('CANONICAL_LAYOUT_FILES', () => {
  it('lists every file vault must have, in deterministic order', () => {
    expect(CANONICAL_LAYOUT_FILES).toEqual([
      VAULT_FILES.CLAUDE_MD,
      VAULT_FILES.README,
      VAULT_FILES.INDEX,
      VAULT_FILES.LOG,
      VAULT_FILES.GITIGNORE,
      VAULT_FILES.GITATTRIBUTES,
      VAULT_FILES.CLAUDE_SETTINGS,
      VAULT_FILES.PR_TEMPLATE,
      DUPLICATE_CHECK_WORKFLOW_PATH,
      FRESHNESS_WORKFLOW_PATH,
      RAW_GITKEEP,
      WIKI_GITKEEP,
    ]);
  });
});

describe('renderLayoutFile', () => {
  it('renders CLAUDE.md with the vault name', () => {
    const out = renderLayoutFile(VAULT_FILES.CLAUDE_MD, { name: 'TestVault' });
    expect(out).toContain('TestVault');
  });

  it('renders README without site URL when siteUrl is empty', () => {
    const out = renderLayoutFile(VAULT_FILES.README, { name: 'V', siteUrl: '' });
    expect(out).toContain('Notes-only vault');
  });

  it('renders README with site URL when supplied', () => {
    const out = renderLayoutFile(VAULT_FILES.README, { name: 'V', siteUrl: 'owner.github.io/V' });
    expect(out).toContain('https://owner.github.io/V');
  });

  it('renders empty content for raw/.gitkeep and wiki/.gitkeep', () => {
    expect(renderLayoutFile(RAW_GITKEEP, { name: 'V' })).toBe('');
    expect(renderLayoutFile(WIKI_GITKEEP, { name: 'V' })).toBe('');
  });

  it('throws on unknown layout path', () => {
    expect(() => renderLayoutFile('not-a-layout-file.txt', { name: 'V' })).toThrow(/unknown layout path/);
  });
});

describe('detectLayoutGaps', () => {
  it('returns all canonical files when the vault dir is empty', () => {
    const gaps = detectLayoutGaps(tmp);
    expect(gaps).toEqual(CANONICAL_LAYOUT_FILES);
  });

  it('returns nothing once writeLayoutFiles has populated everything', () => {
    createDirectoryTree(tmp);
    writeLayoutFiles(tmp, { name: 'V', siteUrl: '' }, CANONICAL_LAYOUT_FILES);
    expect(detectLayoutGaps(tmp)).toEqual([]);
  });

  it('treats empty raw/ as missing the raw gitkeep', () => {
    mkdirSync(join(tmp, VAULT_DIRS.RAW));
    const gaps = detectLayoutGaps(tmp);
    expect(gaps).toContain(RAW_GITKEEP);
  });

  it('treats raw/ with content as no longer missing the gitkeep', () => {
    mkdirSync(join(tmp, VAULT_DIRS.RAW));
    writeFileSync(join(tmp, VAULT_DIRS.RAW, 'something.md'), 'content');
    expect(detectLayoutGaps(tmp)).not.toContain(RAW_GITKEEP);
  });
});

describe('createDirectoryTree', () => {
  it('creates raw/, wiki/, .github/workflows/ subdirectories', () => {
    createDirectoryTree(tmp);
    expect(existsSync(join(tmp, VAULT_DIRS.RAW, 'articles'))).toBe(true);
    expect(existsSync(join(tmp, VAULT_DIRS.WIKI, 'concepts'))).toBe(true);
    expect(existsSync(join(tmp, VAULT_DIRS.GITHUB_WORKFLOWS))).toBe(true);
  });
});

describe('writeLayoutFiles', () => {
  it('writes only the requested subset of files', () => {
    createDirectoryTree(tmp);
    writeLayoutFiles(tmp, { name: 'V', siteUrl: '' }, [VAULT_FILES.CLAUDE_MD, VAULT_FILES.LOG]);
    expect(existsSync(join(tmp, VAULT_FILES.CLAUDE_MD))).toBe(true);
    expect(existsSync(join(tmp, VAULT_FILES.LOG))).toBe(true);
    expect(existsSync(join(tmp, VAULT_FILES.README))).toBe(false);
  });

  it('creates parent directories as needed (e.g. .github/workflows)', () => {
    writeLayoutFiles(tmp, { name: 'V', siteUrl: '' }, [DUPLICATE_CHECK_WORKFLOW_PATH]);
    expect(existsSync(join(tmp, DUPLICATE_CHECK_WORKFLOW_PATH))).toBe(true);
  });

  it('writes the vault name into CLAUDE.md', () => {
    writeLayoutFiles(tmp, { name: 'MyVault' }, [VAULT_FILES.CLAUDE_MD]);
    const content = readFileSync(join(tmp, VAULT_FILES.CLAUDE_MD), 'utf8');
    expect(content).toContain('MyVault');
  });
});
