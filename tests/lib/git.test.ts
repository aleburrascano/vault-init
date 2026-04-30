import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { init, add, commit, push, pull, getStatus, archiveZip } from '../../src/lib/git.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-git-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function makeRepo(dir: string): Promise<void> {
  await execa('git', ['init', '-b', 'main', dir]);
  await execa('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  await execa('git', ['-C', dir, 'config', 'user.name', 'Test']);
}

async function makeCommit(dir: string, filename: string = 'file.txt', content: string = 'hello'): Promise<void> {
  writeFileSync(join(dir, filename), content);
  await execa('git', ['-C', dir, 'add', '.']);
  await execa('git', ['-C', dir, 'commit', '-m', 'test commit']);
}

describe('init', () => {
  it('initializes a git repo', async () => {
    const repoDir = join(tmp, 'newrepo');
    mkdirSync(repoDir);
    await init(repoDir);
    const result = await execa('git', ['-C', repoDir, 'status'], { reject: false });
    expect(result.exitCode).toBe(0);
  });
});

describe('add + commit', () => {
  it('stages and commits files', async () => {
    const dir = join(tmp, 'repo');
    mkdirSync(dir);
    await makeRepo(dir);
    writeFileSync(join(dir, 'hello.txt'), 'world');
    await add(dir, ['hello.txt']);
    await commit(dir, 'test: add hello');
    const log = await execa('git', ['-C', dir, 'log', '--oneline'], { reject: false });
    expect(String(log.stdout)).toContain('test: add hello');
  });

  it('stages all files when given "."', async () => {
    const dir = join(tmp, 'repo');
    mkdirSync(dir);
    await makeRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    await add(dir, '.');
    await commit(dir, 'add all');
    const log = await execa('git', ['-C', dir, 'log', '--oneline']);
    expect(String(log.stdout)).toContain('add all');
  });
});

describe('push', () => {
  it('returns success:true when pushing to a local bare remote', async () => {
    const bare = join(tmp, 'bare.git');
    const clone = join(tmp, 'clone');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, clone]);
    await execa('git', ['-C', clone, 'config', 'user.email', 'test@test.com']);
    await execa('git', ['-C', clone, 'config', 'user.name', 'Test']);
    await makeCommit(clone);
    const result = await push(clone);
    expect(result.success).toBe(true);
  });

  it('returns success:false when no remote configured', async () => {
    const dir = join(tmp, 'repo');
    mkdirSync(dir);
    await makeRepo(dir);
    await makeCommit(dir);
    const result = await push(dir);
    expect(result.success).toBe(false);
    expect(result.stderr).toBeTruthy();
  });
});

describe('pull', () => {
  it('returns upToDate:true when nothing to pull', async () => {
    const bare = join(tmp, 'bare.git');
    const clone = join(tmp, 'clone');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, clone]);
    await execa('git', ['-C', clone, 'config', 'user.email', 'test@test.com']);
    await execa('git', ['-C', clone, 'config', 'user.name', 'Test']);
    await makeCommit(clone);
    await execa('git', ['-C', clone, 'push', '-u', 'origin', 'main']);
    const result = await pull(clone);
    expect(result.success).toBe(true);
    expect(result.upToDate).toBe(true);
  });

  it('pulls new commits from remote', async () => {
    const bare = join(tmp, 'bare.git');
    const clone1 = join(tmp, 'clone1');
    const clone2 = join(tmp, 'clone2');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, clone1]);
    await execa('git', ['clone', bare, clone2]);
    for (const c of [clone1, clone2]) {
      await execa('git', ['-C', c, 'config', 'user.email', 'test@test.com']);
      await execa('git', ['-C', c, 'config', 'user.name', 'Test']);
    }
    await makeCommit(clone1);
    await execa('git', ['-C', clone1, 'push', '-u', 'origin', 'main']);
    await execa('git', ['-C', clone2, 'fetch']);
    const result = await pull(clone2);
    expect(result.success).toBe(true);
    expect(result.upToDate).toBe(false);
  });
});

describe('getStatus', () => {
  it('returns status for a clean repo with remote', async () => {
    const bare = join(tmp, 'bare.git');
    const clone = join(tmp, 'clone');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, clone]);
    await execa('git', ['-C', clone, 'config', 'user.email', 'test@test.com']);
    await execa('git', ['-C', clone, 'config', 'user.name', 'Test']);
    await makeCommit(clone);
    await execa('git', ['-C', clone, 'push', '-u', 'origin', 'main']);
    const status = await getStatus(clone);
    expect(status.branch).toBe('main');
    expect(status.dirty).toBe(false);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.remote).toContain('bare.git');
  });

  it('reports dirty when there are uncommitted changes', async () => {
    const dir = join(tmp, 'repo');
    mkdirSync(dir);
    await makeRepo(dir);
    await makeCommit(dir);
    writeFileSync(join(dir, 'dirty.txt'), 'change');
    const status = await getStatus(dir);
    expect(status.dirty).toBe(true);
  });
});

describe('archiveZip', () => {
  it('creates a zip file of HEAD', async () => {
    const dir = join(tmp, 'repo');
    mkdirSync(dir);
    await makeRepo(dir);
    await makeCommit(dir);
    const out = join(tmp, 'archive.zip');
    await archiveZip(dir, out);
    const stat = statSync(out);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('throws on a repo with no commits', async () => {
    const dir = join(tmp, 'empty');
    mkdirSync(dir);
    await makeRepo(dir);
    const out = join(tmp, 'out.zip');
    await expect(archiveZip(dir, out)).rejects.toThrow();
  }, 10000);
});

describe('getStatus — edge cases', () => {
  it('returns safe defaults on a non-git directory', async () => {
    const dir = join(tmp, 'notgit');
    mkdirSync(dir);
    const status = await getStatus(dir);
    expect(status.dirty).toBe(false);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.remote).toBeNull();
  });
});

describe('pull — conflict and failure', () => {
  it('returns success:false with stderr on diverged histories (ff-only)', async () => {
    const bare = join(tmp, 'bare.git');
    const c1 = join(tmp, 'c1');
    const c2 = join(tmp, 'c2');

    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, c1]);
    await execa('git', ['clone', bare, c2]);
    for (const c of [c1, c2]) {
      await execa('git', ['-C', c, 'config', 'user.email', 'test@test.com']);
      await execa('git', ['-C', c, 'config', 'user.name', 'Test']);
    }

    // c1 makes an initial commit and pushes
    writeFileSync(join(c1, 'file.txt'), 'line from c1');
    await execa('git', ['-C', c1, 'add', '.']);
    await execa('git', ['-C', c1, 'commit', '-m', 'c1 commit']);
    await execa('git', ['-C', c1, 'push', '-u', 'origin', 'main']);

    // c2 makes its own commit (diverges) without pulling first
    writeFileSync(join(c2, 'file.txt'), 'line from c2');
    await execa('git', ['-C', c2, 'add', '.']);
    await execa('git', ['-C', c2, 'commit', '-m', 'c2 commit']);
    await execa('git', ['-C', c2, 'fetch']);

    const result = await pull(c2);
    expect(result.success).toBe(false);
    expect(result.stderr).toBeTruthy();
  }, 15000);
});
