import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAllVaults } from '../../src/lib/registry.js';

let tmp;
beforeEach(() => {
  tmp = join(tmpdir(), `vk-test-${Date.now()}`);
  mkdirSync(tmp);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('getAllVaults', () => {
  it('returns empty array when config file does not exist', async () => {
    const result = await getAllVaults(join(tmp, '.claude.json'));
    expect(result).toEqual([]);
  });
});
