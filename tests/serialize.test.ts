import { describe, it, expect } from 'vitest';
import { createContextStore, grep } from '../src/index.js';

/** STDIO-92 part 1: a ContextStore can be parked (`serialize`) and
 * picked up (`createContextStore({ serialized })`) — the cache half of
 * the stateless-host handoff. These pin the round-trip, independence,
 * and graceful degradation; encryption + blob storage are part 2. */

const SRC = 'https://github.com/acme/widgets';
const V = 'main';

describe('ContextStore serialize / restore (park + pick up)', () => {
  it('round-trips content + symbols + cachedAt, and grep works on the restored store', () => {
    const store = createContextStore();
    store.setContent(
      { sourceId: SRC, version: V, itemId: 'a.ts' },
      'has needle here',
      'sha-a',
      () => 1000
    );
    store.setContent(
      { sourceId: SRC, version: V, itemId: 'b.ts' },
      'no match',
      'sha-b',
      () => 2000
    );
    store.setSymbols({ sourceId: SRC, version: V, itemId: 'a.ts' }, [
      { name: 'Widget', kind: 'class', startLine: 1, endLine: 3 },
    ]);

    const restored = createContextStore({ serialized: store.serialize() });

    expect(restored.getCached({ sourceId: SRC, version: V, itemId: 'a.ts' })).toEqual({
      content: 'has needle here',
      version: 'sha-a',
      cachedAt: 1000,
    });
    expect(restored.getSymbols({ sourceId: SRC, version: V, itemId: 'a.ts' })).toEqual([
      { name: 'Widget', kind: 'class', startLine: 1, endLine: 3 },
    ]);
    expect(restored.listIndexedItems(SRC, V)).toEqual(['a.ts', 'b.ts']);

    // The whole point: search works against the restored (never-fetched) cache.
    const hits = grep('needle', { sources: [{ sourceId: SRC, version: V }] }, { store: restored });
    expect(hits.map((h) => h.itemId)).toEqual(['a.ts']);
  });

  it('restored store is an independent copy of the original', () => {
    const store = createContextStore();
    store.setContent({ sourceId: SRC, version: V, itemId: 'a.ts' }, 'one');
    const restored = createContextStore({ serialized: store.serialize() });

    store.setContent({ sourceId: SRC, version: V, itemId: 'a.ts' }, 'two'); // mutate original after park
    expect(restored.getContent({ sourceId: SRC, version: V, itemId: 'a.ts' })).toBe('one');
  });

  it('degrades to an empty store on malformed or wrong-version input (no throw)', () => {
    expect(createContextStore({ serialized: 'not json at all' }).listIndexedItems(SRC, V)).toEqual(
      []
    );
    expect(
      createContextStore({
        serialized: JSON.stringify({ v: 999, contents: [], symbols: [] }),
      }).listIndexedItems(SRC, V)
    ).toEqual([]);
  });
});
