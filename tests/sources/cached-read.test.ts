import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@verevoir/sources/github', async () => {
  const actual = await vi.importActual<typeof import('@verevoir/sources/github')>(
    '@verevoir/sources/github'
  );
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

import { readFile } from '@verevoir/sources/github';
import type { SourceEnv } from '@verevoir/sources';
import { cachedReadFile } from '../../src/sources/index.js';
import { contextStore } from '../../src/index.js';

const ENV: SourceEnv = { token: 'test-token', forkOrg: 'verevoir' };
const REPO = 'https://github.com/acme/docs';

beforeEach(() => {
  vi.resetAllMocks();
  contextStore.clearAll();
});

describe('cachedReadFile', () => {
  it('fetches via the source adapter on the first call and populates the cache', async () => {
    vi.mocked(readFile).mockResolvedValue({
      content: '# overview\n\nbody',
      sha: 'sha-1',
    });

    const content = await cachedReadFile(ENV, REPO, 'docs/project-overview.md');

    expect(content).toBe('# overview\n\nbody');
    expect(readFile).toHaveBeenCalledTimes(1);
    const cached = contextStore.getContent({
      sourceId: REPO,
      version: '',
      itemId: 'docs/project-overview.md',
    });
    expect(cached).toBe('# overview\n\nbody');
  });

  it('returns the cached content on the second call without hitting the adapter', async () => {
    vi.mocked(readFile).mockResolvedValue({
      content: 'cached body',
      sha: 'sha-2',
    });

    await cachedReadFile(ENV, REPO, 'docs/intent.md');
    await cachedReadFile(ENV, REPO, 'docs/intent.md');

    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('shares the cache slot with whatever else writes at the default-version sentinel', async () => {
    contextStore.setContent(
      { sourceId: REPO, version: '', itemId: 'docs/tech-stack.md' },
      'pre-populated'
    );
    vi.mocked(readFile).mockResolvedValue({
      content: 'should-not-be-used',
      sha: 'sha-3',
    });

    const content = await cachedReadFile(ENV, REPO, 'docs/tech-stack.md');

    expect(content).toBe('pre-populated');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('honours an explicit version option', async () => {
    vi.mocked(readFile).mockResolvedValue({
      content: 'feature-branch body',
      sha: 'sha-4',
    });

    await cachedReadFile(ENV, REPO, 'docs/feature.md', {
      version: 'feature/x',
    });

    expect(readFile).toHaveBeenCalledWith(ENV, REPO, 'docs/feature.md', 'feature/x');
    const cached = contextStore.getContent({
      sourceId: REPO,
      version: 'feature/x',
      itemId: 'docs/feature.md',
    });
    expect(cached).toBe('feature-branch body');
  });

  it('propagates adapter errors so callers can handle 404 / other failures', async () => {
    const err = new Error('upstream 404');
    vi.mocked(readFile).mockRejectedValue(err);

    await expect(cachedReadFile(ENV, REPO, 'docs/missing.md')).rejects.toThrow('upstream 404');
    expect(
      contextStore.getContent({
        sourceId: REPO,
        version: '',
        itemId: 'docs/missing.md',
      })
    ).toBeUndefined();
  });
});
