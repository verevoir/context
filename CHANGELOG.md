# Changelog

## 0.14.0 — 2026-07-19

- **Lazy cold ops** (STDIO-584). Small one-shot operations no longer pay for a whole-tree warm:
  - **`WarmSourceOptions.prefix`** — scope `warmSource` / `grepSource` to one subtree. Normalised (`'src'` ≡ `'src/'`) and segment-aware (`'src'` never covers `'srcx/…'`); composes with `include` / `exclude`.
  - **`grepSource` early-terminates.** It now processes files in the deterministic search order (sorted item ids — the same order the pure `grep` scans a fully-warmed store) with the warm `concurrency` as a bounded read-ahead window, and stops scheduling reads once `maxResults` hits are settled by a contiguous completed prefix of that order. Contract (pinned by test against the eager path): the hits are exactly what `warmSource`-then-`grep` would return for the same options, prefix included — a prefix-scoped call compares against a prefix-scoped warm; early termination changes how much is read, never what is returned. Files it does read are warmed into the store with the same skip rules (binary + oversized skipped, already-warm entries served from cache, not re-read).
  - Design stance: the laziness lives in the cold-op path — `warmSource` called directly is unchanged, so long-session consumers that warm eagerly by choice (the multi-day regime) are unaffected.
- **CI: the antagonistic gate reviews the live merge-base** (STDIO-584). The panel's diff range now resolves against the live base ref via an extracted, unit-tested `resolve-merge-base.sh` (the frozen event sha is fallback only; fail-closed when no merge base exists or the diff would be empty) — ending the wrong-diff reviews observed whenever main moved after a PR opened. Hardening absorbed from the review rounds: CR-stripping + %-encoding in the aggregator's workflow-command neutralisation, bounded jq parses and a capped oversize read, a same-repo guard so fork PRs never run with panelist secrets, and step-level timeouts on every workflow step. (The 5-lens panel itself landed with STDIO-564.)

## 0.13.0 — 2026-07-05

- **`wrapWithCache` covers `commitFiles`** (STDIO-543). The multi-file, atomically-committed twin of `writeFile` (added to the `SourceAdapter` contract in `@verevoir/sources@0.7.0`) now passes through the cache facade and applies the identical cache treatment to every file in the set: populate the just-written content under the `version: branch` key with an unknown (forced-stale) version so the next freshness check re-fetches the real sha, and drop the `version: ''` default-branch alias so a later no-ref read can't serve pre-commit content — the same dual-scope invariant `writeFile` holds (STDIO-134), now per file across the whole change-set. Bumps the `@verevoir/sources` dep to `^0.7.0` for the `commitFiles` contract.

## 0.12.1 — 2026-06-29

- Publish the refreshed `llms.txt` surface — adds the `@verevoir/context/concept-network` subpath entry (current as of #19 but unpublished at 0.12.0).
- Bump `@verevoir/workflows` — devDep `^0.5.0` → `^0.6.1` and peer `*` → `^0.6.0` — picking up 0.6.1 with the vite `server.fs.deny` security override.

## 0.12.0 — 2026-06-28

- **New: `@verevoir/context/concept-network`** (STDIO-488) — v1 concept-link accumulator: the observation trail for differential ingestion (ADR 014 §7). Persists `ClaimRecord`s (concept mentions with mandatory provenance + timestamp) and `ConceptLink`s as append-only JSONL files; materialises an in-memory `ConceptGraph` on read with a derived, rebuildable JSON index (never canonical state). Provides recurrence counting weighted by source independence (independent-source count outweighs raw mention count) and temporal trail with structural supersession check (does a connecting `supersededBy` or labelled link record exist?). Two clean seam interfaces for the deferred semantic layers: `TopicMatcher` (baseline: `NormalisedKeyMatcher` — normalised-key exact grouping; deferred: embedding-based concept identity) and `TensionDetector` (baseline: `StructuralOnlyDetector` — always returns `false`; deferred: model-driven contradiction detection). Per-project partitioned (`storeRoot/<projectId>/`). Same primitive shape as `@verevoir/context/code`'s code graph, one domain over (concepts + relationships instead of symbols + relationships).

## 0.11.1 — 2026-06-08

- **Fix: large files no longer crash symbol / graph search** (STDIO-313). node-tree-sitter's `parse()` reads the source through a chunk callback bounded by `bufferSize` (default ~32KB) and throws `Invalid argument` for any source larger than that — so a single file over ~32KB (common in real repos and vendored deps) crashed `find_symbol` / `code_graph` outright. It predates the multi-language work (large TS/JS files hit it too); a Python tree with vendored deps surfaced it. `parseCode` now sizes `bufferSize` to the source's UTF-8 byte length, and `symbolsForItem` / `edgesForItem` swallow a per-file parse failure (degrade to empty, cache it) so one unparseable file can never crash a whole-source search. Verified against a 3033-file tree: previously 30+ throws, now 0.

## 0.11.0 — 2026-06-08

- **Multi-language code graph** (STDIO-313). `parseCode` / `parseSymbols` / `findSymbols` / `edgesForItem` now cover **Python, Java, C#, Go, Scala, C and C++** in addition to TypeScript/TSX/JavaScript. The parser is driven by a per-language `LanguageConfig` (symbol-kind map, scope nodes, call + member/attribute/selector resolution, import/using/include extraction), so the tree-sitter node-name divergence between grammars lives in one place — adding a language is one config entry plus a grammar dep. `detectLanguage` maps the new extensions (`.py`/`.pyi`, `.java`, `.cs`, `.go`, `.scala`/`.sc`, `.c`/`.h`, `.cpp`/`.cc`/`.cxx`/`.hpp`/…). The new grammars are optional peer deps; the runtime stays on `tree-sitter` 0.21.1. Kotlin is deferred — its community grammar fails to build on node 24 (STDIO-316).

## 0.10.0 — 2026-06-07

- **Code-graph edges** (STDIO-313). `parseCode` now returns import + call edges alongside symbols; `edgesForItem` lazily parses + caches them per item. `ContextStore` gains `getEdges` / `setEdges` / `listIndexedItems` and v2 serialization (edges park/restore with content + symbols). Call-edge `from` names the enclosing declaration; callee resolution is name-based (approximate, no type resolution). The foundation for the `code_graph` MCP tool.

## 0.9.1 — 2026-05-28

- **Fix: `wrapWithCache` no longer serves a stale read after a write to the default branch** (STDIO-134). A no-ref `readFile` keys the cache under `version: ''` (the default-branch sentinel), but `writeFile` only wrote/invalidated under `version: branch` — so a write to the default branch followed by a no-ref read inside the validation TTL served the pre-write content with no `isFresh` check. `writeFile` now also drops the `''` alias for the path. The cache can't know whether `branch` is the default without resolving it, so the drop is unconditional: at most one extra fetch on the next no-ref read after a non-default-branch write, never a stale read. The `ref === branch` read-after-write optimisation is untouched.

## 0.9.0 — 2026-05-26

- **New: `wrapWorkflowWithCache`** (root export) — the workflow twin of `wrapWithCache`. Wraps any `@verevoir/workflows` `WorkflowAdapter` and routes board reads through the same `ContextStore`, so board state parks + restores for free alongside file content via `serialize()` (0.8.0). `getCard` gets read-through-with-validation against the held `Card.lastActivity` using the adapter's `isCardFresh` primitive (same default 10s `validationTtlMs`, configurable); `listColumns` / `listCards` / `listComments` / `listCustomFields` get TTL-only caching (no per-list freshness primitive — `listCards` is keyed per filter so different filters don't clobber each other); writes (`createCard` / `updateCard` / `moveCard` / `addComment`) pass through then invalidate what they could have changed (the touched card + every list view, or the card's comments). Returned cards/lists are JSON-decoded fresh per read, so a returned reference can't mutate the cache. `@verevoir/workflows` is a new **optional** peer dep — the decorator type-checks against it but doesn't import it at runtime unless called. (STDIO-43 — the workflow-cache + park/restore half of the stateless-host critical path; cross-surface invalidation between the workflow cache and the source cache is a separate, deferred concern.)

## 0.8.0 — 2026-05-26

- **`ContextStore` can park + restore** — new `serialize(): string` method snapshots the whole store (content + symbols, versioned), and `createContextStore({ serialized })` restores it; malformed / wrong-version input degrades to an empty store rather than throwing. The cache half of the stateless-host handoff: a host parks a warm cache and another picks it up by id, resuming warm without re-fetching. Restored store is an independent copy; `grep` / `findSymbols` work against it with no source access. (STDIO-92 part 1 — the primitive; per-project envelope encryption + blob storage are part 2.)

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
