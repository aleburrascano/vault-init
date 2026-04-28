#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// cwd for spawnSync must be the package dir so bash can find vault-init.sh.
// We pass the user's real working directory via VAULT_INIT_CWD instead.
const cwd = resolve(import.meta.dirname, '..');
const env = { ...process.env };

// Always tell the script where the user actually ran the command from.
env.VAULT_INIT_CWD = process.cwd();

let bash = 'bash';

if (process.platform === 'win32') {
  const toUnix = p => p
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`)
    .replace(/\/$/, '');

  // User's CWD needs to be in POSIX format for bash.
  env.VAULT_INIT_CWD = toUnix(process.cwd());

  // ── Find Git for Windows bash ──────────────────────────────────────────────
  // C:\Windows\System32\bash.exe is the WSL launcher — it boots a Linux
  // environment where Windows tools (node, git, npm, gh) are invisible.
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
        'vault-init: Git for Windows bash not found.\n' +
        'Install Git for Windows: https://git-scm.com\n' +
        '(C:\\Windows\\System32\\bash.exe is WSL — it cannot see Windows tools.)\n'
      );
      process.exit(1);
    }
  }
  bash = bashPath;

  // ── Build PATH from known tool locations ──────────────────────────────────
  // git is bundled with Git for Windows — dirname(bash) is Git\bin which also
  // has git.exe, ssh, curl, etc. node's dir covers npm (same directory).
  // gh and claude may be absent; the bash script handles installation/auth.
  const toolDirs = new Set([
    dirname(bash),                // git, ssh, curl, etc.
    dirname(process.execPath),    // node, npm
  ]);

  for (const tool of ['gh', 'claude']) {
    const r = spawnSync('where', [tool], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) {
      toolDirs.add(dirname(r.stdout.trim().split('\n')[0].trim()));
    }
  }

  // Tool dirs go first so they shadow anything broken in the existing PATH.
  // Append the full converted PATH so bash built-ins and Git's bundled
  // utilities (ssh, curl, etc.) remain reachable.
  const existing = (env.PATH || '').split(';').filter(Boolean).map(toUnix);
  env.PATH = [...new Set([...[...toolDirs].map(toUnix), ...existing])].join(':');
}

const result = spawnSync(bash, ['vault-init.sh', ...process.argv.slice(2)], {
  cwd,
  stdio: 'inherit',
  env,
});

if (result.error) {
  process.stderr.write(`vault-init: failed to launch bash — ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
