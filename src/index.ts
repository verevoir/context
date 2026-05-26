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

/** Cached content + the metadata needed to validate it later.
 * `version` is the source-specific version handle (git blob sha,
 * FS content hash, Trello dateLastActivity, etc.) — the value
 * `SourceAdapter.isFresh` will be called with. `cachedAt` is the
 * ms-epoch timestamp of the last successful fetch or refresh;
 * `wrapWithCache` uses it to gate freshness checks behind a TTL. */
export interface CachedContent {
  content: string;
  version: string;
  cachedAt: number;
}

/** A ContextStore instance — content cache + symbol cache + the
 * housekeeping that keeps them in sync (set-content drops the
 * matching symbols entry; set-symbols presumes content is fresh).
 *
 * The module exports a default singleton (`contextStore`) plus a
 * factory (`createContextStore`) so tests and multi-tenant
 * consumers can spin up isolated instances. */
export interface ContextStore {
  /** Returns just the cached content string. Sugar over `getCached`
   * for consumers (like `grep`) that don't care about version /
   * cachedAt. */
  getContent(key: IndexKey): string | undefined;
  /** Returns the full cached record (content + version handle +
   * cachedAt timestamp). Used by `wrapWithCache` for freshness
   * validation. */
  getCached(key: IndexKey): CachedContent | undefined;
  /** Stores content with an optional version handle. `cachedAt` is
   * set to `now()` (defaults to `Date.now`; injectable for tests).
   * Pass an empty `version` when the source has no version concept
   * (or the caller doesn't have one to record). */
  setContent(key: IndexKey, content: string, version?: string, now?: () => number): void;
  getSymbols(key: IndexKey): SymbolEntry[] | undefined;
  setSymbols(key: IndexKey, entries: SymbolEntry[]): void;
  /** Refreshes the `cachedAt` timestamp on an existing entry
   * without touching content or version. `wrapWithCache` calls this
   * after a successful `isFresh` check so the next read can serve
   * from cache without re-checking. No-op when the entry is absent. */
  touch(key: IndexKey, now?: () => number): void;
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
  /** Serialise the whole store (content + symbols) to a JSON string —
   * the *park* half of park/restore. Restore by passing the result to
   * `createContextStore({ serialized })`. Versioned + round-trips, so a
   * stateless host can put a warm cache down and pick it up later. */
  serialize(): string;
}

/** Wire snapshot of a ContextStore — both maps as entry arrays,
 * versioned so a format change is detectable on restore. */
interface StoreSnapshot {
  v: number;
  contents: Array<[string, CachedContent]>;
  symbols: Array<[string, SymbolEntry[]]>;
}
const SNAPSHOT_VERSION = 1;

export interface CreateContextStoreOptions {
  /** Restore from a prior `serialize()` snapshot. Malformed input or a
   * version mismatch yields an empty store (never throws) — a stale
   * snapshot format degrades to a cold start, not a crash. */
  serialized?: string;
}

export function createContextStore(options: CreateContextStoreOptions = {}): ContextStore {
  const contents = new Map<string, CachedContent>();
  const symbols = new Map<string, SymbolEntry[]>();

  if (options.serialized !== undefined) {
    try {
      const snap = JSON.parse(options.serialized) as StoreSnapshot;
      if (snap && snap.v === SNAPSHOT_VERSION) {
        for (const [k, v] of snap.contents ?? []) contents.set(k, v);
        for (const [k, v] of snap.symbols ?? []) symbols.set(k, v);
      }
    } catch {
      // Malformed snapshot → cold start (empty store).
    }
  }

  return {
    getContent(key) {
      return contents.get(flatKey(key))?.content;
    },
    getCached(key) {
      return contents.get(flatKey(key));
    },
    setContent(key, content, version = '', now = Date.now) {
      const k = flatKey(key);
      contents.set(k, { content, version, cachedAt: now() });
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
    touch(key, now = Date.now) {
      const k = flatKey(key);
      const existing = contents.get(k);
      if (existing) {
        contents.set(k, { ...existing, cachedAt: now() });
      }
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
    serialize() {
      const snap: StoreSnapshot = {
        v: SNAPSHOT_VERSION,
        contents: [...contents.entries()],
        symbols: [...symbols.entries()],
      };
      return JSON.stringify(snap);
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

/** Default ms-window during which the wrapper serves cache without
 * asking the source whether the held version is still current.
 * 10s is the starting position — long enough to cover a tool-loop's
 * burst of correlated reads, short enough that the cheap upstream
 * ping doesn't pile up. Per-call override via `validationTtlMs`.
 * It's a dial; tune from observed cost vs staleness, not theory. */
export const DEFAULT_VALIDATION_TTL_MS = 10_000;

export interface WrapWithCacheOptions {
  /** Store to read/write. Defaults to the module's singleton. */
  store?: ContextStore;
  /** Skip the `isFresh` check entirely when the cached entry's
   * `cachedAt` is younger than this many milliseconds. Default
   * 10000. Set to 0 to validate on every cache hit; set to
   * `Infinity` to never validate (pre-isFresh behaviour). */
  validationTtlMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Returns a `SourceAdapter`-shaped facade that reads through the
 * ContextStore with read-through-with-validation semantics:
 *
 * - **`readFile`**: cache lookup first. If a hit and the entry is
 *   younger than `validationTtlMs` (default 10s), serve from cache.
 *   Otherwise call `source.isFresh(env, url, path, version, ref)`;
 *   on `true` refresh `cachedAt` and serve cache, on `false` fall
 *   through to fetch. Misses fetch + populate the cache.
 * - **`isFresh`**: pass-through to the source. The wrapper doesn't
 *   second-guess the source's freshness check — that's its whole
 *   reason for existing in the contract.
 * - **`writeFile`**: passes through, then populates the cache with
 *   the just-written content. The post-write source version isn't
 *   known (writeFile is `Promise<void>`), so the cached entry has
 *   `version: ''` and is forced-stale on its next freshness check
 *   — readers re-fetch and pick up the real sha.
 * - **Other methods**: pure pass-throughs. The symbol cache and
 *   grep operate on what `readFile` has populated. Per-method
 *   caching (listFiles, getRepoTree) can layer in later if
 *   profiling shows it matters.
 *
 * Per Adam's foundation model (2026-05-23): a specific cache IS a
 * specific source — same contract — so the consumer just imports
 * `@verevoir/context/<kind>` and gets caching + freshness for free.
 */
export function wrapWithCache(
  source: SourceAdapter,
  options: WrapWithCacheOptions = {}
): SourceAdapter {
  const store = options.store ?? contextStore;
  const ttl = options.validationTtlMs ?? DEFAULT_VALIDATION_TTL_MS;
  const now = options.now ?? Date.now;
  return {
    async readFile(
      env: SourceEnv,
      sourceUrl: string,
      path: string,
      ref?: string
    ): Promise<ReadFileResult> {
      const versionKey = ref ?? '';
      const key = { sourceId: sourceUrl, version: versionKey, itemId: path };
      const cached = store.getCached(key);
      if (cached !== undefined) {
        const age = now() - cached.cachedAt;
        if (age < ttl) {
          // Inside the grace window — serve cache without asking.
          return { content: cached.content, sha: cached.version };
        }
        // Past the grace window — validate before serving.
        const fresh = await source.isFresh(env, sourceUrl, path, cached.version, ref);
        if (fresh) {
          // Refresh cachedAt so we don't recheck on the next read.
          store.touch(key, now);
          return { content: cached.content, sha: cached.version };
        }
        // Stale — fall through to fetch.
      }
      const result = await source.readFile(env, sourceUrl, path, ref);
      store.setContent(key, result.content, result.sha, now);
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
    async isFresh(
      env: SourceEnv,
      sourceUrl: string,
      path: string,
      version: string,
      ref?: string
    ): Promise<boolean> {
      return source.isFresh(env, sourceUrl, path, version, ref);
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
      // Populate cache with the just-written content. Version is
      // unknown (writeFile returns void), so the entry is forced-
      // stale next time it leaves the grace window — readers
      // re-fetch and pick up the real sha. `setContent`
      // invalidates any cached symbols for the same key, so
      // downstream find_symbol re-parses on the next query.
      const key = { sourceId: sourceUrl, version: branch, itemId: path };
      store.setContent(key, content, '', now);
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

// ============================================================
// warmSource — the one cache-warming mechanism, any file source
// ============================================================

/** Files larger than this are skipped while warming — too big to be
 * worth pulling into an in-memory index, and almost never source. */
const MAX_WARM_FILE_BYTES = 1_500_000;

/** Default concurrent file reads while warming. Bounded so a remote
 * source (GitHub API) can't fire hundreds of requests at once; fine
 * for local fs too (libuv caps fs I/O underneath regardless). */
const DEFAULT_WARM_CONCURRENCY = 8;

/** Binary-content heuristic (ripgrep's): a NUL byte in the leading
 * chunk. Char-code scan so no control-char literal sits in source. */
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
  /** Source version handle (git ref for GitHub). Defaults to '' — the
   * adapter's "default / latest". Threaded into the cache key + reads
   * so warmed entries line up with `readFile` and the search scope. */
  ref?: string;
  /** Max concurrent file reads. Default 8. */
  concurrency?: number;
}

/** Pull a whole file-source into the `ContextStore` — *the* cache-
 * warming mechanism, identical across file sources. What varies per
 * source is only how files are enumerated and read, which the
 * `SourceAdapter` abstracts (`getRepoTree` + `readFile`). Skips binary
 * + oversized files, reads up to `concurrency` at a time, and leaves
 * already-warm entries alone. Once warm, the pure cache-only ops
 * (`grep`, and `findSymbols` from `@verevoir/context/code`) work
 * across the whole source. */
export async function warmSource(
  adapter: SourceAdapter,
  env: SourceEnv,
  sourceUrl: string,
  options: WarmSourceOptions = {}
): Promise<void> {
  const store = options.store ?? contextStore;
  const ref = options.ref;
  const version = ref ?? '';
  const concurrency = options.concurrency ?? DEFAULT_WARM_CONCURRENCY;

  const tree = await adapter.getRepoTree(env, sourceUrl, ref);
  const blobs = tree.entries.filter(
    (e) => e.type === 'blob' && !(e.size !== undefined && e.size > MAX_WARM_FILE_BYTES)
  );

  let next = 0;
  async function worker(): Promise<void> {
    while (next < blobs.length) {
      const entry = blobs[next++];
      const key = { sourceId: sourceUrl, version, itemId: entry.path };
      if (store.getContent(key) !== undefined) continue;
      try {
        const { content, sha } = await adapter.readFile(env, sourceUrl, entry.path, ref);
        if (looksBinary(content)) continue;
        store.setContent(key, content, sha);
      } catch {
        // Raced (file changed/removed since enumeration) or unreadable.
      }
    }
  }
  const workers = Math.max(1, Math.min(concurrency, blobs.length || 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/** Cold grep over any file source: `warmSource` the whole tree, then
 * run the pure `grep` over the now-warm cache for consistent,
 * formatted hits. */
export async function grepSource(
  adapter: SourceAdapter,
  env: SourceEnv,
  sourceUrl: string,
  pattern: string,
  options: WarmSourceOptions & GrepOptions = {}
): Promise<GrepHit[]> {
  const store = options.store ?? contextStore;
  const version = options.ref ?? '';
  await warmSource(adapter, env, sourceUrl, options);
  return grep(pattern, { sources: [{ sourceId: sourceUrl, version }] }, { ...options, store });
}

// ============================================================
// wrapWorkflowWithCache — read-through caching for a WorkflowAdapter
// ============================================================

import type {
  WorkflowAdapter,
  WorkflowEnv,
  Card,
  Column,
  Comment,
  CardFilter,
  CardCreate,
  CardPatch,
  CustomFieldDef,
} from '@verevoir/workflows';

/** Workflow entries share the source cache so that park/restore
 * (`serialize` / `createContextStore({ serialized })`) snapshots
 * board state for free, alongside file content. A board has no
 * ref/commit concept, so every entry for a board lives under the
 * `(boardUrl, '')` keyspace; the per-card freshness handle
 * (`Card.lastActivity`) rides in `CachedContent.version`, exactly
 * as a git blob sha does for files. The `itemId` namespaces the
 * entity kind within the board so the kinds can't collide and bulk
 * invalidation can target list views. */
const WF_VERSION = '';
const wfCardItem = (cardId: string): string => `card:${cardId}`;
const wfCommentsItem = (cardId: string): string => `comments:${cardId}`;
const WF_COLUMNS_ITEM = 'columns';
const WF_CUSTOM_FIELDS_ITEM = 'customFields';
/** Stable, order-independent key for a `listCards` filter so the
 * same filter hits the same cache entry and different filters don't
 * clobber each other. */
function wfCardsItem(filter?: CardFilter): string {
  if (!filter) return 'cards:all';
  const parts = [
    filter.columnId ?? '',
    filter.assigneeId ?? '',
    filter.labelId ?? '',
    filter.parentId ?? '',
    filter.includeBody === false ? 'nb' : 'b',
    filter.limit != null ? `l${filter.limit}` : '',
  ];
  return `cards:${parts.join('|')}`;
}

export interface WrapWorkflowWithCacheOptions {
  /** Store to read/write. Defaults to the module's singleton. */
  store?: ContextStore;
  /** Window during which a cached entry is served without asking the
   * source whether it's still current. Default 10s (shared with the
   * source wrapper). For `getCard`, past the window the wrapper calls
   * `isCardFresh`; for list reads (no per-list freshness primitive)
   * the window elapsing forces a re-fetch. */
  validationTtlMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Returns a `WorkflowAdapter`-shaped facade that reads through the
 * `ContextStore` — the workflow twin of `wrapWithCache`. The whole
 * point: board state lands in the same store as file content, so a
 * stateless host parks both with one `serialize()` and picks them up
 * by id (STDIO-92 → STDIO-97), resuming warm without re-fetching.
 *
 * - **`getCard`**: read-through-with-validation. Cache hit inside the
 *   grace window serves immediately; past it, `isCardFresh` (against
 *   the held `Card.lastActivity`) decides serve-vs-refetch — the same
 *   contract the `WorkflowAdapter` exposes for exactly this purpose.
 * - **`listColumns` / `listCards` / `listComments` / `listCustomFields`**:
 *   TTL-only caching. There is no per-list freshness primitive, so
 *   within the window the cached list is served and past it it's
 *   re-fetched. A restored or aged list can therefore lag the source
 *   until the window expires — acceptable for the host's
 *   orient-on-summaries-then-detail (headers-first) pattern; the
 *   restore-time freshness policy is STDIO-97's concern.
 * - **Writes** (`createCard` / `updateCard` / `moveCard` / `addComment`):
 *   pass through, then invalidate what the write could have changed —
 *   the touched card plus every list view (membership/order can shift),
 *   or the card's comments. Keeps a same-process read-after-write
 *   honest without a freshness round-trip.
 *
 * Returned cards/lists are JSON-decoded fresh on every read, so the
 * cache can't be mutated through a returned reference. Cross-surface
 * invalidation (a Notion DB-row write dropping the source-cache entry
 * for that page) is a separate, deferred concern.
 */
export function wrapWorkflowWithCache(
  adapter: WorkflowAdapter,
  options: WrapWorkflowWithCacheOptions = {}
): WorkflowAdapter {
  const store = options.store ?? contextStore;
  const ttl = options.validationTtlMs ?? DEFAULT_VALIDATION_TTL_MS;
  const now = options.now ?? Date.now;

  /** TTL-only read-through for the list-shaped reads: serve the cached
   * JSON within the window, else fetch + repopulate. */
  async function ttlCached<T>(
    boardUrl: string,
    itemId: string,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const key = { sourceId: boardUrl, version: WF_VERSION, itemId };
    const cached = store.getCached(key);
    if (cached !== undefined && now() - cached.cachedAt < ttl) {
      return JSON.parse(cached.content) as T;
    }
    const fresh = await fetcher();
    store.setContent(key, JSON.stringify(fresh), '', now);
    return fresh;
  }

  /** Drop every list-view entry for a board. A card write can change
   * list membership or ordering, so the cached lists (and columns,
   * for moves/creates) must go even though the individual card entry
   * is handled separately. */
  function invalidateLists(boardUrl: string): void {
    for (const itemId of store.listIndexedItems(boardUrl, WF_VERSION)) {
      if (itemId.startsWith('cards:') || itemId === WF_COLUMNS_ITEM) {
        store.invalidateItem({ sourceId: boardUrl, version: WF_VERSION, itemId });
      }
    }
  }

  return {
    async listColumns(env: WorkflowEnv, boardUrl: string): Promise<Column[]> {
      return ttlCached<Column[]>(boardUrl, WF_COLUMNS_ITEM, () =>
        adapter.listColumns(env, boardUrl)
      );
    },
    async listCards(env: WorkflowEnv, boardUrl: string, filter?: CardFilter): Promise<Card[]> {
      return ttlCached<Card[]>(boardUrl, wfCardsItem(filter), () =>
        adapter.listCards(env, boardUrl, filter)
      );
    },
    async getCard(env: WorkflowEnv, boardUrl: string, cardId: string): Promise<Card> {
      const key = { sourceId: boardUrl, version: WF_VERSION, itemId: wfCardItem(cardId) };
      const cached = store.getCached(key);
      if (cached !== undefined) {
        const age = now() - cached.cachedAt;
        if (age < ttl) {
          return JSON.parse(cached.content) as Card;
        }
        // Past the grace window — validate the held lastActivity.
        const fresh = await adapter.isCardFresh(env, boardUrl, cardId, cached.version);
        if (fresh) {
          store.touch(key, now);
          return JSON.parse(cached.content) as Card;
        }
        // Stale — fall through to re-fetch.
      }
      const card = await adapter.getCard(env, boardUrl, cardId);
      store.setContent(key, JSON.stringify(card), card.lastActivity ?? '', now);
      return card;
    },
    async isCardFresh(
      env: WorkflowEnv,
      boardUrl: string,
      cardId: string,
      version: string
    ): Promise<boolean> {
      return adapter.isCardFresh(env, boardUrl, cardId, version);
    },
    async createCard(
      env: WorkflowEnv,
      boardUrl: string,
      columnId: string,
      fields: CardCreate
    ): Promise<Card> {
      const card = await adapter.createCard(env, boardUrl, columnId, fields);
      store.setContent(
        { sourceId: boardUrl, version: WF_VERSION, itemId: wfCardItem(card.id) },
        JSON.stringify(card),
        card.lastActivity ?? '',
        now
      );
      invalidateLists(boardUrl);
      return card;
    },
    async updateCard(
      env: WorkflowEnv,
      boardUrl: string,
      cardId: string,
      patch: CardPatch
    ): Promise<void> {
      await adapter.updateCard(env, boardUrl, cardId, patch);
      store.invalidateItem({ sourceId: boardUrl, version: WF_VERSION, itemId: wfCardItem(cardId) });
      invalidateLists(boardUrl);
    },
    async moveCard(
      env: WorkflowEnv,
      boardUrl: string,
      cardId: string,
      toColumnId: string
    ): Promise<void> {
      await adapter.moveCard(env, boardUrl, cardId, toColumnId);
      store.invalidateItem({ sourceId: boardUrl, version: WF_VERSION, itemId: wfCardItem(cardId) });
      invalidateLists(boardUrl);
    },
    async listComments(env: WorkflowEnv, boardUrl: string, cardId: string): Promise<Comment[]> {
      return ttlCached<Comment[]>(boardUrl, wfCommentsItem(cardId), () =>
        adapter.listComments(env, boardUrl, cardId)
      );
    },
    async addComment(
      env: WorkflowEnv,
      boardUrl: string,
      cardId: string,
      body: string
    ): Promise<void> {
      await adapter.addComment(env, boardUrl, cardId, body);
      store.invalidateItem({
        sourceId: boardUrl,
        version: WF_VERSION,
        itemId: wfCommentsItem(cardId),
      });
    },
    async listCustomFields(env: WorkflowEnv, boardUrl: string): Promise<CustomFieldDef[]> {
      return ttlCached<CustomFieldDef[]>(boardUrl, WF_CUSTOM_FIELDS_ITEM, () =>
        adapter.listCustomFields(env, boardUrl)
      );
    },
  };
}
