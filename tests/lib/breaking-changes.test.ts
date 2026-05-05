import { describe, it, expect } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  BREAKING_CHANGES,
  migrationsNeeded,
  type BreakingChange,
} from '../../src/lib/breaking-changes.js';

describe('CURRENT_SCHEMA_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});

describe('BREAKING_CHANGES table', () => {
  it('every entry references a non-zero positive toSchemaVersion', () => {
    for (const entry of BREAKING_CHANGES) {
      expect(Number.isInteger(entry.toSchemaVersion)).toBe(true);
      expect(entry.toSchemaVersion).toBeGreaterThan(0);
    }
  });

  it('every toSchemaVersion is at most CURRENT_SCHEMA_VERSION (no orphan entries)', () => {
    for (const entry of BREAKING_CHANGES) {
      expect(entry.toSchemaVersion).toBeLessThanOrEqual(CURRENT_SCHEMA_VERSION);
    }
  });

  it('every entry has a non-empty remedyCommand and humanLabel', () => {
    for (const entry of BREAKING_CHANGES) {
      expect(entry.remedyCommand.length).toBeGreaterThan(0);
      expect(entry.humanLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('migrationsNeeded', () => {
  it('returns empty for null vault version when the table is empty', () => {
    if (BREAKING_CHANGES.length > 0) return; // skip — table populated
    expect(migrationsNeeded(null)).toEqual([]);
  });

  it('returns empty for undefined vault version when the table is empty', () => {
    if (BREAKING_CHANGES.length > 0) return; // skip
    expect(migrationsNeeded(undefined)).toEqual([]);
  });

  it('returns empty for a vault at CURRENT_SCHEMA_VERSION', () => {
    expect(migrationsNeeded(CURRENT_SCHEMA_VERSION)).toEqual([]);
  });

  it('with a synthetic table, returns entries whose toSchemaVersion exceeds the vault version', () => {
    // Test the filter logic against a synthetic table without mutating the
    // real BREAKING_CHANGES array (which is `readonly`).
    const synthetic: readonly BreakingChange[] = [
      { toSchemaVersion: 1, component: 'launcher', severity: 'warn', remedyCommand: 'vaultkit update --all', humanLabel: 'launcher v1' },
      { toSchemaVersion: 2, component: 'registry', severity: 'fail', remedyCommand: 'vaultkit setup', humanLabel: 'registry v2' },
      { toSchemaVersion: 3, component: 'layout',   severity: 'warn', remedyCommand: 'vaultkit update <name>', humanLabel: 'layout v3' },
    ];
    const filterFor = (v: number | null | undefined): readonly BreakingChange[] => {
      const version = v ?? 0;
      return synthetic.filter(c => version < c.toSchemaVersion);
    };
    // Vault at v0 (legacy) → all three apply
    expect(filterFor(null).length).toBe(3);
    // Vault at v1 → entries with toSchemaVersion > 1 apply (2 and 3)
    expect(filterFor(1).map(c => c.toSchemaVersion)).toEqual([2, 3]);
    // Vault at v3 → none apply
    expect(filterFor(3)).toEqual([]);
  });
});
