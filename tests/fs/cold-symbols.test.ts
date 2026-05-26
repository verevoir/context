import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { warmSource } from '../../src/fs/index.js';
import { findSymbols } from '../../src/code/index.js';
import { createContextStore, type ContextStore } from '../../src/index.js';

/** `warmSource` is the cold-search primitive: it pulls a whole tree
 * into the store so the pure, cache-only operations work across the
 * source. `grepSource` bundles warm + grep; cold *symbol* search is
 * the same shape — `warmSource` then the `/code` `findSymbols` (which
 * lazily tree-sitter-parses the warmed content on demand). This test
 * pins that composition. */

const ENV = { token: '', forkOrg: '' };

let root: string;
let store: ContextStore;

beforeEach(async () => {
  root = await fsPromises.mkdtemp(join(tmpdir(), 'context-cold-sym-'));
  store = createContextStore();
});

afterEach(async () => {
  await fsPromises.rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await fsPromises.mkdir(join(abs, '..'), { recursive: true });
  await fsPromises.writeFile(abs, content, 'utf8');
}

const scope = () => ({ sources: [{ sourceId: root, version: '' }] });

describe('cold find_symbol — warmSource + findSymbols', () => {
  beforeEach(async () => {
    await write('src/widget.ts', 'export class Widget {\n  render() {}\n}\n');
    await write('src/util.ts', 'export function helper() {\n  return 1;\n}\n');
  });

  it('finds a symbol defined in a file that was never read, after warming', async () => {
    // Cold: nothing parsed/warmed yet.
    expect(findSymbols('Widget', scope(), { store, match: 'exact' })).toEqual([]);

    await warmSource(ENV, root, { store });

    const hits = findSymbols('Widget', scope(), { store, match: 'exact' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      sourceId: root,
      itemId: 'src/widget.ts',
      name: 'Widget',
      kind: 'class',
      startLine: 1,
    });
  });

  it('searches symbols across the whole warmed source', async () => {
    await warmSource(ENV, root, { store });
    const names = findSymbols('e', scope(), { store }) // substring across files
      .map((h) => h.name)
      .sort();
    expect(names).toContain('Widget');
    expect(names).toContain('helper');
    expect(names).toContain('render');
  });
});
