import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Smoke test: confirms `@verevoir/context/github` wires the cache
 * around `@verevoir/sources/github`'s `readFile`. The caching
 * behaviour itself is exercised in `wrap-cache.test.ts`; here we
 * only prove the wiring. */

vi.mock('@verevoir/sources/github', async () => {
  const actual = await vi.importActual<typeof import('@verevoir/sources/github')>(
    '@verevoir/sources/github'
  );
  const stub = {
    ...actual.github,
    readFile: vi.fn(async () => ({ content: 'STUBBED', sha: 'sha' })),
  };
  return {
    ...actual,
    github: stub,
    readFile: stub.readFile,
  };
});

import { github, readFile } from '../../src/github/index.js';
import { contextStore } from '../../src/index.js';

const ENV = { token: 't', forkOrg: 'o' };

beforeEach(() => {
  contextStore.clearAll();
  vi.clearAllMocks();
});

describe('@verevoir/context/github', () => {
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
      expect(typeof (github as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });

  it('first read fetches via the source; second read hits the cache', async () => {
    const a = await readFile(ENV, 'https://github.com/x/y', 'README.md');
    expect(a.content).toBe('STUBBED');
    const b = await readFile(ENV, 'https://github.com/x/y', 'README.md');
    expect(b.content).toBe('STUBBED');
    // Source `readFile` called exactly once across both reads.
    const sourceReadFile = (await import('@verevoir/sources/github')).readFile;
    expect(vi.mocked(sourceReadFile)).toHaveBeenCalledTimes(1);
  });
});
