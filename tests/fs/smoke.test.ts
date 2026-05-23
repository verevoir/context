import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Smoke test: confirms `@verevoir/context/fs` actually wires
 * caching around real filesystem reads. Uses tmp dirs for
 * end-to-end behaviour rather than mocking the source. */

import { readFile, fs as fsAdapter } from '../../src/fs/index.js';
import { contextStore } from '../../src/index.js';

const ENV = { token: '', forkOrg: '' };
let root: string;

beforeEach(async () => {
  contextStore.clearAll();
  root = await fsPromises.mkdtemp(join(tmpdir(), 'context-fs-smoke-'));
});

afterEach(async () => {
  await fsPromises.rm(root, { recursive: true, force: true });
});

describe('@verevoir/context/fs', () => {
  it('exposes the SourceAdapter shape via the aggregate', () => {
    for (const m of [
      'readFile',
      'listFiles',
      'getRepoTree',
      'writeFile',
      'ensureBranch',
      'ensureFork',
      'openPullRequest',
      'getDefaultBranch',
    ]) {
      expect(typeof (fsAdapter as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });

  it('caches reads: changing the file underneath does not change the cached read', async () => {
    await fsPromises.writeFile(join(root, 'x.md'), 'first', 'utf8');

    const first = await readFile(ENV, root, 'x.md');
    expect(first.content).toBe('first');

    // Mutate the file directly. The cache served by /context/fs
    // does not re-read; subsequent reads see the cached value.
    await fsPromises.writeFile(join(root, 'x.md'), 'second', 'utf8');
    const second = await readFile(ENV, root, 'x.md');
    expect(second.content).toBe('first');
  });

  it('writeFile populates the cache so reads see what was written', async () => {
    await fsAdapter.writeFile(ENV, root, 'new.md', 'just-written', 'main', 'ignored');
    const r = await readFile(ENV, root, 'new.md', 'main');
    expect(r.content).toBe('just-written');
    // Underlying file actually has the content.
    const onDisk = await fsPromises.readFile(join(root, 'new.md'), 'utf8');
    expect(onDisk).toBe('just-written');
  });
});
