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
  let origPlatform: NodeJS.Platform;
  beforeEach(() => { origPlatform = process.platform; });
  afterEach(() => { Object.defineProperty(process, 'platform', { value: origPlatform, writable: true }); });

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
  let origPlatform: NodeJS.Platform;
  beforeEach(() => { origEnv = { ...process.env }; origPlatform = process.platform; });
  afterEach(() => {
    process.env = origEnv;
    Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
  });

  it('returns a path containing .claude.json even when HOME is unset', async () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const { claudeJsonPath } = await import('../../src/lib/platform.js?bust=' + Date.now());
    const p = claudeJsonPath();
    expect(p).toMatch(/\.claude\.json$/);
  });

  it('returns a RELATIVE `.claude.json` when HOME and USERPROFILE are both unset on Linux (latent bug)', async () => {
    // The `?? ''` fallback at platform.ts:71 + path.join('', '.claude.json')
    // produces the relative path '.claude.json'. In practice HOME is always
    // set; pinning this so a future hardening (refuse-on-unset, default
    // to /tmp, etc.) is a deliberate, diff-visible change. Flagged in
    // the test-debt audit as a "latent bug" — registry would be written
    // to cwd instead of $HOME.
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const { claudeJsonPath } = await import('../../src/lib/platform.js?bust=' + Date.now());
    const { isAbsolute } = await import('node:path');
    const p = claudeJsonPath();
    expect(p).toBe('.claude.json');
    expect(isAbsolute(p)).toBe(false);
  });
});

describe('vaultsRoot — env var edge cases', () => {
  let origEnv: NodeJS.ProcessEnv;
  let origPlatform: NodeJS.Platform;
  beforeEach(() => { origEnv = { ...process.env }; origPlatform = process.platform; });
  afterEach(() => {
    process.env = origEnv;
    Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
  });

  it('uses HOME fallback when VAULTKIT_HOME is empty string', async () => {
    process.env.VAULTKIT_HOME = '';
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const { vaultsRoot } = await import('../../src/lib/platform.js?bust=' + Date.now());
    // Empty string is falsy — should fall back to HOME/vaults
    expect(vaultsRoot()).toBe(join(home, 'vaults'));
  });

  it('on linux with explicit HOME, returns HOME/vaults (platform-forced pin)', async () => {
    // The earlier test reads whatever HOME / USERPROFILE the host has —
    // this pin forces both platform and HOME so the test is deterministic
    // regardless of CI host. A future flip of the isWindows() branch order
    // in vaultsRoot would surface here.
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    process.env.HOME = '/home/testuser';
    delete process.env.VAULTKIT_HOME;
    const { vaultsRoot } = await import('../../src/lib/platform.js?bust=' + Date.now());
    expect(vaultsRoot()).toBe(join('/home/testuser', 'vaults'));
  });

  it('on win32 with explicit USERPROFILE, returns USERPROFILE\\vaults', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    process.env.USERPROFILE = 'C:\\Users\\TestUser';
    delete process.env.VAULTKIT_HOME;
    const { vaultsRoot } = await import('../../src/lib/platform.js?bust=' + Date.now());
    expect(vaultsRoot()).toBe(join('C:\\Users\\TestUser', 'vaults'));
  });
});

describe('findTool', () => {
  let tmp: string;
  let origEnv: NodeJS.ProcessEnv;
  let origPlatform: NodeJS.Platform;

  beforeEach(() => {
    origEnv = { ...process.env };
    origPlatform = process.platform;
    tmp = mkdtempSync(join(tmpdir(), 'vk-platform-test-'));
  });
  afterEach(() => {
    process.env = origEnv;
    Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
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

  it('falls through PROGRAMFILES to LOCALAPPDATA WinGet Links candidate (Windows)', async () => {
    if (process.platform !== 'win32') return;
    // PROGRAMFILES set to a path with NO gh.exe → first candidate misses.
    // LOCALAPPDATA/Microsoft/WinGet/Links/gh.exe exists → third candidate hits.
    process.env.PROGRAMFILES = join(tmp, 'fake-programfiles');
    const linksDir = join(tmp, 'Microsoft', 'WinGet', 'Links');
    mkdirSync(linksDir, { recursive: true });
    writeFileSync(join(linksDir, 'gh.exe'), '');
    process.env.LOCALAPPDATA = tmp;

    const result = await findTool('gh');
    expect(result).toBe(join(linksDir, 'gh.exe'));
  });

  it('falls through to probeWinGetGhPath when no candidate dir contains gh.exe (Windows)', async () => {
    if (process.platform !== 'win32') return;
    // PROGRAMFILES + the hardcoded C:\Program Files path + LOCALAPPDATA Links
    // all miss. The probe walks LOCALAPPDATA/Microsoft/WinGet/Packages/GitHub.cli_*/tools/gh.exe
    // and returns the first match.
    process.env.PROGRAMFILES = join(tmp, 'fake-programfiles');
    const wingetPkg = join(tmp, 'Microsoft', 'WinGet', 'Packages',
      'GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe', 'tools');
    mkdirSync(wingetPkg, { recursive: true });
    writeFileSync(join(wingetPkg, 'gh.exe'), '');
    // LOCALAPPDATA points at tmp, but /Microsoft/WinGet/Links/gh.exe doesn't
    // exist (only the Packages subtree does), so probeWinGetGhPath runs.
    process.env.LOCALAPPDATA = tmp;

    const result = await findTool('gh');
    expect(result).toBe(join(wingetPkg, 'gh.exe'));
  });

  it('on non-Windows, falls through to findOnPath which resolves a real binary', async () => {
    if (process.platform === 'win32') return;
    // Skip the Windows shortcut paths entirely. `node` is guaranteed to
    // exist on any Node test runner; `which node` returns its path.
    // Pins the POSIX fall-through so a regression that adds a hardcoded
    // POSIX shortcut path (or breaks the fall-through) surfaces.
    const result = await findTool('node');
    expect(result).not.toBeNull();
    expect(result).toContain('node');
  });
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

