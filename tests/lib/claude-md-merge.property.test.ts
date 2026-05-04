import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mergeManagedSection, renderManagedSection } from '../../src/lib/claude-md-merge.js';

/**
 * Property-based tests for `mergeManagedSection` — vault concept
 * "Idempotency" applied to a marker-based merge. The wiki-style policy
 * section in CLAUDE.md is rewritten on every `vaultkit update`, and
 * users can edit around it. The merge MUST be idempotent so running
 * update twice in a row produces the same content as running it once.
 *
 * Properties below probe the algebraic shape: idempotence (apply twice
 * → same as once), preservation (markers in the input are honored), and
 * the no-edit fixed point (replacing identical content is a no-op).
 */

describe('mergeManagedSection: property-based', () => {
  it('is idempotent: applying twice yields the same merged content as applying once', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),  // existing CLAUDE.md content
        fc.string({ minLength: 1, maxLength: 100 }),  // section body
        (existing, body) => {
          const id = 'test-id';
          const heading = 'Test Heading';
          const sectionBody = `## ${heading}\n${body}`;

          const first = mergeManagedSection(existing, id, sectionBody, heading);
          // Apply again to the result — should be a fixed point.
          const second = mergeManagedSection(first.merged, id, sectionBody, heading);
          expect(second.merged).toBe(first.merged);

          // The action on the second pass is always 'replaced' when the
          // first pass wasn't 'manual'. (After 'replaced' or 'appended',
          // the markers are present in the output, so the next call enters
          // the replace path.)
          if (first.action === 'replaced' || first.action === 'appended') {
            expect(second.action).toBe('replaced');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('replacing identical body content is a fixed point: merged === existing when content already matches', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (body) => {
          const id = 'test-id';
          const heading = 'Test Heading';
          const sectionBody = `## ${heading}\n${body}`;
          // Construct a CLAUDE.md whose only content IS the managed section
          // wrapped in the canonical markers + outer formatting.
          const fresh = `# Title\n\n${renderManagedSection(id, sectionBody)}\n`;

          const result = mergeManagedSection(fresh, id, sectionBody, heading);
          expect(result.merged).toBe(fresh);
          expect(result.action).toBe('replaced');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('user-edited section without markers stays untouched (action: "manual")', () => {
    // When the user has a `## <heading>` in their CLAUDE.md but no markers,
    // we leave their content alone. Property: the merged content equals
    // the input verbatim.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (preamble, userContent) => {
          const id = 'test-id';
          const heading = 'Wiki Style';
          const userMd = `${preamble}\n\n## ${heading}\n${userContent}`;
          const newBody = `## ${heading}\nupdated body content`;

          const result = mergeManagedSection(userMd, id, newBody, heading);
          expect(result.action).toBe('manual');
          expect(result.merged).toBe(userMd);
        },
      ),
      { numRuns: 50 },
    );
  });
});
