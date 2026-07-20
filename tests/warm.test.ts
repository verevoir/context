import { describe, it, expect, beforeEach } from 'vitest';
import {
  warmSource,
  grepSource,
  grep,
  createContextStore,
  DEFAULT_WARM_EXCLUDE,
  type ContextStore,
} from '../src/index.js';
import type { SourceAdapter, ReadFileResult, RepoTree, TreeEntry } from '@verevoir/sources';

/** `warmSource` is the one cache-warming mechanism for every file
 * source — what varies per source is only how files are enumerated +
 * read, which the SourceAdapter abstracts (`getRepoTree` + `readFile`).
 * These tests drive it with a mock adapter, so they assert the
 * *mechanism* (skip binary/oversized, ref threading, bounded
 * concurrency) independent of any real source. */

const NUL = String.fromCharCode(0);
const URL = 'https://github.com/acme/widgets';
const ENV = { token: '', forkOrg: '' };

interface FileFixture {
  content: string;
  size?: number;
}

function mockAdapter(
  files: Record<string, FileFixture>,
  onRead?: (path: string) => Promise<void>
): SourceAdapter {
  const unused = () => {
    throw new Error('not exercised by warmSource');
  };
  const adapter = {
    async getRepoTree(): Promise<RepoTree> {
      const entries: TreeEntry[] = Object.entries(files).map(([path, f]) => ({
        path,
        type: 'blob',
        size: f.size ?? f.content.length,
        sha: '',
      }));
      return { entries, truncated: false };
    },
    async readFile(_e: unknown, _u: string, path: string): Promise<ReadFileResult> {
      if (onRead) await onRead(path);
      const f = files[path];
      if (!f) {
        const err = new Error('not_found') as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      return { content: f.content, sha: `sha-${path}` };
    },
    listFiles: unused,
    getDefaultBranch: unused,
    isFresh: unused,
    writeFile: unused,
    ensureBranch: unused,
    ensureFork: unused,
    openPullRequest: unused,
  };
  return adapter as unknown as SourceAdapter;
}

let store: ContextStore;
beforeEach(() => {
  store = createContextStore();
});

describe('warmSource (generic, adapter-driven)', () => {
  it('warms text blobs, skips binary + oversized, then grep finds matches', async () => {
    const adapter = mockAdapter({
      'a.ts': { content: 'has needle here' },
      'big.ts': { content: `needle ${'x'.repeat(10)}`, size: 2_000_000 }, // size over cap
      'blob.bin': { content: `needle${NUL}binary` },
      'b.ts': { content: 'no match in this one' },
    });

    const hits = await grepSource(adapter, ENV, URL, 'needle', { store });

    expect(hits.map((h) => h.itemId)).toEqual(['a.ts']);
    expect(store.getContent({ sourceId: URL, version: '', itemId: 'a.ts' })).toBe(
      'has needle here'
    );
    // oversized + binary neither matched nor warmed
    expect(store.getContent({ sourceId: URL, version: '', itemId: 'big.ts' })).toBeUndefined();
    expect(store.getContent({ sourceId: URL, version: '', itemId: 'blob.bin' })).toBeUndefined();
  });

  it('threads ref into the cache key and the search scope', async () => {
    const adapter = mockAdapter({ 'x.ts': { content: 'find ZZ here' } });

    const hits = await grepSource(adapter, ENV, URL, 'ZZ', { store, ref: 'main' });

    expect(hits).toHaveLength(1);
    expect(store.getContent({ sourceId: URL, version: 'main', itemId: 'x.ts' })).toBe(
      'find ZZ here'
    );
    // not under the default-version key
    expect(store.getContent({ sourceId: URL, version: '', itemId: 'x.ts' })).toBeUndefined();
  });

  it('bounds concurrent reads to `concurrency` (matters for remote sources)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const files: Record<string, FileFixture> = {};
    for (let i = 0; i < 8; i++) files[`f${i}.ts`] = { content: 'x' };

    const adapter = mockAdapter(files, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });

    await warmSource(adapter, ENV, URL, { store, concurrency: 3 });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // genuinely overlapped, not serial
  });

  it('skips dependency / VCS / tool-output dirs by default, keeps committed output', async () => {
    const adapter = mockAdapter({
      'src/a.ts': { content: 'needle in source' },
      'node_modules/dep/index.js': { content: 'needle in a dependency' },
      'coverage/lcov-report/index.html': { content: 'needle in coverage' },
      '.git/COMMIT_EDITMSG': { content: 'needle in git' },
      'dist/a.js': { content: 'needle in committed dist' },
    });

    const hits = await grepSource(adapter, ENV, URL, 'needle', { store });

    // node_modules / coverage / .git skipped; source + committed dist kept
    expect(hits.map((h) => h.itemId).sort()).toEqual(['dist/a.js', 'src/a.ts']);
    expect(
      store.getContent({ sourceId: URL, version: '', itemId: 'coverage/lcov-report/index.html' })
    ).toBeUndefined();
  });

  it('exclude globs are overridable — extend the default, or disable with []', async () => {
    const files = {
      'src/a.ts': { content: 'needle' },
      'generated/x.ts': { content: 'needle' },
    };

    const extended = createContextStore();
    const extendedHits = await grepSource(mockAdapter(files), ENV, URL, 'needle', {
      store: extended,
      exclude: [...DEFAULT_WARM_EXCLUDE, '**/generated/**'],
    });
    expect(extendedHits.map((h) => h.itemId)).toEqual(['src/a.ts']);

    const all = createContextStore();
    const allHits = await grepSource(
      mockAdapter({ 'node_modules/d.js': { content: 'needle' } }),
      ENV,
      URL,
      'needle',
      { store: all, exclude: [] }
    );
    expect(allHits.map((h) => h.itemId)).toEqual(['node_modules/d.js']);
  });

  it('include narrows the positive scope (cross-segment globs)', async () => {
    const store2 = createContextStore();
    const hits = await grepSource(
      mockAdapter({
        'src/a.ts': { content: 'needle' },
        'src/b.md': { content: 'needle' },
        'src/deep/c.ts': { content: 'needle' },
      }),
      ENV,
      URL,
      'needle',
      { store: store2, include: ['**/*.ts'] }
    );
    expect(hits.map((h) => h.itemId).sort()).toEqual(['src/a.ts', 'src/deep/c.ts']);
  });
});

describe('prefix-scoped warming', () => {
  const files = {
    'src/a.ts': { content: 'alpha' },
    'src/deep/b.ts': { content: 'beta' },
    'srcx/d.ts': { content: 'delta' }, // shares the string prefix, not the segment
    'docs/c.md': { content: 'gamma' },
  };

  it('warms only the subtree under the prefix (segment-aware)', async () => {
    await warmSource(mockAdapter(files), ENV, URL, { store, prefix: 'src' });

    expect(store.listIndexedItems(URL, '')).toEqual(['src/a.ts', 'src/deep/b.ts']);
  });

  it("normalises the prefix — 'dir' and 'dir/' select the same subtree", async () => {
    await warmSource(mockAdapter(files), ENV, URL, { store, prefix: 'src/' });

    expect(store.listIndexedItems(URL, '')).toEqual(['src/a.ts', 'src/deep/b.ts']);
  });

  it('grepSource passes the prefix through — files outside it are never read', async () => {
    const reads: string[] = [];
    const hits = await grepSource(
      mockAdapter(files, async (path) => {
        reads.push(path);
      }),
      ENV,
      URL,
      'a', // matches alpha, beta, delta, gamma
      { store, prefix: 'src' }
    );

    expect(hits.map((h) => h.itemId)).toEqual(['src/a.ts', 'src/deep/b.ts']);
    expect(reads.sort()).toEqual(['src/a.ts', 'src/deep/b.ts']);
  });
});

/** The lazy cold-grep contract: `grepSource` must return exactly what
 * whole-tree `warmSource` + pure `grep` return for the same options —
 * early termination is allowed to change how much gets *read*, never
 * what gets *returned*. These tests pin both halves: result equality
 * against the eager path, and the read-count saving (the observable
 * point of the laziness). */
describe('grepSource — early-terminating lazy path', () => {
  /** Run the eager reference path (whole-tree warm, then pure grep)
   * on an isolated store. */
  async function eagerGrep(
    files: Record<string, FileFixture>,
    pattern: string,
    options: { maxResults?: number; ignoreCase?: boolean; contextLines?: number } = {},
    prefix?: string
  ) {
    const eagerStore = createContextStore();
    await warmSource(mockAdapter(files), ENV, URL, { store: eagerStore, prefix });
    return grep(
      pattern,
      { sources: [{ sourceId: URL, version: '' }] },
      { ...options, store: eagerStore }
    );
  }

  it('returns identical hits to warm-whole-tree-then-grep (matches spread across tree order)', async () => {
    // Matches spread across the sorted order, several per file, and
    // reads completing out of order (later files resolve faster) to
    // exercise the read-ahead window's ordering discipline.
    const files: Record<string, FileFixture> = {};
    for (let i = 0; i < 12; i++) {
      const body = i % 3 === 0 ? `x\nneedle one\ny\nneedle two\nz` : 'no match here';
      files[`f${String(i).padStart(2, '0')}.ts`] = { content: body };
    }
    const delays = new Map(Object.keys(files).map((p, i, all) => [p, (all.length - i) * 2]));

    const lazy = await grepSource(
      mockAdapter(files, (path) => new Promise((r) => setTimeout(r, delays.get(path)))),
      ENV,
      URL,
      'needle',
      { store, maxResults: 5 }
    );

    expect(lazy).toEqual(await eagerGrep(files, 'needle', { maxResults: 5 }));
    expect(lazy).toHaveLength(5);
  });

  it('stops scheduling reads once the result is settled — reads fewer files than the tree holds', async () => {
    const files: Record<string, FileFixture> = {};
    for (let i = 0; i < 20; i++) {
      files[`f${String(i).padStart(2, '0')}.ts`] = {
        content: i < 2 ? 'has needle' : 'also needle here',
      };
    }
    const reads: string[] = [];
    const hits = await grepSource(
      mockAdapter(files, async (path) => {
        reads.push(path);
      }),
      ENV,
      URL,
      'needle',
      { store, maxResults: 2, concurrency: 2 }
    );

    expect(hits.map((h) => h.itemId)).toEqual(['f00.ts', 'f01.ts']);
    // The first two files settle the result; the read-ahead window can
    // overshoot by at most `concurrency` already-claimed reads.
    expect(reads.length).toBeLessThanOrEqual(2 + 2);
    expect(reads.length).toBeLessThan(20);
  });

  it('maxResults boundary — exactly at the total, and one past it', async () => {
    const files = {
      'a.ts': { content: 'needle' },
      'b.ts': { content: 'needle' },
      'c.ts': { content: 'needle' },
      'd.ts': { content: 'nothing' },
    };

    const atStore = createContextStore();
    const at = await grepSource(mockAdapter(files), ENV, URL, 'needle', {
      store: atStore,
      maxResults: 3,
    });
    expect(at.map((h) => h.itemId)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(at).toEqual(await eagerGrep(files, 'needle', { maxResults: 3 }));

    const pastStore = createContextStore();
    const past = await grepSource(mockAdapter(files), ENV, URL, 'needle', {
      store: pastStore,
      maxResults: 4,
    });
    expect(past.map((h) => h.itemId)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(past).toEqual(await eagerGrep(files, 'needle', { maxResults: 4 }));
  });

  it('already-warm entries serve from cache and are not re-read', async () => {
    store.setContent({ sourceId: URL, version: '', itemId: 'a.ts' }, 'cached needle', 'sha-old');
    const reads: string[] = [];
    const hits = await grepSource(
      mockAdapter(
        { 'a.ts': { content: 'needle from source' }, 'b.ts': { content: 'needle too' } },
        async (path) => {
          reads.push(path);
        }
      ),
      ENV,
      URL,
      'needle',
      { store }
    );

    expect(reads).toEqual(['b.ts']);
    expect(hits.find((h) => h.itemId === 'a.ts')?.line).toBe('cached needle');
  });

  it('searches cached items outside the tree, same as the eager path would', async () => {
    // grep over a warmed store scans every indexed item under the
    // (source, version) — including ones the current tree no longer
    // enumerates. The lazy path must not lose them.
    store.setContent({ sourceId: URL, version: '', itemId: 'gone/z.ts' }, 'needle z', 'sha-z');

    const hits = await grepSource(
      mockAdapter({ 'a.ts': { content: 'needle a' } }),
      ENV,
      URL,
      'needle',
      { store }
    );

    expect(hits.map((h) => h.itemId)).toEqual(['a.ts', 'gone/z.ts']);
  });

  it('diminishes the budget across files — the cap can land mid-file, mid-order', async () => {
    // Three matches per file; a cap of 5 takes all of f0, then only
    // two of f1's three — the boundary the shared kernel's budget
    // argument exists for.
    const files: Record<string, FileFixture> = {
      'f0.ts': { content: 'needle\nneedle\nneedle' },
      'f1.ts': { content: 'needle\nneedle\nneedle' },
      'f2.ts': { content: 'needle\nneedle\nneedle' },
    };

    const lazy = await grepSource(mockAdapter(files), ENV, URL, 'needle', {
      store,
      maxResults: 5,
    });

    expect(lazy).toEqual(await eagerGrep(files, 'needle', { maxResults: 5 }));
    expect(lazy).toHaveLength(5);
    expect(lazy.map((h) => h.itemId)).toEqual(['f0.ts', 'f0.ts', 'f0.ts', 'f1.ts', 'f1.ts']);
  });

  it('threads ignoreCase end-to-end — needle lowering happens at the grepSource level too', async () => {
    const files: Record<string, FileFixture> = {
      'a.ts': { content: 'has NEEDLE here' },
      'b.ts': { content: 'has needle here' },
      'c.ts': { content: 'no match' },
    };

    const lazy = await grepSource(mockAdapter(files), ENV, URL, 'NeEdLe', {
      store,
      ignoreCase: true,
    });

    expect(lazy).toEqual(await eagerGrep(files, 'NeEdLe', { ignoreCase: true }));
    expect(lazy.map((h) => h.itemId)).toEqual(['a.ts', 'b.ts']);
  });

  it('threads contextLines end-to-end', async () => {
    const files: Record<string, FileFixture> = {
      'a.ts': { content: 'one\ntwo\nneedle\nfour\nfive' },
    };

    const lazy = await grepSource(mockAdapter(files), ENV, URL, 'needle', {
      store,
      contextLines: 1,
    });

    expect(lazy).toEqual(await eagerGrep(files, 'needle', { contextLines: 1 }));
    expect(lazy[0].contextBefore).toEqual(['two']);
    expect(lazy[0].contextAfter).toEqual(['four']);
  });

  it('bounds concurrent reads to `concurrency`, like warmSource', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const files: Record<string, FileFixture> = {};
    // no matches anywhere, so the lazy pass cannot settle early and
    // must stream the whole tree through the read-ahead window
    for (let i = 0; i < 8; i++) files[`f${i}.ts`] = { content: 'x' };

    await grepSource(
      mockAdapter(files, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }),
      ENV,
      URL,
      'needle',
      { store, concurrency: 3 }
    );

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // genuinely overlapped, not serial
  });

  it('drops a file whose read fails and still settles past it', async () => {
    // f00 (first in order) errors; settlement must advance past the
    // failure and the erroring file must contribute nothing.
    const files: Record<string, FileFixture> = {
      'f00.ts': { content: 'has needle but will error' },
      'f01.ts': { content: 'has needle' },
      'f02.ts': { content: 'also has needle' },
    };

    const hits = await grepSource(
      mockAdapter(files, async (path) => {
        if (path === 'f00.ts') throw new Error('read exploded');
      }),
      ENV,
      URL,
      'needle',
      { store, maxResults: 1 }
    );

    expect(hits.map((h) => h.itemId)).toEqual(['f01.ts']);
    expect(store.getContent({ sourceId: URL, version: '', itemId: 'f00.ts' })).toBeUndefined();
  });

  it('with a prefix, still searches pre-cached items outside it (contract: prefix-scoped warm + grep)', async () => {
    // A prefix scopes what gets WARMED; grep then scans the whole
    // store — so an already-cached item outside the prefix is
    // searched, exactly as prefix-scoped warmSource + grep would.
    store.setContent({ sourceId: URL, version: '', itemId: 'docs/z.ts' }, 'needle z', 'sha-z');

    const hits = await grepSource(
      mockAdapter({
        'src/a.ts': { content: 'needle a' },
        'lib/b.ts': { content: 'needle b (outside prefix, not cached — must NOT appear)' },
      }),
      ENV,
      URL,
      'needle',
      { store, prefix: 'src' }
    );

    expect(hits.map((h) => h.itemId)).toEqual(['docs/z.ts', 'src/a.ts']);
  });

  it('holds the equal-hits contract under prefix + maxResults together', async () => {
    // Matches inside and outside the prefix; the comparison case is a
    // prefix-scoped warm + grep, and the cap must bind identically.
    const files: Record<string, FileFixture> = {
      'lib/x.ts': { content: 'needle outside' },
      'src/a.ts': { content: 'needle\nneedle' },
      'src/b.ts': { content: 'needle\nneedle' },
      'src/c.ts': { content: 'needle' },
    };

    const lazy = await grepSource(mockAdapter(files), ENV, URL, 'needle', {
      store,
      prefix: 'src',
      maxResults: 3,
    });

    expect(lazy).toEqual(await eagerGrep(files, 'needle', { maxResults: 3 }, 'src'));
    expect(lazy).toHaveLength(3);
    expect(lazy.every((h) => h.itemId.startsWith('src/'))).toBe(true);
  });

  it('normalises the prefix at the grepSource call site — src and src/ scope identically', async () => {
    const files: Record<string, FileFixture> = {
      'src/a.ts': { content: 'needle a' },
      'srcx/b.ts': { content: 'needle b' },
    };

    const bare = await grepSource(mockAdapter(files), ENV, URL, 'needle', {
      store: createContextStore(),
      prefix: 'src',
    });
    const slashed = await grepSource(mockAdapter(files), ENV, URL, 'needle', {
      store: createContextStore(),
      prefix: 'src/',
    });

    expect(bare).toEqual(slashed);
    expect(bare.map((h) => h.itemId)).toEqual(['src/a.ts']); // srcx/ never covered
  });

  it('returns an empty array when nothing in a fully-streamed tree matches', async () => {
    const files: Record<string, FileFixture> = {};
    for (let i = 0; i < 6; i++) files[`f${i}.ts`] = { content: 'nothing to see' };

    const hits = await grepSource(mockAdapter(files), ENV, URL, 'needle', { store });

    expect(hits).toEqual([]);
  });
});
