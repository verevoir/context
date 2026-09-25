import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Smoke test: confirms `@verevoir/context/gitlab` wires the cache
 * around `@verevoir/sources/gitlab`'s `readFile`. The caching
 * behaviour itself is exercised in `wrap-cache.test.ts`; here we
 * only prove the wiring. */

vi.mock('@verevoir/sources/gitlab', async () => {
  const actual = await vi.importActual<typeof import('@verevoir/sources/gitlab')>(
    '@verevoir/sources/gitlab'
  );
  const stub = {
    ...actual.gitlab,
    readFile: vi.fn(async () => ({ content: 'STUBBED', sha: 'sha' })),
  };
  return {
    ...actual,
    gitlab: stub,
    readFile: stub.readFile,
  };
});

import {
  gitlab,
  readFile,
  commitFiles,
  isGitlabUrl,
  parseGitlabProjectUrl,
} from '../../src/gitlab/index.js';
import { contextStore } from '../../src/index.js';

const ENV = { token: 't', forkOrg: 'o' };

beforeEach(() => {
  contextStore.clearAll();
  vi.clearAllMocks();
});

describe('@verevoir/context/gitlab', () => {
  it('exposes the SourceAdapter shape via the aggregate', () => {
    for (const m of [
      'readFile',
      'listFiles',
      'getRepoTree',
      'writeFile',
      'commitFiles',
      'ensureBranch',
      'ensureFork',
      'openPullRequest',
      'getDefaultBranch',
    ]) {
      expect(typeof (gitlab as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });

  it('first read fetches via the source; second read hits the cache', async () => {
    const a = await readFile(ENV, 'https://gitlab.com/x/y', 'README.md');
    expect(a.content).toBe('STUBBED');
    const b = await readFile(ENV, 'https://gitlab.com/x/y', 'README.md');
    expect(b.content).toBe('STUBBED');
    // Source `readFile` called exactly once across both reads.
    const sourceReadFile = (await import('@verevoir/sources/gitlab')).readFile;
    expect(vi.mocked(sourceReadFile)).toHaveBeenCalledTimes(1);
  });

  it('exports the destructured writers, commitFiles included', () => {
    expect(typeof commitFiles).toBe('function');
  });

  it('re-exports isGitlabUrl, so a router can classify through this import', () => {
    expect(isGitlabUrl('https://gitlab.com/a/b')).toBe(true);
    expect(isGitlabUrl('https://gitlab.com.evil.io/a/b')).toBe(false);
  });

  it('re-exports parseGitlabProjectUrl, so a router can resolve project paths through this import', () => {
    expect(parseGitlabProjectUrl('https://gitlab.com/group/sub/repo.git')).toEqual({
      apiBase: 'https://gitlab.com/api/v4',
      projectPath: 'group/sub/repo',
    });
    expect(() => parseGitlabProjectUrl('https://gitlab.com/onlygroup')).toThrow(/namespace/);
  });

  it('does not route around the adapter host guard: an unlisted host is refused with no request', async () => {
    // getRepoTree is not stubbed above, so this runs the real adapter
    // behind the cache facade.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await expect(
        gitlab.getRepoTree(ENV, 'https://gitlab.com.evil.io/a/b', 'main')
      ).rejects.toThrow(/GITLAB_HOSTS/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
