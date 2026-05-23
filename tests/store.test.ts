import { describe, it, expect, beforeEach } from 'vitest';
import { createContextStore, type ContextStore, type SymbolEntry } from '../src/index.js';

let store: ContextStore;

beforeEach(() => {
  store = createContextStore();
});

const sample: SymbolEntry[] = [{ name: 'foo', kind: 'function', startLine: 1, endLine: 3 }];

describe('ContextStore — content cache', () => {
  it('returns undefined for unset content', () => {
    expect(
      store.getContent({
        sourceId: 'owner/repo',
        version: 'main',
        itemId: 'src/x.ts',
      })
    ).toBeUndefined();
  });

  it('returns the stored content after set', () => {
    store.setContent(
      { sourceId: 'owner/repo', version: 'main', itemId: 'src/x.ts' },
      'export const x = 1;'
    );
    expect(
      store.getContent({
        sourceId: 'owner/repo',
        version: 'main',
        itemId: 'src/x.ts',
      })
    ).toBe('export const x = 1;');
  });

  it('isolates entries across different versions', () => {
    const itemId = 'src/x.ts';
    store.setContent({ sourceId: 'owner/repo', version: 'main', itemId }, 'main-version');
    store.setContent({ sourceId: 'owner/repo', version: 'aigency/TP-5', itemId }, 'branch-version');
    expect(store.getContent({ sourceId: 'owner/repo', version: 'main', itemId })).toBe(
      'main-version'
    );
    expect(
      store.getContent({
        sourceId: 'owner/repo',
        version: 'aigency/TP-5',
        itemId,
      })
    ).toBe('branch-version');
  });

  it('isolates entries across different sourceIds', () => {
    store.setContent({ sourceId: 'owner/repo-a', version: 'main', itemId: 'README.md' }, 'A');
    store.setContent({ sourceId: 'owner/repo-b', version: 'main', itemId: 'README.md' }, 'B');
    expect(
      store.getContent({
        sourceId: 'owner/repo-a',
        version: 'main',
        itemId: 'README.md',
      })
    ).toBe('A');
    expect(
      store.getContent({
        sourceId: 'owner/repo-b',
        version: 'main',
        itemId: 'README.md',
      })
    ).toBe('B');
  });
});

describe('ContextStore — symbol cache', () => {
  it('returns undefined when no symbols cached', () => {
    expect(
      store.getSymbols({
        sourceId: 'owner/repo',
        version: 'main',
        itemId: 'src/x.ts',
      })
    ).toBeUndefined();
  });

  it('returns cached symbols after set', () => {
    const key = {
      sourceId: 'owner/repo',
      version: 'main',
      itemId: 'src/x.ts',
    };
    store.setSymbols(key, sample);
    expect(store.getSymbols(key)).toEqual(sample);
  });

  it('drops cached symbols when content is overwritten', () => {
    const key = {
      sourceId: 'owner/repo',
      version: 'main',
      itemId: 'src/x.ts',
    };
    store.setContent(key, 'old');
    store.setSymbols(key, sample);
    store.setContent(key, 'new');
    expect(store.getSymbols(key)).toBeUndefined();
  });
});

describe('ContextStore — invalidation', () => {
  it('invalidateItem drops content + symbols for a single itemId', () => {
    const key = {
      sourceId: 'owner/repo',
      version: 'main',
      itemId: 'src/x.ts',
    };
    const other = {
      sourceId: 'owner/repo',
      version: 'main',
      itemId: 'src/y.ts',
    };
    store.setContent(key, 'x');
    store.setSymbols(key, sample);
    store.setContent(other, 'y');
    store.invalidateItem(key);
    expect(store.getContent(key)).toBeUndefined();
    expect(store.getSymbols(key)).toBeUndefined();
    expect(store.getContent(other)).toBe('y');
  });

  it('invalidateVersion drops everything for one (sourceId, version)', () => {
    const version = 'aigency/TP-5';
    store.setContent({ sourceId: 'owner/repo', version, itemId: 'a.ts' }, '1');
    store.setContent({ sourceId: 'owner/repo', version, itemId: 'b.ts' }, '2');
    store.setSymbols({ sourceId: 'owner/repo', version, itemId: 'a.ts' }, sample);
    store.setContent({ sourceId: 'owner/repo', version: 'main', itemId: 'a.ts' }, 'M');
    store.setContent({ sourceId: 'owner/other', version, itemId: 'a.ts' }, 'OTHER');

    store.invalidateVersion('owner/repo', version);

    expect(store.getContent({ sourceId: 'owner/repo', version, itemId: 'a.ts' })).toBeUndefined();
    expect(store.getContent({ sourceId: 'owner/repo', version, itemId: 'b.ts' })).toBeUndefined();
    expect(store.getSymbols({ sourceId: 'owner/repo', version, itemId: 'a.ts' })).toBeUndefined();
    expect(
      store.getContent({
        sourceId: 'owner/repo',
        version: 'main',
        itemId: 'a.ts',
      })
    ).toBe('M');
    expect(store.getContent({ sourceId: 'owner/other', version, itemId: 'a.ts' })).toBe('OTHER');
  });

  it('clearAll drops every entry', () => {
    store.setContent({ sourceId: 'a', version: 'b', itemId: 'c' }, 'd');
    store.setSymbols({ sourceId: 'a', version: 'b', itemId: 'c' }, sample);
    store.clearAll();
    expect(store.getContent({ sourceId: 'a', version: 'b', itemId: 'c' })).toBeUndefined();
    expect(store.getSymbols({ sourceId: 'a', version: 'b', itemId: 'c' })).toBeUndefined();
  });
});

describe('ContextStore — listIndexedItems', () => {
  it('returns items with cached content under (sourceId, version), sorted', () => {
    const version = 'aigency/TP-5';
    store.setContent({ sourceId: 'owner/repo', version, itemId: 'src/x.ts' }, 'x');
    store.setContent({ sourceId: 'owner/repo', version, itemId: 'README.md' }, 'r');
    store.setContent({ sourceId: 'owner/repo', version, itemId: 'src/y.ts' }, 'y');
    expect(store.listIndexedItems('owner/repo', version)).toEqual([
      'README.md',
      'src/x.ts',
      'src/y.ts',
    ]);
  });

  it('does not include items from other versions', () => {
    store.setContent({ sourceId: 'owner/repo', version: 'main', itemId: 'main-only.ts' }, 'M');
    store.setContent(
      {
        sourceId: 'owner/repo',
        version: 'aigency/TP-5',
        itemId: 'branch-only.ts',
      },
      'B'
    );
    expect(store.listIndexedItems('owner/repo', 'aigency/TP-5')).toEqual(['branch-only.ts']);
    expect(store.listIndexedItems('owner/repo', 'main')).toEqual(['main-only.ts']);
  });

  it('returns an empty array when nothing is cached for the version', () => {
    expect(store.listIndexedItems('owner/repo', 'main')).toEqual([]);
  });
});

describe('ContextStore — key collision', () => {
  // The NUL-byte separator prevents ('ab','c','x') vs ('a','bc','x')
  // collisions. Locked here so a future "simplification" doesn't
  // reintroduce the bug.
  it("doesn't collide on lookalike (sourceId, version) splits", () => {
    store.setContent({ sourceId: 'ab', version: 'c', itemId: 'x' }, 'first');
    store.setContent({ sourceId: 'a', version: 'bc', itemId: 'x' }, 'second');
    expect(store.getContent({ sourceId: 'ab', version: 'c', itemId: 'x' })).toBe('first');
    expect(store.getContent({ sourceId: 'a', version: 'bc', itemId: 'x' })).toBe('second');
  });
});

describe('ContextStore — instances are isolated', () => {
  it('two createContextStore() instances do not share state', () => {
    const a = createContextStore();
    const b = createContextStore();
    a.setContent({ sourceId: 'r', version: 'r', itemId: 'p' }, 'A-val');
    expect(b.getContent({ sourceId: 'r', version: 'r', itemId: 'p' })).toBeUndefined();
  });
});
