#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const cwd = path.resolve(__dirname, '..');
const env = { ...process.env };

if (process.platform === 'win32') {
  // Windows PATH uses semicolons and backslashes; bash needs colons and forward slashes.
  // Convert every entry so git, node, npm, gh are all findable from bash.
  const toUnix = p => p
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`)
    .replace(/\/$/, '');

  const entries = (env.PATH || '').split(';').filter(Boolean).map(toUnix);
  // Guarantee the running node's own directory is present.
  entries.unshift(toUnix(path.dirname(process.execPath) + path.sep));
  env.PATH = [...new Set(entries)].join(':');
}

const result = spawnSync('bash', ['vault-init.sh', ...process.argv.slice(2)], {
  cwd,
  stdio: 'inherit',
  env,
});

if (result.error) {
  process.stderr.write(
    `vault-init: failed to launch bash — ${result.error.message}\n` +
    `Make sure Git for Windows is installed and 'bash' is on your PATH.\n`
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
