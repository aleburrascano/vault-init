# vaultkit

[![npm](https://img.shields.io/npm/v/@aleburrascano/vaultkit.svg?label=npm)](https://www.npmjs.com/package/@aleburrascano/vaultkit)
[![CI](https://github.com/aleburrascano/vaultkit/actions/workflows/ci.yml/badge.svg)](https://github.com/aleburrascano/vaultkit/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@aleburrascano/vaultkit.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/@aleburrascano/vaultkit.svg)](package.json)

Make an Obsidian wiki searchable by Claude Code — yours, your team's, or someone else's.

[Obsidian](https://obsidian.md) is a free Markdown note-taking app where a "vault" is just a folder of `.md` files on your disk. vaultkit takes that vault, backs it with a GitHub repo, and registers it as a Claude Code MCP server — so every Claude Code session in every project can full-text search and read your notes, with no per-project setup. Connect as many vaults as you want; each lives under its own MCP namespace and stays in sync with upstream automatically.

```bash
npm install -g @aleburrascano/vaultkit
vaultkit setup     # REQUIRED: bootstraps prerequisites — see below
vaultkit help
```

> [!IMPORTANT]
> **You must run `vaultkit setup` once after installing.** Every other command (`init`, `connect`, `pull`, `visibility`, …) refuses to run with `Error: vaultkit isn't set up yet` until setup verifies the prerequisites. The two exceptions are `vaultkit setup` itself (obviously) and `vaultkit doctor` (so you can diagnose without being blocked).

`vaultkit setup` walks through every prerequisite in one go (node 22+, gh CLI, gh auth with `repo` + `workflow` scopes, git config, claude CLI). It's idempotent — re-run any time. The `delete_repo` scope is requested separately on the first `vaultkit destroy` so you're never asked up front to authorize a destructive permission you may never use.

Each vault registers as one MCP server backed by vaultkit's own `mcp-server` daemon (see [ADR-0011](docs/decisions/0011-vaultkit-mcp-replaces-obsidian-mcp-pro.md)) — six tools tuned for Claude (`vk_search`, `vk_list_notes`, `vk_get_note`, `vk_get_tags`, `vk_search_by_tag`, `vk_recent_notes`). `vk_search` uses SQLite FTS5 + BM25 with title hits weighted 5x, so a query like *"token optimization"* against a note titled *"Token Efficiency"* finds it even when the body never says "optimization". Pass `vault: "*"` to any tool for cross-vault scope. The search engine is Node 22.13+'s built-in `node:sqlite` — zero npm dependency for the search story.

**Updating**: `npm update -g @aleburrascano/vaultkit` to pull a new release; re-run `vaultkit setup` after major versions to re-check prerequisites and `vaultkit doctor` to flag any vault whose pinned launcher hash has drifted.

## What you'd use this for

- **Personal knowledge base.** A vault of research notes, papers, books you've read, recurring ideas. Open Claude Code on any project and your notes are queryable mid-conversation — no copy-paste, no "let me find that link."
- **Team wiki.** A shared decision log, runbook collection, or product knowledge base lives in one GitHub repo. Every teammate's Claude Code can answer from it without anyone manually pasting context, and PRs gate every change.
- **Public reference.** Publish a curated wiki for a domain you know well; others run `vaultkit connect owner/repo` and their Claude Code now has access too — like a knowledge graph anyone can subscribe to. Optional public Quartz site so non-Claude users can read it in a browser.
- **Reading notebook.** Drop source PDFs/articles into `raw/`, write synthesis pages in `wiki/`, ask Claude to surface contradictions between sources or pull every quote on a topic.

## Quick Start

A 60-second path from install to "Claude knows my notes":

1. **Install + onboard** (one-time):
   ```bash
   npm install -g @aleburrascano/vaultkit
   vaultkit setup
   ```

2. **Create a vault** (interactive — choose `n` for private notes-only):
   ```bash
   vaultkit init my-wiki
   ```

3. **Drop in a note**:
   ```bash
   echo "# Mitochondria" > ~/vaults/my-wiki/wiki/concepts/mitochondria.md
   echo "Powerhouse of the cell." >> ~/vaults/my-wiki/wiki/concepts/mitochondria.md
   ```

4. **Open Claude Code in any project** and ask: *"What do I know about mitochondria?"* — Claude calls `mcp__my-wiki__vk_search`, finds your note via BM25, answers.

That's it. Push to GitHub when you want teammates' Claude Code sessions to see the same content (`cd ~/vaults/my-wiki && git add -A && git commit -m "first note" && git push`).

## Commands

```
FIRST-TIME SETUP
  vaultkit setup                      Verify + install every prerequisite (run once after install)

CREATE & CONNECT
  vaultkit init <name>                Create a new vault from scratch
  vaultkit connect <owner/repo>       Clone someone else's vault and register it

EVERYDAY USE
  vaultkit list [name]                List vaults + git state (or detail for one)
  vaultkit sync                       Sync all vaults from their upstream
  vaultkit refresh [name]             Check sources for upstream changes and write a freshness report
  vaultkit backup <name>              Snapshot a vault to a local zip

WHEN SOMETHING'S WRONG
  vaultkit doctor                     Check environment + flag broken vaults
  vaultkit update [name|--all]        Refresh launcher / restore layout (single vault or all)
  vaultkit verify <name>              Launcher refused to start (pinned SHA-256 mismatch)

CHANGE OR REMOVE
  vaultkit visibility <name> <mode>   Toggle public / private / auth-gated
  vaultkit remove <name>              Stop using locally + remove from MCP (keeps GitHub repo)
  vaultkit remove <name> --delete-repo  Also delete the GitHub repo (you must own it)

  vaultkit help                       Show this reference
```

Every command supports `--help` / `-h` for detailed usage. Pass `--verbose` (or `-v`) before the args to get trace output. Pass `--version` to print the installed version + runtime info.

**The ecosystem in three steps:** someone publishes a vault (`vaultkit init`), you connect to it (`vaultkit connect owner/repo`), then every Claude Code session in any project can query its contents — always against the latest merged content upstream.

## Anatomy of a vault

Each vault is an [Obsidian](https://obsidian.md) wiki backed by a GitHub repo. On disk it looks like this:

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
├── .mcp-start.js     ← MCP server launcher (SHA-pinned, see Security)
└── .quartz/          ← Quartz static site generator (only when publishing)
```

The subfolders are conventions, not requirements — vaultkit creates them but won't complain if you ignore some, delete what you don't use, or add new ones:

- **`raw/`** holds material you didn't author: PDFs in `papers/`, saved articles in `articles/`, scanned books in `books/`, audio transcripts in `transcripts/`, images and screenshots in `assets/`. CI's duplicate-check workflow blocks PRs that add a file whose name already exists anywhere under `raw/`.
- **`wiki/`** holds pages *you* wrote: synthesis notes in `concepts/`, broader subject pages in `topics/`, biographies in `people/`, per-source pages (one wiki page per `raw/` source) in `sources/`.

If you don't write biographies, leave `wiki/people/` empty or delete it. The structure is for you, not the tool.

And each vault ships with these capabilities:

| | |
|---|---|
| **Site** (optional) | `https://your-username.github.io/<name>` — public, auth-gated, or none |
| **PR gating** | `main` is branch-protected — all changes go through pull requests |
| **Duplicate check** | CI blocks PRs that add a source file whose name already exists in `raw/` |
| **MCP server** | The vault is registered as a Claude Code MCP server so you can query it from any project |

Vaults live in `~/vaults/` by default (override with `VAULTKIT_HOME` — see [Configuration](#configuration)).

## Prerequisites

You'll need:

- **A GitHub account.** Every vault is backed by a GitHub repo — there's no GitLab, self-hosted-git, or local-only mode. If you don't want a GitHub repo, vaultkit isn't for you.
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

- **`y`** publishes a public [Quartz](https://quartz.jzhc.io/) site on GitHub Pages. ([Quartz](https://quartz.jzhc.io/) is an Obsidian-aware static-site generator that renders your `wiki/` and `raw/` markdown into a browsable web wiki.)
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
vaultkit connect git@github.com:owner/repo
```

Clones the vault and registers it as an MCP server. The MCP server auto-pulls vault content (`raw/`, `wiki/`) on every Claude Code session start, so you always query the latest merged content without any manual `git pull`. The launcher script itself (`.mcp-start.js`) is **never** auto-pulled — see [Security & Trust](#security--trust).

### Remove a vault

```bash
vaultkit disconnect my-wiki   # removes local + MCP, keeps the GitHub repo
vaultkit destroy my-wiki      # deletes local + GitHub repo (if you own it) + MCP
```

`destroy` checks ownership via `gh api repos/.../permissions.admin` first. If you're a collaborator and don't have admin rights, only the local clone and MCP registration are removed (effectively a `disconnect`).

## Using with Claude Code

Open any project in Claude Code and your wiki is already there — full-text searchable, always synced to upstream, no per-project setup. The wiki shows up as a set of MCP tools:

```
search_notes    full-text search across all wiki pages
get_note        read a specific page
get_backlinks   find pages that link to a given page
get_tags        browse by tag
```

Multiple wikis are available simultaneously under their own MCP namespaces:
`mcp__my-wiki__search_notes`, `mcp__cooking-wiki__get_note`, etc. Ask Claude *"what do I know about quartz?"* in any project and it'll search your `obsidian` vault, your `cooking-wiki`, and any other vaults you've connected — all at once.

## Contributing to a wiki

1. Fork the repo on GitHub
2. Add a source file to `raw/` and create wiki pages in `wiki/`
3. Open a pull request — CI automatically checks for duplicate source filenames
4. The maintainer reviews and merges

## Security & Trust

`vaultkit connect` clones a vault and registers its `.mcp-start.js` as a Claude Code MCP server. That script runs automatically with your **full user permissions** on every Claude Code session start — equivalent to adding the vault author to your system PATH.

The launcher itself is small (~70 lines — see [`lib/mcp-start.js.tmpl`](./lib/mcp-start.js.tmpl) for the canonical bytes). On startup it does a SHA-256 self-check, runs a guarded `git fetch`, and then spawns `vaultkit mcp-server --vault-dir <path>` — vaultkit's own MCP daemon ([src/commands/mcp-server.ts](./src/commands/mcp-server.ts)) which exposes the `vk_search` / `vk_get_note` / `vk_list_notes` / `vk_get_tags` / `vk_search_by_tag` / `vk_recent_notes` tools to Claude Code (see [ADR-0011](docs/decisions/0011-vaultkit-mcp-replaces-obsidian-mcp-pro.md) for the engine and tool decisions). Trust thus extends to: vaultkit itself, the per-vault launcher (SHA-pinned), and the vault's git history.

The trust chain on every Claude Code session start, end-to-end:

```
  ~/.claude.json  ── pins H = SHA-256 of <vault>/.mcp-start.js
       │              (set at registration time -- TOFU prompt; layer 1)
       │ spawn
       ▼
  <vault>/.mcp-start.js   (~70 lines, byte-pinned via H; layer 2)
       │   1. recompute SHA-256 of self -- abort if != H
       │   2. `git fetch` -- abort if upstream changed .mcp-start.js
       │   3. `git merge --ff-only` to pull raw/, wiki/ from upstream
       │   4. spawn the actual MCP server via `npx`
       ▼
  obsidian-mcp-pro
       │   exposes (per-vault namespaced):
       │     mcp__my-wiki__search_notes
       │     mcp__my-wiki__get_note
       │     mcp__my-wiki__get_backlinks
       │     mcp__my-wiki__get_tags
       ▼
  Claude Code  -- uses those tools to answer queries about your notes
```

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
| `VAULTKIT_LOG` | *(unset)* | If set, every `vaultkit` invocation appends a tab-separated audit line: `timestamp\tcommand\targs\texit=N\t<duration>ms` |
| `VAULTKIT_PULL_TIMEOUT` | `30000` | Per-vault timeout in milliseconds for `vaultkit sync` |
| `VAULTKIT_VERBOSE` | *(unset)* | Set automatically by the `--verbose` flag — scripts emit trace output to stderr when it's `1` |
| `VAULTKIT_NO_UPDATE_CHECK` | *(unset)* | If set to `1`, suppresses the once-per-24h "newer version available" notification. Useful in CI or for scripted callers that parse stderr |

Set in your shell profile to override the default:

```bash
# ~/.bashrc or ~/.zshrc
export VAULTKIT_HOME=~/Documents/vaults
export VAULTKIT_LOG=~/.vaultkit.log
```

## Platform support

| Platform | Status |
|---|---|
| Windows (Git Bash) | Supported |
| macOS | Supported |
| Linux (apt / dnf / brew) | Supported |

## FAQ

Common questions — can I use this without GitHub, does it cost money, where does my data go, can I plug it into MCP clients other than Claude Code, what's the difference between `disconnect` and `destroy` — are answered in [docs/faq.md](./docs/faq.md).

## Troubleshooting

If `vaultkit doctor` doesn't catch your problem, [docs/troubleshooting.md](./docs/troubleshooting.md) covers the recurring ones with the exact error string each time: launcher SHA-256 mismatch, "Vault has a new `.mcp-start.js` upstream", `gh: command not found` on Windows, the first-`destroy` browser flow, branch-protection push rejections during `update`, and `init` failing to enable GitHub Pages.

## Contributing to vaultkit

See [CONTRIBUTING.md](./CONTRIBUTING.md). The repo is intentionally small — TypeScript source under `bin/`, `src/`, and `tests/`, compiled to `dist/` at publish time. Three runtime dependencies (`commander`, `execa`, `@inquirer/prompts`) plus `typescript` and `vitest` for development.

## License

[MIT](./LICENSE) © Alessandro Burrascano
