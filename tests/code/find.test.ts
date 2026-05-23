import { describe, it, expect, beforeEach } from 'vitest';
import { findSymbols } from '../../src/code/index.js';
import { contextStore } from '../../src/index.js';

const REPO_A = 'https://github.com/acme/charts';
const REPO_B = 'https://github.com/acme/templates';
const VERSION = 'aigency/TP-5';

beforeEach(() => {
  contextStore.clearAll();
});

function prime(sourceId: string, itemId: string, content: string): void {
  contextStore.setContent({ sourceId, version: VERSION, itemId }, content);
}

describe('findSymbols', () => {
  it('finds matching symbols via substring match across cached items', () => {
    prime(
      REPO_A,
      'src/auth.ts',
      `
export class AuthHandler {
  authenticate() {}
}

export function authenticateRequest() { return true; }
`
    );
    prime(REPO_A, 'src/other.ts', `export function unrelated() {}`);

    const hits = findSymbols('auth', {
      sources: [{ sourceId: REPO_A, version: VERSION }],
    });
    const names = hits.map((h) => h.name).sort();
    expect(names).toEqual(['AuthHandler', 'authenticate', 'authenticateRequest']);
  });

  it('returns no hits when query does not match anything cached', () => {
    prime(REPO_A, 'src/x.ts', `export function foo() {}`);
    expect(
      findSymbols('nonexistent', {
        sources: [{ sourceId: REPO_A, version: VERSION }],
      })
    ).toEqual([]);
  });

  it('searches across multiple sources when scope includes them', () => {
    prime(REPO_A, 'a.ts', `export class HandlerA {}`);
    prime(REPO_B, 'b.ts', `export class HandlerB {}`);
    const hits = findSymbols('Handler', {
      sources: [
        { sourceId: REPO_A, version: VERSION },
        { sourceId: REPO_B, version: VERSION },
      ],
    });
    expect(hits.map((h) => h.sourceId).sort()).toEqual([REPO_A, REPO_B]);
  });

  it('caches parsed symbols on the store after first call (lazy parse-and-store)', () => {
    prime(REPO_A, 'src/x.ts', `export function lazyParseTest() {}`);
    expect(
      contextStore.getSymbols({
        sourceId: REPO_A,
        version: VERSION,
        itemId: 'src/x.ts',
      })
    ).toBeUndefined();
    findSymbols('lazyParseTest', {
      sources: [{ sourceId: REPO_A, version: VERSION }],
    });
    const cached = contextStore.getSymbols({
      sourceId: REPO_A,
      version: VERSION,
      itemId: 'src/x.ts',
    });
    expect(cached).toBeDefined();
    expect(cached?.map((s) => s.name)).toContain('lazyParseTest');
  });

  it('honours the exact-match option', () => {
    prime(REPO_A, 'src/x.ts', `export function user() {} export function userId() {}`);
    const exact = findSymbols(
      'user',
      { sources: [{ sourceId: REPO_A, version: VERSION }] },
      { match: 'exact' }
    );
    expect(exact.map((h) => h.name)).toEqual(['user']);

    const substring = findSymbols(
      'user',
      { sources: [{ sourceId: REPO_A, version: VERSION }] },
      { match: 'substring' }
    );
    expect(substring.map((h) => h.name).sort()).toEqual(['user', 'userId']);
  });

  it('caps results at maxResults', () => {
    let content = '';
    for (let i = 0; i < 30; i++) {
      content += `export function fn${i}() {}\n`;
    }
    prime(REPO_A, 'big.ts', content);
    const hits = findSymbols(
      'fn',
      { sources: [{ sourceId: REPO_A, version: VERSION }] },
      { maxResults: 5 }
    );
    expect(hits).toHaveLength(5);
  });

  it('returns empty list when no items have been cached for the scope', () => {
    expect(
      findSymbols('anything', {
        sources: [{ sourceId: REPO_A, version: VERSION }],
      })
    ).toEqual([]);
  });

  it('caches an empty symbol list for non-code items (yaml/md/etc.)', () => {
    prime(REPO_A, 'config.yaml', 'foo: bar\nbaz: qux\n');
    findSymbols('foo', {
      sources: [{ sourceId: REPO_A, version: VERSION }],
    });
    expect(
      contextStore.getSymbols({
        sourceId: REPO_A,
        version: VERSION,
        itemId: 'config.yaml',
      })
    ).toEqual([]);
  });
});
