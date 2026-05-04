import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateName } from '../../src/lib/vault.js';
import { VAULT_CONSTRAINTS } from '../../src/lib/constants.js';
import { isVaultkitError } from '../../src/lib/errors.js';

/**
 * Property-based tests for `validateName`. Example-based tests in
 * `vault.test.ts` cover the canonical cases. These properties exercise
 * the decision matrix at a higher rate — fast-check generates strings,
 * the properties pin the math.
 *
 * Targeting one specific class of regression: the validateName guards
 * are in front of every destructive operation (per
 * security-invariants.md: "Vault names must match ^[a-zA-Z0-9_-]+$,
 * max 64 chars"). A regex relaxation ('+', '/', whitespace, etc.)
 * would silently let dangerous names through. The properties make any
 * such regression break a generated test in CI.
 *
 * Implementation note: we build arbitraries from `fc.constantFrom` over
 * the canonical alphabet (or a known-bad alphabet) instead of using
 * `fc.stringMatching` with quantified patterns — the latter has been
 * observed to hang during generation on this fast-check version.
 */

const CANONICAL_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const FORBIDDEN_CHARS = '/. !@#$%^&*()+={}[]|\\:;<>?,~`\'"';

/** A string of 1-64 characters drawn only from the canonical alphabet. */
const validNameArb = fc
  .array(fc.constantFrom(...CANONICAL_CHARS), { minLength: 1, maxLength: 64 })
  .map(chars => chars.join(''));

/** A string of 65-128 characters from the canonical alphabet (over-length). */
const tooLongArb = fc
  .array(fc.constantFrom(...CANONICAL_CHARS), {
    minLength: VAULT_CONSTRAINTS.NAME_MAX_LENGTH + 1,
    maxLength: VAULT_CONSTRAINTS.NAME_MAX_LENGTH * 2,
  })
  .map(chars => chars.join(''));

/** A string with at least one forbidden character. */
const invalidCharArb = fc
  .tuple(
    // canonical-or-empty prefix
    fc.array(fc.constantFrom(...CANONICAL_CHARS), { minLength: 0, maxLength: 30 }),
    // at least one forbidden char in the middle
    fc.constantFrom(...FORBIDDEN_CHARS),
    // canonical-or-empty suffix
    fc.array(fc.constantFrom(...CANONICAL_CHARS), { minLength: 0, maxLength: 30 }),
  )
  .map(([prefix, mid, suffix]) => prefix.join('') + mid + suffix.join(''));

describe('validateName: property-based', () => {
  it('accepts every name made entirely of canonical chars at any length 1..64', () => {
    fc.assert(
      fc.property(validNameArb, (name) => {
        expect(() => validateName(name)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('throws INVALID_NAME for any over-length canonical-only string', () => {
    fc.assert(
      fc.property(tooLongArb, (name) => {
        let caught: unknown;
        try { validateName(name); } catch (err) { caught = err; }
        expect(isVaultkitError(caught)).toBe(true);
        expect((caught as { code: string }).code).toBe('INVALID_NAME');
      }),
      { numRuns: 100 },
    );
  });

  it('throws INVALID_NAME for any string containing a forbidden character', () => {
    fc.assert(
      fc.property(invalidCharArb, (name) => {
        let caught: unknown;
        try { validateName(name); } catch (err) { caught = err; }
        expect(isVaultkitError(caught), `accepted invalid name: ${JSON.stringify(name)}`).toBe(true);
        expect((caught as { code: string }).code).toBe('INVALID_NAME');
      }),
      { numRuns: 200 },
    );
  });

  it("rejects strings containing '/' with the canonical 'owner/repo' message", () => {
    // '/' is in FORBIDDEN_CHARS but earns its own message — pinned because
    // it's the friendliest error path (tells the user "vault name only,
    // not owner/repo").
    const slashArb = fc
      .tuple(
        fc.array(fc.constantFrom(...CANONICAL_CHARS), { minLength: 1, maxLength: 20 }),
        fc.array(fc.constantFrom(...CANONICAL_CHARS), { minLength: 1, maxLength: 20 }),
      )
      .map(([owner, repo]) => `${owner.join('')}/${repo.join('')}`);
    fc.assert(
      fc.property(slashArb, (name) => {
        let caught: unknown;
        try { validateName(name); } catch (err) { caught = err; }
        expect(isVaultkitError(caught)).toBe(true);
        expect((caught as { message: string }).message).toMatch(/owner\/repo/);
      }),
      { numRuns: 100 },
    );
  });
});
