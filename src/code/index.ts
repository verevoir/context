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
  type CodeEdges,
  type ImportEdge,
  type CallEdge,
} from '../index.js';

export type { CodeEdges, ImportEdge, CallEdge } from '../index.js';

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

/** Parse source once and extract both symbols and code-graph edges.
 *
 * Symbols: top-level + class-method declarations (same rules as the
 * original `parseSymbols`; nested function bodies are skipped).
 *
 * Edges:
 * - imports: every `import_statement` → module specifier + the set
 *   of locally-bound names (default, named, namespace).
 * - calls: every `call_expression` found anywhere in the full tree
 *   (including inside function bodies). Callee resolution is
 *   name-based only — no type resolution (approximate is expected).
 *   The enclosing symbol is tracked via a push/pop stack so each
 *   `CallEdge.from` names the immediately-enclosing declaration, or
 *   `null` for module top-level calls. */
export function parseCode(
  language: SupportedLanguage,
  source: string
): { symbols: SymbolEntry[]; edges: CodeEdges } {
  const parser = getParser();
  parser.setLanguage(LANGUAGES[language] as Parameters<Parser['setLanguage']>[0]);
  const tree = parser.parse(source);

  const symbols: SymbolEntry[] = [];
  walk(tree.rootNode, symbols, source);

  const imports: ImportEdge[] = [];
  const calls: CallEdge[] = [];
  walkEdges(tree.rootNode, imports, calls, null);

  return { symbols, edges: { imports, calls } };
}

/** Convenience wrapper — identical output to the original contract.
 * Delegates to `parseCode` so callers that already use `parseSymbols`
 * continue working without any changes. */
export function parseSymbols(language: SupportedLanguage, source: string): SymbolEntry[] {
  return parseCode(language, source).symbols;
}

interface TSNode {
  type: string;
  children: TSNode[];
  namedChildren: TSNode[];
  parent: TSNode | null;
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
// walkEdges — import + call edge extraction over the full tree
// ============================================================

/** Node types that introduce a named enclosing scope for call-edge
 * `from` tracking. These are the same declarations the symbol walk
 * captures, plus the variable-declarator pattern for named arrow /
 * function expressions. */
const SCOPE_NODE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'class_declaration',
  'function_expression',
  'arrow_function',
]);

/** Resolve the enclosing-symbol name when entering a node that starts
 * a new scope. Returns the name string if determinable, otherwise
 * `null` (anonymous function — doesn't change the tracking context). */
function scopeName(node: TSNode): string | null {
  // Named function/method/class declarations carry a `name` field.
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text;
  // `const X = () => {}` / `const X = function() {}` — the name is
  // on the parent variable_declarator, not on the arrow/function
  // itself. Walk up one level if the parent is a variable_declarator.
  if (node.parent && node.parent.type === 'variable_declarator') {
    const parentName = node.parent.childForFieldName('name');
    if (parentName) return parentName.text;
  }
  return null;
}

/** Resolve the callee name from the `function` field of a
 * `call_expression`. Returns:
 * - `identifier.text` for plain calls (`foo()`)
 * - property name for member calls (`obj.foo()`, `this.foo()`)
 * - `null` for anything else (e.g. computed `obj[key]()`) */
function calleeName(callNode: TSNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    if (prop) return prop.text;
  }
  return null;
}

/** Walk the full tree to collect import edges and call edges.
 * `enclosingSymbol` is the name of the immediately-enclosing
 * declared symbol, or `null` at module top-level. The stack is
 * implemented via the call-stack (recursive DFS with scope tracking
 * passed down as a parameter). */
function walkEdges(
  node: TSNode,
  imports: ImportEdge[],
  calls: CallEdge[],
  enclosingSymbol: string | null
): void {
  // ── Import statements ──────────────────────────────────────────
  if (node.type === 'import_statement') {
    const moduleNode = node.childForFieldName('source');
    const module = moduleNode ? stripQuotes(moduleNode.text) : '';
    const names: string[] = [];
    // Walk named children to find import clause → named/default/namespace imports.
    for (const child of node.namedChildren) {
      collectImportNames(child, names);
    }
    imports.push({ module, names, line: node.startPosition.row + 1 });
    // No further descent needed — import statements don't contain calls.
    return;
  }

  // ── Call expressions ───────────────────────────────────────────
  if (node.type === 'call_expression') {
    const callee = calleeName(node);
    if (callee) {
      calls.push({
        from: enclosingSymbol,
        to: callee,
        line: node.startPosition.row + 1,
      });
    }
    // Continue descent — calls can nest (e.g. `foo(bar())`).
  }

  // ── Scope-introducing nodes ────────────────────────────────────
  let nextEnclosing = enclosingSymbol;
  if (SCOPE_NODE_TYPES.has(node.type)) {
    const name = scopeName(node);
    if (name !== null) {
      nextEnclosing = name;
    }
    // Anonymous function expression / arrow → enclosing unchanged.
  }

  for (const child of node.namedChildren) {
    walkEdges(child, imports, calls, nextEnclosing);
  }
}

/** Strip the surrounding quote characters from a string literal's
 * text (tree-sitter includes them). Handles single, double, and
 * backtick quotes. */
function stripQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === '`' && last === '`')
    ) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** Recursively collect imported names from an import clause node.
 * Handles: default identifier, named imports, namespace (`* as X`). */
function collectImportNames(node: TSNode, out: string[]): void {
  switch (node.type) {
    case 'identifier':
      // Default import: `import Foo from '...'` — identifier directly
      // under import_clause.
      out.push(node.text);
      break;
    case 'namespace_import': {
      // `* as X` — the alias is the first named child (an identifier).
      const alias = node.namedChildren[0];
      if (alias && alias.type === 'identifier') out.push(alias.text);
      break;
    }
    case 'named_imports':
      // `{ a, b as c }` — each child is an import_specifier.
      for (const child of node.namedChildren) {
        collectImportNames(child, out);
      }
      break;
    case 'import_specifier': {
      // The locally-bound name is the `alias` field if present, else `name`.
      const alias = node.childForFieldName('alias');
      const name = alias ?? node.childForFieldName('name');
      if (name) out.push(name.text);
      break;
    }
    case 'import_clause':
      // Container; recurse into children.
      for (const child of node.namedChildren) {
        collectImportNames(child, out);
      }
      break;
    default:
      break;
  }
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

/** Get the code-graph edges for a `(sourceId, version, itemId)`,
 * lazily parsing on miss. Mirrors `symbolsForItem` — same cache-miss
 * fallback pattern.
 *
 * Returns an empty `{ imports: [], calls: [] }` for non-code items
 * (no language detected) — a deterministic answer callers don't need
 * to special-case. Caches the empty result so language-detect runs
 * once per item, not on every call.
 *
 * Returns `null` when the item has no cached content at all; callers
 * should treat this as "not indexed yet". */
export function edgesForItem(
  store: ContextStore,
  sourceId: string,
  version: string,
  itemId: string
): CodeEdges | null {
  const key = { sourceId, version, itemId };
  const cached = store.getEdges(key);
  if (cached) return cached;
  const content = store.getContent(key);
  if (content === undefined) return null;
  const language = detectLanguage(itemId);
  if (!language) {
    const empty: CodeEdges = { imports: [], calls: [] };
    store.setEdges(key, empty);
    return empty;
  }
  const { edges } = parseCode(language, content);
  store.setEdges(key, edges);
  return edges;
}
