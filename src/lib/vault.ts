import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function validateName(name: string): void {
  if (name.includes('/')) {
    throw new Error("provide the vault name only (e.g. 'MyVault'), not owner/repo.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('vault name must contain only letters, numbers, hyphens, and underscores.');
  }
  if (name.length > 64) {
    throw new Error('vault name must be 64 characters or less.');
  }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

export function isVaultLike(dir: string): boolean {
  if (!isDir(dir)) return false;
  if (isDir(join(dir, '.obsidian'))) return true;
  return isFile(join(dir, 'CLAUDE.md')) && isDir(join(dir, 'raw')) && isDir(join(dir, 'wiki'));
}

export async function sha256(filePath: string): Promise<string> {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export function renderClaudeMd(vaultName: string): string {
  return `# CLAUDE.md — ${vaultName}

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
