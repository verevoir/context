# @verevoir/context

In-process content + symbol cache for LLM context windows. Keyed `(sourceId, version, itemId)`. Tree-sitter symbol extraction + grep + a cached-read bridge to `@verevoir/sources`, all as optional subpath imports.

## Purpose

Lets an LLM agent navigate a codebase (or any versioned content source) without re-fetching the same files every turn. The cache is purpose-built for LLM-context flows: lazy population, cheap repeated lookups, symbol-aware indexing for files where that helps.

Pairs naturally with [`@verevoir/sources`](https://github.com/verevoir/sources) for the read side, but doesn't require it — consumers can populate the store from any source.

## Most consumers reach this via MCP

If you're driving an LLM agent and want cached source reads + symbol search as tools, you usually don't import `@verevoir/context` directly — you run the [`@verevoir/mcp`](https://github.com/verevoir/mcp) server. That server wires `@verevoir/context/github` + `@verevoir/context/fs` (the cached drop-ins) under the hood, so its `read_file` / `grep` / `find_symbol` tools transparently benefit from the in-process cache and `wrapWithCache`'s read-through-with-validation (default 10s TTL). See [`@verevoir/mcp`](https://github.com/verevoir/mcp) for Claude Code config; key recommendation is `"alwaysLoad": true` so the tools surface as first-class instead of being deferred behind `ToolSearch`.

Direct in-process consumption (the usage shown below) is for: writing your own MCP server, embedding cached source reads in a non-MCP runtime, customising `validationTtlMs` per-call, or building higher-level libraries that share a `ContextStore` across multiple sources.

## Subpaths

- `@verevoir/context` — core `ContextStore` (content + symbol cache), `grep` over cached content, `wrapWithCache` decorator that adds read-through caching to any `@verevoir/sources` adapter, `IndexKey` + `SymbolEntry` types. No external dependencies; the decorator type-checks against `@verevoir/sources` but doesn't import it at runtime unless you call it.
- `@verevoir/context/code` — tree-sitter symbol extraction (`parseSymbols`, `detectLanguage`) + `findSymbols` over the store. Optional peer deps on tree-sitter packages.
- `@verevoir/context/github` — cached GitHub source. Drop-in replacement for `@verevoir/sources/github` that adds read-through caching. Identical contract.
- `@verevoir/context/fs` — cached local-filesystem source. Drop-in replacement for `@verevoir/sources/fs` that adds read-through caching. Identical contract.

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

### Cached source — convenience subpaths

Drop-in replacements for `@verevoir/sources/<kind>` that add read-through caching. Same `SourceAdapter` contract; consumers swap the import path to gain caching, no other code changes.

```ts
import { envFromProcessEnv } from '@verevoir/sources';
import { readFile, writeFile } from '@verevoir/context/github';

const env = envFromProcessEnv();
if (!env) throw new Error('GITHUB_TOKEN not set');

// First call hits the GitHub API; second call serves from cache.
const a = await readFile(env, 'https://github.com/acme/charts', 'README.md');
const b = await readFile(env, 'https://github.com/acme/charts', 'README.md');

// Writes pass through and populate the cache.
await writeFile(
  env,
  'https://github.com/acme/charts',
  'docs/notes.md',
  '# Notes\n',
  'feature/notes',
  'Add notes'
);
```

```ts
import { readFile } from '@verevoir/context/fs';
const env = { token: '', forkOrg: '' }; // fs adapter ignores both

const r = await readFile(env, '/path/to/project', 'src/index.ts');
```

### Cached source — custom adapters

Bring your own SourceAdapter implementation; wrap it once to get the same caching behaviour.

```ts
import { wrapWithCache } from '@verevoir/context';
import { mySource } from 'my-source-pkg'; // implements @verevoir/sources's SourceAdapter

const cached = wrapWithCache(mySource);
const r = await cached.readFile(env, sourceUrl, path);
```

`wrapWithCache(source, { store?, validationTtlMs?, now? })` returns a `SourceAdapter`-shaped facade. Cache hits preserve the source-returned `sha` (so callers can use it as a freshness handle).

### Freshness validation

`wrapWithCache` uses the source's `isFresh` primitive (from `@verevoir/sources@^0.3.0`) to validate cache entries instead of returning forever within the process.

- Inside `validationTtlMs` (default **10s**), cache hits serve without asking the source — same fast path as before.
- After the window elapses, the wrapper calls `source.isFresh(env, url, path, version, ref)`. `true` → refresh `cachedAt` and serve cache; `false` → re-fetch.
- `validationTtlMs: 0` validates every cache hit; `validationTtlMs: Infinity` never validates.

The 10s default covers a tool-loop's burst of correlated reads without piling up upstream pings. It's a dial — tune based on observed cost vs staleness.

```ts
import { wrapWithCache } from '@verevoir/context';
import { github } from '@verevoir/sources/github';

// Default 10s TTL.
const cached = wrapWithCache(github);

// Or tune it explicitly.
const eager = wrapWithCache(github, { validationTtlMs: 1000 });    // probe every second
const lazy  = wrapWithCache(github, { validationTtlMs: 60_000 });  // once a minute
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

The default singleton `contextStore` is shared across imports of the same module. Tests and multi-tenant consumers can call `createContextStore()` to get an isolated instance and pass it via the `store` option on `grep`, `findSymbols`, and `wrapWithCache`.

## What this is NOT

- Not LSP. Tree-sitter gives structure (symbols, locations); no type resolution, no cross-reference. The LSP comparison is in ADR 019 in the aigency docs repo if relevant.
- Not a fetch layer. Reads happen via `@verevoir/sources` or whatever adapter you bring. The store caches what's handed to it.
- Not persistent. Per-process, in-memory. Cross-instance shared cache lands when forcing functions arrive.

## See also

- [`@verevoir/sources`](https://github.com/verevoir/sources) — the SourceAdapter contract + implementations the cached-read bridge pairs with.
- [`@verevoir/llm`](https://github.com/verevoir/llm) — provider-agnostic LLM call surface.

## License

Apache-2.0.
