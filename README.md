# vaultkit

Make an Obsidian wiki searchable by Claude Code — yours, your team's, or someone else's.

[Obsidian](https://obsidian.md) is a free Markdown note-taking app where a "vault" is just a folder of `.md` files on your disk. vaultkit takes that vault, backs it with a GitHub repo, and registers it as a Claude Code MCP server — so every Claude Code session in every project can full-text search and read your notes, with no per-project setup. Connect as many vaults as you want; each lives under its own MCP namespace and stays in sync with upstream automatically.

```bash
npm install -g @aleburrascano/vaultkit
vaultkit setup     # one-time: checks node, gh, git, claude — installs/auths what's missing
vaultkit help
```

`vaultkit setup` walks through every prerequisite in one go (node 22+, gh CLI, gh auth with `repo` + `workflow` scopes, git config, claude CLI). It's idempotent — re-run any time. The `delete_repo` scope is requested separately on the first `vaultkit destroy` so you're never asked up front to authorize a destructive permission you may never use.

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

4. **Open Claude Code in any project** and ask: *"What do I know about mitochondria?"* — Claude calls `mcp__my-wiki__search_notes`, finds your note, answers.

That's it. Push to GitHub when you want teammates' Claude Code sessions to see the same content (`cd ~/vaults/my-wiki && git add -A && git commit -m "first note" && git push`).

## Commands

```
FIRST-TIME SETUP
  vaultkit setup                      Verify + install every prerequisite (run once after install)

CREATE & CONNECT
  vaultkit init <name>                Create a new vault from scratch
  vaultkit connect <owner/repo>       Clone someone else's vault and register it

EVERYDAY USE
  vaultkit status [name]              See your vaults + git state (or detailed status for one)
  vaultkit pull                       Sync all vaults from their upstream
  vaultkit backup <name>              Snapshot a vault to a local zip

WHEN SOMETHING'S WRONG
  vaultkit doctor                     Check environment + flag broken vaults
  vaultkit update <name>              Vault is missing layout files or has a stale launcher
  vaultkit verify <name>              Launcher refused to start (pinned SHA-256 mismatch)

CHANGE OR REMOVE
  vaultkit visibility <name> <mode>   Toggle public / private / auth-gated
  vaultkit disconnect <name>          Stop using locally — keep the GitHub repo
  vaultkit destroy <name>             Delete locally + on GitHub

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

The launcher itself is small (~70 lines — see [`lib/mcp-start.js.tmpl`](./lib/mcp-start.js.tmpl) for the canonical bytes). On startup it does a SHA-256 self-check, runs a guarded `git fetch`, and then spawns [`obsidian-mcp-pro`](https://www.npmjs.com/package/obsidian-mcp-pro) via `npx` — that's the package that exposes the `search_notes` / `get_note` / etc. tools to Claude Code. Trust thus extends to: vaultkit itself, the per-vault launcher (SHA-pinned), the vault's git history, and `obsidian-mcp-pro`.

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
| `VAULTKIT_PULL_TIMEOUT` | `30000` | Per-vault timeout in milliseconds for `vaultkit pull` |
| `VAULTKIT_VERBOSE` | *(unset)* | Set automatically by the `--verbose` flag — scripts emit trace output to stderr when it's `1` |

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

See [CONTRIBUTING.md](./CONTRIBUTING.md). The repo is intentionally small — TypeScript source under `bin/`, `src/`, and `tests/`, compiled to `dist/` at publish time. Three runtime dependencies (`commander`, `execa`, `@inquirer/prompts`) plus `typescript` and `vitest` for development.

## License

[MIT](./LICENSE) © Alessandro Burrascano
