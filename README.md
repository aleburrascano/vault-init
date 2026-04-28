# vaultkit

A package manager for Obsidian vaults — powered by GitHub and Claude Code.

vaultkit lets you publish, discover, and connect to knowledge wikis the same way npm lets you publish and install packages. Each vault is a GitHub repo with a built-in MCP server. One command to connect, and it's immediately available as a tool in every Claude Code session — no configuration, no manual setup.

**The ecosystem in three steps:**
1. Someone publishes a vault (`vaultkit init`) — a structured Obsidian wiki with a public GitHub Pages site
2. You connect to it (`vaultkit connect owner/repo`) — clones it locally and registers it as an MCP server in Claude Code
3. Open any project in Claude Code — the vault's knowledge is instantly queryable, always up to date

Connect as many vaults as you want. They live in your `~/vaults/` folder, each registered under its own MCP namespace, ready to query the moment you start a new chat.

```bash
npm install -g @aleburrascano/vaultkit
vaultkit help
```

## Commands

```
vaultkit init <name> [--private]   Create a new vault with GitHub Pages + MCP
vaultkit connect <owner/repo>      Clone a vault and register it as an MCP server
vaultkit disconnect <name>         Remove a vault locally and from MCP (keeps GitHub repo)
vaultkit destroy <name>            Delete a vault locally, on GitHub, and from MCP
vaultkit list                      Show all registered vaults
vaultkit pull                      Pull latest changes in all registered vaults
vaultkit update <name>             Update system files in a vault to the latest version
vaultkit doctor                    Check environment and vault health
vaultkit help                      Show this reference
```

## What a vault is

Each vault is an Obsidian wiki backed by a GitHub repo with:

| | |
|---|---|
| **Site** | `https://your-username.github.io/<name>` — deployed automatically on every push to `main` |
| **PR gating** | `main` is branch-protected — all changes go through pull requests |
| **Duplicate check** | CI blocks PRs that add a source file whose name already exists in `raw/` |
| **MCP server** | The vault is registered as a Claude Code MCP server so you can query it from any project |

## Prerequisites

Only two things must be installed manually:

- **Node.js 22+** — [nodejs.org](https://nodejs.org)
- **Git** (+ Git Bash on Windows) — [git-scm.com](https://git-scm.com)

Everything else — GitHub CLI, GitHub authentication, git user config, Claude Code — is handled interactively the first time you run `vaultkit init`.

## Usage

### Create a vault

```bash
vaultkit init my-wiki            # public repo + site
vaultkit init my-wiki --private  # private repo (site is still public via GitHub Pages)
```

On first run, `vaultkit init` will:
1. Install GitHub CLI if missing (via winget / brew / apt / dnf)
2. Open a browser for GitHub authentication if not logged in
3. Prompt for your git name and email if not configured
4. Ask whether to install Claude Code CLI (required for MCP registration)

After that, every subsequent `vaultkit init` runs completely unattended.

### Connect to someone else's vault

```bash
vaultkit connect owner/repo
vaultkit connect https://github.com/owner/repo
```

Clones the vault and registers it as an MCP server. The MCP server auto-pulls on every Claude Code session start, so you always query the latest merged content without any manual `git pull`.

### Remove a vault

```bash
vaultkit destroy my-wiki
```

Deletes the local directory, GitHub repository, and MCP registration. Prompts for the `delete_repo` GitHub permission on first use (handled automatically via browser).

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
└── .quartz/          ← Quartz static site generator (hidden from Obsidian)
```

## Using with Claude Code

After `vaultkit init` or `vaultkit connect`, open any project in Claude Code — your wiki is immediately available:

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

## Security & Trust

`vaultkit connect` clones a vault and registers its `.mcp-start.js` as a Claude Code MCP server. That script runs automatically with your **full user permissions** on every Claude Code session start — equivalent to adding the vault author to your system PATH.

Before registering, vaultkit shows you the SHA-256 of `.mcp-start.js` and asks for confirmation:

```
  File:    /home/you/vaults/my-vault/.mcp-start.js
  SHA-256: a3f2c1...
Register as MCP server? [y/N]
```

**Trust rule:** only connect vaults from authors you trust, the same way you'd only `npm install -g` packages from trusted publishers. You can inspect `.mcp-start.js` before confirming, and `vaultkit doctor` shows the current SHA-256 of every registered vault's entry point so you can detect changes over time.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VAULTKIT_HOME` | `~/vaults` | Root directory where `vaultkit connect` clones vaults |

Set in your shell profile to override the default:

```bash
export VAULTKIT_HOME=~/Documents/vaults
```

## Platform support

| Platform | Status |
|---|---|
| Windows (Git Bash) | Supported |
| macOS | Supported |
| Linux (apt / dnf / brew) | Supported |
