# Changelog

## 0.1.0 — 2026-05-23

Initial release.

- `@verevoir/context` — `ContextStore` (content + symbol cache) keyed `(sourceId, version, itemId)`. `createContextStore` factory + default singleton. `grep` over cached content. `IndexKey` + `SymbolEntry` types.
- `@verevoir/context/code` — tree-sitter symbol extraction (`parseSymbols`, `detectLanguage`) for TypeScript / TSX / JavaScript + `findSymbols` over the store. Optional peer deps on `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript`.
- `@verevoir/context/sources` — `cachedReadFile` bridge that pairs the store with `@verevoir/sources/github`. Optional peer dep on `@verevoir/sources`.
- Extracted from aigency-web's `src/server/code-index/*` per ADR 019 (substrate libraries).
