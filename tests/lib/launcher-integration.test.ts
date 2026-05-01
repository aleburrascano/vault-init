import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TMPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../lib/mcp-start.js.tmpl');

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed: ${result.stderr}`);
  }
}

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vk-launcher-int-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ── Step 1: SHA-256 self-verification ────────────────────────────────────────

describe('launcher: SHA-256 verification (step 1)', () => {
  it('exits non-zero with diagnostic stderr when --expected-sha256 does not match', () => {
    const launcherPath = join(tmp, '.mcp-start.js');
    copyFileSync(TMPL_PATH, launcherPath);

    const wrongHash = 'f'.repeat(64);
    const result = spawnSync(process.execPath, [launcherPath, `--expected-sha256=${wrongHash}`], {
      cwd: tmp,
      timeout: 5000,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/SHA-256 mismatch/i);
    expect(result.stderr).toMatch(/vaultkit verify/i);
    expect(result.stderr).toContain(wrongHash);
  });

  it('emits a warning and continues when --expected-sha256 is omitted', () => {
    // Without the pinned hash the launcher prints a warning, then proceeds.
    // We use a 3s timeout so step 6 (npx obsidian-mcp-pro) does not hang the test.
    const launcherPath = join(tmp, '.mcp-start.js');
    copyFileSync(TMPL_PATH, launcherPath);

    const result = spawnSync(process.execPath, [launcherPath], {
      cwd: tmp,
      timeout: 3000,
      encoding: 'utf8',
    });

    // Hash-missing warning is emitted before any other step runs.
    expect(result.stderr).toMatch(/registered without a pinned SHA-256/i);
    expect(result.stderr).not.toMatch(/SHA-256 mismatch/i);
  });
});

// ── Step 5: .obsidian/ auto-create ───────────────────────────────────────────

describe('launcher: .obsidian/ stub creation (step 5)', () => {
  it('creates .obsidian/ when missing, reaching step 5 even if step 6 (npx) fails', () => {
    const launcherPath = join(tmp, '.mcp-start.js');
    copyFileSync(TMPL_PATH, launcherPath);
    const expected = sha256(launcherPath);

    expect(existsSync(join(tmp, '.obsidian'))).toBe(false);

    // Run with a timeout so npx in step 6 does not hang. Whether step 6
    // fails fast (no obsidian-mcp-pro available) or hangs until timeout,
    // step 5 will have already executed.
    const result = spawnSync(process.execPath, [launcherPath, `--expected-sha256=${expected}`], {
      cwd: tmp,
      timeout: 3000,
      encoding: 'utf8',
    });

    // No hash-mismatch error — we got past step 1.
    expect(result.stderr).not.toMatch(/SHA-256 mismatch/);
    // .obsidian/ exists from step 5, regardless of how step 6 ended.
    expect(existsSync(join(tmp, '.obsidian'))).toBe(true);
  });
});

// ── Step 3: refuse fast-forward when upstream tampers with launcher ──────────

describe('launcher: refuses fast-forward on upstream launcher tampering (step 3)', () => {
  it('exits non-zero with refusing-to-auto-update diagnostic when upstream .mcp-start.js differs', () => {
    // Topology: a bare "upstream" repo, a "work" clone that holds the
    // launcher under test, and a "tamper" clone that pushes a modified
    // launcher to upstream so `work` sees a launcher diff at fetch time.
    const upstream = join(tmp, 'upstream.git');
    const work = join(tmp, 'work');
    const tamper = join(tmp, 'tamper');

    git(tmp, 'init', '--bare', '-b', 'main', upstream);
    git(tmp, 'clone', upstream, work);
    git(work, 'config', 'user.email', 't@example.com');
    git(work, 'config', 'user.name', 'Tester');
    git(work, 'checkout', '-B', 'main');

    copyFileSync(TMPL_PATH, join(work, '.mcp-start.js'));
    git(work, 'add', '.mcp-start.js');
    git(work, 'commit', '-m', 'v1');
    git(work, 'push', '-u', 'origin', 'main');

    const v1Hash = sha256(join(work, '.mcp-start.js'));

    // Tamper clone pushes a different launcher to upstream/main.
    git(tmp, 'clone', upstream, tamper);
    git(tamper, 'config', 'user.email', 't@example.com');
    git(tamper, 'config', 'user.name', 'Tester');
    git(tamper, 'checkout', '-B', 'main');
    writeFileSync(
      join(tamper, '.mcp-start.js'),
      '// tampered upstream launcher\n' + readFileSync(TMPL_PATH, 'utf8'),
    );
    git(tamper, 'commit', '-am', 'v2-tampered');
    git(tamper, 'push', 'origin', 'main');

    // Run launcher in `work` — its on-disk launcher still matches v1Hash, but
    // git fetch will pull in upstream's tampered v2 commit and the diff check
    // (step 3) must abort.
    const result = spawnSync(process.execPath, [
      join(work, '.mcp-start.js'),
      `--expected-sha256=${v1Hash}`,
    ], {
      cwd: work,
      timeout: 10_000,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refusing to auto-update/i);
    expect(result.stderr).toMatch(/vaultkit verify/i);
  });
});
