# vault-init

One command to spin up a collaborative Obsidian wiki with GitHub Pages, PR gating, duplicate source detection, and Claude Code MCP access.

```bash
npm install -g @aleburrascano/vault-init
vault-init my-wiki --private
```

## What it sets up

| | |
|---|---|
| **Site** | `https://your-username.github.io/my-wiki` — deployed automatically on every push to `main` |
| **PR gating** | `main` is branch-protected — all changes go through pull requests |
| **Duplicate check** | CI blocks PRs that add a source file whose name already exists in `raw/` |
| **MCP server** | The wiki is registered as a Claude Code MCP server so you can query it from any project |

## Prerequisites

Only two things must be installed manually:

- **Node.js 22+** — [nodejs.org](https://nodejs.org)
- **Git** (+ Git Bash on Windows) — [git-scm.com](https://git-scm.com)

Everything else — GitHub CLI, GitHub authentication, git user config, Claude Code — is handled interactively the first time you run `vault-init`.

## Usage

```bash
vault-init <name>            # public repo + site
vault-init <name> --private  # private repo (site is still public via GitHub Pages)
```

On first run, `vault-init` will:
1. Install GitHub CLI if missing (via winget / brew / apt / dnf)
2. Open a browser for GitHub authentication if not logged in
3. Prompt for your git name and email if not configured
4. Ask whether to install Claude Code CLI (required for MCP registration)

After that, every subsequent `vault-init` runs completely unattended.

## Vault structure

```
my-wiki/
├── raw/              ← source material — immutable, never edit
│   ├── articles/
│   ├── books/
│   ├── notes/
│   ├── papers/
│   ├── transcripts/
│   └── assets/
├── wiki/             ← your authored pages
│   ├── concepts/
│   ├── topics/
│   ├── people/
│   └── sources/
├── index.md          ← one-line entry per page
├── log.md            ← append-only operation log
├── CLAUDE.md         ← instructions for your AI assistant
└── site/             ← Quartz static site generator (don't edit)
```

## Removing a vault

```bash
vault-destroy my-wiki
```

Deletes the local directory, GitHub repository, and MCP registration. Prompts for the `delete_repo` GitHub permission on first use (handled automatically via browser).

## Using with Claude Code

After `vault-init` runs, open any project in Claude Code — your wiki is immediately available:

```
search_notes    full-text search across all wiki pages
get_note        read a specific page
get_backlinks   find pages that link to a given page
get_tags        browse by tag
```

Multiple wikis are available simultaneously under their own MCP namespaces:
`mcp__my-wiki__search_notes`, `mcp__cooking-wiki__get_note`, etc.

## Contributing to a wiki

1. Fork the repo on GitHub
2. Add a source file to `raw/` and create wiki pages in `wiki/`
3. Open a pull request — CI automatically checks for duplicate source filenames
4. The maintainer reviews and merges

## Platform support

| Platform | Status |
|---|---|
| Windows (Git Bash) | Supported |
| macOS | Supported |
| Linux (apt / dnf / brew) | Supported |
