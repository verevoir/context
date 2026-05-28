import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  SourceAdapter,
  SourceEnv,
  ReadFileResult,
  DirEntry,
  RepoTree,
} from '@verevoir/sources';
import { wrapWithCache, contextStore, createContextStore } from '../src/index.js';

const ENV: SourceEnv = { token: 't', forkOrg: 'o' };
const URL = 'https://stub.test/owner/repo';

/** Build a stub adapter with every method as a vi.fn. Tests configure
 * the methods they exercise; the rest are present but unused. */
function makeStub(): { adapter: SourceAdapter; methods: Record<string, ReturnType<typeof vi.fn>> } {
  const methods = {
    readFile: vi.fn<readFileFn>(),
    listFiles: vi.fn<listFilesFn>(),
    getRepoTree: vi.fn<getRepoTreeFn>(),
    isFresh: vi.fn<isFreshFn>(),
    writeFile: vi.fn(),
    ensureBranch: vi.fn(),
    ensureFork: vi.fn(),
    openPullRequest: vi.fn(),
    getDefaultBranch: vi.fn(),
  };
  const adapter: SourceAdapter = {
    readFile: methods.readFile,
    listFiles: methods.listFiles,
    getRepoTree: methods.getRepoTree,
    isFresh: methods.isFresh,
    writeFile: methods.writeFile,
    ensureBranch: methods.ensureBranch,
    ensureFork: methods.ensureFork,
    openPullRequest: methods.openPullRequest,
    getDefaultBranch: methods.getDefaultBranch,
  } as SourceAdapter;
  return { adapter, methods };
}

type readFileFn = (
  env: SourceEnv,
  url: string,
  path: string,
  ref?: string
) => Promise<ReadFileResult>;
type listFilesFn = (
  env: SourceEnv,
  url: string,
  prefix: string,
  ref?: string
) => Promise<DirEntry[]>;
type getRepoTreeFn = (env: SourceEnv, url: string, ref?: string) => Promise<RepoTree>;
type isFreshFn = (
  env: SourceEnv,
  url: string,
  path: string,
  version: string,
  ref?: string
) => Promise<boolean>;

beforeEach(() => {
  contextStore.clearAll();
});

describe('wrapWithCache — readFile', () => {
  it('fetches via the source on first call and populates the cache', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile.mockResolvedValue({ content: 'hello', sha: 'sha-1' });
    const cached = wrapWithCache(adapter);

    const result = await cached.readFile(ENV, URL, 'README.md');

    expect(result.content).toBe('hello');
    expect(result.sha).toBe('sha-1');
    expect(methods.readFile).toHaveBeenCalledTimes(1);
    expect(
      contextStore.getContent({
        sourceId: URL,
        version: '',
        itemId: 'README.md',
      })
    ).toBe('hello');
  });

  it('serves cache on second call without hitting the source', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile.mockResolvedValue({ content: 'body', sha: 'sha' });
    const cached = wrapWithCache(adapter);

    await cached.readFile(ENV, URL, 'a.md');
    const second = await cached.readFile(ENV, URL, 'a.md');

    expect(second.content).toBe('body');
    expect(methods.readFile).toHaveBeenCalledTimes(1);
  });

  it('preserves the source-returned sha on cache hits (so callers can use it as a freshness handle)', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile.mockResolvedValue({ content: 'x', sha: 'real-sha' });
    const cached = wrapWithCache(adapter);

    await cached.readFile(ENV, URL, 'x.md');
    const second = await cached.readFile(ENV, URL, 'x.md');

    expect(second.sha).toBe('real-sha');
  });

  it('honours the ref param — different refs are separate cache slots', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile
      .mockResolvedValueOnce({ content: 'main-body', sha: 'sha-m' })
      .mockResolvedValueOnce({ content: 'branch-body', sha: 'sha-b' });
    const cached = wrapWithCache(adapter);

    const a = await cached.readFile(ENV, URL, 'x.md');
    const b = await cached.readFile(ENV, URL, 'x.md', 'feature/x');

    expect(a.content).toBe('main-body');
    expect(b.content).toBe('branch-body');
    expect(methods.readFile).toHaveBeenCalledTimes(2);
  });

  it('propagates errors and does not populate the cache on failure', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile.mockRejectedValue(new Error('upstream 404'));
    const cached = wrapWithCache(adapter);

    await expect(cached.readFile(ENV, URL, 'missing.md')).rejects.toThrow('upstream 404');
    expect(
      contextStore.getContent({
        sourceId: URL,
        version: '',
        itemId: 'missing.md',
      })
    ).toBeUndefined();
  });
});

describe('wrapWithCache — freshness validation (TTL gate)', () => {
  it('serves cache without calling isFresh while inside the TTL', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile.mockResolvedValue({ content: 'body', sha: 'sha-1' });
    let clock = 1_000_000;
    const cached = wrapWithCache(adapter, {
      store: createContextStore(),
      validationTtlMs: 10_000,
      now: () => clock,
    });

    await cached.readFile(ENV, URL, 'a.md');
    clock += 5_000; // still inside the 10s TTL
    const second = await cached.readFile(ENV, URL, 'a.md');

    expect(second.content).toBe('body');
    expect(methods.readFile).toHaveBeenCalledTimes(1);
    expect(methods.isFresh).not.toHaveBeenCalled();
  });

  it('calls isFresh after the TTL elapses; on true, serves cache and touches cachedAt', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile.mockResolvedValue({ content: 'body', sha: 'sha-1' });
    methods.isFresh.mockResolvedValue(true);
    let clock = 1_000_000;
    const cached = wrapWithCache(adapter, {
      store: createContextStore(),
      validationTtlMs: 10_000,
      now: () => clock,
    });

    await cached.readFile(ENV, URL, 'a.md');
    clock += 15_000; // past TTL
    const second = await cached.readFile(ENV, URL, 'a.md');

    expect(second.content).toBe('body');
    expect(methods.isFresh).toHaveBeenCalledTimes(1);
    expect(methods.isFresh).toHaveBeenCalledWith(ENV, URL, 'a.md', 'sha-1', undefined);
    expect(methods.readFile).toHaveBeenCalledTimes(1); // not re-fetched

    // The successful isFresh check should have touched cachedAt —
    // the next read within the new TTL window should not re-check.
    clock += 5_000;
    await cached.readFile(ENV, URL, 'a.md');
    expect(methods.isFresh).toHaveBeenCalledTimes(1); // still 1
  });

  it('calls isFresh after the TTL elapses; on false, re-fetches from the source', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile
      .mockResolvedValueOnce({ content: 'old', sha: 'sha-old' })
      .mockResolvedValueOnce({ content: 'new', sha: 'sha-new' });
    methods.isFresh.mockResolvedValue(false);
    let clock = 1_000_000;
    const cached = wrapWithCache(adapter, {
      store: createContextStore(),
      validationTtlMs: 10_000,
      now: () => clock,
    });

    await cached.readFile(ENV, URL, 'a.md');
    clock += 15_000;
    const second = await cached.readFile(ENV, URL, 'a.md');

    expect(second.content).toBe('new');
    expect(second.sha).toBe('sha-new');
    expect(methods.isFresh).toHaveBeenCalledTimes(1);
    expect(methods.readFile).toHaveBeenCalledTimes(2);
  });

  it('validationTtlMs = 0 means validate on every cache hit', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile.mockResolvedValue({ content: 'x', sha: 's' });
    methods.isFresh.mockResolvedValue(true);
    const cached = wrapWithCache(adapter, {
      store: createContextStore(),
      validationTtlMs: 0,
    });

    await cached.readFile(ENV, URL, 'a.md');
    await cached.readFile(ENV, URL, 'a.md');
    await cached.readFile(ENV, URL, 'a.md');

    expect(methods.isFresh).toHaveBeenCalledTimes(2); // every hit after the first
    expect(methods.readFile).toHaveBeenCalledTimes(1);
  });

  it('validationTtlMs = Infinity means never validate (pre-isFresh behaviour)', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile.mockResolvedValue({ content: 'x', sha: 's' });
    let clock = 1_000_000;
    const cached = wrapWithCache(adapter, {
      store: createContextStore(),
      validationTtlMs: Infinity,
      now: () => clock,
    });

    await cached.readFile(ENV, URL, 'a.md');
    clock += 365 * 24 * 60 * 60 * 1000; // one year later
    await cached.readFile(ENV, URL, 'a.md');

    expect(methods.isFresh).not.toHaveBeenCalled();
    expect(methods.readFile).toHaveBeenCalledTimes(1);
  });
});

describe('wrapWithCache — isFresh pass-through', () => {
  it('passes isFresh straight through to the source', async () => {
    const { adapter, methods } = makeStub();
    methods.isFresh.mockResolvedValue(true);
    const cached = wrapWithCache(adapter);

    const result = await cached.isFresh(ENV, URL, 'a.md', 'v1', 'main');

    expect(result).toBe(true);
    expect(methods.isFresh).toHaveBeenCalledWith(ENV, URL, 'a.md', 'v1', 'main');
  });
});

describe('wrapWithCache — writeFile', () => {
  it('passes through to the source and populates the cache with the just-written content', async () => {
    const { adapter, methods } = makeStub();
    methods.writeFile.mockResolvedValue(undefined);
    methods.readFile.mockResolvedValue({ content: 'should-not-be-called', sha: '' });
    const cached = wrapWithCache(adapter);

    await cached.writeFile(ENV, URL, 'new.md', 'fresh content', 'main', 'msg');

    expect(methods.writeFile).toHaveBeenCalledWith(
      ENV,
      URL,
      'new.md',
      'fresh content',
      'main',
      'msg'
    );
    // Subsequent read serves from cache, never calls the source.
    const r = await cached.readFile(ENV, URL, 'new.md', 'main');
    expect(r.content).toBe('fresh content');
    expect(methods.readFile).not.toHaveBeenCalled();
  });

  it('drops the no-ref slot on write, so a write-then-no-ref-read re-fetches instead of serving the stale default-branch entry', async () => {
    const { adapter, methods } = makeStub();
    methods.writeFile.mockResolvedValue(undefined);
    // A no-ref read keys version '' (the default-branch sentinel).
    // The first read sees the pre-write content; once the write lands,
    // the source returns the new content.
    methods.readFile
      .mockResolvedValueOnce({ content: 'old', sha: 'sha-old' })
      .mockResolvedValueOnce({ content: 'new', sha: 'sha-new' });
    let clock = 1_000_000;
    const cached = wrapWithCache(adapter, {
      store: createContextStore(),
      validationTtlMs: 10_000,
      now: () => clock,
    });

    // 1. No-ref read populates the '' slot with 'old'.
    expect((await cached.readFile(ENV, URL, 'a.md')).content).toBe('old');

    // 2. Write to the default branch.
    await cached.writeFile(ENV, URL, 'a.md', 'new', 'main', 'msg');

    // 3. No-ref read *inside* the grace window. Without the alias drop
    //    the stale '' slot is served with no isFresh check; with it the
    //    write invalidated '', so we re-fetch and get 'new'.
    clock += 1_000; // well within the 10s TTL
    const second = await cached.readFile(ENV, URL, 'a.md');

    expect(second.content).toBe('new');
    expect(second.sha).toBe('sha-new');
    expect(methods.readFile).toHaveBeenCalledTimes(2); // re-fetched, not stale-served
  });
});

describe('wrapWithCache — pass-throughs', () => {
  it('listFiles passes through to the source', async () => {
    const { adapter, methods } = makeStub();
    methods.listFiles.mockResolvedValue([{ name: 'a', type: 'file', path: 'a', sha: 's' }]);
    const cached = wrapWithCache(adapter);
    const r = await cached.listFiles(ENV, URL, 'src');
    expect(r).toHaveLength(1);
    expect(methods.listFiles).toHaveBeenCalledWith(ENV, URL, 'src', undefined);
  });

  it('getRepoTree passes through to the source', async () => {
    const { adapter, methods } = makeStub();
    methods.getRepoTree.mockResolvedValue({ entries: [], truncated: false });
    const cached = wrapWithCache(adapter);
    await cached.getRepoTree(ENV, URL);
    expect(methods.getRepoTree).toHaveBeenCalledTimes(1);
  });

  it('ensureFork / openPullRequest / ensureBranch / getDefaultBranch all pass through', async () => {
    const { adapter, methods } = makeStub();
    methods.ensureFork.mockResolvedValue('fork-url');
    methods.openPullRequest.mockResolvedValue('pr-url');
    methods.getDefaultBranch.mockResolvedValue('main');
    methods.ensureBranch.mockResolvedValue(undefined);
    const cached = wrapWithCache(adapter);

    await cached.ensureBranch(ENV, URL, 'feature');
    await cached.ensureFork(ENV, URL);
    await cached.openPullRequest(ENV, URL, 'h', 'b', 't', 'body');
    await cached.getDefaultBranch(ENV, URL);

    expect(methods.ensureBranch).toHaveBeenCalledTimes(1);
    expect(methods.ensureFork).toHaveBeenCalledTimes(1);
    expect(methods.openPullRequest).toHaveBeenCalledTimes(1);
    expect(methods.getDefaultBranch).toHaveBeenCalledTimes(1);
  });
});

describe('wrapWithCache — isolated stores', () => {
  it('honours the `store` option for tenant / per-test isolation', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile.mockResolvedValue({ content: 'val', sha: 'sha' });
    const store = createContextStore();
    const cached = wrapWithCache(adapter, { store });

    await cached.readFile(ENV, URL, 'x.md');

    expect(store.getContent({ sourceId: URL, version: '', itemId: 'x.md' })).toBe('val');
    // The default singleton is untouched.
    expect(contextStore.getContent({ sourceId: URL, version: '', itemId: 'x.md' })).toBeUndefined();
  });
});
