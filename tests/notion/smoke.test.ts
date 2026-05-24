import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Smoke test: confirms `@verevoir/context/notion` wires the cache
 * around `@verevoir/sources/notion`'s `readFile`. The caching
 * behaviour itself is exercised in `wrap-cache.test.ts`; here we
 * only prove the wiring. */

// Mock the source module without `vi.importActual` so the test
// doesn't transitively load `@notionhq/client` (which is an optional
// peer dep of `@verevoir/sources/notion` and not in context's
// devDeps). All methods of the SourceAdapter contract are stubbed
// to satisfy callers that introspect the aggregate; only `readFile`
// + `isFresh` carry meaningful behaviour for the smoke test.
vi.mock('@verevoir/sources/notion', () => {
  const stub = {
    readFile: vi.fn(async () => ({ content: 'STUBBED', sha: '2026-05-24T12:00:00.000Z' })),
    listFiles: vi.fn(async () => []),
    getRepoTree: vi.fn(async () => ({ entries: [], truncated: false })),
    isFresh: vi.fn(async () => true),
    writeFile: vi.fn(async () => undefined),
    ensureBranch: vi.fn(async () => undefined),
    ensureFork: vi.fn(async () => 'fork-url'),
    openPullRequest: vi.fn(async () => 'pr-url'),
    getDefaultBranch: vi.fn(async () => 'live'),
  };
  return {
    notion: stub,
    readFile: stub.readFile,
    listFiles: stub.listFiles,
    getRepoTree: stub.getRepoTree,
    isFresh: stub.isFresh,
    writeFile: stub.writeFile,
    ensureBranch: stub.ensureBranch,
    ensureFork: stub.ensureFork,
    openPullRequest: stub.openPullRequest,
    getDefaultBranch: stub.getDefaultBranch,
  };
});

import { notion, readFile, isFresh } from '../../src/notion/index.js';
import { contextStore } from '../../src/index.js';

const ENV = { token: 'ntn_test', forkOrg: '' };
const ROOT = 'https://www.notion.so/myws/Root-aabbccdd11223344556677889900aabb';

beforeEach(() => {
  contextStore.clearAll();
  vi.clearAllMocks();
});

describe('@verevoir/context/notion', () => {
  it('exposes the SourceAdapter shape via the aggregate', () => {
    for (const m of [
      'readFile',
      'listFiles',
      'getRepoTree',
      'isFresh',
      'writeFile',
      'ensureBranch',
      'ensureFork',
      'openPullRequest',
      'getDefaultBranch',
    ]) {
      expect(typeof (notion as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });

  it('first read fetches via the source; second read inside the TTL hits the cache', async () => {
    const a = await readFile(ENV, ROOT, 'intent');
    expect(a.content).toBe('STUBBED');
    const b = await readFile(ENV, ROOT, 'intent');
    expect(b.content).toBe('STUBBED');
    // Source `readFile` called exactly once across both reads (within
    // the default 10s validation TTL).
    const sourceReadFile = (await import('@verevoir/sources/notion')).readFile;
    expect(vi.mocked(sourceReadFile)).toHaveBeenCalledTimes(1);
  });

  it('exposes isFresh as a pass-through to the source', async () => {
    await expect(isFresh(ENV, ROOT, 'intent', '2026-05-24T12:00:00.000Z')).resolves.toBe(true);
    const sourceIsFresh = (await import('@verevoir/sources/notion')).isFresh;
    expect(vi.mocked(sourceIsFresh)).toHaveBeenCalledTimes(1);
  });
});
