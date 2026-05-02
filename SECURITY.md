# Security Policy

## Reporting a vulnerability

If you discover a security issue in vaultkit, please **do not** open a public GitHub issue. Instead, email **aleburrascano123@gmail.com** with:

- A description of the issue
- Steps to reproduce
- The version you tested against (`vaultkit doctor` shows the installed version)
- Your assessment of severity, if you have one

You'll get an acknowledgment within 7 days. Coordinated disclosure is appreciated — if you'd like to give a public CVE, we can work out a timeline together.

## Trust model

vaultkit is a thin wrapper around `git`, `gh`, `claude`, and three permissive npm dependencies (`commander`, `execa`, `@inquirer/prompts`). It does not run a server and does not phone home. The trust surface is:

1. **The `vaultkit` package itself.** When you `npm install -g @aleburrascano/vaultkit`, you trust the published package contents to behave as the source on GitHub does. The `files` allowlist in `package.json` is restrictive — only `dist/` ships, which contains the TypeScript-compiled CLI plus the byte-immutable launcher template ([`lib/mcp-start.js.tmpl`](./lib/mcp-start.js.tmpl), copied to `dist/lib/` at build time).
2. **Vaults you connect to.** `vaultkit connect` clones a vault from GitHub and registers `.mcp-start.js` as a Claude Code MCP server. **That script runs with your full user permissions on every Claude Code session start.** This is equivalent to adding the vault author to your system PATH. The same rule as `npm install` applies: only connect vaults from authors you trust.

## Supply-chain protections

Two mechanisms reduce the risk of (2):

### Pre-registration SHA-256 check (TOFU)

Before `vaultkit connect` registers a vault, it shows you the SHA-256 of `.mcp-start.js` and asks for explicit `[y/N]` confirmation. You can `cat` the file in another terminal first if you want to inspect.

### Per-session self-verification (post-TOFU)

The pinned SHA-256 is stored in the MCP registration. On every Claude Code session start, the launcher:

1. Reads its own file, computes SHA-256, and aborts if it does not match the pinned value.
2. Runs `git fetch` (without merging) and aborts if upstream has a changed `.mcp-start.js`.
3. Only fast-forwards if the launcher itself is unchanged — vault content (`raw/`, `wiki/`) updates normally.

If a malicious commit lands upstream that modifies `.mcp-start.js`, the launcher refuses to start and tells you to inspect the diff and run `vaultkit verify` (or `vaultkit update`) to re-trust.

`vaultkit doctor` flags any vault whose pinned hash is missing or has drifted.

## Out of scope

- Compromise of your local machine or `~/.claude.json`. vaultkit assumes your home directory is trusted.
- Compromise of GitHub (the platform itself). If `gh repo clone` returns malicious bytes, no client-side check can save you.
- Vulnerabilities in `obsidian-mcp-pro` (the MCP server `.mcp-start.js` invokes via `npx`). Report those upstream.
- Vulnerabilities in `claude` or `gh` themselves. Report those upstream.

## What you should still do

- Inspect `.mcp-start.js` before confirming registration when connecting an unfamiliar vault.
- Run `vaultkit doctor` periodically — it surfaces hash drift and missing pins.
- Treat your `~/.claude.json` like an SSH key file: it lists every command Claude Code is willing to spawn.
