import { describe, it, expect } from 'vitest';
import {
  VaultkitError,
  isVaultkitError,
  EXIT_CODES,
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
    ];
    for (const code of expectedCodes) {
      expect(EXIT_CODES[code], `missing exit code for ${code}`).toBeDefined();
      expect(EXIT_CODES[code], `non-numeric exit code for ${code}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('uses exit codes 2-12 (vaultkit-reserved range)', () => {
    for (const code of Object.values(EXIT_CODES)) {
      expect(code).toBeGreaterThanOrEqual(2);
      expect(code).toBeLessThanOrEqual(12);
    }
  });
});
