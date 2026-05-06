/**
 * Marker-based merge for vaultkit-managed sections in CLAUDE.md.
 * Wraps content in `<!-- vaultkit:<id>:start -->` ... `<!-- vaultkit:<id>:end -->`
 * markers so future template updates can replace just the managed region
 * without disturbing the user's surrounding edits. Reusable for any future
 * vaultkit-managed CLAUDE.md section, not just the wiki-style one.
 */

export type MergeAction = 'replaced' | 'appended' | 'manual';

export interface MergeResult {
  merged: string;
  action: MergeAction;
}

const startMarker = (id: string): string => `<!-- vaultkit:${id}:start -->`;
const endMarker = (id: string): string => `<!-- vaultkit:${id}:end -->`;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wrap a section body in vaultkit's start/end markers. The body should
 * include its own `## Heading` line. Used by `init` (full scaffold) and
 * `update` (gap repair via the layout system).
 */
export function renderManagedSection(id: string, body: string): string {
  return `${startMarker(id)}\n${body}\n${endMarker(id)}`;
}

/**
 * Merge a vaultkit-managed section into an existing CLAUDE.md. Three cases:
 *
 *   1. Markers present → replace content between them (action: 'replaced').
 *   2. Markers absent AND no `## <headingName>` heading → append the wrapped
 *      section at the end (action: 'appended').
 *   3. Heading present without markers → user has hand-edited; don't touch.
 *      Return original unchanged so the caller can print a manual-merge
 *      snippet (action: 'manual').
 *
 * `body` is the raw section content (no markers). `headingName` is used
 * only for case-3 detection; it should match the H2 inside `body`.
 */
export function mergeManagedSection(
  existingMd: string,
  id: string,
  body: string,
  headingName: string,
): MergeResult {
  const start = startMarker(id);
  const end = endMarker(id);
  const startIdx = existingMd.indexOf(start);
  const endIdx = existingMd.indexOf(end);

  if (startIdx >= 0 && endIdx > startIdx) {
    const before = existingMd.slice(0, startIdx);
    const after = existingMd.slice(endIdx + end.length);
    const merged = before + renderManagedSection(id, body) + after;
    return { merged, action: 'replaced' };
  }

  const headingPattern = new RegExp(`^##\\s+${escapeRegex(headingName)}\\s*$`, 'm');
  if (headingPattern.test(existingMd)) {
    return { merged: existingMd, action: 'manual' };
  }

  const trimmed = existingMd.replace(/\n+$/, '');
  const merged = `${trimmed}\n\n${renderManagedSection(id, body)}\n`;
  return { merged, action: 'appended' };
}
