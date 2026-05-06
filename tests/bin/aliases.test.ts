import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for the deprecation-alias printers.
 *
 * The full alias dispatch flow (commander invocation → notice → forward
 * to new command) is exercised end-to-end by the per-command test files
 * (e.g. `tests/commands/list.test.ts` covers the `status` alias by
 * running `vaultkit status` and asserting both the notice fires and
 * `list`'s output appears). These tests pin the printer wording so that
 * a future copy-edit doesn't silently change the contract that scripted
 * callers might grep for.
 */

import { printDeprecationNotice, printRemovalNotice } from '../../src/lib/cli-aliases.js';

describe('deprecation alias printers', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  describe('printDeprecationNotice', () => {
    it('prints the canonical notice format to stderr', () => {
      printDeprecationNotice('verify', 'doctor');
      expect(captured.join('')).toBe(
        `Note: 'vaultkit verify' is deprecated; use 'vaultkit doctor' instead.\n`,
      );
    });

    it('handles renamed commands like status → list', () => {
      printDeprecationNotice('status', 'list');
      expect(captured.join('')).toContain(`'vaultkit status' is deprecated`);
      expect(captured.join('')).toContain(`use 'vaultkit list' instead`);
    });

    it('handles compound replacements like update --all → doctor --fix --all', () => {
      printDeprecationNotice('update --all', 'doctor --fix --all');
      expect(captured.join('')).toBe(
        `Note: 'vaultkit update --all' is deprecated; use 'vaultkit doctor --fix --all' instead.\n`,
      );
    });
  });

  describe('printRemovalNotice', () => {
    it('prints the canonical removal notice with a migration hint', () => {
      printRemovalNotice(
        'backup',
        `Use 'git clone --mirror <repo-url> <dest>' for a full snapshot.`,
      );
      expect(captured.join('')).toBe(
        `Note: 'vaultkit backup' was removed in 3.0. Use 'git clone --mirror <repo-url> <dest>' for a full snapshot.\n`,
      );
    });
  });
});
