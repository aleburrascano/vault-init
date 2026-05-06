import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arrayLogger } from '../helpers/logger.js';

// homedir() is read at module-load time to compute CACHE_PATH. We mock it
// inside the factory (which is hoisted by vi.mock) so the fake home dir
// exists before update-check.ts's static import evaluates.
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  const { mkdtempSync } = await import('node:fs');
  const home = mkdtempSync(join(real.tmpdir(), 'vk-update-check-home-'));
  return { ...real, homedir: () => home };
});

import { _isNewer, checkForUpdate } from '../../src/lib/notices/update-check.js';
import { homedir } from 'node:os';

const CACHE_PATH = join(homedir(), '.vaultkit-update-check.json');

beforeEach(() => {
  // Clean cache between tests; clear env gate.
  rmSync(CACHE_PATH, { force: true });
  delete process.env.VAULTKIT_NO_UPDATE_CHECK;
});

afterEach(() => {
  rmSync(CACHE_PATH, { force: true });
  delete process.env.VAULTKIT_NO_UPDATE_CHECK;
});

describe('_isNewer', () => {
  it('returns true when latest patch > current patch', () => {
    expect(_isNewer('2.5.1', '2.5.0')).toBe(true);
  });

  it('returns true when latest minor > current minor', () => {
    expect(_isNewer('2.6.0', '2.5.99')).toBe(true);
  });

  it('returns true when latest major > current major', () => {
    expect(_isNewer('3.0.0', '2.99.99')).toBe(true);
  });

  it('returns false on equal versions', () => {
    expect(_isNewer('2.5.0', '2.5.0')).toBe(false);
  });

  it('returns false when current is newer', () => {
    expect(_isNewer('2.4.0', '2.5.0')).toBe(false);
    expect(_isNewer('1.99.99', '2.0.0')).toBe(false);
  });

  it('treats missing components as 0', () => {
    expect(_isNewer('2.5', '2.5.0')).toBe(false);
    expect(_isNewer('2.5.0', '2.5')).toBe(false);
    expect(_isNewer('2.6', '2.5.99')).toBe(true);
  });

  it('returns false on non-numeric components rather than throwing', () => {
    expect(_isNewer('garbage', '2.5.0')).toBe(false);
    expect(_isNewer('2.5.0', 'garbage')).toBe(false);
    expect(_isNewer('2.5.beta', '2.5.0')).toBe(false);
  });

  it('treats prerelease and build-metadata suffixes as the numeric prefix', () => {
    // parseInt('2-beta') === 2; parseInt('5+build.1') === 5
    expect(_isNewer('2.5.1-beta', '2.5.0')).toBe(true);
    expect(_isNewer('2.5.0+build.1', '2.5.0')).toBe(false);
  });

  it('returns false for v-prefixed versions (parseInt cannot strip the v)', () => {
    // parseInt('v2.5.0') === NaN → guard returns false
    expect(_isNewer('v2.5.0', '2.5.0')).toBe(false);
    expect(_isNewer('2.5.0', 'v2.5.0')).toBe(false);
  });

  it('handles versions with leading zeros (parseInt strips them)', () => {
    expect(_isNewer('02.05.01', '2.5.0')).toBe(true);
    expect(_isNewer('02.05.00', '2.5.0')).toBe(false);
  });

  it('handles very large version components without overflow', () => {
    expect(_isNewer('999999999.0.0', '999999998.99.99')).toBe(true);
  });
});

describe('checkForUpdate env gate', () => {
  it('returns immediately when VAULTKIT_NO_UPDATE_CHECK=1 — no log, no cache read', () => {
    process.env.VAULTKIT_NO_UPDATE_CHECK = '1';
    // Pre-populate cache with a newer version — the gate should still suppress.
    writeFileSync(CACHE_PATH, JSON.stringify({ latest: '99.0.0', checkedAt: Date.now() }), 'utf8');

    const lines: string[] = [];
    checkForUpdate('1.0.0', arrayLogger(lines));
    expect(lines.length).toBe(0);
  });

  it('does NOT suppress on truthy-looking but non-"1" values', () => {
    // Only the literal '1' gates. '0', 'true', 'TRUE', '' all fall through.
    for (const value of ['0', 'true', 'TRUE', '']) {
      process.env.VAULTKIT_NO_UPDATE_CHECK = value;
      writeFileSync(
        CACHE_PATH,
        JSON.stringify({ latest: '99.0.0', checkedAt: Date.now() }),
        'utf8',
      );
      const lines: string[] = [];
      checkForUpdate('1.0.0', arrayLogger(lines));
      // Newer cached version should produce two log.warn lines.
      expect(lines.length, `value="${value}" should not suppress`).toBe(2);
    }
  });
});

describe('checkForUpdate cache behavior', () => {
  it('logs two warn lines when cached version is newer than current', () => {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ latest: '99.0.0', checkedAt: Date.now() }),
      'utf8',
    );

    const lines: string[] = [];
    checkForUpdate('1.2.3', arrayLogger(lines));
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/vaultkit 99\.0\.0 is available \(you have 1\.2\.3\)/);
    expect(lines[1]).toMatch(/npm update -g @aleburrascano\/vaultkit/);
  });

  it('logs nothing when cached version equals current', () => {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ latest: '1.2.3', checkedAt: Date.now() }),
      'utf8',
    );

    const lines: string[] = [];
    checkForUpdate('1.2.3', arrayLogger(lines));
    expect(lines.length).toBe(0);
  });

  it('logs nothing when cached version is older than current', () => {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ latest: '1.0.0', checkedAt: Date.now() }),
      'utf8',
    );

    const lines: string[] = [];
    checkForUpdate('2.0.0', arrayLogger(lines));
    expect(lines.length).toBe(0);
  });

  it('treats corrupt JSON as missing cache (no warn, no throw)', () => {
    writeFileSync(CACHE_PATH, '{ this is not valid json', 'utf8');

    const lines: string[] = [];
    expect(() => checkForUpdate('1.2.3', arrayLogger(lines))).not.toThrow();
    expect(lines.length).toBe(0);
  });

  it('treats partial-shape cache (latest as number) as missing', () => {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ latest: 99, checkedAt: Date.now() }),
      'utf8',
    );

    const lines: string[] = [];
    checkForUpdate('1.2.3', arrayLogger(lines));
    // latest is not a string → readCache returns null → no warn fires
    expect(lines.length).toBe(0);
  });

  it('treats partial-shape cache (missing checkedAt) as missing', () => {
    writeFileSync(CACHE_PATH, JSON.stringify({ latest: '99.0.0' }), 'utf8');

    const lines: string[] = [];
    checkForUpdate('1.2.3', arrayLogger(lines));
    expect(lines.length).toBe(0);
  });

  it('does not warn from a stale cache that happens to be newer (still warns — staleness only triggers refetch)', () => {
    // Stale = checkedAt > 24h ago. The current code still uses the cached
    // value for the warn check; staleness only triggers backgroundFetch.
    // This pins that behavior.
    const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ latest: '99.0.0', checkedAt: staleTimestamp }),
      'utf8',
    );

    const lines: string[] = [];
    checkForUpdate('1.2.3', arrayLogger(lines));
    // Still warns because the cached value is newer than current, even
    // though the cache is stale (background refresh is fire-and-forget).
    expect(lines.length).toBe(2);
  });
});
