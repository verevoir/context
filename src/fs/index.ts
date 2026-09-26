// @verevoir/context/fs — cached local-filesystem source.
//
// Drop-in replacement for `@verevoir/sources/fs` that adds
// read-through caching via the root `ContextStore`. SourceAdapter
// contract identical; consumers swap the import path to add
// caching, no other code changes.
//
// Read-through caching lives in `wrapWithCache` at the root. Local
// searches also validate cached files before using the generic cold ops.
//
// `warmSource` / `grepSource` are the fs bindings of the generic
// cold-warm + cold-grep mechanism (root `index.ts`). The mechanism is
// identical across file sources; the fs adapter supplies how files
// are enumerated and read.

import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fs as rawFs } from '@verevoir/sources/fs';
import type { SourceEnv } from '@verevoir/sources';
import {
  contextStore,
  type CachedContent,
  wrapWithCache,
  warmSource as warmSourceGeneric,
  grepSource as grepSourceGeneric,
  type GrepHit,
  type GrepOptions,
  type WarmSourceOptions,
} from '../index.js';

export const fs = wrapWithCache(rawFs);

export const readFile = fs.readFile.bind(fs);
export const listFiles = fs.listFiles.bind(fs);
export const getRepoTree = fs.getRepoTree.bind(fs);
export const isFresh = fs.isFresh.bind(fs);
export const writeFile = fs.writeFile.bind(fs);
export const ensureBranch = fs.ensureBranch.bind(fs);
export const ensureFork = fs.ensureFork.bind(fs);
export const openPullRequest = fs.openPullRequest.bind(fs);
export const getDefaultBranch = fs.getDefaultBranch.bind(fs);

// Keep filesystem metadata out of portable cache snapshots. Restored entries
// (and entries populated by readFile) are verified against their content hash
// once before trusting stat metadata. Weak keys expire with the cache records.
const fingerprints = new WeakMap<CachedContent, { mtimeMs: number; size: number }>();

async function refreshCachedFiles(
  env: SourceEnv,
  sourceUrl: string,
  options: WarmSourceOptions
): Promise<void> {
  const store = options.store ?? contextStore;
  const version = options.ref ?? '';
  const items = store.listIndexedItems(sourceUrl, version);
  const root = resolve(sourceUrl);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const itemId = items[next++];
      const key = { sourceId: sourceUrl, version, itemId };
      const cached = store.getCached(key);
      if (!cached) continue;
      try {
        const path = resolve(root, itemId);
        if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) {
          throw new Error('Path escapes the root');
        }
        const current = await stat(path);
        const previous = fingerprints.get(cached);
        const fresh =
          current.isFile() &&
          (previous
            ? previous.mtimeMs === current.mtimeMs && previous.size === current.size
            : await rawFs.isFresh(env, sourceUrl, itemId, cached.version, options.ref));
        // Another request may have replaced this record while we checked it.
        if (store.getCached(key) !== cached) continue;
        if (fresh) fingerprints.set(cached, { mtimeMs: current.mtimeMs, size: current.size });
        else store.invalidateItem(key);
      } catch {
        // Failed validation must not leave old content, symbols, or edges
        // searchable. The source pass can retry eligible files.
        if (store.getCached(key) === cached) store.invalidateItem(key);
      }
    }
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, items.length || 1));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/** Cold-warm the local source into the `ContextStore` (fs binding of
 * the generic `warmSource`). `sourceUrl` is the absolute root path;
 * scope with `WarmSourceOptions.prefix` to warm one subtree. Validates
 * cached files on every call; use before each local symbol/graph query. */
export async function warmSource(
  env: SourceEnv,
  sourceUrl: string,
  options: WarmSourceOptions = {}
): Promise<void> {
  await refreshCachedFiles(env, sourceUrl, options);
  return warmSourceGeneric(rawFs, env, sourceUrl, options);
}

/** Cold grep over the local source (fs binding of the generic
 * `grepSource`): lazy — reads files in deterministic search order and
 * stops once `maxResults` is settled; hits are identical to
 * warm-then-`grep`. `prefix` scopes which files are read. Cached files
 * are validated on every call, without the readFile validation TTL. */
export async function grepSource(
  env: SourceEnv,
  sourceUrl: string,
  pattern: string,
  options: WarmSourceOptions & GrepOptions = {}
): Promise<GrepHit[]> {
  await refreshCachedFiles(env, sourceUrl, options);
  return grepSourceGeneric(rawFs, env, sourceUrl, pattern, options);
}
