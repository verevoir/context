// @verevoir/context/sources — bridge between a `@verevoir/sources`
// SourceAdapter and the root `ContextStore`.
//
// Wraps `readFile` with cache-lookup + populate-on-miss. First call
// for a given `(sourceId, version, itemId)` triggers the adapter
// fetch; subsequent calls return cached content without re-fetching.
//
// Peer dep on `@verevoir/sources` is optional in the package
// manifest — consumers using `@verevoir/context` purely as an
// in-memory cache (writing their own values via `setContent`) don't
// need to install it.

import { type SourceEnv } from '@verevoir/sources';
import { readFile } from '@verevoir/sources/github';
import { contextStore as defaultContextStore, type ContextStore } from '../index.js';

export interface CachedReadOptions {
  /** Source version to use as the cache key. Defaults to the empty
   * string — the canonical "default branch / latest" sentinel. */
  version?: string;
  /** Store to read/write. Defaults to the module's singleton. */
  store?: ContextStore;
}

/** Read a file from a GitHub repo via `@verevoir/sources/github`,
 * with an in-process cache layered on top via `ContextStore`. Misses
 * fetch and populate the store; hits return immediately.
 *
 * The cache key is `(repoUrl, version, path)` — the empty-string
 * version sentinel keeps default-branch reads in a stable slot so
 * different call sites reading the same file at default share the
 * cache.
 *
 * For non-GitHub sources, callers can implement an equivalent bridge
 * using their adapter's `readFile` and the same store. */
export async function cachedReadFile(
  env: SourceEnv,
  repoUrl: string,
  path: string,
  options: CachedReadOptions = {}
): Promise<string> {
  const version = options.version ?? '';
  const store = options.store ?? defaultContextStore;
  const key = { sourceId: repoUrl, version, itemId: path };
  const cached = store.getContent(key);
  if (cached !== undefined) return cached;
  // Map empty-string sentinel back to "no ref" for the adapter.
  const ref = version === '' ? undefined : version;
  const { content } = await readFile(env, repoUrl, path, ref);
  store.setContent(key, content);
  return content;
}
