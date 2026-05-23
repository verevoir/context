# @verevoir/context

In-process content + symbol cache for LLM context windows. Keyed `(sourceId, version, itemId)`. Tree-sitter symbol extraction + grep + a cached-read bridge to `@verevoir/sources`, all as optional subpath imports.

## Purpose

Lets an LLM agent navigate a codebase (or any versioned content source) without re-fetching the same files every turn. The cache is purpose-built for LLM-context flows: lazy population, cheap repeated lookups, symbol-aware indexing for files where that helps.

Pairs naturally with [`@verevoir/sources`](https://github.com/verevoir/sources) for the read side, but doesn't require it — consumers can populate the store from any source.

## Subpaths

- `@verevoir/context` — core `ContextStore` (content + symbol cache), `grep` over cached content, `IndexKey` + `SymbolEntry` types. No external dependencies.
- `@verevoir/context/code` — tree-sitter symbol extraction (`parseSymbols`, `detectLanguage`) + `findSymbols` over the store. Optional peer deps on `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript`.
- `@verevoir/context/sources` — `cachedReadFile` bridge that pairs the store with `@verevoir/sources/github`. Optional peer dep on `@verevoir/sources`.

## Install

```bash
# Core only — no peer deps required.
npm install @verevoir/context

# Add tree-sitter symbol extraction.
npm install tree-sitter tree-sitter-typescript tree-sitter-javascript

# Add the cached-read bridge to @verevoir/sources.
npm install @verevoir/sources
```

Peer dependencies are optional — install only the subpaths you import.

## Canonical usage

### Store + grep (root only)

```ts
import { contextStore, grep } from '@verevoir/context';

// Populate the store with content from any source.
contextStore.setContent(
  { sourceId: 'https://github.com/acme/charts', version: '', itemId: 'README.md' },
  '# Charts\n\nA collection of charts.\n'
);

// Grep across cached items in a scope.
const hits = grep('charts', {
  sources: [{ sourceId: 'https://github.com/acme/charts', version: '' }],
});
```

### Symbol search (with tree-sitter)

```ts
import { contextStore } from '@verevoir/context';
import { findSymbols } from '@verevoir/context/code';

contextStore.setContent(
  { sourceId: 'https://github.com/acme/charts', version: '', itemId: 'src/auth.ts' },
  'export class AuthHandler { authenticate() {} }'
);

const hits = findSymbols('auth', {
  sources: [{ sourceId: 'https://github.com/acme/charts', version: '' }],
});
// → [{ name: 'AuthHandler', kind: 'class', ... }, { name: 'authenticate', kind: 'method', ... }]
```

### Cached reads against `@verevoir/sources`

```ts
import { envFromProcessEnv } from '@verevoir/sources';
import { cachedReadFile } from '@verevoir/context/sources';

const env = envFromProcessEnv();
if (!env) throw new Error('GITHUB_TOKEN not set');

// First call fetches and caches; second call hits the cache.
const a = await cachedReadFile(env, 'https://github.com/acme/charts', 'README.md');
const b = await cachedReadFile(env, 'https://github.com/acme/charts', 'README.md');
// `b` came from cache; only one HTTP call was made.
```

## Key shape

The cache key is `(sourceId, version, itemId)`:

- **`sourceId`** — opaque identifier for the source. Typically a URL.
- **`version`** — version handle for the source. Git ref for code sources; etag / last-modified / content-hash for non-git. Empty string `''` is the canonical "default branch / latest" sentinel.
- **`itemId`** — item identifier within the source. Usually a path.

Different versions of the same item are independent cache entries. The store doesn't fetch — it caches what consumers put in it.

## Symbol shape

```ts
interface SymbolEntry {
  name: string; // bare identifier: `AuthHandler`, not `class AuthHandler`
  kind: SymbolKind; // 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum'
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
}
```

`@verevoir/context/code` populates these from tree-sitter parses (TypeScript / TSX / JavaScript today). Consumers can also populate from their own parsers.

## Per-instance + singleton

The default singleton `contextStore` is shared across imports of the same module. Tests and multi-tenant consumers can call `createContextStore()` to get an isolated instance and pass it via the `store` option on `grep`, `findSymbols`, and `cachedReadFile`.

## What this is NOT

- Not LSP. Tree-sitter gives structure (symbols, locations); no type resolution, no cross-reference. The LSP comparison is in ADR 019 in the aigency docs repo if relevant.
- Not a fetch layer. Reads happen via `@verevoir/sources` or whatever adapter you bring. The store caches what's handed to it.
- Not persistent. Per-process, in-memory. Cross-instance shared cache lands when forcing functions arrive.

## See also

- [`@verevoir/sources`](https://github.com/verevoir/sources) — the SourceAdapter contract + implementations the cached-read bridge pairs with.
- [`@verevoir/llm`](https://github.com/verevoir/llm) — provider-agnostic LLM call surface.

## License

Apache-2.0.
