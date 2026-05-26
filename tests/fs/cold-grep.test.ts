import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { grepSource } from '../../src/fs/index.js';
import { createContextStore, grep, type ContextStore } from '../../src/index.js';

/** Cold grep fans out to the filesystem (unlike the pure `grep`,
 * which only sees content already pulled into the store): it walks
 * the whole tree, warms the store with every text file, then greps
 * the warm cache. The walk + reads + match are all owned in Node —
 * no external scanner — so these run against real tmp trees with no
 * conditional skips. */

const ENV = { token: '', forkOrg: '' };
const NUL = String.fromCharCode(0);

let root: string;
let store: ContextStore;

beforeEach(async () => {
  root = await fsPromises.mkdtemp(join(tmpdir(), 'context-cold-grep-'));
  store = createContextStore();
});

afterEach(async () => {
  await fsPromises.rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await fsPromises.mkdir(join(abs, '..'), { recursive: true });
  await fsPromises.writeFile(abs, content, 'utf8');
}

const key = (itemId: string) => ({ sourceId: root, version: '', itemId });

describe('grepSource (cold whole-tree grep)', () => {
  it('finds matches across files never read, and warms the store as it scans', async () => {
    await write('a.ts', 'first\nhas needle here\nthird');
    await write('sub/c.ts', 'another needle line');
    await write('b.ts', 'no match in this one');

    expect(store.getContent(key('a.ts'))).toBeUndefined(); // cold

    const hits = await grepSource(ENV, root, 'needle', { store });

    expect(hits.map((h) => `${h.itemId}:${h.lineNumber}`).sort()).toEqual(['a.ts:2', 'sub/c.ts:1']);
    expect(hits.find((h) => h.itemId === 'a.ts')?.line).toBe('has needle here');

    // Every text file is now warm — including the non-matching one…
    expect(store.getContent(key('a.ts'))).toBe('first\nhas needle here\nthird');
    expect(store.getContent(key('b.ts'))).toBe('no match in this one');
    // …so a subsequent *pure* grep over the same store reproduces hits
    // with zero further filesystem access.
    const warm = grep('needle', { sources: [{ sourceId: root, version: '' }] }, { store });
    expect(warm.map((h) => h.itemId).sort()).toEqual(['a.ts', 'sub/c.ts']);
  });

  it('honours maxResults and ignoreCase, and supplies context lines', async () => {
    await write('x.ts', ['NEEDLE one', 'mid', 'needle two', 'needle three'].join('\n'));

    const hits = await grepSource(ENV, root, 'needle', {
      store,
      ignoreCase: true,
      maxResults: 2,
      contextLines: 1,
    });

    expect(hits).toHaveLength(2);
    expect(hits[0].lineNumber).toBe(1); // case-insensitive matched "NEEDLE one"
    expect(hits[0].contextAfter).toEqual(['mid']);
  });

  it('skips vendored dirs (node_modules) — neither matched nor warmed', async () => {
    await write('src/app.ts', 'real needle');
    await write('node_modules/dep/index.ts', 'vendored needle should be ignored');

    const hits = await grepSource(ENV, root, 'needle', { store });

    expect(hits.map((h) => h.itemId)).toEqual(['src/app.ts']);
    expect(store.getContent(key('node_modules/dep/index.ts'))).toBeUndefined();
  });

  it('skips binary files (NUL byte) — neither matched nor warmed', async () => {
    await write('text.ts', 'needle in text');
    await write('blob.dat', `needle${NUL}then binary`);

    const hits = await grepSource(ENV, root, 'needle', { store });

    expect(hits.map((h) => h.itemId)).toEqual(['text.ts']);
    expect(store.getContent(key('blob.dat'))).toBeUndefined();
  });

  it('skips oversized files', async () => {
    await write('small.ts', 'needle small');
    await write('huge.txt', `needle ${'x'.repeat(1_600_000)}`);

    const hits = await grepSource(ENV, root, 'needle', { store });

    expect(hits.map((h) => h.itemId)).toEqual(['small.ts']);
    expect(store.getContent(key('huge.txt'))).toBeUndefined();
  });

  it('returns [] when nothing matches', async () => {
    await write('a.ts', 'nothing relevant here');
    await expect(grepSource(ENV, root, 'absent', { store })).resolves.toEqual([]);
  });
});
