import { describe, it, expect, beforeEach } from 'vitest';
import {
  warmSource,
  grepSource,
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
