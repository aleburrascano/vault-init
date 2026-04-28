#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
let script = path.resolve(__dirname, '..', 'vault-init.sh');
if (process.platform === 'win32')
  script = script.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);
const result = spawnSync('bash', [script, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status || 0);
