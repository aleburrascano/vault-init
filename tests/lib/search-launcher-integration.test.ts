import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end coverage for `lib/search-launcher.js.tmpl`. Mirrors the
 * shape of `launcher-integration.test.ts` for the per-vault launcher:
 * we spawn the template as a real Node process and assert it
 * self-verifies its SHA pin before doing anything else.
 *
 * We do NOT spawn the actual `vaultkit-search-server` here — that
 * requires the npm bin to be installed/linked, which the unit test
 * environment doesn't guarantee. The launcher's job is the SHA
 * verification; if that succeeds, the spawn-then-exec path is
 * already covered by the per-vault launcher's integration test
 * (same shape).
 */

const TMPL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../lib/search-launcher.js.tmpl',
);

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-search-launcher-int-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('search-launcher SHA self-verification', () => {
  it('refuses to start with exit 1 + clear stderr when the pin does not match', () => {
    const launcher = join(tmp, 'launcher.js');
    copyFileSync(TMPL_PATH, launcher);
    // Wrong pin: actual SHA is correct but we provide a deliberately
    // wrong --expected-sha256.
    const wrongPin = 'a'.repeat(64);
    const result = spawnSync('node', [launcher, `--expected-sha256=${wrongPin}`], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Search launcher SHA-256 mismatch/);
    expect(result.stderr).toMatch(/Expected: a{64}/);
    expect(result.stderr).toMatch(/Actual:/);
    expect(result.stderr).toMatch(/vaultkit setup/);
  });

  it('refuses to start when the launcher has been tampered with after registration', () => {
    const launcher = join(tmp, 'launcher.js');
    copyFileSync(TMPL_PATH, launcher);
    const correctPin = sha256(launcher);
    // Tamper: append a malicious line. Pin no longer matches.
    const tampered = readFileSync(launcher, 'utf8') + '\nrequire("os").homedir();';
    writeFileSync(launcher, tampered);
    const result = spawnSync('node', [launcher, `--expected-sha256=${correctPin}`], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Search launcher SHA-256 mismatch/);
  });

  it('warns (does not refuse) when no --expected-sha256 is given', () => {
    // Spawn without the pin flag. The launcher should warn but proceed
    // to the npx step. We can't easily test the npx step in CI without
    // a real `vaultkit-search-server` binary, so we just confirm the
    // warning surfaces. The exit code may be non-zero if npx fails to
    // find the binary — that's expected.
    const launcher = join(tmp, 'launcher.js');
    copyFileSync(TMPL_PATH, launcher);
    const result = spawnSync('node', [launcher], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.stderr).toMatch(/Warning: registered without a pinned SHA-256/);
  });
});
