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
    readFile: vi.fn<typeof readFileFn>(),
    listFiles: vi.fn<typeof listFilesFn>(),
    getRepoTree: vi.fn<typeof getRepoTreeFn>(),
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

  it('returns empty sha on cache hits (sha is not preserved across rounds)', async () => {
    const { adapter, methods } = makeStub();
    methods.readFile.mockResolvedValue({ content: 'x', sha: 'real-sha' });
    const cached = wrapWithCache(adapter);

    await cached.readFile(ENV, URL, 'x.md');
    const second = await cached.readFile(ENV, URL, 'x.md');

    expect(second.sha).toBe('');
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
