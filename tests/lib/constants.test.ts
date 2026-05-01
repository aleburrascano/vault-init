import { describe, it, expect } from 'vitest';
import {
  VAULT_FILES,
  VAULT_DIRS,
  WORKFLOW_FILES,
  VAULT_CONSTRAINTS,
} from '../../src/lib/constants.js';

/**
 * Drift guard. These constants are SHA-pinned in user vaults
 * (LAUNCHER) or hardcoded in shipping templates (CLAUDE_MD, README).
 * If anyone accidentally renames one, every downstream consumer
 * silently breaks. These tests fix the values explicitly so a typo
 * shows up at test time rather than in production.
 */
describe('VAULT_FILES — pinned values', () => {
  it('LAUNCHER is exactly ".mcp-start.js" (SHA-pinned in every user vault)', () => {
    expect(VAULT_FILES.LAUNCHER).toBe('.mcp-start.js');
  });

  it('CLAUDE_MD is exactly "CLAUDE.md"', () => {
    expect(VAULT_FILES.CLAUDE_MD).toBe('CLAUDE.md');
  });

  it('OBSIDIAN_DIR is exactly ".obsidian"', () => {
    expect(VAULT_FILES.OBSIDIAN_DIR).toBe('.obsidian');
  });

  it('VAULT_JSON is exactly "_vault.json"', () => {
    expect(VAULT_FILES.VAULT_JSON).toBe('_vault.json');
  });
});

describe('VAULT_DIRS', () => {
  it('RAW is "raw" and WIKI is "wiki"', () => {
    expect(VAULT_DIRS.RAW).toBe('raw');
    expect(VAULT_DIRS.WIKI).toBe('wiki');
  });

  it('GITHUB_WORKFLOWS is the standard workflow path', () => {
    expect(VAULT_DIRS.GITHUB_WORKFLOWS).toBe('.github/workflows');
  });
});

describe('WORKFLOW_FILES', () => {
  it('DEPLOY is "deploy.yml"', () => {
    expect(WORKFLOW_FILES.DEPLOY).toBe('deploy.yml');
  });

  it('DUPLICATE_CHECK is "duplicate-check.yml"', () => {
    expect(WORKFLOW_FILES.DUPLICATE_CHECK).toBe('duplicate-check.yml');
  });
});

describe('VAULT_CONSTRAINTS', () => {
  it('NAME_MAX_LENGTH is 64 (matches validateName)', () => {
    expect(VAULT_CONSTRAINTS.NAME_MAX_LENGTH).toBe(64);
  });

  it('NAME_PATTERN accepts standard vault names', () => {
    expect(VAULT_CONSTRAINTS.NAME_PATTERN.test('MyVault')).toBe(true);
    expect(VAULT_CONSTRAINTS.NAME_PATTERN.test('my-vault')).toBe(true);
    expect(VAULT_CONSTRAINTS.NAME_PATTERN.test('my_vault')).toBe(true);
    expect(VAULT_CONSTRAINTS.NAME_PATTERN.test('A1')).toBe(true);
  });

  it('NAME_PATTERN rejects invalid characters', () => {
    expect(VAULT_CONSTRAINTS.NAME_PATTERN.test('my vault')).toBe(false);
    expect(VAULT_CONSTRAINTS.NAME_PATTERN.test('my.vault')).toBe(false);
    expect(VAULT_CONSTRAINTS.NAME_PATTERN.test('my/vault')).toBe(false);
    expect(VAULT_CONSTRAINTS.NAME_PATTERN.test('my!vault')).toBe(false);
  });
});
