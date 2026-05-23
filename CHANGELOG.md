# Changelog

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
