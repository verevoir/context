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
// `warmSource` / `grepSource` are the fs bindings of the generic
// cold-warm + cold-grep mechanism (root `index.ts`). The mechanism is
// identical across file sources; the fs adapter supplies how files
// are enumerated and read.

import { fs as rawFs } from '@verevoir/sources/fs';
import type { SourceEnv } from '@verevoir/sources';
import {
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

/** Cold-warm the local source into the `ContextStore` (fs binding of
 * the generic `warmSource`). `sourceUrl` is the absolute root path;
 * scope with `WarmSourceOptions.prefix` to warm one subtree. */
export function warmSource(
  env: SourceEnv,
  sourceUrl: string,
  options: WarmSourceOptions = {}
): Promise<void> {
  return warmSourceGeneric(rawFs, env, sourceUrl, options);
}

/** Cold grep over the local source (fs binding of the generic
 * `grepSource`): lazy — reads files in deterministic search order and
 * stops once `maxResults` is settled; hits are identical to
 * warm-then-`grep`. `prefix` scopes which files are read. */
export function grepSource(
  env: SourceEnv,
  sourceUrl: string,
  pattern: string,
  options: WarmSourceOptions & GrepOptions = {}
): Promise<GrepHit[]> {
  return grepSourceGeneric(rawFs, env, sourceUrl, pattern, options);
}
