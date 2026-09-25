import { describe, it, expect, vi } from 'vitest';

/** The gitlab subpath binds the generic warm+grep mechanism to the
 * gitlab adapter. The mechanism itself is covered in warm.test.ts; this
 * confirms the *wiring* — `@verevoir/context/gitlab`'s `grepSource`
 * enumerates + reads via the gitlab adapter and warms the store. The
 * adapter is mocked so no network / token is needed. */

vi.mock('@verevoir/sources/gitlab', () => ({
  gitlab: {
    async getRepoTree() {
      return {
        entries: [
          { path: 'src/app.ts', type: 'blob', size: 20, sha: '' },
          { path: 'README.md', type: 'blob', size: 10, sha: '' },
        ],
        truncated: false,
      };
    },
    async readFile(_env: unknown, _url: string, path: string) {
      const content = path === 'src/app.ts' ? 'const token = secret()' : 'just docs';
      return { content, sha: `sha-${path}` };
    },
  },
}));

const REPO = 'https://gitlab.com/acme/platform/widgets';

describe('@verevoir/context/gitlab grepSource (wiring)', () => {
  it('warms the repo via the gitlab adapter, then greps the warm cache', async () => {
    const { grepSource } = await import('../../src/gitlab/index.js');
    const { createContextStore } = await import('../../src/index.js');
    const store = createContextStore();

    const hits = await grepSource({ token: 'x', forkOrg: '' }, REPO, 'token', { store });

    expect(hits.map((h) => h.itemId)).toEqual(['src/app.ts']);
    expect(store.getContent({ sourceId: REPO, version: '', itemId: 'src/app.ts' })).toBe(
      'const token = secret()'
    );
    expect(store.getContent({ sourceId: REPO, version: '', itemId: 'README.md' })).toBe(
      'just docs'
    );
  });
});
