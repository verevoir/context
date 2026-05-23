// @verevoir/context/github — cached GitHub source.
//
// Drop-in replacement for `@verevoir/sources/github` that adds
// read-through caching via the root `ContextStore`. The
// SourceAdapter contract is identical; consumers swap the import
// path to add caching, no other code changes.
//
// All caching logic lives in `wrapWithCache` at the root — this
// file is just the wiring. Per Adam's substrate framing
// (2026-05-23): "specific cache == cache + specific source".

import { github as rawGithub } from '@verevoir/sources/github';
import { wrapWithCache } from '../index.js';

export const github = wrapWithCache(rawGithub);

// Re-export the individual functions for ergonomic destructured
// imports. Same shape as `@verevoir/sources/github` — only the
// behaviour (cache-hit / cache-populate) differs.
export const readFile = github.readFile.bind(github);
export const listFiles = github.listFiles.bind(github);
export const getRepoTree = github.getRepoTree.bind(github);
export const writeFile = github.writeFile.bind(github);
export const ensureBranch = github.ensureBranch.bind(github);
export const ensureFork = github.ensureFork.bind(github);
export const openPullRequest = github.openPullRequest.bind(github);
export const getDefaultBranch = github.getDefaultBranch.bind(github);
