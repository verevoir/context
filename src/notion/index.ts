// @verevoir/context/notion — cached Notion source.
//
// Drop-in replacement for `@verevoir/sources/notion` that adds
// read-through-with-validation caching via the root `ContextStore`.
// SourceAdapter contract identical; consumers swap the import path
// to add caching, no other code changes.
//
// All caching logic lives in `wrapWithCache` at the root — this
// file is just the wiring. Per Adam's substrate framing
// (2026-05-23): "specific cache == cache + specific source".

import { notion as rawNotion } from '@verevoir/sources/notion';
import { wrapWithCache } from '../index.js';

export const notion = wrapWithCache(rawNotion);

export const readFile = notion.readFile.bind(notion);
export const listFiles = notion.listFiles.bind(notion);
export const getRepoTree = notion.getRepoTree.bind(notion);
export const isFresh = notion.isFresh.bind(notion);
export const writeFile = notion.writeFile.bind(notion);
export const ensureBranch = notion.ensureBranch.bind(notion);
export const ensureFork = notion.ensureFork.bind(notion);
export const openPullRequest = notion.openPullRequest.bind(notion);
export const getDefaultBranch = notion.getDefaultBranch.bind(notion);
