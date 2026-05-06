import { describe, it, expect } from 'vitest';
import {
  HISTORICAL_LAUNCHER_SHAS,
  classifyLauncherSha,
  historicalVersionLabel,
} from '../../src/lib/notices/launcher-history.js';

describe('classifyLauncherSha', () => {
  it('returns match when on-disk equals expected', () => {
    const sha = 'a'.repeat(64);
    expect(classifyLauncherSha(sha, sha)).toBe('match');
  });

  it('returns historical when on-disk is a known prior shipped SHA', () => {
    const expected = 'b'.repeat(64);
    const historicalSha = Object.keys(HISTORICAL_LAUNCHER_SHAS)[0];
    if (!historicalSha) throw new Error('expected at least one entry in HISTORICAL_LAUNCHER_SHAS');
    expect(classifyLauncherSha(historicalSha, expected)).toBe('historical');
  });

  it('returns unknown when on-disk matches no known SHA', () => {
    const expected = 'c'.repeat(64);
    const random = '0'.repeat(64);
    expect(classifyLauncherSha(random, expected)).toBe('unknown');
  });

  it('match wins over historical (current SHA happens to be in the table is a no-op)', () => {
    // If a historical SHA is also the current expected SHA (shouldn't happen in
    // practice — old releases drop out — but the contract is well-defined), the
    // 'match' branch fires first.
    const historicalSha = Object.keys(HISTORICAL_LAUNCHER_SHAS)[0];
    if (!historicalSha) throw new Error('expected at least one entry in HISTORICAL_LAUNCHER_SHAS');
    expect(classifyLauncherSha(historicalSha, historicalSha)).toBe('match');
  });
});

describe('historicalVersionLabel', () => {
  it('returns the label for a known SHA', () => {
    const [sha, label] = Object.entries(HISTORICAL_LAUNCHER_SHAS)[0] ?? [];
    if (!sha || !label) throw new Error('expected at least one entry in HISTORICAL_LAUNCHER_SHAS');
    expect(historicalVersionLabel(sha)).toBe(label);
  });

  it('returns null for an unknown SHA', () => {
    expect(historicalVersionLabel('f'.repeat(64))).toBeNull();
  });
});

describe('HISTORICAL_LAUNCHER_SHAS table shape', () => {
  it('every key is a 64-hex-char SHA-256', () => {
    for (const sha of Object.keys(HISTORICAL_LAUNCHER_SHAS)) {
      expect(sha).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('every value is a non-empty version label', () => {
    for (const label of Object.values(HISTORICAL_LAUNCHER_SHAS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
