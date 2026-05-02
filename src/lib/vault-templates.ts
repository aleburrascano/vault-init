import { readFileSync } from 'node:fs';
import { renderManagedSection } from './claude-md-merge.js';
import { getFreshnessTemplate, getPrTemplate, getClaudeSettingsTemplate } from './platform.js';

export const WIKI_STYLE_SECTION_ID = 'wiki-style';
export const WIKI_STYLE_HEADING = 'Wiki Style & Refresh Policy';

/**
 * Body content (no markers) of the vaultkit-managed "Wiki Style & Refresh
 * Policy" section in CLAUDE.md. Exported so `update.ts` can pass it to
 * `mergeManagedSection` when reconciling existing vaults' CLAUDE.md.
 */
export function renderWikiStyleSection(): string {
  return `## ${WIKI_STYLE_HEADING}

### Voice and structure
<describe the wiki's voice, tone, page templates, what lives in concepts/ vs topics/, naming conventions, etc.>

### Refresh constraints (patch flow)
- When applying a freshness report, edit existing wiki pages surgically. Never regenerate a wiki page from sources.
- Scope edits to pages listed under "Wiki pages that cite this source" in the report.
- For sources in the "text-only compare" or "manual review" sections: use WebFetch to retrieve and compare against the corresponding raw/<file>.md. Patch only on meaningful semantic difference; ignore formatting noise.

### Workflow
For refresh sessions, cd into this vault directory and run \`claude\` there. The vault's \`.claude/settings.json\` will set recommended defaults (model, permissions). Don't rely on the MCP connection from another cwd for refresh work.

### Recommended Claude Code settings for refresh sessions
Model: <e.g. Sonnet 4.6 or higher>
Thinking: <enabled / disabled>
Effort: <low / medium / high>`;
}

/**
 * Read the freshness GitHub Action template from `lib/freshness.yml.tmpl`.
 * Returns the template's bytes verbatim — the workflow takes no per-vault
 * substitutions. Resolves to `<repo>/lib/...` in dev, `<install>/dist/lib/...`
 * after build.
 */
export function renderFreshnessYml(): string {
  return readFileSync(getFreshnessTemplate(), 'utf8');
}

/**
 * Read the PR description scaffold from `lib/pr-template.md.tmpl`.
 * Static — no substitutions. Lands at `.github/pull_request_template.md`.
 */
export function renderPrTemplate(): string {
  return readFileSync(getPrTemplate(), 'utf8');
}

/**
 * Read the project-scoped Claude Code settings template from
 * `lib/claude-settings.json.tmpl`. Static. Lands at `.claude/settings.json`.
 */
export function renderClaudeSettings(): string {
  return readFileSync(getClaudeSettingsTemplate(), 'utf8');
}

export function renderClaudeMd(vaultName: string): string {
  const baseContent = `# CLAUDE.md — ${vaultName}

You maintain this personal knowledge wiki. Read this at session start, then search-first — see Session start below.

## Layers
1. \`raw/\` — immutable source material. Read; never modify.
2. \`wiki/\` — your domain. Author and maintain pages here.

## Page conventions
- Frontmatter every page: \`type\`, \`created\`, \`updated\`, \`sources\`, \`tags\`
- Cross-references: Obsidian wikilinks \`[[Page Name]]\`
- Source pages in \`wiki/sources/\` with \`source_path\`, \`source_date\`, \`source_author\`
- Never invent facts. Use \`> [!question] Unverified\` for uncertain claims.

## Operations

### Ingest (adding a source)
1. Read raw source fully.
2. Discuss takeaways before writing pages.
3. Create source page in \`wiki/sources/\`.
4. Update or create pages in \`wiki/topics/\` (synthesis) and \`wiki/concepts/\` touched.
5. Update \`index.md\` (one line per page: \`- [[Page]] — summary\`). Append \`log.md\` entry (\`## [YYYY-MM-DD] ingest | title\`).

### Query
Use \`search_notes\` (folder: \`wiki\`) first → \`get_note\` on top 1–3 hits → synthesize.
\`wiki/topics/\` = synthesis pages (start here). \`wiki/sources/\` = per-source detail.

### Lint (on request)
Find: orphans, contradictions, missing cross-refs, index drift. Discuss before bulk edits.

## Session start
- **Queries**: read this → \`search_notes\` directly → respond.
- **Ingest / lint**: read this → read \`index.md\` → skim tail of \`log.md\` → proceed.
- **Always** scope \`search_notes\` to \`folder: "wiki"\` or \`folder: "raw"\` — unscoped searches can hit \`.quartz\` noise.

## You do NOT
- Modify \`raw/\` (immutable).
- Delete wiki pages without confirmation.
- Fabricate sources or citations.
- Skip the log.
`;
  return `${baseContent}\n${renderManagedSection(WIKI_STYLE_SECTION_ID, renderWikiStyleSection())}\n`;
}

export function renderReadme(vaultName: string, siteUrl: string = ''): string {
  const siteLine = siteUrl
    ? `**Site**: https://${siteUrl} *(live after first deploy)*`
    : '*(Notes-only vault — no public site.)*';
  return `# ${vaultName}

A personal knowledge wiki powered by [vaultkit](https://github.com/aleburrascano/vaultkit).

${siteLine}

## Structure

\`\`\`
raw/    ← source material (immutable — never edit directly)
wiki/   ← authored knowledge pages
\`\`\`

## Contributing

1. Fork this repo on GitHub
2. Add sources to \`raw/\` and pages to \`wiki/\`
3. Open a pull request — CI checks for duplicate sources automatically
4. The maintainer reviews and merges
`;
}

export function renderDuplicateCheckYaml(): string {
  return `name: Duplicate Source Check

on:
  pull_request:
    paths:
      - 'raw/**'

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check for duplicate filenames in raw/
        run: |
          DUPES=$(find raw/ -type f -printf '%f\\n' | sort | uniq -d)
          if [ -n "$DUPES" ]; then
            echo "Duplicate filenames found in raw/:"
            echo "$DUPES"
            exit 1
          fi
          echo "No duplicate source filenames found."
`;
}

export function renderVaultJson(repoOwner: string, repoName: string): string {
  return JSON.stringify({
    pageTitle: repoName,
    baseUrl: `https://${repoOwner}.github.io/${repoName}/`,
  }, null, 2);
}

export function renderGitignore(): string {
  return `.quartz/
.obsidian/
.DS_Store
`;
}

export function renderGitattributes(): string {
  return `* text=auto
*.js text eol=lf
*.ts text eol=lf
*.json text eol=lf
*.yml text eol=lf
*.md text eol=lf
`;
}

export function renderIndexMd(): string {
  return `# Index

## Topics

## Concepts

## Sources
`;
}

export function renderLogMd(): string {
  return `# Log
`;
}
