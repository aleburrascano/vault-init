#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { isVaultkitError, EXIT_CODES } from '../src/lib/errors.js';
import { ConsoleLogger } from '../src/lib/logger.js';
import { checkForUpdate } from '../src/lib/update-check.js';
import type { PublishMode } from '../src/lib/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string };
const versionString = `${pkg.version} (node ${process.version}, ${process.platform} ${process.arch})`;

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
    await fn();
    auditLog(commandName, args, 0, start);
    checkForUpdate(pkg.version, new ConsoleLogger());
    if (verbose) console.error(`[debug] ${commandName} ok (${Date.now() - start}ms)`);
  } catch (err) {
    const exitCode = isVaultkitError(err) ? EXIT_CODES[err.code] : 1;
    auditLog(commandName, args, exitCode, start);
    if (verbose) console.error(`[debug] ${commandName} exit=${exitCode} (${Date.now() - start}ms)`);
    const message = (err as { message?: string })?.message;
    if (message) {
      process.stderr.write(`Error: ${message}\n`);
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
    status [name]                     See your vaults + git state (or detailed status for one)
    pull                              Sync all vaults from their upstream
    refresh [name]                    Check sources for upstream changes and write a freshness report
    backup <name>                     Snapshot a vault to a local zip

  WHEN SOMETHING'S WRONG
    doctor                            Check environment + flag broken vaults
    update <name>                     Refresh launcher and restore missing layout files
    verify <name>                     Inspect launcher SHA-256 and re-pin if needed

  CHANGE OR REMOVE
    visibility <name> <mode>          Toggle public / private / auth-gated
    disconnect <name>                 Remove vault locally and from MCP (keeps GitHub repo)
    destroy <name>                    Delete vault locally, on GitHub, and from MCP

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
  .command('disconnect <name>')
  .description('Remove vault locally and from MCP (keeps GitHub repo)')
  .addHelpText('after', `
Examples:
  $ vaultkit disconnect my-wiki

Removes the local clone and MCP registration. Keeps the GitHub repo --
use 'vaultkit destroy' to delete the GitHub repo too.
`)
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/disconnect.js');
      await run(name);
    }, 'disconnect', [name]);
  });

program
  .command('destroy <name>')
  .description('Delete vault locally, on GitHub, and from MCP')
  .addHelpText('after', `
Examples:
  $ vaultkit destroy my-wiki

Deletes the local clone, the MCP registration, and the GitHub repo (only
if you own it). Requests the delete_repo scope interactively on first run.
To pre-grant: gh auth refresh -h github.com -s delete_repo
`)
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/destroy.js');
      await run(name);
    }, 'destroy', [name]);
  });

program
  .command('pull')
  .description('Sync all vaults from upstream')
  .addHelpText('after', `
Examples:
  $ vaultkit pull
  $ VAULTKIT_PULL_TIMEOUT=60000 vaultkit pull

Syncs every registered vault from its upstream. Per-vault timeout defaults
to 30s; override with VAULTKIT_PULL_TIMEOUT (milliseconds).
`)
  .action(async () => {
    await wrap(async () => {
      const { run } = await import('../src/commands/pull.js');
      await run();
    }, 'pull', []);
  });

program
  .command('update <name>')
  .description('Refresh launcher and restore missing layout files')
  .addHelpText('after', `
Examples:
  $ vaultkit update my-wiki

Re-pins the launcher SHA-256 in MCP and restores any missing canonical
layout files (CLAUDE.md, README.md, raw/, wiki/, etc.). Run after a
vaultkit upgrade or when 'vaultkit verify' reports drift.
`)
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/update.js');
      await run(name);
    }, 'update', [name]);
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
  .command('status [name]')
  .description('Show vault registry + git state')
  .addHelpText('after', `
Examples:
  $ vaultkit status              # list all registered vaults
  $ vaultkit status my-wiki      # detailed status for one vault

Shows registry contents, on-disk presence, git state, and MCP pin status.
`)
  .action(async (name: string | undefined) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/status.js');
      await run(name);
    }, 'status', name ? [name] : []);
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
