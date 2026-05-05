#!/usr/bin/env node
// Post-build step: copy lib/*.tmpl into dist/lib/ so command modules can find
// their templates with the same relative path in both raw (src/commands/) and
// compiled (dist/src/commands/) execution contexts. Also marks the bin
// executable on Unix; chmod is a no-op on Windows.

import { copyFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATES = [
  'mcp-start.js.tmpl',
  'deploy.yml.tmpl',
  'freshness.yml.tmpl',
  'pr-template.md.tmpl',
  'claude-settings.json.tmpl',
  'search-launcher.js.tmpl',
];
const SRC_DIR = 'lib';
const DEST_DIR = join('dist', 'lib');

mkdirSync(DEST_DIR, { recursive: true });
for (const f of TEMPLATES) {
  copyFileSync(join(SRC_DIR, f), join(DEST_DIR, f));
}

for (const bin of ['vaultkit.js', 'vaultkit-search-server.js']) {
  try {
    chmodSync(join('dist', 'bin', bin), 0o755);
  } catch {
    // Windows or other platforms without POSIX permissions — safe to ignore.
  }
}
