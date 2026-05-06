import { describe, it, expect } from 'vitest';
import { renderManagedSection, mergeManagedSection } from '../../src/lib/templates/claude-md-merge.js';

const ID = 'wiki-style';
const HEADING = 'Wiki Style & Refresh Policy';
const BODY = `## ${HEADING}\n\nFresh content here.`;

describe('renderManagedSection', () => {
  it('wraps body with start and end markers', () => {
    const result = renderManagedSection(ID, BODY);
    expect(result).toBe(
      `<!-- vaultkit:${ID}:start -->\n${BODY}\n<!-- vaultkit:${ID}:end -->`,
    );
  });
});

describe('mergeManagedSection', () => {
  it('replaces content between markers when both are present', () => {
    const existing =
      `# CLAUDE\n\nIntro paragraph.\n\n` +
      `<!-- vaultkit:${ID}:start -->\n## ${HEADING}\n\nOld content\n<!-- vaultkit:${ID}:end -->\n\n` +
      `Trailing user content.`;
    const result = mergeManagedSection(existing, ID, BODY, HEADING);
    expect(result.action).toBe('replaced');
    expect(result.merged).toContain('Fresh content here.');
    expect(result.merged).not.toContain('Old content');
    expect(result.merged).toContain('Intro paragraph.');
    expect(result.merged).toContain('Trailing user content.');
    expect(result.merged).toContain(`<!-- vaultkit:${ID}:start -->`);
    expect(result.merged).toContain(`<!-- vaultkit:${ID}:end -->`);
  });

  it('appends a wrapped section when no markers and no heading exist', () => {
    const existing = '# CLAUDE\n\nIntro only.';
    const result = mergeManagedSection(existing, ID, BODY, HEADING);
    expect(result.action).toBe('appended');
    expect(result.merged.startsWith('# CLAUDE\n\nIntro only.')).toBe(true);
    expect(result.merged).toContain(`<!-- vaultkit:${ID}:start -->`);
    expect(result.merged).toContain('Fresh content here.');
    expect(result.merged).toContain(`<!-- vaultkit:${ID}:end -->`);
  });

  it('returns original unchanged when heading exists without markers', () => {
    const existing = `# CLAUDE\n\n## ${HEADING}\n\nUser hand-wrote this.`;
    const result = mergeManagedSection(existing, ID, BODY, HEADING);
    expect(result.action).toBe('manual');
    expect(result.merged).toBe(existing);
  });

  it('treats only-start-marker as a non-replace (falls back to heading check)', () => {
    const existing = `# CLAUDE\n\n<!-- vaultkit:${ID}:start -->\nSomething.`;
    const result = mergeManagedSection(existing, ID, BODY, HEADING);
    expect(result.action).toBe('appended');
  });

  it('treats only-end-marker as a non-replace', () => {
    const existing = `# CLAUDE\n\nText\n<!-- vaultkit:${ID}:end -->\n`;
    const result = mergeManagedSection(existing, ID, BODY, HEADING);
    expect(result.action).toBe('appended');
  });

  it('escapes special regex chars in headingName', () => {
    const fancyHeading = 'Style & Policy (v1.0)';
    const fancyBody = `## ${fancyHeading}\n\nbody`;
    const existing = `# CLAUDE\n\n## ${fancyHeading}\n\nUser content.`;
    const result = mergeManagedSection(existing, 'fancy', fancyBody, fancyHeading);
    expect(result.action).toBe('manual');
  });

  it('preserves content order: before-marker / managed / after-marker', () => {
    const existing =
      `# CLAUDE\n\nFirst paragraph.\n\n` +
      `<!-- vaultkit:${ID}:start -->\nold\n<!-- vaultkit:${ID}:end -->\n\n` +
      `Last paragraph.`;
    const result = mergeManagedSection(existing, ID, BODY, HEADING);
    const firstIdx = result.merged.indexOf('First paragraph.');
    const managedIdx = result.merged.indexOf('Fresh content here.');
    const lastIdx = result.merged.indexOf('Last paragraph.');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(managedIdx).toBeGreaterThan(firstIdx);
    expect(lastIdx).toBeGreaterThan(managedIdx);
  });
});
