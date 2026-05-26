// @verevoir/context/github — cached GitHub source.
//
// Drop-in replacement for `@verevoir/sources/github` that adds
// read-through caching via the root `ContextStore`. The
// SourceAdapter contract is identical; consumers swap the import
// path to add caching, no other code changes.
//
// All caching logic lives in `wrapWithCache` at the root — this
// file is just the wiring. Per Adam's foundation framing
// (2026-05-23): "specific cache == cache + specific source".

import { github as rawGithub } from '@verevoir/sources/github';
import type { SourceEnv } from '@verevoir/sources';
import {
  wrapWithCache,
  warmSource as warmSourceGeneric,
  grepSource as grepSourceGeneric,
  type GrepHit,
  type GrepOptions,
  type WarmSourceOptions,
} from '../index.js';

export const github = wrapWithCache(rawGithub);

// Re-export the individual functions for ergonomic destructured
// imports. Same shape as `@verevoir/sources/github` — only the
// behaviour (cache-hit / cache-populate) differs.
export const readFile = github.readFile.bind(github);
export const listFiles = github.listFiles.bind(github);
export const getRepoTree = github.getRepoTree.bind(github);
export const isFresh = github.isFresh.bind(github);
export const writeFile = github.writeFile.bind(github);
export const ensureBranch = github.ensureBranch.bind(github);
export const ensureFork = github.ensureFork.bind(github);
export const openPullRequest = github.openPullRequest.bind(github);
export const getDefaultBranch = github.getDefaultBranch.bind(github);

/** Cold-warm a whole GitHub repo into the `ContextStore` (github
 * binding of the generic `warmSource`). `sourceUrl` is the repo URL;
 * pass `ref` for a branch/sha (defaults to the repo default). Reads
 * are concurrency-bounded (default 8) to stay clear of API rate
 * limits — the same mechanism as fs, only the enumerate/read differ. */
export function warmSource(
  env: SourceEnv,
  sourceUrl: string,
  options: WarmSourceOptions = {}
): Promise<void> {
  return warmSourceGeneric(rawGithub, env, sourceUrl, options);
}

/** Cold grep over a whole GitHub repo: warm, then pure `grep` over the
 * warm cache (github binding of the generic `grepSource`). */
export function grepSource(
  env: SourceEnv,
  sourceUrl: string,
  pattern: string,
  options: WarmSourceOptions & GrepOptions = {}
): Promise<GrepHit[]> {
  return grepSourceGeneric(rawGithub, env, sourceUrl, pattern, options);
}
