import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { similarity } from '../../src/lib/text-compare.js';

/**
 * Property-based tests for `similarity` (Jaccard over word sets). The
 * algebraic invariants below should hold for any inputs — fast-check
 * generates strings, the properties pin the math. Used by `compareSource`
 * for the freshness check; if any of these break, drift detection
 * silently degrades.
 */

describe('similarity: property-based', () => {
  it('reflexivity: similarity(s, s) === 1 for every non-empty string', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        (s) => {
          expect(similarity(s, s)).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('symmetry: similarity(a, b) === similarity(b, a)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 200 }),
        (a, b) => {
          expect(similarity(a, b)).toBe(similarity(b, a));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('range: similarity(a, b) is always in [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 200 }),
        (a, b) => {
          const result = similarity(a, b);
          expect(result).toBeGreaterThanOrEqual(0);
          expect(result).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
