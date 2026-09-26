import { describe, it, expect } from 'vitest';
import { parseCode, edgesForItem } from '../../src/code/index.js';
import { createContextStore } from '../../src/index.js';

describe('JS/TS re-export dependencies', () => {
  it.each(['typescript', 'tsx', 'javascript'] as const)(
    'records named, wildcard and namespace re-exports in %s',
    (language) => {
      const { edges } = parseCode(
        language,
        `export { x, y as z, default as Button } from './primitives';
export * from './all';
export * as widgets from './widgets';
export { local };
export const value = 1;
export default function App() { render(); }
export const result = compute();`
      );
      expect(edges.imports).toEqual([
        { module: './primitives', names: ['x', 'z', 'Button'], line: 1 },
        { module: './all', names: [], line: 2 },
        { module: './widgets', names: ['widgets'], line: 3 },
      ]);
      expect(edges.calls).toEqual([
        { from: 'App', to: 'render', line: 6 },
        { from: null, to: 'compute', line: 7 },
      ]);
    }
  );

  it('records type-only re-exports and preserves ordinary imports', () => {
    const { edges } = parseCode(
      'typescript',
      `import { x as local } from './runtime';
export type { Props as ButtonProps } from './types';
export { type Theme, Button } from './button';
export type * from './more-types';`
    );
    expect(edges.imports).toEqual([
      { module: './runtime', names: ['local'], line: 1 },
      { module: './types', names: ['ButtonProps'], line: 2 },
      { module: './button', names: ['Theme', 'Button'], line: 3 },
      { module: './more-types', names: [], line: 4 },
    ]);
  });

  it('exposes a barrel as an importer through the cached graph API', () => {
    const store = createContextStore();
    const key = { sourceId: 'repo', version: '', itemId: 'index.ts' };
    store.setContent(key, "export { Button } from './button';");
    const importers = store
      .listIndexedItems('repo', '')
      .filter((itemId) =>
        edgesForItem(store, key.sourceId, key.version, itemId)?.imports.some(
          (edge) => edge.module === './button'
        )
      );
    expect(importers).toEqual(['index.ts']);
    expect(store.getEdges(key)?.imports).toEqual([
      { module: './button', names: ['Button'], line: 1 },
    ]);
  });
});
