# Changelog

## 0.7.0 — 2026-05-26

- **`warmSource` / `grepSource` generalised to any file source** (root export). The cache-warming mechanism is now one adapter-parameterised function — `warmSource(adapter, env, sourceUrl, options)` — that enumerates via `adapter.getRepoTree` and reads via `adapter.readFile`. What varies per source is only enumeration + reading (the `SourceAdapter`); the warming itself (skip binary + oversized, bounded-concurrency parallel reads, `ref`-aware cache keys) is identical everywhere. Adds `WarmSourceOptions` (`store`, `ref`, `concurrency`; default concurrency 8 — bounds remote sources like GitHub, harmless for fs).
- **New: cold grep + cold `find_symbol` over GitHub** — `@verevoir/context/github` now exports `warmSource` + `grepSource` (github bindings of the generic). `findSymbols` composes over a warmed repo exactly as for fs.
- `@verevoir/context/fs`'s `warmSource` / `grepSource` are now thin bindings of the generic — identical public API + behaviour. (STDIO-83, GitHub slice + mechanism generalisation.)

## 0.6.0 — 2026-05-26

- **New: `warmSource` in `@verevoir/context/fs`** — the cold-search primitive extracted from `grepSource`. Pulls a whole local source into the `ContextStore` (enumerate via `getRepoTree`, parallel-read every in-bounds text file, skipping binary + oversized), so any pure cache-only operation then works across the whole source. Cold **symbol** search composes it: `await warmSource(...)` then `findSymbols(query, scope)` from `@verevoir/context/code` (which lazily tree-sitter-parses the warmed content). `grepSource` is now `warmSource` + `grep`. Kept out of the bundled API on `/fs` so the lean fs subpath doesn't pull in tree-sitter — the composition is the consumer's. (STDIO-83, find_symbol slice.)

## 0.5.0 — 2026-05-26

- **New: `grepSource` in `@verevoir/context/fs`** — cold whole-tree search. Where the pure root `grep` only sees content already pulled into the store, `grepSource` enumerates the source via `getRepoTree` (which already skips vendored / build dirs), pulls every in-bounds text file into the `ContextStore` in parallel — warming it for later `readFile` / `grep` / `find_symbol` — then runs the pure `grep` over the warm cache. Binary (NUL-byte) and oversized files are skipped. Owned end to end in Node: no external scanner process, no `PATH` dependence. (STDIO-83, fs slice.)

## 0.4.0 — 2026-05-24

- **New: `@verevoir/context/notion`** — cached drop-in for `@verevoir/sources/notion`, identical SourceAdapter contract plus read-through-with-validation via `wrapWithCache`. Consumers swap the import path to get caching with no other code changes.
- Bumped peer dep on `@verevoir/sources` to `^0.4.0` (the version that ships the Notion adapter).

## 0.3.1 — 2026-05-24

- Docs: README + llms.txt gain a "Most consumers reach this via MCP" section pointing at `@verevoir/mcp` and the `alwaysLoad: true` Claude Code config. Notes that the MCP server wires `@verevoir/context/github` + `/fs` under the hood, so its tools transparently benefit from `wrapWithCache`'s read-through-with-validation.

## 0.3.0 — 2026-05-24

**Read-through-with-validation** — `wrapWithCache` now uses the new `SourceAdapter.isFresh` primitive (added in `@verevoir/sources@0.3.0`) to validate cached entries instead of returning forever within the process.

- `readFile` cache hits inside the `validationTtlMs` window (default **10s**, configurable per `wrapWithCache` call) serve from cache without calling the source — same fast path as before.
- After the window elapses, the wrapper calls `source.isFresh(env, url, path, version, ref)`. `true` → refresh `cachedAt` and serve cache. `false` → re-fetch and repopulate.
- Set `validationTtlMs: 0` to validate on every cache hit; set `validationTtlMs: Infinity` to never validate (pre-0.3 behaviour).
- The wrapper's `readFile` now preserves the source-returned `sha` on cache hits (was empty string before). Callers can use the returned `sha` as a freshness handle for subsequent `isFresh` calls.
- New `isFresh` method on the wrapped adapter — pure pass-through to the source.

**ContextStore upgrade**:

- New `CachedContent` shape: `{ content, version, cachedAt }`.
- New `store.getCached(key)` returns the full triple. `store.getContent(key)` continues to return just the content string for backwards compat (used by `grep`).
- `store.setContent(key, content, version?, now?)` — `version` defaults to empty string; `now` defaults to `Date.now` (injectable for tests).
- New `store.touch(key, now?)` — refreshes `cachedAt` without touching content. Used internally after a successful `isFresh` check.

**Calibration philosophy** (per Adam, 2026-05-24): 10s is the starting position, not a commitment. The TTL is a dial to turn from observed cost vs staleness — the load-bearing decision is per-call configurability, not the default value.

**Breaking**: `ContextStore.setContent` signature gains optional params (still callable as `setContent(key, content)`). `wrapWithCache` cache hits now return the cached `sha`, not empty string. Both are _behavioural_ breaks rather than type-shape breaks — most consumers won't notice. Bumped peer dep to `@verevoir/sources@^0.3.0` for the `isFresh` contract.

## 0.2.0 — 2026-05-23

**Breaking restructure** — replaces `@verevoir/context/sources` with a per-source subpath pattern + a generic `wrapWithCache` primitive.

```ts
// 0.1.x
import { cachedReadFile } from '@verevoir/context/sources';
await cachedReadFile(env, repoUrl, path);

// 0.2.x — convenience subpath
import { readFile } from '@verevoir/context/github';
await readFile(env, repoUrl, path);

// 0.2.x — custom adapter via the generic decorator
import { wrapWithCache } from '@verevoir/context';
import { mySource } from 'my-source-pkg';
const cached = wrapWithCache(mySource);
await cached.readFile(env, sourceUrl, path);
```

**The model** (per Adam's substrate framing): a cache implements the same contract as the source it wraps. So `@verevoir/context/github` is a drop-in replacement for `@verevoir/sources/github` — same `SourceAdapter` shape, plus caching. Same for `@verevoir/context/fs`.

**Two new subpaths**:

- `@verevoir/context/github` = `wrapWithCache(github)` from `@verevoir/sources/github`. Optional peer dep on `@verevoir/sources`.
- `@verevoir/context/fs` = `wrapWithCache(fs)` from `@verevoir/sources/fs`. Optional peer dep on `@verevoir/sources`.

**New export at the root**: `wrapWithCache(source, { store? })` — decorator that adds read-through caching to any SourceAdapter. For custom adapter implementations that aren't shipped as a convenience subpath.

Behaviour: `readFile` caches; `writeFile` passes through and populates the cache with the just-written content; everything else is pass-through at v0. Per-method caching (listFiles, getRepoTree) can layer in later if profiling shows it matters.

**Removed**: `@verevoir/context/sources` (the generic adapter-pluggable bridge that 0.1.x exposed). The per-source convenience + the generic `wrapWithCache` together cover the use cases more cleanly.

## 0.1.0 — 2026-05-23

Initial release.

- `@verevoir/context` — `ContextStore` (content + symbol cache) keyed `(sourceId, version, itemId)`. `createContextStore` factory + default singleton. `grep` over cached content. `IndexKey` + `SymbolEntry` types.
- `@verevoir/context/code` — tree-sitter symbol extraction (`parseSymbols`, `detectLanguage`) for TypeScript / TSX / JavaScript + `findSymbols` over the store. Optional peer deps on `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript`.
- `@verevoir/context/sources` — `cachedReadFile` bridge that pairs the store with `@verevoir/sources/github`. Optional peer dep on `@verevoir/sources`.
- Extracted from aigency-web's `src/server/code-index/*` per ADR 019 (substrate libraries).
