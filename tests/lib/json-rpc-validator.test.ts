import { describe, it, expect } from 'vitest';
import {
  validateString,
  validateOptionalString,
  validateOptionalInteger,
  ValidationError,
} from '../../src/lib/mcp/json-rpc-validator.js';

describe('validateString', () => {
  it('returns the value when present and a string', () => {
    expect(validateString({ q: 'hello' }, 'q')).toBe('hello');
  });

  it('throws on missing field', () => {
    expect(() => validateString({}, 'q')).toThrowError(ValidationError);
    expect(() => validateString({ q: null }, 'q')).toThrowError(/Missing required field/);
  });

  it('throws when value is not a string', () => {
    expect(() => validateString({ q: 42 }, 'q')).toThrowError(/must be a string/);
  });

  it('enforces minLength', () => {
    expect(() => validateString({ q: '' }, 'q', { minLength: 1 })).toThrowError(/at least 1/);
    expect(validateString({ q: 'a' }, 'q', { minLength: 1 })).toBe('a');
  });

  it('enforces maxLength', () => {
    expect(() => validateString({ q: 'longer' }, 'q', { maxLength: 3 })).toThrowError(/at most 3/);
  });

  it('enforces enum membership', () => {
    expect(() =>
      validateString({ mode: 'fast' }, 'mode', { enum: ['slow', 'medium'] }),
    ).toThrowError(/must be one of: slow, medium/);
    expect(validateString({ mode: 'slow' }, 'mode', { enum: ['slow', 'medium'] })).toBe('slow');
  });
});

describe('validateOptionalString', () => {
  it('returns undefined when field absent', () => {
    expect(validateOptionalString({}, 'q')).toBeUndefined();
    expect(validateOptionalString({ q: null }, 'q')).toBeUndefined();
  });

  it('returns the value when present', () => {
    expect(validateOptionalString({ q: 'x' }, 'q')).toBe('x');
  });

  it('throws when present-but-wrong-type', () => {
    expect(() => validateOptionalString({ q: 42 }, 'q')).toThrowError(/must be a string/);
  });
});

describe('validateOptionalInteger', () => {
  it('returns undefined when field absent', () => {
    expect(validateOptionalInteger({}, 'n')).toBeUndefined();
  });

  it('returns the value when an integer', () => {
    expect(validateOptionalInteger({ n: 5 }, 'n')).toBe(5);
  });

  it('throws on non-integer numbers', () => {
    expect(() => validateOptionalInteger({ n: 1.5 }, 'n')).toThrowError(/must be an integer/);
  });

  it('throws on non-numbers', () => {
    expect(() => validateOptionalInteger({ n: '5' }, 'n')).toThrowError(/must be an integer/);
  });

  it('enforces minimum / maximum', () => {
    expect(() => validateOptionalInteger({ n: 0 }, 'n', { minimum: 1 })).toThrowError(/>= 1/);
    expect(() => validateOptionalInteger({ n: 100 }, 'n', { maximum: 50 })).toThrowError(/<= 50/);
    expect(validateOptionalInteger({ n: 5 }, 'n', { minimum: 1, maximum: 10 })).toBe(5);
  });
});
