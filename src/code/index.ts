// @verevoir/context/code — tree-sitter symbol extraction + symbol
// search over the ContextStore.
//
// Parses source text into a flat list of top-level symbols (functions,
// classes, methods, interfaces, types, enums) with their `:line`
// locations. No semantic analysis, no cross-reference — just the
// structural surface a downstream index uses to answer
// `find_symbol(name)` and to render compact repo-map summaries.
//
// `findSymbols` is the chat-time entry point. It walks every cached
// item in scope, lazily parses any whose symbols aren't yet cached,
// and returns hits. Composes the root store's content cache + this
// module's parse module + the root's symbol cache into one
// fall-through.
//
// v0 languages: TypeScript, TSX, JavaScript. Python + others follow.
//
// Peer deps on `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-
// javascript` are optional in the package manifest — consumers who
// don't import this subpath don't need to install them.

import Parser from 'tree-sitter';
import TreeSitterTypeScript from 'tree-sitter-typescript';
import TreeSitterJavaScript from 'tree-sitter-javascript';
import {
  contextStore as defaultContextStore,
  type ContextStore,
  type SymbolEntry,
  type SymbolKind,
} from '../index.js';

export type SupportedLanguage = 'typescript' | 'tsx' | 'javascript';

/** Tree-sitter language object as accepted by `parser.setLanguage`.
 * The exported language modules don't declare a stable TS type, so
 * we treat them as opaque pointers. */
type TreeSitterLanguage = unknown;

const LANGUAGES: Readonly<Record<SupportedLanguage, TreeSitterLanguage>> = {
  typescript: TreeSitterTypeScript.typescript,
  tsx: TreeSitterTypeScript.tsx,
  javascript: TreeSitterJavaScript,
};

/** Per-language tree-sitter node-type → SymbolKind mapping. Shared
 * across typescript/tsx/javascript since their grammars use the same
 * relevant node names; centralised so adding Python or other
 * languages keeps the divergence in one place. */
const NODE_TYPE_TO_KIND: Readonly<Record<string, SymbolKind>> = {
  function_declaration: 'function',
  function_expression: 'function',
  arrow_function: 'function',
  class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
};

let cachedParser: Parser | null = null;
function getParser(): Parser {
  if (cachedParser) return cachedParser;
  cachedParser = new Parser();
  return cachedParser;
}

/** Heuristic mapping from a path → SupportedLanguage. Returns null
 * when the file extension is not yet supported; callers should treat
 * unknown extensions as "no symbols". */
export function detectLanguage(itemId: string): SupportedLanguage | null {
  const lower = itemId.toLowerCase();
  if (lower.endsWith('.ts')) return 'typescript';
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
    return 'javascript';
  if (lower.endsWith('.jsx')) return 'tsx';
  return null;
}

/** Walk the tree-sitter AST and pull out top-level + class-method
 * symbol declarations. Nested function declarations inside other
 * functions are skipped — they're not meaningful index entries at
 * v0; the outer symbol's name suffices to locate them.
 *
 * Anonymous functions (function expressions / arrow functions
 * without a binding name) are also skipped — they're not retrievable
 * by `findSymbols(name)`. Named function expressions assigned to
 * `const X = function () {...}` are captured under `X` via the
 * variable-declarator branch. */
export function parseSymbols(language: SupportedLanguage, source: string): SymbolEntry[] {
  const parser = getParser();
  parser.setLanguage(LANGUAGES[language] as Parameters<Parser['setLanguage']>[0]);
  const tree = parser.parse(source);
  const entries: SymbolEntry[] = [];
  walk(tree.rootNode, entries, source);
  return entries;
}

interface TSNode {
  type: string;
  children: TSNode[];
  namedChildren: TSNode[];
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  text: string;
  childForFieldName(name: string): TSNode | null;
}

function walk(node: TSNode, out: SymbolEntry[], source: string): void {
  const kind = NODE_TYPE_TO_KIND[node.type];
  if (kind) {
    const name = extractName(node, kind);
    if (name) {
      out.push({
        name,
        kind,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }
  }
  // `const X = function() {}` / `const X = () => {}` — the function
  // is in the initializer, the name is on the declarator. Walk into
  // the declarator's initializer; if it's a function-shape, capture
  // it under the declarator's name.
  if (node.type === 'variable_declarator') {
    const declarator = node;
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (
      nameNode &&
      valueNode &&
      (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')
    ) {
      out.push({
        name: nameNode.text,
        kind: 'function',
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
      return;
    }
  }
  for (const child of node.namedChildren) {
    if (kind === 'function' || kind === 'method') continue;
    walk(child, out, source);
  }
  void source;
}

function extractName(node: TSNode, kind: SymbolKind): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;
  if (kind === 'method') {
    const first = node.namedChildren[0];
    if (first && first.type === 'property_identifier') return first.text;
  }
  return null;
}

// ============================================================
// findSymbols — lazy-parse + scoped search over the store
// ============================================================

export interface FindScope {
  /** Set of `(sourceId, version)` pairs to search across. Typically
   * the caller passes the set of attached sources at a given
   * version (e.g. all attached repos at the conversation's working
   * branch). */
  sources: Array<{ sourceId: string; version: string }>;
}

export interface SymbolHit {
  sourceId: string;
  itemId: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
}

export interface FindSymbolOptions {
  /** Hard cap on hits returned. Default 50. */
  maxResults?: number;
  /** Match strategy. Default 'substring' — callers usually don't
   * know exact symbol names. 'exact' is available for callers that
   * do. Both are case-insensitive. */
  match?: 'substring' | 'exact';
  /** Store to search. Defaults to the module's singleton. */
  store?: ContextStore;
}

const DEFAULT_FIND_MAX = 50;

/** Search the symbol index for entries whose name matches `query`.
 * Triggers lazy parsing of any cached items that haven't been
 * parsed yet — content cache + parse module + symbol cache compose
 * into one fall-through. */
export function findSymbols(
  query: string,
  scope: FindScope,
  options: FindSymbolOptions = {}
): SymbolHit[] {
  const max = options.maxResults ?? DEFAULT_FIND_MAX;
  const match = options.match ?? 'substring';
  const store = options.store ?? defaultContextStore;
  const q = query.toLowerCase();
  const hits: SymbolHit[] = [];

  for (const { sourceId, version } of scope.sources) {
    const items = store.listIndexedItems(sourceId, version);
    for (const itemId of items) {
      if (hits.length >= max) return hits;
      const symbols = symbolsForItem(store, sourceId, version, itemId);
      if (!symbols) continue;
      for (const sym of symbols) {
        if (hits.length >= max) return hits;
        const name = sym.name.toLowerCase();
        const isHit = match === 'exact' ? name === q : name.includes(q);
        if (!isHit) continue;
        hits.push({
          sourceId,
          itemId,
          name: sym.name,
          kind: sym.kind,
          startLine: sym.startLine,
          endLine: sym.endLine,
        });
      }
    }
  }
  return hits;
}

/** Get the symbols for a `(sourceId, version, itemId)`, lazily
 * parsing on miss. Returns null when the item has no cached content
 * (caller should treat as "not indexed") or when no language is
 * detected for the path (e.g. .yaml, .md — no symbols to extract). */
function symbolsForItem(
  store: ContextStore,
  sourceId: string,
  version: string,
  itemId: string
): SymbolEntry[] | null {
  const key = { sourceId, version, itemId };
  const cached = store.getSymbols(key);
  if (cached) return cached;
  const content = store.getContent(key);
  if (content === undefined) return null;
  const language = detectLanguage(itemId);
  if (!language) {
    // Don't reparse on every call — empty result for non-code items
    // is a legitimate answer. Cache an empty list so the language
    // detect happens once per item.
    store.setSymbols(key, []);
    return [];
  }
  const symbols = parseSymbols(language, content);
  store.setSymbols(key, symbols);
  return symbols;
}
