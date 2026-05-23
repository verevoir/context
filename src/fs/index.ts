// @verevoir/context/fs — cached local-filesystem source.
//
// Drop-in replacement for `@verevoir/sources/fs` that adds
// read-through caching via the root `ContextStore`. SourceAdapter
// contract identical; consumers swap the import path to add
// caching, no other code changes.
//
// All caching logic lives in `wrapWithCache` at the root — this
// file is just the wiring. Per Adam's substrate framing
// (2026-05-23): "specific cache == cache + specific source".

import { fs as rawFs } from '@verevoir/sources/fs';
import { wrapWithCache } from '../index.js';

export const fs = wrapWithCache(rawFs);

export const readFile = fs.readFile.bind(fs);
export const listFiles = fs.listFiles.bind(fs);
export const getRepoTree = fs.getRepoTree.bind(fs);
export const writeFile = fs.writeFile.bind(fs);
export const ensureBranch = fs.ensureBranch.bind(fs);
export const ensureFork = fs.ensureFork.bind(fs);
export const openPullRequest = fs.openPullRequest.bind(fs);
export const getDefaultBranch = fs.getDefaultBranch.bind(fs);
