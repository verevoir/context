// @verevoir/context/fs — cached local-filesystem source.
//
// Drop-in replacement for `@verevoir/sources/fs` that adds
// read-through caching via the root `ContextStore`. SourceAdapter
// contract identical; consumers swap the import path to add
// caching, no other code changes.
//
// All caching logic lives in `wrapWithCache` at the root — this
// file is just the wiring. Per Adam's foundation framing
// (2026-05-23): "specific cache == cache + specific source".
//
// On top of the adapter it adds cold whole-source operations. The
// pure root `grep` / `findSymbols` only see content already pulled
// into the store; `warmSource` pulls a whole tree in so those
// operations work cold. `grepSource` bundles warm + grep.

import { fs as rawFs } from '@verevoir/sources/fs';
import type { SourceEnv } from '@verevoir/sources';
import {
  wrapWithCache,
  grep,
  contextStore,
  type ContextStore,
  type GrepHit,
  type GrepOptions,
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

// ============================================================
// Cold whole-source operations — pull the tree in, then search
// ============================================================

/** Files larger than this are skipped — too big to be worth pulling
 * into an in-memory grep index, and almost never source. */
const MAX_GREP_FILE_BYTES = 1_500_000;

/** Binary-content heuristic (ripgrep's): a NUL byte in the leading
 * chunk. Scans char codes so no control-char literal is embedded in
 * source. */
function looksBinary(content: string): boolean {
  const limit = Math.min(content.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

export interface WarmSourceOptions {
  /** Store to warm. Defaults to the module's singleton. */
  store?: ContextStore;
}

/** Pull a whole local source into the `ContextStore`. Enumerates the
 * tree via `getRepoTree` (which already skips vendored / build dirs),
 * then reads every in-bounds text file into the store *in parallel*
 * (`fsPromises.readFile` funnels through libuv's threadpool, so the
 * awaits overlap without unbounded fd use). Binary (NUL-byte) and
 * oversized files are skipped; already-warm entries are left alone.
 *
 * This is the cold-search primitive: once warm, the pure cache-only
 * operations work across the whole source —
 *   - `grep` (root) for text  (also bundled as `grepSource`), and
 *   - `findSymbols` (`@verevoir/context/code`) for symbol definitions
 *     (compose `await warmSource(...)` then `findSymbols(query, scope)`).
 *
 * `sourceUrl` is the absolute root path (the fs adapter's `repoUrl`). */
export async function warmSource(
  env: SourceEnv,
  sourceUrl: string,
  options: WarmSourceOptions = {}
): Promise<void> {
  const store = options.store ?? contextStore;
  const tree = await rawFs.getRepoTree(env, sourceUrl);
  await Promise.all(
    tree.entries.map(async (entry) => {
      if (entry.type !== 'blob') return;
      if (entry.size !== undefined && entry.size > MAX_GREP_FILE_BYTES) return;
      const key = { sourceId: sourceUrl, version: '', itemId: entry.path };
      if (store.getContent(key) !== undefined) return; // already warm
      try {
        const { content, sha } = await rawFs.readFile(env, sourceUrl, entry.path);
        if (looksBinary(content)) return;
        store.setContent(key, content, sha);
      } catch {
        // Raced (file vanished/renamed since the walk) or unreadable.
      }
    })
  );
}

/** Cold grep over a local source: `warmSource` the whole tree, then
 * run the pure `grep` over the now-warm cache for consistent,
 * formatted hits. Owned end to end — no external scanner process. */
export async function grepSource(
  env: SourceEnv,
  sourceUrl: string,
  pattern: string,
  options: GrepOptions = {}
): Promise<GrepHit[]> {
  const store = options.store ?? contextStore;
  await warmSource(env, sourceUrl, { store });
  return grep(pattern, { sources: [{ sourceId: sourceUrl, version: '' }] }, { ...options, store });
}
