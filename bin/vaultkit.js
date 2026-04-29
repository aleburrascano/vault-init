#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const COMMANDS = {
  init:       'vault-init.sh',
  connect:    'vault-connect.sh',
  disconnect: 'vault-disconnect.sh',
  destroy:    'vault-destroy.sh',
  pull:       'vault-pull.sh',
  update:     'vault-update.sh',
  doctor:     'vault-doctor.sh',
  verify:     'vault-verify.sh',
  status:     'vault-status.sh',
  backup:     'vault-backup.sh',
  visibility: 'vault-visibility.sh',
};

const HELP = `
vaultkit — Obsidian wiki management

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

Flags:
  --verbose, -v   Enable trace output (sets VAULTKIT_VERBOSE=1 for scripts)
  --version       Print vaultkit version + runtime info
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

if (sub === '--version') {
  printVersion();
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

function printVersion() {
  const root = resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  const cfgPath = process.platform === 'win32'
    ? (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.claude.json') : null)
    : (process.env.HOME ? join(process.env.HOME, '.claude.json') : null);
  let count = 0;
  if (cfgPath && existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const servers = cfg.mcpServers || {};
      count = Object.values(servers).filter(s =>
        s && s.args && s.args.some(a => String(a).endsWith('.mcp-start.js'))
      ).length;
    } catch {}
  }

  console.log('vaultkit  ' + pkg.version);
  console.log('node      ' + process.version);
  console.log('platform  ' + process.platform + ' ' + process.arch);
  console.log('vaults    ' + count + ' registered');
}
