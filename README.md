# vaultkit

A package manager for Obsidian vaults — powered by GitHub and Claude Code.

vaultkit lets you publish, discover, and connect to knowledge wikis the same way npm lets you publish and install packages. Each vault is a GitHub repo with a built-in MCP server. One command to connect, and it's immediately available as a tool in every Claude Code session — no configuration, no manual setup.

**The ecosystem in three steps:**
1. Someone publishes a vault (`vaultkit init`) — a structured Obsidian wiki, optionally with a public GitHub Pages site
2. You connect to it (`vaultkit connect owner/repo`) — clones it locally and registers it as an MCP server in Claude Code
3. Open any project in Claude Code — the vault's knowledge is instantly queryable, always up to date

Connect as many vaults as you want. They live in your `~/vaults/` folder, each registered under its own MCP namespace, ready to query the moment you start a new chat.

```bash
npm install -g @aleburrascano/vaultkit
vaultkit help
```

## Commands

```
vaultkit init <name>               Create a new vault (asks: public site / private notes / auth-gated)
vaultkit connect <owner/repo>      Clone a vault and register it as an MCP server
vaultkit disconnect <name>         Remove a vault locally and from MCP (keeps GitHub repo)
vaultkit destroy <name>            Delete a vault locally, on GitHub (if you own it), and from MCP
vaultkit list                      Show all registered vaults with pinned SHA-256
vaultkit pull                      Pull latest changes in all registered vaults
vaultkit update <name>             Update the launcher script and re-pin its SHA-256
vaultkit doctor                    Check environment and vault health (flags hash drift)
vaultkit help                      Show this reference
```

## What a vault is

Each vault is an Obsidian wiki backed by a GitHub repo with:

| | |
|---|---|
| **Site** (optional) | `https://your-username.github.io/<name>` — public, auth-gated, or none |
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
vaultkit init my-wiki
```

`init` asks how you want to publish:

```
Publish this vault as a public knowledge site?
  (y) Public repo + public Quartz site at https://<user>.github.io/my-wiki
  (n) Private repo, notes-only — no Pages, no deploy workflow, no public URL  [default]
  (a) Private repo + auth-gated Pages site (requires GitHub Pro+)
```

- **`y`** publishes a public Quartz site on GitHub Pages.
- **`n`** (default) creates a private repo with no Pages workflow at all — fully hidden, even by URL.
- **`a`** creates a private repo with auth-gated Pages so only authorized GitHub users can view the site. Requires GitHub Pro or higher.

> **Why not `--private`?** A private GitHub repo with Pages enabled defaults to a *publicly-accessible site* on Pro plans — repo visibility and Pages visibility are decoupled. Option `(n)` skips Pages entirely so there's no site to discover; option `(a)` explicitly locks Pages visibility down via the GitHub API.

On first run, `vaultkit init` will:
1. Install GitHub CLI if missing (via winget / brew / apt / dnf)
2. Open a browser for GitHub authentication if not logged in
3. Prompt for your git name and email if not configured
4. Ask whether to install Claude Code CLI (required for MCP registration)

After that, every subsequent `vaultkit init` runs through the same prompts but skips the install steps.

### Connect to someone else's vault

```bash
vaultkit connect owner/repo
vaultkit connect https://github.com/owner/repo
```

Clones the vault and registers it as an MCP server. The MCP server auto-pulls vault content (`raw/`, `wiki/`) on every Claude Code session start, so you always query the latest merged content without any manual `git pull`. The launcher script itself (`.mcp-start.js`) is **never** auto-pulled — see [Security & Trust](#security--trust).

### Remove a vault

```bash
vaultkit disconnect my-wiki   # removes local + MCP, keeps the GitHub repo
vaultkit destroy my-wiki      # deletes local + GitHub repo (if you own it) + MCP
```

`destroy` checks ownership via `gh api repos/.../permissions.admin` first. If you're a collaborator and don't have admin rights, only the local clone and MCP registration are removed (effectively a `disconnect`).

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
└── .quartz/          ← Quartz static site generator (only when publishing)
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

### Two-layer protection

**Layer 1 — TOFU at registration.** Before registering, vaultkit shows the SHA-256 of `.mcp-start.js` and asks for explicit confirmation:

```
  File:    /home/you/vaults/my-vault/.mcp-start.js
  SHA-256: a3f2c1...
Register as MCP server? [y/N]
```

The hash you confirm is **pinned** in the MCP registration via `--expected-sha256=...`.

**Layer 2 — self-verification on every session start.** Each time Claude Code launches the vault's MCP server, the launcher:

1. Recomputes its own SHA-256 and aborts if it doesn't match the pinned value (catches in-place tampering).
2. Runs `git fetch` and aborts if upstream introduced a different `.mcp-start.js` (catches malicious upstream commits).
3. Only fast-forwards when the launcher itself is unchanged. Vault content (`raw/`, `wiki/`) updates normally.

If the launcher has changed upstream, you'll see:

```
[vaultkit] Vault "my-vault" has a new .mcp-start.js upstream — refusing to auto-update.
[vaultkit] Inspect: cd "/home/you/vaults/my-vault" && git diff HEAD..@{u} -- .mcp-start.js
[vaultkit] Re-trust: vaultkit verify my-vault
```

Run `vaultkit doctor` periodically — it surfaces hash drift and missing pins across all vaults.

**Trust rule:** only connect vaults from authors you trust, the same way you'd only `npm install -g` packages from trusted publishers. See [SECURITY.md](./SECURITY.md) for the full threat model.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VAULTKIT_HOME` | `~/vaults` | Root directory where `vaultkit init` and `vaultkit connect` create vaults |

Set in your shell profile to override the default:

```bash
# ~/.bashrc or ~/.zshrc
export VAULTKIT_HOME=~/Documents/vaults
```

## Platform support

| Platform | Status |
|---|---|
| Windows (Git Bash) | Supported |
| macOS | Supported |
| Linux (apt / dnf / brew) | Supported |

## Troubleshooting

### `vaultkit init` fails with "gh: command not found" on Windows

Open a new Git Bash window after installing the GitHub CLI. Windows installers update PATH in the registry, but processes that started before the install (including your shell) won't see the change. Closing and reopening the terminal picks up the new PATH.

### "Launcher SHA-256 mismatch — refusing to start" when Claude Code launches

Either `.mcp-start.js` was modified locally or the vault was re-cloned without re-registering. Run:

```bash
vaultkit doctor                  # see which vault has drifted
vaultkit update <vault-name>     # re-pin the current SHA-256
```

If you didn't make the change yourself and don't recognize the diff, treat it as suspicious — `cd` into the vault and `git log -p -- .mcp-start.js` to inspect.

### "Vault has a new `.mcp-start.js` upstream — refusing to auto-update"

The vault owner pushed a new launcher. Inspect the change before re-trusting:

```bash
cd ~/vaults/<vault-name>
git diff HEAD..@{u} -- .mcp-start.js
```

If it looks legitimate (e.g., they ran `vaultkit update` against a new vaultkit version), run `vaultkit update <vault-name>` locally to re-pin.

### `vaultkit destroy` says "you don't own this repo"

You're a collaborator, not the owner. Only the GitHub repo's owner can delete it. The local clone and MCP registration are still removed — effectively a `disconnect`. To remove yourself from the repo's collaborators, do that manually on GitHub.

### `vaultkit update` fails to push to `main`

Branch protection on `main` is rejecting the direct push. vaultkit automatically falls back to creating a feature branch and opening a pull request. Merge the PR (or have a maintainer merge it) and the launcher update will take effect.

### "Could not auto-enable GitHub Pages" during `init`

The Pages API call failed (often due to a brand-new repo where Pages isn't immediately ready). Enable manually at the URL printed in the warning, set Source to "GitHub Actions", and re-push to trigger the deploy workflow.

## Contributing to vaultkit

See [CONTRIBUTING.md](./CONTRIBUTING.md). The repo is intentionally small — Node.js dispatcher + bash scripts, zero npm dependencies, no build step.

## License

[MIT](./LICENSE) © Alessandro Burrascano
