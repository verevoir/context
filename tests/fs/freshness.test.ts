import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fs as rawFs } from '@verevoir/sources/fs';
import { grepSource, warmSource } from '../../src/fs/index.js';
import { edgesForItem, findSymbols } from '../../src/code/index.js';
import { createContextStore, type ContextStore } from '../../src/index.js';

const env = { token: '', forkOrg: '' };
let root: string;
let store: ContextStore;
const key = () => ({ sourceId: root, version: '', itemId: 'app.ts' });
const scope = () => ({ sources: [{ sourceId: root, version: '' }] });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-freshness-'));
  store = createContextStore();
  await writeFile(join(root, 'app.ts'), 'export function before() { oldCall(); }');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('local search freshness', () => {
  it('sees external edits in grep, symbols and edges without a cached readFile', async () => {
    await warmSource(env, root, { store });
    expect(findSymbols('before', scope(), { store })).toHaveLength(1);
    expect(edgesForItem(store, root, '', 'app.ts')?.calls[0].to).toBe('oldCall');
    await writeFile(join(root, 'app.ts'), 'export function afterChange() { newCall(); }');

    expect(await grepSource(env, root, 'afterChange', { store })).toHaveLength(1);
    expect(await grepSource(env, root, 'before', { store })).toEqual([]);
    expect(findSymbols('before', scope(), { store })).toEqual([]);
    expect(findSymbols('afterChange', scope(), { store })).toHaveLength(1);
    expect(edgesForItem(store, root, '', 'app.ts')?.calls[0].to).toBe('newCall');
  });

  it('refreshes symbol searches through warmSource, including equal-size edits', async () => {
    await warmSource(env, root, { store });
    await warmSource(env, root, { store }); // establish the stat fast path
    findSymbols('before', scope(), { store });
    const path = join(root, 'app.ts');
    const previous = await stat(path);
    await writeFile(path, 'export function after_() { newCall(); }');
    await utimes(path, previous.atime, new Date(previous.mtimeMs + 2000));
    await warmSource(env, root, { store });
    expect(findSymbols('before', scope(), { store })).toEqual([]);
    expect(findSymbols('after_', scope(), { store })).toHaveLength(1);
  });

  it('detects size changes even when the modification time is preserved', async () => {
    const path = join(root, 'app.ts');
    const fixedTime = new Date('2026-01-01T00:00:00Z');
    await utimes(path, fixedTime, fixedTime);
    await warmSource(env, root, { store });
    await warmSource(env, root, { store });
    await writeFile(path, 'export function aLongerName() {}');
    await utimes(path, fixedTime, fixedTime);
    expect(await grepSource(env, root, 'aLongerName', { store })).toHaveLength(1);
  });

  it.each(['grep', 'symbols'])(
    'removes deleted files and derived caches before %s search',
    async (search) => {
      await warmSource(env, root, { store });
      findSymbols('before', scope(), { store });
      edgesForItem(store, root, '', 'app.ts');
      await unlink(join(root, 'app.ts'));
      if (search === 'grep') expect(await grepSource(env, root, 'before', { store })).toEqual([]);
      else await warmSource(env, root, { store });
      expect(findSymbols('before', scope(), { store })).toEqual([]);
      expect(store.getCached(key())).toBeUndefined();
      expect(store.getSymbols(key())).toBeUndefined();
      expect(store.getEdges(key())).toBeUndefined();
    }
  );

  it('keeps unchanged parsed records and uses stat after the first hash check', async () => {
    await warmSource(env, root, { store });
    findSymbols('before', scope(), { store });
    const symbols = store.getSymbols(key());
    const check = vi.spyOn(rawFs, 'isFresh');
    const read = vi.spyOn(rawFs, 'readFile');
    await warmSource(env, root, { store });
    expect(check).toHaveBeenCalledTimes(1);
    await grepSource(env, root, 'before', { store });
    await warmSource(env, root, { store });
    expect(check).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(store.getSymbols(key())).toBe(symbols);
  });

  it('validates cached files absent from a truncated tree without dropping existing files', async () => {
    await writeFile(join(root, 'keep.ts'), 'export function keep() {}');
    await warmSource(env, root, { store });
    await unlink(join(root, 'app.ts'));
    vi.spyOn(rawFs, 'getRepoTree').mockResolvedValue({ entries: [], truncated: true });
    await warmSource(env, root, { store, prefix: 'unrelated' });
    expect(store.getCached(key())).toBeUndefined();
    expect(findSymbols('keep', scope(), { store })).toHaveLength(1);
  });

  it('removes stale data when validation and the subsequent read fail', async () => {
    await warmSource(env, root, { store });
    findSymbols('before', scope(), { store });
    edgesForItem(store, root, '', 'app.ts');
    vi.spyOn(rawFs, 'isFresh').mockRejectedValue(new Error('unreadable'));
    vi.spyOn(rawFs, 'readFile').mockRejectedValue(new Error('unreadable'));
    expect(await grepSource(env, root, 'before', { store })).toEqual([]);
    expect(store.getCached(key())).toBeUndefined();
    expect(store.getSymbols(key())).toBeUndefined();
    expect(store.getEdges(key())).toBeUndefined();
  });

  it('does not invalidate a replacement installed while validation is pending', async () => {
    await warmSource(env, root, { store });
    vi.spyOn(rawFs, 'isFresh').mockImplementation(async () => {
      store.setContent(key(), 'export function replacement() {}');
      return false;
    });
    expect(await grepSource(env, root, 'replacement', { store })).toHaveLength(1);
    expect(findSymbols('replacement', scope(), { store })).toHaveLength(1);
  });

  it('validates restored cache entries before associating filesystem metadata', async () => {
    await warmSource(env, root, { store });
    store = createContextStore({ serialized: store.serialize() });
    await writeFile(join(root, 'app.ts'), 'export function restored() {}');
    expect(await grepSource(env, root, 'restored', { store })).toHaveLength(1);
  });

  it('drops cached text that becomes binary or oversized', async () => {
    await warmSource(env, root, { store });
    await writeFile(join(root, 'app.ts'), 'before\0binary');
    expect(await grepSource(env, root, 'before', { store })).toEqual([]);
    await writeFile(join(root, 'app.ts'), 'before');
    await warmSource(env, root, { store });
    await writeFile(join(root, 'app.ts'), 'before' + 'x'.repeat(1_600_000));
    expect(await grepSource(env, root, 'before', { store })).toEqual([]);
    expect(store.getCached(key())).toBeUndefined();
  });
});
