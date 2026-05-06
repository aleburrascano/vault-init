#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { isVaultkitError, EXIT_CODES } from '../src/lib/errors.js';
import { ConsoleLogger } from '../src/lib/logger.js';
import { checkForUpdate } from '../src/lib/notices/update-check.js';
import { checkPostUpgrade } from '../src/lib/notices/post-upgrade-check.js';
import { preflightLauncherCheck, preflightAllVaults } from '../src/lib/notices/preflight-launcher.js';
import { gateOrSkip } from '../src/lib/prereqs.js';
import { printDeprecationNotice } from '../src/lib/cli-aliases.js';
import type { PublishMode } from '../src/lib/constants.js';

// Commands whose body is meaningfully affected by — or whose user is
// most likely about to be bitten by — a stale launcher. The preflight
// check fires before fn() runs so the user sees the warning at the
// moment they're closest to opening Claude Code.
//
// Excluded by design: backup / disconnect / destroy / visibility — none
// of these depend on the launcher; warning there is noise. Also
// excluded: verify / update — already disambiguate stale launchers in
// their own bodies, so a preflight line would duplicate.
// `status` and `pull` remain in the set during the 3.x deprecation
// window so the alias dispatch still triggers preflight; they fall out
// when the aliases are deleted in 4.0.
const VAULT_PREFLIGHT_COMMANDS = new Set(['list', 'sync', 'refresh', 'status', 'pull']);

// Error codes whose remedy genuinely is `vaultkit setup`. Adding a 4th
// is a one-line edit. Other codes get the bare error message — no hint —
// so this signal stays meaningful.
const SETUP_HINT_CODES = new Set(['SETUP_REQUIRED', 'TOOL_MISSING', 'AUTH_REQUIRED']);

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string };
const versionString = `${pkg.version} (node ${process.version}, ${process.platform} ${process.arch})`;

function shouldPrintSetupHint(err: unknown, message: string | undefined): boolean {
  if (!isVaultkitError(err)) return false;
  if (!SETUP_HINT_CODES.has(err.code)) return false;
  if (/vaultkit setup/i.test(message ?? '')) return false;
  return true;
}

function auditLog(command: string, args: string[], exitCode: number, start: number): void {
  const logFile = process.env.VAULTKIT_LOG;
  if (!logFile) return;
  const duration = Date.now() - start;
  const line = `${new Date().toISOString()}\t${command}\t${args.join(' ')}\t${exitCode}\t${duration}ms\n`;
  try { appendFileSync(logFile, line); } catch { /* ignore */ }
}

async function wrap(fn: () => Promise<void>, commandName: string, args: string[]): Promise<void> {
  const start = Date.now();
  const verbose = process.env.VAULTKIT_VERBOSE === '1';
  if (verbose) console.error(`[debug] vaultkit ${commandName}${args.length ? ' ' + args.join(' ') : ''}`);
  try {
    await gateOrSkip(commandName, new ConsoleLogger());
    if (VAULT_PREFLIGHT_COMMANDS.has(commandName)) {
      const preflightLog = new ConsoleLogger();
      const maybeName = args[0];
      // The vault-name regex from validateName — accepting otherwise
      // means a refresh --vault-dir / a stray flag triggers a doomed
      // preflight that would log "vault not registered" silently.
      if (maybeName && /^[a-zA-Z0-9_-]+$/.test(maybeName)) {
        await preflightLauncherCheck(maybeName, undefined, preflightLog).catch(() => { /* best-effort */ });
      } else if (!maybeName) {
        await preflightAllVaults(undefined, preflightLog).catch(() => { /* best-effort */ });
      }
    }
    await fn();
    auditLog(commandName, args, 0, start);
    const notifyLog = new ConsoleLogger();
    checkForUpdate(pkg.version, notifyLog);
    await checkPostUpgrade(pkg.version, undefined, notifyLog).catch(() => { /* best-effort */ });
    if (verbose) console.error(`[debug] ${commandName} ok (${Date.now() - start}ms)`);
  } catch (err) {
    const exitCode = isVaultkitError(err) ? EXIT_CODES[err.code] : 1;
    auditLog(commandName, args, exitCode, start);
    if (verbose) console.error(`[debug] ${commandName} exit=${exitCode} (${Date.now() - start}ms)`);
    const message = (err as { message?: string })?.message;
    if (message) {
      process.stderr.write(`Error: ${message}\n`);
    }
    if (shouldPrintSetupHint(err, message)) {
      process.stderr.write(`Hint: run 'vaultkit setup' to bootstrap or repair prerequisites.\n`);
    }
    process.exit(exitCode);
  }
}

const program = new Command();
program
  .name('vaultkit')
  .description('Obsidian wiki management')
  .version(versionString)
  .option('-v, --verbose', 'enable trace output');

// Categorized root help -- mirrors the README's Commands section so the CLI's
// first-impression help and the README's first-impression help match. Only
// overrides the root program; each subcommand keeps its own addHelpText output
// (since helpInformation is per-instance).
program.helpInformation = () => `Usage: vaultkit [options] [command]

Obsidian wiki management -- make an Obsidian vault searchable by Claude Code.

Options:
  -V, --version                       output the version + runtime info
  -v, --verbose                       enable trace output
  -h, --help                          display this help

Commands:
  FIRST-TIME SETUP
    setup                             Verify + install every prerequisite (run once after install)

  CREATE & CONNECT
    init <name>                       Create a new vault from scratch
    connect <input>                   Clone someone else's vault and register it

  EVERYDAY USE
    list [name]                       List vaults + git state (or detail for one)
    sync                              Sync all vaults from their upstream
    refresh [name]                    Check sources for upstream changes and write a freshness report
    backup <name>                     Snapshot a vault to a local zip

  WHEN SOMETHING'S WRONG
    doctor                            Check environment + flag broken vaults
    update [name|--all]               Refresh launcher and restore layout (single vault or all)
    verify <name>                     Inspect launcher SHA-256 and re-pin if needed

  CHANGE OR REMOVE
    visibility <name> <mode>          Toggle public / private / auth-gated
    remove <name> [--delete-repo]     Remove vault locally + MCP (add --delete-repo to also delete GitHub repo)

Run 'vaultkit <command> --help' for detailed usage and examples for any command.
`;

program.hook('preAction', () => {
  if (program.opts().verbose) process.env.VAULTKIT_VERBOSE = '1';
});

program
  .command('setup')
  .description('One-time prerequisite check + install (run once after `npm i -g`)')
  .addHelpText('after', `
Examples:
  $ vaultkit setup

Walks through every prerequisite -- Node 22+, gh CLI, gh auth (repo +
workflow scopes), git config user.name/email, and the claude CLI. Idempotent;
re-run any time to fix what's broken. Does NOT request the delete_repo scope
-- that's requested on demand by 'vaultkit destroy'.
`)
  .action(async () => {
    await wrap(async () => {
      const { run } = await import('../src/commands/setup.js');
      const issues = await run();
      if (issues > 0) process.exit(1);
    }, 'setup', []);
  });

program
  .command('init <name>')
  .description('Create a new vault from scratch')
  .option('-m, --mode <mode>', 'publish mode: public, private, or auth-gated (skips the interactive prompt)')
  .addHelpText('after', `
Examples:
  $ vaultkit init my-wiki                       # interactive: prompts for publish mode
  $ vaultkit init my-wiki --mode private        # skip prompt: private notes-only
  $ vaultkit init my-wiki --mode public         # skip prompt: public Quartz site
  $ vaultkit init my-wiki --mode auth-gated     # skip prompt: auth-gated Pages (Pro+)

Creates ~/vaults/<name> (override with VAULTKIT_HOME), creates a GitHub repo,
and registers the vault as a Claude Code MCP server. Without --mode, prompts
for publish mode interactively. Vault names must match ^[a-zA-Z0-9_-]+$, max
64 chars.
`)
  .action(async (name: string, options: { mode?: string }) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/init.js');
      await run(name, options.mode ? { publishMode: options.mode as PublishMode } : {});
    }, 'init', options.mode ? [name, '--mode', options.mode] : [name]);
  });

program
  .command('connect <input>')
  .description('Clone an existing vault and register it as MCP server')
  .addHelpText('after', `
Examples:
  $ vaultkit connect owner/repo
  $ vaultkit connect https://github.com/owner/repo
  $ vaultkit connect git@github.com:owner/repo

Clones into ~/vaults/<repo-name> and registers as an MCP server. Shows the
launcher SHA-256 and asks for explicit confirmation before pinning. Only
connect vaults from authors you trust -- the launcher runs with your full
user permissions on every Claude Code session start.
`)
  .action(async (input: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/connect.js');
      await run(input);
    }, 'connect', [input]);
  });

program
  .command('remove <name>')
  .description('Remove vault locally + from MCP (use --delete-repo to also delete GitHub repo)')
  .option('--delete-repo', 'also delete the GitHub repo (requires admin + delete_repo scope)')
  .addHelpText('after', `
Examples:
  $ vaultkit remove my-wiki                    # local + MCP only; keep GitHub repo
  $ vaultkit remove my-wiki --delete-repo      # also delete the GitHub repo (you must own it)

Without --delete-repo: removes the local clone + MCP registration; the
GitHub repo stays online. Useful when disconnecting from a vault you
don't own or want to keep available for others.

With --delete-repo: also deletes the GitHub repo. Requests the
delete_repo scope interactively on first use; the scope is never
requested without the flag (security invariant). Pre-grant via:
  gh auth refresh -h github.com -s delete_repo
`)
  .action(async (name: string, opts: { deleteRepo?: boolean }) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/remove.js');
      await run(name, opts.deleteRepo ? { deleteRepo: true } : {});
    }, 'remove', opts.deleteRepo ? [name, '--delete-repo'] : [name]);
  });

// Deprecated alias for `vaultkit remove <name>` — see ADR. Removed in 4.0.
program
  .command('disconnect <name>')
  .description('(deprecated) Use `vaultkit remove <name>` instead')
  .action(async (name: string) => {
    printDeprecationNotice('disconnect', 'remove');
    await wrap(async () => {
      const { run } = await import('../src/commands/remove.js');
      await run(name);
    }, 'remove', [name]);
  });

// Deprecated alias for `vaultkit remove <name> --delete-repo`. Removed in 4.0.
program
  .command('destroy <name>')
  .description('(deprecated) Use `vaultkit remove <name> --delete-repo` instead')
  .action(async (name: string) => {
    printDeprecationNotice('destroy', 'remove --delete-repo');
    await wrap(async () => {
      const { run } = await import('../src/commands/remove.js');
      await run(name, { deleteRepo: true });
    }, 'remove', [name, '--delete-repo']);
  });

program
  .command('sync')
  .description('Sync all vaults from upstream (git pull --ff-only)')
  .addHelpText('after', `
Examples:
  $ vaultkit sync
  $ VAULTKIT_PULL_TIMEOUT=60000 vaultkit sync

Syncs every registered vault from its upstream. Per-vault timeout defaults
to 30s; override with VAULTKIT_PULL_TIMEOUT (milliseconds).
`)
  .action(async () => {
    await wrap(async () => {
      const { run } = await import('../src/commands/sync.js');
      await run();
    }, 'sync', []);
  });

// Deprecated alias for `vaultkit pull` — see ADR for the rename rationale.
// Removed in 4.0.
program
  .command('pull')
  .description('(deprecated) Use `vaultkit sync` instead')
  .action(async () => {
    printDeprecationNotice('pull', 'sync');
    await wrap(async () => {
      const { run } = await import('../src/commands/sync.js');
      await run();
    }, 'sync', []);
  });

program
  .command('update [name]')
  .description('Refresh launcher and restore missing layout files (use --all to update every vault)')
  .option('--all', 'update every registered vault in one pass')
  .addHelpText('after', `
Examples:
  $ vaultkit update my-wiki      # single vault
  $ vaultkit update --all        # every registered vault

Re-pins the launcher SHA-256 in MCP and restores any missing canonical
layout files (CLAUDE.md, README.md, raw/, wiki/, etc.). Run after a
vaultkit upgrade or when 'vaultkit verify' reports drift. With --all,
iterates every registered vault and reports a per-vault status summary;
exits non-zero if any vault failed.
`)
  .action(async (name: string | undefined, opts: { all?: boolean }) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/update.js');
      await run(name, opts.all ? { all: true } : {});
    }, 'update', opts.all ? ['--all'] : [name ?? '']);
  });

program
  .command('mcp-server')
  .description('Per-vault MCP server (long-running daemon — invoked by the launcher, not directly)')
  .requiredOption('--vault-dir <path>', "vault directory this server is bound to")
  .option('--expected-sha256 <hex>', '(ignored here; verified by launcher before invoking)')
  .addHelpText('after', `
Examples:
  $ vaultkit mcp-server --vault-dir ~/vaults/my-wiki   # not for direct human use
  $ vaultkit mcp-server --vault-dir . --expected-sha256=...

Speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP transport
Claude Code uses). Spawned automatically by the byte-immutable per-vault
launcher (.mcp-start.js) on every Claude Code session start. Replaces
'npx obsidian-mcp-pro <vault-dir>' as the launcher's spawn target.

Exposes 6 tools tuned for Claude: vk_search, vk_list_notes, vk_get_note,
vk_get_tags, vk_search_by_tag, vk_recent_notes. Search uses Node's built-in
node:sqlite (FTS5 + BM25) against the shared ~/.vaultkit-search.db index.
`)
  .action(async (opts: { vaultDir: string; expectedSha256?: string }) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/mcp-server.js');
      await run({ vaultDir: opts.vaultDir });
    }, 'mcp-server', ['--vault-dir', opts.vaultDir]);
  });

program
  .command('refresh [name]')
  .description('Check sources for upstream changes and write a freshness report')
  .option('--vault-dir <path>', 'operate on this directory instead of a registered vault (CI mode)')
  .addHelpText('after', `
Examples:
  $ vaultkit refresh my-wiki                  # registered vault
  $ vaultkit refresh --vault-dir .            # current dir (used by CI)

Walks raw/, reads each file's frontmatter URL + clip date, and classifies
sources: GitHub repos get a commit-since-clip count via 'gh api'; other URLs
get an HTTP fetch + Mozilla Readability text-only compare against the local
clip; paywalls / SPAs / 4xx / 5xx route to the report's "manual review"
section. Output: wiki/_freshness/<YYYY-MM-DD>.md (only written when
findings exist). Apply the report by following the patch flow in CLAUDE.md.
`)
  .action(async (name: string | undefined, opts: { vaultDir?: string }) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/refresh.js');
      await run(name, opts.vaultDir ? { vaultDir: opts.vaultDir } : {});
    }, 'refresh', [name ?? '', opts.vaultDir ?? '']);
  });

program
  .command('doctor')
  .description('Check environment and flag broken vaults')
  .addHelpText('after', `
Examples:
  $ vaultkit doctor

Checks Node version, gh auth, git config, claude CLI, and every registered
vault's launcher SHA-256 against the pinned hash. Exits non-zero if any
issue is found, so it composes well in CI.
`)
  .action(async () => {
    await wrap(async () => {
      const { run } = await import('../src/commands/doctor.js');
      const issues = await run();
      if (issues > 0) process.exit(1);
    }, 'doctor', []);
  });

program
  .command('verify <name>')
  .description('Inspect launcher SHA-256 and re-pin if needed')
  .addHelpText('after', `
Examples:
  $ vaultkit verify my-wiki

Re-computes the launcher SHA-256 and offers to re-pin if it has drifted
from the value in the MCP registry. Use when Claude Code refuses to start
a vault's MCP server with "SHA-256 mismatch".
`)
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/verify.js');
      await run(name);
    }, 'verify', [name]);
  });

program
  .command('list [name]')
  .description('List vaults + git state (or detail for one)')
  .addHelpText('after', `
Examples:
  $ vaultkit list                # list all registered vaults
  $ vaultkit list my-wiki        # detailed status for one vault

Shows registry contents, on-disk presence, git state, and MCP pin status.
`)
  .action(async (name: string | undefined) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/list.js');
      await run(name);
    }, 'list', name ? [name] : []);
  });

// Deprecated alias for `vaultkit list` — see ADR for the rename
// rationale (the verb `status` collided with `doctor`'s diagnostic
// surface). Removed in 4.0.
program
  .command('status [name]')
  .description('(deprecated) Use `vaultkit list` instead')
  .action(async (name: string | undefined) => {
    printDeprecationNotice('status', 'list');
    await wrap(async () => {
      const { run } = await import('../src/commands/list.js');
      await run(name);
    }, 'list', name ? [name] : []);
  });

program
  .command('backup <name>')
  .description('Snapshot a vault to a local zip')
  .addHelpText('after', `
Examples:
  $ vaultkit backup my-wiki

Writes <name>-<timestamp>.zip in the current directory.
`)
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/backup.js');
      await run(name);
    }, 'backup', [name]);
  });

program
  .command('visibility <name> <mode>')
  .description('Toggle public / private / auth-gated')
  .addHelpText('after', `
Examples:
  $ vaultkit visibility my-wiki public
  $ vaultkit visibility my-wiki private
  $ vaultkit visibility my-wiki auth-gated     # requires GitHub Pro+

Toggles the GitHub repo + Pages visibility. auth-gated keeps the repo
private but lets authenticated GitHub users view the Pages site.
`)
  .action(async (name: string, mode: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/visibility.js');
      await run(name, mode);
    }, 'visibility', [name, mode]);
  });

program.parseAsync(process.argv);
