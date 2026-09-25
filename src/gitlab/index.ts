// @verevoir/context/gitlab — cached GitLab source.
//
// Drop-in replacement for `@verevoir/sources/gitlab` that adds
// read-through caching via the root `ContextStore`. The
// SourceAdapter contract is identical; consumers swap the import
// path to add caching, no other code changes.
//
// All caching logic lives in `wrapWithCache` at the root — this
// file is just the wiring, exactly as for github: "specific cache ==
// cache + specific source". The adapter's host allowlist, origin pin
// and token handling live in `@verevoir/sources/gitlab` and are not
// weakened by the cache: a cache miss goes through the raw adapter.

import { gitlab as rawGitlab } from '@verevoir/sources/gitlab';
import type { SourceEnv } from '@verevoir/sources';
import {
  wrapWithCache,
  warmSource as warmSourceGeneric,
  grepSource as grepSourceGeneric,
  type GrepHit,
  type GrepOptions,
  type WarmSourceOptions,
} from '../index.js';

// URL helpers pass straight through, so a router can route and read
// through one import.
export { isGitlabUrl, parseGitlabProjectUrl } from '@verevoir/sources/gitlab';

export const gitlab = wrapWithCache(rawGitlab);

// Re-export the individual functions for ergonomic destructured
// imports. Same shape as `@verevoir/sources/gitlab` — only the
// behaviour (cache-hit / cache-populate) differs.
export const readFile = gitlab.readFile.bind(gitlab);
export const listFiles = gitlab.listFiles.bind(gitlab);
export const getRepoTree = gitlab.getRepoTree.bind(gitlab);
export const isFresh = gitlab.isFresh.bind(gitlab);
export const writeFile = gitlab.writeFile.bind(gitlab);
export const commitFiles = gitlab.commitFiles.bind(gitlab);
export const ensureBranch = gitlab.ensureBranch.bind(gitlab);
export const ensureFork = gitlab.ensureFork.bind(gitlab);
export const openPullRequest = gitlab.openPullRequest.bind(gitlab);
export const getDefaultBranch = gitlab.getDefaultBranch.bind(gitlab);

/** Cold-warm a GitLab project into the `ContextStore` (gitlab binding
 * of the generic `warmSource`). `sourceUrl` is the project URL; pass
 * `ref` for a branch/sha (defaults to the project default) and
 * `WarmSourceOptions.prefix` to warm one subtree. Reads are
 * concurrency-bounded (default 8) — which matters more on GitLab than
 * GitHub: gitlab.com rate-limits anonymous API reads tightly. */
export function warmSource(
  env: SourceEnv,
  sourceUrl: string,
  options: WarmSourceOptions = {}
): Promise<void> {
  return warmSourceGeneric(rawGitlab, env, sourceUrl, options);
}

/** Cold grep over a GitLab project (gitlab binding of the generic
 * `grepSource`): lazy — reads files in deterministic search order and
 * stops once `maxResults` is settled; hits are identical to
 * warm-then-`grep`. `prefix` scopes which files are read — a real
 * saving against API rate limits. */
export function grepSource(
  env: SourceEnv,
  sourceUrl: string,
  pattern: string,
  options: WarmSourceOptions & GrepOptions = {}
): Promise<GrepHit[]> {
  return grepSourceGeneric(rawGitlab, env, sourceUrl, pattern, options);
}
