// @verevoir/context — in-process content + symbol cache for LLM
// context windows.
//
// Keyed `(sourceId, version, itemId)` — today realised as
// `(repoUrl, ref, path)` for git-style sources but the shape is
// generic. Two payload types:
//
//   - content cache: bytes (or text) the consumer has fetched
//   - symbol cache: parsed-symbol view of the same item (when the
//     payload is code; populated lazily by the `/code` subpath)
//
// Pure in-memory. No I/O — the cache holds what consumers put in it.
// `wrapWithCache(source)` here returns a SourceAdapter-shaped facade
// that reads through the cache; per-source convenience wrappers live
// in subpaths (`@verevoir/context/github` = wrap-cache + github,
// `@verevoir/context/fs` = wrap-cache + fs). Tree-sitter symbol
// extraction lives in `/code`.
//
// Scope: per-process. A Cloud Run instance, a long-running worker,
// a CLI invocation — each holds its own. Cross-instance share lands
// when projects grow past per-process working sets.

/** Symbol payload — language-agnostic structural shape. The `/code`
 * subpath populates these from tree-sitter parses; consumers can
 * also populate from their own parsers. */
export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum';

export interface SymbolEntry {
  /** Bare identifier — `AuthHandler`, not `class AuthHandler`. */
  name: string;
  kind: SymbolKind;
  /** 1-indexed line in the source. */
  startLine: number;
  /** 1-indexed line at the end of the declaration. */
  endLine: number;
}

/** Three-part lookup key for content + symbols. The `sourceId` is
 * the canonical identifier (typically a URL); `version` is the
 * source-specific version handle (git ref, etag, content hash); the
 * `itemId` is the source-local path (file path, page id, etc.). */
export interface IndexKey {
  /** Today named `repoUrl` for git sources; generalises to source
   * URLs (S3 bucket URL, wiki space URL) for other adapters. */
  sourceId: string;
  /** Git ref for code; etag / last-modified / content-hash for
   * non-git sources. Empty string is the canonical "default" /
   * "latest" sentinel. */
  version: string;
  /** Item identifier within the source — usually a path. */
  itemId: string;
}

// NUL byte as separator: never appears in URLs, refs, or paths, so
// concatenation can't collide. The NUL also makes the
// `(sourceId, version)` prefix a clean substring boundary for bulk
// invalidations + listIndexedItems.
const SEP = '\x00';
function flatKey(key: IndexKey): string {
  return `${key.sourceId}${SEP}${key.version}${SEP}${key.itemId}`;
}
function versionPrefix(sourceId: string, version: string): string {
  return `${sourceId}${SEP}${version}${SEP}`;
}

/** A ContextStore instance — content cache + symbol cache + the
 * housekeeping that keeps them in sync (set-content drops the
 * matching symbols entry; set-symbols presumes content is fresh).
 *
 * The module exports a default singleton (`contextStore`) plus a
 * factory (`createContextStore`) so tests and multi-tenant
 * consumers can spin up isolated instances. */
export interface ContextStore {
  getContent(key: IndexKey): string | undefined;
  setContent(key: IndexKey, content: string): void;
  getSymbols(key: IndexKey): SymbolEntry[] | undefined;
  setSymbols(key: IndexKey, entries: SymbolEntry[]): void;
  /** Drop both content and symbols for one item. */
  invalidateItem(key: IndexKey): void;
  /** Drop every entry (content + symbols) for one
   * `(sourceId, version)` — used when a commit lands on the ref,
   * or an etag changes. */
  invalidateVersion(sourceId: string, version: string): void;
  /** Items under a given `(sourceId, version)` that have cached
   * content. Backs `grep` and repo-map style listings. */
  listIndexedItems(sourceId: string, version: string): string[];
  /** Drop everything. Test affordance; in production state lives
   * the lifetime of the host process. */
  clearAll(): void;
}

export function createContextStore(): ContextStore {
  const contents = new Map<string, string>();
  const symbols = new Map<string, SymbolEntry[]>();

  return {
    getContent(key) {
      return contents.get(flatKey(key));
    },
    setContent(key, content) {
      const k = flatKey(key);
      contents.set(k, content);
      // Content changed → any cached symbols for this item are
      // stale; drop them. The next getSymbols miss tells the
      // caller to re-parse.
      symbols.delete(k);
    },
    getSymbols(key) {
      return symbols.get(flatKey(key));
    },
    setSymbols(key, entries) {
      symbols.set(flatKey(key), entries);
    },
    invalidateItem(key) {
      const k = flatKey(key);
      contents.delete(k);
      symbols.delete(k);
    },
    invalidateVersion(sourceId, version) {
      const prefix = versionPrefix(sourceId, version);
      for (const k of contents.keys()) {
        if (k.startsWith(prefix)) contents.delete(k);
      }
      for (const k of symbols.keys()) {
        if (k.startsWith(prefix)) symbols.delete(k);
      }
    },
    listIndexedItems(sourceId, version) {
      const prefix = versionPrefix(sourceId, version);
      const out: string[] = [];
      for (const k of contents.keys()) {
        if (k.startsWith(prefix)) {
          out.push(k.slice(prefix.length));
        }
      }
      return out.sort();
    },
    clearAll() {
      contents.clear();
      symbols.clear();
    },
  };
}

/** Default singleton used by typical consumers. Tests and isolated
 * use cases should prefer `createContextStore()`. */
export const contextStore: ContextStore = createContextStore();

// ============================================================
// Grep — substring search over cached content
// ============================================================

export interface GrepScope {
  /** Set of `(sourceId, version)` pairs to search across. */
  sources: Array<{ sourceId: string; version: string }>;
}

export interface GrepHit {
  sourceId: string;
  itemId: string;
  /** 1-indexed line number. */
  lineNumber: number;
  /** The full matching line. */
  line: string;
  /** Up to `contextLines` lines before the hit (default 2). */
  contextBefore: string[];
  /** Up to `contextLines` lines after the hit (default 2). */
  contextAfter: string[];
}

export interface GrepOptions {
  /** Hard cap on hits returned. Default 50. */
  maxResults?: number;
  /** Case-insensitive substring match. Default false (case-sensitive). */
  ignoreCase?: boolean;
  /** Lines of context before + after each hit. Default 2. */
  contextLines?: number;
  /** Store to search. Defaults to the module's singleton. */
  store?: ContextStore;
}

const DEFAULT_GREP_MAX = 50;
const DEFAULT_GREP_CONTEXT = 2;

/** Plain-substring search across cached content. Operates on items
 * the consumer has fetched into the store — does not fan out to
 * the underlying source. Pure local lookup. */
export function grep(pattern: string, scope: GrepScope, options: GrepOptions = {}): GrepHit[] {
  const max = options.maxResults ?? DEFAULT_GREP_MAX;
  const context = options.contextLines ?? DEFAULT_GREP_CONTEXT;
  const ignoreCase = options.ignoreCase ?? false;
  const store = options.store ?? contextStore;
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const hits: GrepHit[] = [];

  for (const { sourceId, version } of scope.sources) {
    const items = store.listIndexedItems(sourceId, version);
    for (const itemId of items) {
      if (hits.length >= max) return hits;
      const content = store.getContent({ sourceId, version, itemId });
      if (content === undefined) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= max) return hits;
        const haystack = ignoreCase ? lines[i].toLowerCase() : lines[i];
        if (!haystack.includes(needle)) continue;
        hits.push({
          sourceId,
          itemId,
          lineNumber: i + 1,
          line: lines[i],
          contextBefore: lines.slice(Math.max(0, i - context), i),
          contextAfter: lines.slice(i + 1, i + 1 + context),
        });
      }
    }
  }
  return hits;
}

// ============================================================
// wrapWithCache — adds read-through caching to any SourceAdapter
// ============================================================

import type {
  SourceAdapter,
  SourceEnv,
  ReadFileResult,
  DirEntry,
  RepoTree,
} from '@verevoir/sources';

export interface WrapWithCacheOptions {
  /** Store to read/write. Defaults to the module's singleton. */
  store?: ContextStore;
}

/** Returns a `SourceAdapter`-shaped facade that reads through the
 * ContextStore. A drop-in replacement for the underlying source:
 * the contract is identical, the wrapping is invisible to callers.
 *
 * - `readFile` checks the cache; on miss, fetches via the source
 *   and populates the cache. Cache hits return `sha: ''` (the
 *   source's sha is not preserved across cache rounds; callers
 *   that need a real sha should go to the source directly or
 *   re-fetch from cache-miss).
 * - `writeFile` passes through, then populates the cache with the
 *   just-written content so subsequent reads see it without a
 *   refetch.
 * - All other methods are pure pass-throughs at v0; the symbol
 *   cache and grep operate on what the cache already holds, fed
 *   primarily by `readFile`. Per-method caching (listFiles tree
 *   memoisation, etc.) can layer in later if profiling shows it
 *   matters.
 *
 * Per Adam's substrate model (2026-05-23): a specific cache IS a
 * specific source — same contract — so the consumer just imports
 * `@verevoir/context/<kind>` and gets caching for free, without
 * having to thread the adapter through every call site.
 */
export function wrapWithCache(
  source: SourceAdapter,
  options: WrapWithCacheOptions = {}
): SourceAdapter {
  const store = options.store ?? contextStore;
  return {
    async readFile(
      env: SourceEnv,
      sourceUrl: string,
      path: string,
      ref?: string
    ): Promise<ReadFileResult> {
      const version = ref ?? '';
      const key = { sourceId: sourceUrl, version, itemId: path };
      const cached = store.getContent(key);
      if (cached !== undefined) {
        return { content: cached, sha: '' };
      }
      const result = await source.readFile(env, sourceUrl, path, ref);
      store.setContent(key, result.content);
      return result;
    },
    async listFiles(
      env: SourceEnv,
      sourceUrl: string,
      prefix: string,
      ref?: string
    ): Promise<DirEntry[]> {
      return source.listFiles(env, sourceUrl, prefix, ref);
    },
    async getRepoTree(env: SourceEnv, sourceUrl: string, ref?: string): Promise<RepoTree> {
      return source.getRepoTree(env, sourceUrl, ref);
    },
    async writeFile(
      env: SourceEnv,
      sourceUrl: string,
      path: string,
      content: string,
      branch: string,
      commitMessage: string
    ): Promise<void> {
      await source.writeFile(env, sourceUrl, path, content, branch, commitMessage);
      // Populate cache with the just-written content. `setContent`
      // invalidates any cached symbols for the same key, so
      // downstream find_symbol re-parses on the next query.
      const key = { sourceId: sourceUrl, version: branch, itemId: path };
      store.setContent(key, content);
    },
    async ensureBranch(env: SourceEnv, sourceUrl: string, branch: string): Promise<void> {
      return source.ensureBranch(env, sourceUrl, branch);
    },
    async ensureFork(env: SourceEnv, upstreamUrl: string): Promise<string> {
      return source.ensureFork(env, upstreamUrl);
    },
    async openPullRequest(
      env: SourceEnv,
      targetUrl: string,
      head: string,
      base: string,
      title: string,
      body: string
    ): Promise<string> {
      return source.openPullRequest(env, targetUrl, head, base, title, body);
    },
    async getDefaultBranch(env: SourceEnv, sourceUrl: string): Promise<string> {
      return source.getDefaultBranch(env, sourceUrl);
    },
  };
}
