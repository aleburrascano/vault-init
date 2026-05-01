#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { isVaultkitError, EXIT_CODES } from '../src/lib/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string };

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
  .version(pkg.version)
  .option('-v, --verbose', 'enable trace output');

program.hook('preAction', () => {
  if (program.opts().verbose) process.env.VAULTKIT_VERBOSE = '1';
});

program
  .command('setup')
  .description('One-time prerequisite check + install (run once after `npm i -g`)')
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
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/init.js');
      await run(name);
    }, 'init', [name]);
  });

program
  .command('connect <input>')
  .description('Clone an existing vault and register it as MCP server')
  .action(async (input: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/connect.js');
      await run(input);
    }, 'connect', [input]);
  });

program
  .command('disconnect <name>')
  .description('Remove vault locally and from MCP (keeps GitHub repo)')
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/disconnect.js');
      await run(name);
    }, 'disconnect', [name]);
  });

program
  .command('destroy <name>')
  .description('Delete vault locally, on GitHub, and from MCP')
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/destroy.js');
      await run(name);
    }, 'destroy', [name]);
  });

program
  .command('pull')
  .description('Sync all vaults from upstream')
  .action(async () => {
    await wrap(async () => {
      const { run } = await import('../src/commands/pull.js');
      await run();
    }, 'pull', []);
  });

program
  .command('update <name>')
  .description('Refresh launcher and restore missing layout files')
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/update.js');
      await run(name);
    }, 'update', [name]);
  });

program
  .command('doctor')
  .description('Check environment and flag broken vaults')
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
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/verify.js');
      await run(name);
    }, 'verify', [name]);
  });

program
  .command('status [name]')
  .description('Show vault registry + git state')
  .action(async (name: string | undefined) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/status.js');
      await run(name);
    }, 'status', name ? [name] : []);
  });

program
  .command('backup <name>')
  .description('Snapshot a vault to a local zip')
  .action(async (name: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/backup.js');
      await run(name);
    }, 'backup', [name]);
  });

program
  .command('visibility <name> <mode>')
  .description('Toggle public / private / auth-gated')
  .action(async (name: string, mode: string) => {
    await wrap(async () => {
      const { run } = await import('../src/commands/visibility.js');
      await run(name, mode);
    }, 'visibility', [name, mode]);
  });

program.parseAsync(process.argv);
