import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { silent, arrayLogger } from '../helpers/logger.js';

// Mock git.pull so we can control its responses without real network I/O
vi.mock('../../src/lib/git.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/git.js')>();
  return { ...real, pull: vi.fn() };
});

import { pull as mockPull } from '../../src/lib/git.js';
import { writeCfg } from '../helpers/registry.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-pull-mock-'));
  vi.mocked(mockPull).mockReset();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

describe('sync — mocked git scenarios', () => {
  it('logs pull failure with first line of stderr and continues to next vault', async () => {
    const v1 = makeDir(join(tmp, 'Vault1'));
    const v2 = makeDir(join(tmp, 'Vault2'));
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { Vault1: v1, Vault2: v2 });

    vi.mocked(mockPull)
      .mockResolvedValueOnce({ success: false, upToDate: false, timedOut: false, stderr: 'CONFLICT (content): Merge conflict in file.md\nother error' })
      .mockResolvedValueOnce({ success: true, upToDate: true, timedOut: false, stderr: '' });

    const { run } = await import('../../src/commands/sync.js');
    const lines: string[] = [];
    await run({ cfgPath, log: arrayLogger(lines) });

    expect(lines.some(l => /Vault1.*fail/i.test(l))).toBe(true);
    expect(lines.some(l => /CONFLICT/i.test(l))).toBe(true);
    expect(lines.some(l => /Vault2.*up.to.date/i.test(l))).toBe(true);
    // Both vaults attempted — pull called twice
    expect(vi.mocked(mockPull)).toHaveBeenCalledTimes(2);
  });

  it('logs timeout per vault and continues to others', async () => {
    const v1 = makeDir(join(tmp, 'Vault1'));
    const v2 = makeDir(join(tmp, 'Vault2'));
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { Vault1: v1, Vault2: v2 });

    vi.mocked(mockPull)
      .mockResolvedValueOnce({ success: false, upToDate: false, timedOut: true, stderr: '' })
      .mockResolvedValueOnce({ success: true, upToDate: false, timedOut: false, stderr: '' });

    const { run } = await import('../../src/commands/sync.js');
    const lines: string[] = [];
    await run({ cfgPath, log: arrayLogger(lines) });

    expect(lines.some(l => /Vault1.*timed? ?out/i.test(l))).toBe(true);
    expect(lines.some(l => /Vault2.*synced/i.test(l))).toBe(true);
    expect(vi.mocked(mockPull)).toHaveBeenCalledTimes(2);
  });

  it('logs failure when remote is not configured', async () => {
    const v = makeDir(join(tmp, 'NoRemote'));
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoRemote: v });

    vi.mocked(mockPull).mockResolvedValueOnce({
      success: false, upToDate: false, timedOut: false,
      stderr: 'There is no tracking information for the current branch.',
    });

    const { run } = await import('../../src/commands/sync.js');
    const lines: string[] = [];
    await run({ cfgPath, log: arrayLogger(lines) });

    expect(lines.some(l => /NoRemote.*fail/i.test(l))).toBe(true);
    expect(lines.some(l => /no tracking/i.test(l))).toBe(true);
  });

  it('respects VAULTKIT_PULL_TIMEOUT env var', async () => {
    const v = makeDir(join(tmp, 'MyVault'));
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: v });
    vi.mocked(mockPull).mockResolvedValueOnce({ success: true, upToDate: true, timedOut: false, stderr: '' });

    const origTimeout = process.env.VAULTKIT_PULL_TIMEOUT;
    process.env.VAULTKIT_PULL_TIMEOUT = '5000';
    const { run } = await import('../../src/commands/sync.js');
    await run({ cfgPath, log: silent });
    process.env.VAULTKIT_PULL_TIMEOUT = origTimeout;

    // pull was called with the custom timeout
    expect(vi.mocked(mockPull)).toHaveBeenCalledWith(v, { timeout: 5000 });
  });

  it('summary line reports correct synced and skipped counts', async () => {
    const v1 = makeDir(join(tmp, 'Synced'));
    const v2 = makeDir(join(tmp, 'Failed'));
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { Synced: v1, Failed: v2 });

    vi.mocked(mockPull)
      .mockResolvedValueOnce({ success: true, upToDate: false, timedOut: false, stderr: '' })
      .mockResolvedValueOnce({ success: false, upToDate: false, timedOut: false, stderr: 'err' });

    const { run } = await import('../../src/commands/sync.js');
    const lines: string[] = [];
    await run({ cfgPath, log: arrayLogger(lines) });

    const summary = lines.find(l => /\d+ vault.s. synced/i.test(l));
    expect(summary).toMatch(/1 vault.s. synced/i);
    expect(summary).toMatch(/1 skipped/i);
  });
});
