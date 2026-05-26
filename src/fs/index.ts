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
// On top of the adapter it adds `grepSource`: a *cold* whole-tree
// search. The pure root `grep` only sees content already pulled into
// the store; `grepSource` enumerates the whole source, pulls every
// text file into the store in parallel (warming it), then greps the
// warm cache — owned end to end, no external scanner process.

import { fs as rawFs } from '@verevoir/sources/fs';
import type { SourceEnv } from '@verevoir/sources';
import { wrapWithCache, grep, contextStore, type GrepHit, type GrepOptions } from '../index.js';

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
// Cold grep — scan the whole source on demand, warming the store
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

/** Cold grep over a local source. Where the pure `grep` searches only
 * what `readFile` has already pulled into the store, this fans out to
 * the filesystem: it enumerates the whole tree via `getRepoTree`
 * (which already skips vendored / build dirs), reads every text file
 * into the `ContextStore` *in parallel* — warming it so subsequent
 * `readFile` / `grep` / `find_symbol` are cache hits — then runs the
 * pure `grep` over the now-warm cache for consistent, formatted hits.
 *
 * No external process: the walk, the reads, and the match are all
 * owned here. `sourceUrl` is the absolute root path (the fs adapter's
 * `repoUrl`). */
export async function grepSource(
  env: SourceEnv,
  sourceUrl: string,
  pattern: string,
  options: GrepOptions = {}
): Promise<GrepHit[]> {
  const store = options.store ?? contextStore;
  const tree = await rawFs.getRepoTree(env, sourceUrl);

  // Pull every (text, in-bounds) blob into the store at once.
  // `fsPromises.readFile` funnels through libuv's threadpool, so the
  // awaits overlap without unbounded fd use.
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

  return grep(pattern, { sources: [{ sourceId: sourceUrl, version: '' }] }, { ...options, store });
}
