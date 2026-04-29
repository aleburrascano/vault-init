#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const COMMANDS = {
  init:       'vault-init.sh',
  connect:    'vault-connect.sh',
  disconnect: 'vault-disconnect.sh',
  destroy:    'vault-destroy.sh',
  list:       'vault-list.sh',
  pull:       'vault-pull.sh',
  update:     'vault-update.sh',
  doctor:     'vault-doctor.sh',
  verify:     'vault-verify.sh',
  status:     'vault-status.sh',
  backup:     'vault-backup.sh',
  version:    'vault-version.sh',
  visibility: 'vault-visibility.sh',
};

const HELP = `
vaultkit — Obsidian wiki management

Commands:
  vaultkit init <name>                Create a new vault (asks: public site / private notes / auth-gated)
  vaultkit connect <owner/repo>       Clone a vault and register it as an MCP server
  vaultkit disconnect <name>          Remove a vault locally and from MCP (keeps GitHub repo)
  vaultkit destroy <name>             Delete a vault locally, on GitHub (if you own it), and from MCP
  vaultkit list                       Show all registered vaults with pinned SHA-256
  vaultkit pull                       Pull latest changes in all registered vaults
  vaultkit update <name>              Update the launcher script and re-pin its SHA-256
  vaultkit verify <name>              Inspect launcher state and re-pin if you accept it
  vaultkit visibility <name> <mode>   Flip a vault between public / private / auth-gated
  vaultkit status [name]              Show git state across vaults
  vaultkit backup <name>              Create a local zip snapshot via git archive
  vaultkit doctor                     Check environment and vault health (flags hash drift)
  vaultkit version                    Print vaultkit version + runtime info
  vaultkit help                       Show this help

Flags:
  --verbose, -v   Enable trace output (sets VAULTKIT_VERBOSE=1 for scripts)
  --help,    -h   Per-command usage (e.g., 'vaultkit init --help')

Environment:
  VAULTKIT_HOME            Vaults root directory (default: ~/vaults)
  VAULTKIT_LOG             If set, append timestamped command audit log to this file
  VAULTKIT_PULL_TIMEOUT    Per-vault timeout for 'vaultkit pull' (default: 30000ms)
`.trim();

const sub = process.argv[2];

if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
  console.log(HELP);
  process.exit(0);
}

const script = COMMANDS[sub];
if (!script) {
  process.stderr.write(`vaultkit: unknown command "${sub}"\nRun "vaultkit help" for usage.\n`);
  process.exit(1);
}

// Pull --verbose / -v out of the args before passing through to the script.
const rawArgs = process.argv.slice(3);
const verbose = rawArgs.includes('--verbose') || rawArgs.includes('-v');
const scriptArgs = rawArgs.filter(a => a !== '--verbose' && a !== '-v');

const cwd = resolve(import.meta.dirname, '..');
const env = { ...process.env };
if (verbose) env.VAULTKIT_VERBOSE = '1';

let bash = 'bash';

if (process.platform === 'win32') {
  const toUnix = p => p
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`)
    .replace(/\/$/, '');

  const gitRoots = [
    process.env.PROGRAMFILES         && join(process.env.PROGRAMFILES,         'Git'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Git'),
    process.env.LOCALAPPDATA         && join(process.env.LOCALAPPDATA,         'Programs', 'Git'),
  ].filter(Boolean);

  let bashPath = null;
  for (const root of gitRoots) {
    const candidate = join(root, 'bin', 'bash.exe');
    if (existsSync(candidate)) { bashPath = candidate; break; }
  }

  if (!bashPath) {
    const where = spawnSync('where', ['bash'], { encoding: 'utf8' });
    const found = (where.stdout || '').trim().split('\n')
      .map(s => s.trim())
      .filter(s => s && !s.toLowerCase().includes('system32'));
    if (found.length > 0) {
      bashPath = found[0];
    } else {
      process.stderr.write(
        'vaultkit: Git for Windows bash not found.\n' +
        'Install Git for Windows: https://git-scm.com\n'
      );
      process.exit(1);
    }
  }
  bash = bashPath;

  const toolDirs = new Set([dirname(bash), dirname(process.execPath)]);
  for (const tool of ['gh', 'claude']) {
    const r = spawnSync('where', [tool], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) {
      toolDirs.add(dirname(r.stdout.trim().split('\n')[0].trim()));
    }
  }

  // Probe known gh install locations directly — `where` misses installs made in the
  // current session because the registry PATH change never reaches running processes.
  const ghCandidates = [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'GitHub CLI'),
    'C:\\Program Files\\GitHub CLI',
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages',
      'GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe', 'tools'),
  ].filter(Boolean);
  for (const p of ghCandidates) {
    if (existsSync(join(p, 'gh.exe'))) { toolDirs.add(p); break; }
  }

  const existing = (env.PATH || '').split(';').filter(Boolean).map(toUnix);
  env.PATH = [...new Set([...[...toolDirs].map(toUnix), ...existing])].join(':');
}

const startedAt = Date.now();
const result = spawnSync(bash, [script, ...scriptArgs], {
  cwd,
  stdio: 'inherit',
  env,
});

if (result.error) {
  process.stderr.write(`vaultkit: failed to launch bash — ${result.error.message}\n`);
  writeAuditLog(sub, scriptArgs, 1, Date.now() - startedAt);
  process.exit(1);
}

const exitCode = result.status ?? 1;
writeAuditLog(sub, scriptArgs, exitCode, Date.now() - startedAt);
process.exit(exitCode);

function writeAuditLog(command, args, code, durationMs) {
  const logPath = process.env.VAULTKIT_LOG;
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    const line = [
      new Date().toISOString(),
      command,
      args.join(' '),
      `exit=${code}`,
      `${durationMs}ms`,
    ].join('\t') + '\n';
    appendFileSync(logPath, line);
  } catch {
    // Logging must never break the command. Swallow.
  }
}
