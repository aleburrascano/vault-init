#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
};

const HELP = `
vaultkit — Obsidian wiki management

Commands:
  vaultkit init <name> [--private]   Create a new vault with GitHub Pages + MCP
  vaultkit connect <owner/repo>      Clone a vault and register it as an MCP server
  vaultkit disconnect <name>         Remove a vault locally and from MCP (keeps GitHub repo)
  vaultkit destroy <name>            Delete a vault locally, on GitHub, and from MCP
  vaultkit list                      Show all registered vaults
  vaultkit pull                      Pull latest changes in all registered vaults
  vaultkit update <name>             Update system files in a vault to the latest version
  vaultkit doctor                    Check environment and vault health
  vaultkit help                      Show this help
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

const cwd = resolve(import.meta.dirname, '..');
const env = { ...process.env };

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

  const existing = (env.PATH || '').split(';').filter(Boolean).map(toUnix);
  env.PATH = [...new Set([...[...toolDirs].map(toUnix), ...existing])].join(':');
}

const result = spawnSync(bash, [script, ...process.argv.slice(3)], {
  cwd,
  stdio: 'inherit',
  env,
});

if (result.error) {
  process.stderr.write(`vaultkit: failed to launch bash — ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
