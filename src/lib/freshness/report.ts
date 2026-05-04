import type { SourceEntry } from './sources.js';

/**
 * Result of comparing one source to its upstream — the discriminated union
 * the report builder consumes. Pure data shapes; the I/O that produces them
 * lives in `src/commands/refresh.ts`'s checkers (gh API for GitHub repos,
 * `compareSource` for web URLs). Decoupled from those checkers so the
 * report formatting changes for one reason (presentation) and the freshness
 * logic changes for a different reason (which sources, which strategy).
 */
export interface GitCheck {
  kind: 'git';
  entry: SourceEntry;
  slug: string;
  newCommits: number;
  recentSubjects: string[];
  error?: string;
}

export interface ComparedCheck {
  kind: 'compared';
  entry: SourceEntry;
  similarity: number;
}

export interface UnfetchableCheck {
  kind: 'unfetchable';
  entry: SourceEntry;
  reason: string;
}

export interface NoUrlCheck {
  kind: 'no-url';
  entry: SourceEntry;
}

export type CheckResult = GitCheck | ComparedCheck | UnfetchableCheck | NoUrlCheck;

/**
 * Threshold below which a `compareSource` result is treated as drifted.
 * 0.95 chosen so format-noise variations (Web Clipper vs. fresh fetch of
 * the same article) don't trip the alert, but a meaningful semantic change
 * does. Tunable per-vault is a future option.
 */
export const SIMILARITY_THRESHOLD = 0.95;

/**
 * Build the markdown freshness report from a list of check results, plus
 * a YYYY-MM-DD date string. Returns `{ report, findingCount }` where
 * `findingCount` lets the caller skip writing a report on quiet runs
 * (no findings → no PR noise).
 *
 * Sections, when present (in order):
 *   1. Sources auto-checked (git) — repos with new commits since clip
 *   2. Sources auto-checked (text-only compare) — drifted similarity
 *   3. Sources couldn't auto-check (manual review) — unfetchable + git API errors
 *   4. Sources without a URL in frontmatter — informational
 * Plus a footer pointing at the wiki style + patch-flow guidance in CLAUDE.md.
 */
export function formatReport(checks: CheckResult[], date: string): { report: string; findingCount: number } {
  const gits = checks.filter((c): c is GitCheck => c.kind === 'git');
  const compareds = checks.filter((c): c is ComparedCheck => c.kind === 'compared');
  const unfetchables = checks.filter((c): c is UnfetchableCheck => c.kind === 'unfetchable');
  const noUrls = checks.filter((c): c is NoUrlCheck => c.kind === 'no-url');

  const changedGits = gits.filter(g => !g.error && g.newCommits > 0);
  const erroredGits = gits.filter(g => g.error);
  const driftedCompares = compareds.filter(c => c.similarity < SIMILARITY_THRESHOLD);

  const findingCount =
    changedGits.length + driftedCompares.length + unfetchables.length + erroredGits.length + noUrls.length;

  const lines: string[] = [`# Freshness report — ${date}`, ''];

  if (findingCount === 0) {
    lines.push('No upstream changes detected. All sources unchanged.', '');
    return { report: lines.join('\n'), findingCount };
  }

  if (changedGits.length > 0) {
    lines.push('## Sources auto-checked (git)', '');
    for (const g of changedGits) {
      lines.push(`### ${g.slug}`);
      lines.push(`- Source URL: ${g.entry.url}`);
      lines.push(`- Local file: \`${g.entry.filePath}\``);
      if (g.entry.sourceDate) lines.push(`- Last clipped: ${g.entry.sourceDate}`);
      lines.push(`- New commits since clip: ${g.newCommits}`);
      if (g.recentSubjects.length > 0) {
        lines.push('- Recent commits:');
        for (const s of g.recentSubjects) lines.push(`  - ${s}`);
      }
      lines.push('');
    }
  }

  if (driftedCompares.length > 0) {
    lines.push('## Sources auto-checked (text-only compare)', '');
    for (const c of driftedCompares) {
      lines.push(`### ${c.entry.url}`);
      lines.push(`- Local file: \`${c.entry.filePath}\``);
      if (c.entry.sourceDate) lines.push(`- Last clipped: ${c.entry.sourceDate}`);
      lines.push(`- Similarity: ${(c.similarity * 100).toFixed(0)}% (likely changed)`);
      lines.push('');
    }
  }

  if (unfetchables.length + erroredGits.length > 0) {
    lines.push("## Sources couldn't auto-check (manual review)", '');
    for (const u of unfetchables) {
      lines.push(`- \`${u.entry.filePath}\` → ${u.entry.url} (${u.reason})`);
    }
    for (const g of erroredGits) {
      lines.push(`- \`${g.entry.filePath}\` → ${g.slug} (gh API: ${g.error})`);
    }
    lines.push('');
  }

  if (noUrls.length > 0) {
    lines.push('## Sources without a URL in frontmatter', '');
    for (const n of noUrls) {
      lines.push(`- \`${n.entry.filePath}\` (no \`source\`/\`url\`/\`source_path\` field)`);
    }
    lines.push('');
  }

  lines.push('---', '');
  lines.push('When patching, follow the "Wiki Style & Refresh Policy" section in CLAUDE.md.');
  lines.push('Scope edits to wiki pages whose `sources:` frontmatter cites the affected source.');
  lines.push('For sources in the "manual review" section, use WebFetch in your Obsidian session and patch only on meaningful semantic difference.');
  lines.push('');

  return { report: lines.join('\n'), findingCount };
}
