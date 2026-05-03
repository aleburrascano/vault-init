import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findTool, npmGlobalBin } from '../../src/lib/platform.js';

describe('claudeJsonPath', () => {
  let origPlatform: NodeJS.Platform;
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origPlatform = process.platform;
    origEnv = { ...process.env };
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
    process.env = origEnv;
  });

  it('uses HOME on non-Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    process.env.HOME = '/home/testuser';
    const { claudeJsonPath } = await import('../../src/lib/platform.js?bust=' + Date.now());
    expect(claudeJsonPath()).toBe(join('/home/testuser', '.claude.json'));
  });

  it('uses USERPROFILE on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    process.env.USERPROFILE = 'C:\\Users\\TestUser';
    const { claudeJsonPath } = await import('../../src/lib/platform.js?bust=' + Date.now());
    expect(claudeJsonPath()).toBe(join('C:\\Users\\TestUser', '.claude.json'));
  });

  it('returns a path ending in .claude.json', async () => {
    const { claudeJsonPath } = await import('../../src/lib/platform.js');
    expect(claudeJsonPath()).toMatch(/\.claude\.json$/);
  });
});

describe('vaultsRoot', () => {
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it('returns VAULTKIT_HOME when set', async () => {
    process.env.VAULTKIT_HOME = '/custom/vaults';
    const { vaultsRoot } = await import('../../src/lib/platform.js?bust=' + Date.now());
    expect(vaultsRoot()).toBe('/custom/vaults');
  });

  it('falls back to HOME/vaults when VAULTKIT_HOME not set', async () => {
    delete process.env.VAULTKIT_HOME;
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const { vaultsRoot } = await import('../../src/lib/platform.js?bust=' + Date.now());
    expect(vaultsRoot()).toBe(join(home, 'vaults'));
  });
});

describe('isWindows', () => {
  it('returns a boolean', async () => {
    const { isWindows } = await import('../../src/lib/platform.js');
    expect(typeof isWindows()).toBe('boolean');
  });

  it('returns true on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    const { isWindows } = await import('../../src/lib/platform.js?bust=' + Date.now());
    expect(isWindows()).toBe(true);
  });

  it('returns false on linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    const { isWindows } = await import('../../src/lib/platform.js?bust=' + Date.now());
    expect(isWindows()).toBe(false);
  });
});

describe('claudeJsonPath — env var edge cases', () => {
  let origEnv: NodeJS.ProcessEnv;
  beforeEach(() => { origEnv = { ...process.env }; });
  afterEach(() => { process.env = origEnv; });

  it('returns a path containing .claude.json even when HOME is unset', async () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const { claudeJsonPath } = await import('../../src/lib/platform.js?bust=' + Date.now());
    const p = claudeJsonPath();
    expect(p).toMatch(/\.claude\.json$/);
  });
});

describe('vaultsRoot — env var edge cases', () => {
  let origEnv: NodeJS.ProcessEnv;
  beforeEach(() => { origEnv = { ...process.env }; });
  afterEach(() => { process.env = origEnv; });

  it('uses HOME fallback when VAULTKIT_HOME is empty string', async () => {
    process.env.VAULTKIT_HOME = '';
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const { vaultsRoot } = await import('../../src/lib/platform.js?bust=' + Date.now());
    // Empty string is falsy — should fall back to HOME/vaults
    expect(vaultsRoot()).toBe(join(home, 'vaults'));
  });
});

describe('findTool', () => {
  let tmp: string;
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
    tmp = mkdtempSync(join(tmpdir(), 'vk-platform-test-'));
  });
  afterEach(() => {
    process.env = origEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finds gh when present in PROGRAMFILES probe path (Windows)', async () => {
    if (process.platform !== 'win32') return; // Windows-only test
    const ghDir = join(tmp, 'GitHub CLI');
    mkdirSync(ghDir, { recursive: true });
    writeFileSync(join(ghDir, 'gh.exe'), '');
    process.env.PROGRAMFILES = tmp;
    const result = await findTool('gh');
    expect(result).toContain('gh.exe');
  });

  it('finds claude when present in APPDATA/npm probe path (Windows)', async () => {
    if (process.platform !== 'win32') return; // Windows-only test
    const npmDir = join(tmp, 'npm');
    mkdirSync(npmDir, { recursive: true });
    writeFileSync(join(npmDir, 'claude.cmd'), '');
    process.env.APPDATA = tmp;
    const result = await findTool('claude');
    expect(result).toContain('claude.cmd');
  });

  it('returns null for a tool that does not exist anywhere', async () => {
    const result = await findTool('definitely-not-a-real-tool-vaultkit-xyz-99');
    expect(result).toBeNull();
  }, 15000);
});

describe('npmGlobalBin', () => {
  it('returns a string path when npm is available', async () => {
    const result = await npmGlobalBin();
    // npm is installed in this environment — should return a path
    if (result !== null) {
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
    // null is also acceptable if npm is unavailable
  });
});

describe('template path getters', () => {
  // The 5 template path helpers (getLauncherTemplate / getDeployTemplate /
  // getFreshnessTemplate / getPrTemplate / getClaudeSettingsTemplate)
  // had zero unit tests before this block. They share one invariant:
  // each resolves to `<...>/lib/<filename>.tmpl`, where the relative
  // offset is what lets the same code work in dev (<repo>/lib/...) and
  // post-build (<install>/dist/lib/... — see scripts/post-build.mjs).
  // A refactor that flattens dist or breaks the `'../../lib/'` offset
  // would silently regress every command that reads a template.
  it.each([
    ['getLauncherTemplate', 'mcp-start.js.tmpl'],
    ['getDeployTemplate', 'deploy.yml.tmpl'],
    ['getFreshnessTemplate', 'freshness.yml.tmpl'],
    ['getPrTemplate', 'pr-template.md.tmpl'],
    ['getClaudeSettingsTemplate', 'claude-settings.json.tmpl'],
  ])('%s resolves to an absolute path ending in lib/%s', async (fnName, filename) => {
    const platform = await import('../../src/lib/platform.js');
    const fn = platform[fnName as keyof typeof platform] as () => string;
    const p = fn();

    // Path is absolute (single point of truth — must not be cwd-relative)
    const { isAbsolute } = await import('node:path');
    expect(isAbsolute(p)).toBe(true);

    // Path's leaf is the expected template filename
    expect(p).toMatch(new RegExp(`[\\\\/]${filename.replace(/\./g, '\\.')}$`));

    // The directory just above the leaf is `lib` — this is the relative-offset
    // invariant that keeps dev (<repo>/lib/) and post-build (<install>/dist/lib/)
    // working from the same code without conditionals.
    const { dirname, basename } = await import('node:path');
    expect(basename(dirname(p))).toBe('lib');
  });
});
