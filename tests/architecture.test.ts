import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'node:fs/promises';

/**
 * Architectural fitness functions. These tests encode the boundary rules
 * documented in `.claude/rules/architecture.md`,
 * `.claude/rules/security-invariants.md`, and `.claude/rules/code-style.md`
 * as runnable CI checks. When a test here fails, the diff has crossed a
 * documented boundary — either fix the violation, grandfather it in
 * `EXCEPTIONS` below with a `// <ratchet>` ticket-style comment, or
 * update the rule file if the boundary itself moved.
 *
 * Implementation note: all checks are file-text grep, not AST. That
 * keeps the suite zero-dependency and fast, but means false positives
 * on tricky regex are possible. The escape hatch is `EXCEPTIONS` — add
 * the offending file there and explain why.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files that are known to cross a boundary today and have been chosen
 * (with rationale) NOT to fix. Each entry should pin a follow-up:
 * either an issue number, a planned refactor, or "permanent" with the
 * reason. Future contributors should resist adding entries without a
 * written justification.
 *
 * Empty today — every category enumerated below is enforced without
 * exemptions. New violations must either fix or earn an entry here.
 */
const EXCEPTIONS: Record<string, string[]> = {};

async function readSourceFiles(pattern: string): Promise<Array<{ path: string; text: string }>> {
  const files: Array<{ path: string; text: string }> = [];
  for await (const abs of glob(pattern, { cwd: REPO_ROOT })) {
    const rel = relative(REPO_ROOT, join(REPO_ROOT, abs)).split(sep).join('/');
    files.push({ path: rel, text: readFileSync(join(REPO_ROOT, abs), 'utf8') });
  }
  return files;
}

function isExempt(category: keyof typeof EXCEPTIONS, path: string): boolean {
  return EXCEPTIONS[category]?.includes(path) ?? false;
}

describe('architecture: gh CLI Anti-Corruption Layer', () => {
  it('no command file invokes gh via raw execa (must go through github-* or ghJson)', async () => {
    // Match either string-literal `execa('gh',`/`execa("gh",` or a
    // variable named `ghPath` / `gh_path`. Anything else execa-shells
    // out (notably git) is fine — git has its own ACL via src/lib/git.ts.
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: Array<{ path: string; lines: string[] }> = [];
    for (const { path, text } of files) {
      if (isExempt('gh-bypass-execa', path)) continue;
      const lines = text.split('\n');
      const hits = lines
        .map((line, i) => ({ line: line.trim(), num: i + 1 }))
        .filter(({ line }) => /\bexeca\s*\(\s*(['"]gh['"]|ghPath|gh_path)\b/.test(line));
      if (hits.length > 0) {
        violations.push({ path, lines: hits.map(({ line, num }) => `:${num}  ${line}`) });
      }
    }
    if (violations.length > 0) {
      const msg = violations.map(v => `${v.path}\n  ${v.lines.join('\n  ')}`).join('\n');
      expect.fail(
        `Found raw \`execa('gh', ...)\` calls in command files. Route through one of\n` +
        `the github-* facades (createRepo / setRepoVisibility / enablePages / etc.) or\n` +
        `import { ghJson } from '../lib/gh-retry.js' for ad-hoc API calls.\n` +
        `If a follow-up is genuinely required, add the file path to\n` +
        `EXCEPTIONS['gh-bypass-execa'] in tests/architecture.test.ts with a reason.\n\n` +
        `Violations:\n${msg}`,
      );
    }
  });

  it('no file outside src/lib/mcp.ts spawns `claude mcp` via execa', async () => {
    const files = await readSourceFiles('src/**/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      if (path === 'src/lib/mcp.ts') continue;
      // Match: execa(<anything>, [..., 'mcp', ...]) where <anything>
      // could be 'claude', a variable named claudePath, etc.
      // Conservative pattern — match the literal `'mcp'` arg in an
      // execa call and let the test fail loudly if it's a false positive.
      if (/\bexeca\s*\([^)]*\[\s*['"]mcp['"]/.test(text)) {
        violations.push(path);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('architecture: ESM-only invariant', () => {
  it('no source or bin file imports from child_process', async () => {
    const files = [
      ...(await readSourceFiles('src/**/*.ts')),
      ...(await readSourceFiles('bin/**/*.ts')),
    ];
    const violations: string[] = [];
    for (const { path, text } of files) {
      if (/from\s+['"]node:child_process['"]/.test(text) || /from\s+['"]child_process['"]/.test(text)) {
        violations.push(path);
      }
    }
    // tests/lib/launcher-integration.test.ts is intentionally exempt:
    // it spawns the launcher template as a real Node process for end-
    // to-end SHA-256 self-verification, which requires raw spawn().
    // That file lives under tests/ and is not in this glob.
    expect(violations).toEqual([]);
  });
});

describe('architecture: registry file ownership', () => {
  it('only registry.ts and platform.ts reference claudeJsonPath()', async () => {
    const files = await readSourceFiles('src/**/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      if (path === 'src/lib/registry.ts' || path === 'src/lib/platform.ts') continue;
      if (isExempt('claudeJsonPath-outside-registry', path)) continue;
      if (/\bclaudeJsonPath\b/.test(text)) {
        violations.push(path);
      }
    }
    if (violations.length > 0) {
      expect.fail(
        `Found claudeJsonPath() references outside src/lib/registry.ts and src/lib/platform.ts.\n` +
        `~/.claude.json reads/writes belong in registry.ts so a future schema/format change\n` +
        `is one edit, not many. If a follow-up is required, add the file to\n` +
        `EXCEPTIONS['claudeJsonPath-outside-registry'] in tests/architecture.test.ts.\n\n` +
        `Violations: ${violations.join(', ')}`,
      );
    }
  });
});

describe('architecture: command module shape', () => {
  it('every src/commands/*.ts exports an async function run(...)', async () => {
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      // The contract per code-style.md and the CommandModule sentinel
      // type: each command file exports a top-level `async function run`.
      // We accept either a top-level `export async function run(`
      // declaration or a `export const run = async (...) =>` form.
      const hasFunction = /export\s+async\s+function\s+run\s*\(/.test(text);
      const hasArrow = /export\s+const\s+run\s*=\s*async\s*\(/.test(text);
      if (!hasFunction && !hasArrow) {
        violations.push(path);
      }
    }
    if (violations.length > 0) {
      expect.fail(
        `Files under src/commands/ without an exported \`async function run(...)\`:\n` +
        `  ${violations.join('\n  ')}\n` +
        `Per code-style.md, every command module must satisfy the CommandModule contract.`,
      );
    }
  });

  it('command files include the CommandModule sentinel type-check', async () => {
    const files = await readSourceFiles('src/commands/*.ts');
    const violations: string[] = [];
    for (const { path, text } of files) {
      // The sentinel `const _module: CommandModule<...> = { run };`
      // exists so a drifted run() signature fails compile, not at
      // runtime. Skip files where the module-level declaration is
      // intentional (today: none — every command has it).
      if (!/const\s+_module\s*:\s*CommandModule/.test(text)) {
        violations.push(basename(path));
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('architecture: bootstrap gate is wired', () => {
  it('bin/vaultkit.ts:wrap() applies gateOrSkip before running the command handler', async () => {
    const text = readFileSync(join(REPO_ROOT, 'bin/vaultkit.ts'), 'utf8');
    // The gate must be invoked from inside wrap() — assert both the
    // import and a top-level call exist. Catches the regression where
    // someone removes the gate call but leaves the import (or vice versa).
    expect(text, 'bin/vaultkit.ts is not importing gateOrSkip from prereqs').toMatch(
      /import\s+\{[^}]*\bgateOrSkip\b[^}]*\}\s+from\s+['"]\.\.\/src\/lib\/prereqs\.js['"]/,
    );
    // Match a non-commented line: line-start, optional whitespace, then
    // `await gateOrSkip(commandName, ...)`. The `^\s*await` anchor is
    // important — without it, a commented-out `// await gateOrSkip(...)`
    // would still match and the regression would slip through.
    expect(text, 'bin/vaultkit.ts is not calling gateOrSkip(commandName, ...) in an active line').toMatch(
      /^\s*await\s+gateOrSkip\s*\(\s*commandName\s*,/m,
    );
  });

  it('every src/commands/*.ts file declares its gate posture in tests/bootstrap-gate.test.ts', async () => {
    // Self-maintaining check: a new command added via /add-command must
    // appear in either COMMANDS_THAT_MUST_BE_GATED or BYPASS in the
    // bootstrap-gate test. Otherwise this fitness function fails and
    // points the contributor at the test file to declare the posture.
    const commandFiles = await readSourceFiles('src/commands/*.ts');
    const commandNames = commandFiles.map(f => basename(f.path).replace(/\.ts$/, ''));
    const gateTestText = readFileSync(join(REPO_ROOT, 'tests/bootstrap-gate.test.ts'), 'utf8');
    const undeclared: string[] = [];
    for (const name of commandNames) {
      // Match the command name as a quoted literal anywhere in the file —
      // the lists currently use single quotes, but accept double quotes
      // and backticks too in case future formatting changes.
      const literal = new RegExp(`['"\`]${name}['"\`]`);
      if (!literal.test(gateTestText)) {
        undeclared.push(name);
      }
    }
    if (undeclared.length > 0) {
      expect.fail(
        `Commands missing gate-posture declaration in tests/bootstrap-gate.test.ts:\n` +
        `  ${undeclared.join(', ')}\n\n` +
        `Each new command must appear in either COMMANDS_THAT_MUST_BE_GATED (the\n` +
        `default — gate fires when prereqs are missing) or BYPASS (rare — only for\n` +
        `setup and doctor today). The /add-command skill should remind you, but\n` +
        `this fitness function is the backstop.`,
      );
    }
  });
});
