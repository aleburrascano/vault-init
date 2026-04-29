# shellcheck shell=bash
# Shared bash helpers for vault-*.sh scripts. Source once near the top:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$SCRIPT_DIR/lib/_helpers.sh"
#
# All functions are pure — they `echo` results and `return` exit codes; they
# never call `exit`, so callers stay in control of error flow.

# Echo the platform-appropriate path to ~/.claude.json
# (Windows-format on Git Bash so node.exe can read it; POSIX elsewhere.)
vk_claude_json() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$HOME/.claude.json"
  else
  
    echo "$HOME/.claude.json"
  fi
}

# Convert a Windows-format path to POSIX (for bash file operations).
# Idempotent: returns input unchanged if cygpath unavailable or path is already POSIX.
vk_to_posix() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1 && [[ "$p" =~ ^[A-Za-z]: ]]; then
    cygpath -u "$p"
  else
    echo "$p"
  fi
}

# Convert a POSIX path to Windows-format (for passing to native Windows tools).
# Idempotent.
vk_to_windows() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$p"
  else
    echo "$p"
  fi
}

# Echo the vault directory registered for <vault-name>, or return non-zero.
# Reads ~/.claude.json's mcpServers entry and extracts the .mcp-start.js parent.
vk_resolve_vault_dir() {
  local name="$1"
  local cfg
  cfg="$(vk_claude_json)"
  node -e "
    const fs = require('fs');
    const path = require('path');
    const file = process.argv[1];
    const name = process.argv[2];
    if (!fs.existsSync(file)) process.exit(1);
    let config;
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.exit(1); }
    const s = (config.mcpServers || {})[name];
    if (!s || !s.args) process.exit(1);
    const scriptArg = s.args.find(a => String(a).endsWith('.mcp-start.js'));
    if (!scriptArg) process.exit(1);
    console.log(path.dirname(scriptArg));
  " "$cfg" "$name" 2>/dev/null
}

# Echo the --expected-sha256=... arg registered for <vault-name>, if any.
# Returns non-zero if the vault isn't registered.
vk_resolve_expected_hash() {
  local name="$1"
  local cfg
  cfg="$(vk_claude_json)"
  node -e "
    const fs = require('fs');
    const file = process.argv[1];
    const name = process.argv[2];
    if (!fs.existsSync(file)) process.exit(1);
    let config;
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.exit(1); }
    const s = (config.mcpServers || {})[name];
    if (!s || !s.args) process.exit(1);
    const arg = s.args.find(a => typeof a === 'string' && a.startsWith('--expected-sha256='));
    console.log(arg ? arg.slice('--expected-sha256='.length) : '');
  " "$cfg" "$name" 2>/dev/null
}

# Returns 0 if <dir> looks like a vaultkit/Obsidian vault, non-zero otherwise.
vk_is_vault_like() {
  local d="$1"
  [ -d "$d" ] || return 1
  if [ -d "$d/.obsidian" ]; then return 0; fi
  if [ -f "$d/CLAUDE.md" ] && [ -d "$d/raw" ] && [ -d "$d/wiki" ]; then return 0; fi
  return 1
}

# Echo the SHA-256 of a file in hex.
vk_sha256() {
  node -e "
    const c=require('crypto'),fs=require('fs');
    console.log(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'));
  " "$1"
}

# Echo the standard prefix for the three message classes.
vk_error()   { echo "Error: $*" >&2; }
vk_warning() { echo "Warning: $*" >&2; }
vk_note()    { echo "Note: $*"; }

# Echo the contents of CLAUDE.md for a vault. Single source of truth shared by
# vault-init.sh and vault-update.sh.
vk_render_claude_md() {
  local vault_name="$1"
  cat <<EOF
# CLAUDE.md — ${vault_name}

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
EOF
}

# Echo the contents of README.md for a vault. Pass an empty second arg for the
# notes-only variant (no live site line).
vk_render_readme() {
  local vault_name="$1"
  local site_url="${2:-}"
  local site_line
  if [ -n "$site_url" ]; then
    site_line="**Site**: https://${site_url} *(live after first deploy)*"
  else
    site_line="*(Notes-only vault — no public site.)*"
  fi
  cat <<EOF
# ${vault_name}

A personal knowledge wiki powered by [vaultkit](https://github.com/aleburrascano/vaultkit).

${site_line}

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
EOF
}

# Echo the .github/workflows/duplicate-check.yml content.
vk_render_duplicate_check_yaml() {
  cat <<'YAML'
name: Duplicate Source Check

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
          DUPES=$(find raw/ -type f -printf '%f\n' | sort | uniq -d)
          if [ -n "$DUPES" ]; then
            echo "Duplicate filenames found in raw/:"
            echo "$DUPES"
            exit 1
          fi
          echo "No duplicate source filenames found."
YAML
}

# Validate <vault-name>; on invalid input, echoes Error: ... to stderr and returns non-zero.
vk_validate_vault_name() {
  local name="$1"
  if [[ "$name" =~ / ]]; then
    vk_error "provide the vault name only (e.g. 'SystemDesign'), not owner/repo."
    return 1
  fi
  if ! [[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    vk_error "vault name must contain only letters, numbers, hyphens, and underscores."
    return 1
  fi
  if [ ${#name} -gt 64 ]; then
    vk_error "vault name must be 64 characters or less."
    return 1
  fi
  return 0
}
