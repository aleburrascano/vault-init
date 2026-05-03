import { describe, it, expect } from 'vitest';
import {
  VaultkitError,
  isVaultkitError,
  EXIT_CODES,
  DEFAULT_MESSAGES,
  type VaultkitErrorCode,
} from '../../src/lib/errors.js';

describe('VaultkitError', () => {
  it('exposes code and message', () => {
    const err = new VaultkitError('INVALID_NAME', 'bad name');
    expect(err.code).toBe('INVALID_NAME');
    expect(err.message).toBe('bad name');
  });

  it('has name "VaultkitError"', () => {
    const err = new VaultkitError('NOT_REGISTERED', 'x');
    expect(err.name).toBe('VaultkitError');
  });

  it('extends Error so it propagates through normal try/catch', () => {
    const err = new VaultkitError('NOT_REGISTERED', 'x');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isVaultkitError', () => {
  it('returns true for VaultkitError instances', () => {
    expect(isVaultkitError(new VaultkitError('INVALID_NAME', 'x'))).toBe(true);
  });

  it('returns false for plain Error instances', () => {
    expect(isVaultkitError(new Error('plain'))).toBe(false);
  });

  it('returns false for non-error values (string, null, undefined, plain object)', () => {
    expect(isVaultkitError('string')).toBe(false);
    expect(isVaultkitError(null)).toBe(false);
    expect(isVaultkitError(undefined)).toBe(false);
    expect(isVaultkitError({ code: 'INVALID_NAME', message: 'x' })).toBe(false);
  });
});

describe('EXIT_CODES', () => {
  it('reserves exit code 0 for success and 1 for unknown errors (no VaultkitErrorCode uses them)', () => {
    const codes = Object.values(EXIT_CODES);
    expect(codes).not.toContain(0);
    expect(codes).not.toContain(1);
  });

  it('assigns a unique exit code to every VaultkitErrorCode (no collisions)', () => {
    const codes = Object.values(EXIT_CODES);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it('includes a mapping for every documented error code', () => {
    const expectedCodes: VaultkitErrorCode[] = [
      'INVALID_NAME',
      'NOT_REGISTERED',
      'ALREADY_REGISTERED',
      'NOT_VAULT_LIKE',
      'HASH_MISMATCH',
      'AUTH_REQUIRED',
      'PERMISSION_DENIED',
      'TOOL_MISSING',
      'NETWORK_TIMEOUT',
      'UNRECOGNIZED_INPUT',
      'PARTIAL_FAILURE',
      'RATE_LIMITED',
    ];
    for (const code of expectedCodes) {
      expect(EXIT_CODES[code], `missing exit code for ${code}`).toBeDefined();
      expect(EXIT_CODES[code], `non-numeric exit code for ${code}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('uses exit codes 2-13 (vaultkit-reserved range)', () => {
    for (const code of Object.values(EXIT_CODES)) {
      expect(code).toBeGreaterThanOrEqual(2);
      expect(code).toBeLessThanOrEqual(13);
    }
  });

  it('pins each code to its exact integer (public contract — scripted callers depend on this)', () => {
    // The earlier loop only asserts presence + range. A swap of two codes
    // (e.g. PERMISSION_DENIED ↔ TOOL_MISSING) would pass uniqueness AND
    // range AND presence, but silently break every shell pipeline that
    // branches on `if [ $? -eq 8 ]`. Per errors.ts:1-8 these values are
    // a public contract; pin them by value.
    const expected: Record<VaultkitErrorCode, number> = {
      INVALID_NAME: 2,
      NOT_REGISTERED: 3,
      ALREADY_REGISTERED: 4,
      NOT_VAULT_LIKE: 5,
      HASH_MISMATCH: 6,
      AUTH_REQUIRED: 7,
      PERMISSION_DENIED: 8,
      TOOL_MISSING: 9,
      NETWORK_TIMEOUT: 10,
      UNRECOGNIZED_INPUT: 11,
      PARTIAL_FAILURE: 12,
      RATE_LIMITED: 13,
    };
    for (const [code, value] of Object.entries(expected)) {
      expect(EXIT_CODES[code as VaultkitErrorCode], `EXIT_CODES.${code} drifted`).toBe(value);
    }
  });

  it('uses every integer from 2 through 13 exactly once (contiguity)', () => {
    // Range + uniqueness + count == 12 → contiguous over [2..13]. Catches
    // a future code drop that leaves a gap (e.g. removes NOT_REGISTERED but
    // doesn't renumber, so 3 is unused while 13 is still RATE_LIMITED).
    const codes = Object.values(EXIT_CODES).sort((a, b) => a - b);
    expect(codes).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });
});

describe('DEFAULT_MESSAGES', () => {
  it('provides a message for every error code', () => {
    const expectedCodes: VaultkitErrorCode[] = [
      'INVALID_NAME', 'NOT_REGISTERED', 'ALREADY_REGISTERED',
      'NOT_VAULT_LIKE', 'HASH_MISMATCH', 'AUTH_REQUIRED',
      'PERMISSION_DENIED', 'TOOL_MISSING', 'NETWORK_TIMEOUT',
      'UNRECOGNIZED_INPUT', 'PARTIAL_FAILURE', 'RATE_LIMITED',
    ];
    for (const code of expectedCodes) {
      const msg = DEFAULT_MESSAGES[code];
      expect(msg, `missing message for ${code}`).toBeDefined();
      expect((msg ?? '').length, `empty message for ${code}`).toBeGreaterThan(0);
    }
  });

  it('formats sensibly when prefixed with a subject', () => {
    // Pattern: `"${name}" ${DEFAULT_MESSAGES.X}` should read as a sentence.
    expect(`"MyVault" ${DEFAULT_MESSAGES.NOT_REGISTERED}`)
      .toBe('"MyVault" is not a registered vault.');
    expect(`"MyVault" ${DEFAULT_MESSAGES.ALREADY_REGISTERED}`)
      .toBe('"MyVault" is already registered.');
  });

  it('NOT_REGISTERED still matches the legacy /not a registered/i regex tests use', () => {
    expect(DEFAULT_MESSAGES.NOT_REGISTERED).toMatch(/not a registered/i);
  });

  it('pins each code to its exact canonical phrasing', () => {
    // Earlier loop only asserts presence + non-empty. A typo fix in any of
    // the 10 currently-untested templates (e.g. 'is not a valid vault name.'
    // → 'is invalid.') slips through. The DEFAULT_MESSAGES record is the
    // single source of truth for these sentence fragments — pin them.
    const expected: Record<VaultkitErrorCode, string> = {
      INVALID_NAME: 'is not a valid vault name.',
      NOT_REGISTERED: 'is not a registered vault.',
      ALREADY_REGISTERED: 'is already registered.',
      NOT_VAULT_LIKE: 'does not look like a vaultkit vault.',
      HASH_MISMATCH: 'launcher SHA-256 differs from the pinned hash.',
      AUTH_REQUIRED: 'requires GitHub authentication.',
      PERMISSION_DENIED: 'requires admin permissions on the remote repo.',
      TOOL_MISSING: 'requires a CLI tool that is not installed.',
      NETWORK_TIMEOUT: 'timed out waiting for a network operation.',
      UNRECOGNIZED_INPUT: 'is not in a recognized format.',
      PARTIAL_FAILURE: 'partially failed — some operations did not complete.',
      RATE_LIMITED: 'was rate-limited by GitHub after exhausting the retry budget.',
    };
    for (const [code, value] of Object.entries(expected)) {
      expect(DEFAULT_MESSAGES[code as VaultkitErrorCode], `DEFAULT_MESSAGES.${code} drifted`).toBe(value);
    }
  });
});
