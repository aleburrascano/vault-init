#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

const cwd = path.resolve(__dirname, '..');
const env = { ...process.env };

let bash = 'bash';

if (process.platform === 'win32') {
  const toUnix = p => p
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`)
    .replace(/\/$/, '');

  // Find bash — Git for Windows often doesn't add bash.exe to PATH.
  const gitRoots = [
    process.env.PROGRAMFILES        && path.join(process.env.PROGRAMFILES,        'Git'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Git'),
    process.env.LOCALAPPDATA         && path.join(process.env.LOCALAPPDATA,         'Programs', 'Git'),
    process.env.USERPROFILE          && path.join(process.env.USERPROFILE,          'AppData', 'Local', 'Programs', 'Git'),
  ].filter(Boolean);

  let bashPath = null;
  for (const root of gitRoots) {
    const candidate = path.join(root, 'bin', 'bash.exe');
    if (existsSync(candidate)) { bashPath = candidate; break; }
  }

  // Also accept bash if it's already on PATH.
  const onPath = spawnSync('where', ['bash'], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) {
    bash = onPath.stdout.trim().split('\n')[0].trim();
  } else if (bashPath) {
    bash = bashPath;
  } else {
    process.stderr.write(
      'vault-init: bash not found.\n' +
      'Install Git for Windows (https://git-scm.com) and re-run.\n'
    );
    process.exit(1);
  }

  // Build a POSIX PATH that bash can use: convert semicolon/backslash Windows PATH,
  // and prepend node's dir + bash's own dir so all tools are findable.
  const entries = (env.PATH || '').split(';').filter(Boolean).map(toUnix);
  entries.unshift(toUnix(path.dirname(process.execPath)));
  entries.unshift(toUnix(path.dirname(bash)));
  env.PATH = [...new Set(entries)].join(':');
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
