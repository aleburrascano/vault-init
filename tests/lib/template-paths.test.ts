import { describe, it, expect } from 'vitest';

describe('template path getters', () => {
  // The 5 template path helpers (getLauncherTemplate / getDeployTemplate /
  // getFreshnessTemplate / getPrTemplate / getClaudeSettingsTemplate)
  // share one invariant: each resolves to `<...>/lib/<filename>.tmpl`,
  // where the relative offset is what lets the same code work in dev
  // (<repo>/lib/...) and post-build (<install>/dist/lib/... — see
  // scripts/post-build.mjs). A refactor that flattens dist or breaks the
  // `'../../lib/'` offset would silently regress every command that reads
  // a template.
  it.each([
    ['getLauncherTemplate', 'mcp-start.js.tmpl'],
    ['getDeployTemplate', 'deploy.yml.tmpl'],
    ['getFreshnessTemplate', 'freshness.yml.tmpl'],
    ['getPrTemplate', 'pr-template.md.tmpl'],
    ['getClaudeSettingsTemplate', 'claude-settings.json.tmpl'],
  ])('%s resolves to an absolute path ending in lib/%s', async (fnName, filename) => {
    const templatePaths = await import('../../src/lib/template-paths.js');
    const fn = templatePaths[fnName as keyof typeof templatePaths] as () => string;
    const p = fn();

    // Path is absolute (single point of truth — must not be cwd-relative)
    const { isAbsolute } = await import('node:path');
    expect(isAbsolute(p)).toBe(true);

    // Path's leaf is the expected template filename
    expect(p).toMatch(new RegExp(`[\\\\/]${filename.replace(/\./g, '\\.')}$`));

    // The directory just above the leaf is `lib` — this is the relative-offset
    // invariant that keeps dev (<repo>/lib/) and post-build (<install>/dist/lib/)
    // working from the same code without conditionals.
    const { dirname, basename } = await import('node:path');
    expect(basename(dirname(p))).toBe('lib');
  });
});
