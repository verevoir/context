// @verevoir/context/code — tree-sitter symbol + code-graph extraction
// over the ContextStore.
//
// Parses source text into (a) a flat list of top-level + class-method
// symbols (functions, classes, methods, interfaces, types, enums) with
// their `:line` locations, and (b) import + call edges for the code
// graph. No semantic analysis, no type resolution — just the structural
// surface a downstream index uses to answer `find_symbol(name)`,
// `code_graph(symbol)`, and compact repo-map summaries.
//
// `findSymbols` is the chat-time entry point. It walks every cached
// item in scope, lazily parses any whose symbols aren't yet cached,
// and returns hits.
//
// Languages: TypeScript, TSX, JavaScript, Python, Java, C#, Go, Scala,
// C, C++. Each is a `LanguageConfig` — the grammar plus the node-type /
// field names that diverge between tree-sitter grammars (Java uses
// `method_invocation`, Python `call`/`attribute`, C# `invocation_
// expression`, Go `selector_expression`, C/C++ nest the function name
// inside `function_declarator`, …). Adding a language is one config
// entry + a grammar dep; the walk is language-agnostic.
//
// Peer deps on `tree-sitter` and the `tree-sitter-*` grammars are
// optional in the package manifest — consumers who don't import this
// subpath don't need to install them.

import Parser from 'tree-sitter';
import TreeSitterTypeScript from 'tree-sitter-typescript';
import TreeSitterJavaScript from 'tree-sitter-javascript';
import TreeSitterPython from 'tree-sitter-python';
import TreeSitterJava from 'tree-sitter-java';
import TreeSitterCSharp from 'tree-sitter-c-sharp';
import TreeSitterGo from 'tree-sitter-go';
import TreeSitterScala from 'tree-sitter-scala';
import TreeSitterC from 'tree-sitter-c';
import TreeSitterCpp from 'tree-sitter-cpp';
import {
  contextStore as defaultContextStore,
  type ContextStore,
  type SymbolEntry,
  type SymbolKind,
  type CodeEdges,
  type ImportEdge,
} from '../index.js';

export type { CodeEdges, ImportEdge, CallEdge } from '../index.js';

export type SupportedLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'java'
  | 'csharp'
  | 'go'
  | 'scala'
  | 'c'
  | 'cpp';

// ============================================================
// AST node shape (subset of tree-sitter's SyntaxNode we use)
// ============================================================

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

/** Tracking state threaded through the symbol walk. `insideType` is
 * true once we've descended into a class/interface/struct body — it
 * lets languages that share one node type for free functions and
 * methods (Python `function_definition`, C++ `function_definition`,
 * Scala `function_definition`) resolve the right kind. */
interface WalkCtx {
  insideType: boolean;
}

/** Resolve a symbol kind dynamically from the node + walk context.
 * Used where one node type maps to different kinds by position
 * (method vs function) or by a child type (Go `type_spec`). */
type KindResolver = (node: TSNode, ctx: WalkCtx) => SymbolKind | null;

interface LanguageConfig {
  /** Grammar object passed to `parser.setLanguage`. */
  grammar: unknown;
  /** Node type → symbol kind (static) or a resolver (dynamic). */
  symbolKinds: Readonly<Record<string, SymbolKind | KindResolver>>;
  /** Extract a declaration's name. */
  nameOf: (node: TSNode, kind: SymbolKind) => string | null;
  /** Node types that name an enclosing scope for call-edge `from`. */
  scopeNodeTypes: ReadonlySet<string>;
  /** Resolve the enclosing-scope name (the callable a call sits in). */
  scopeName: (node: TSNode) => string | null;
  /** Node types that are a call expression. */
  callNodeTypes: ReadonlySet<string>;
  /** Resolve the callee name from a call node, or null. */
  calleeOf: (call: TSNode) => string | null;
  /** Node types that are an import/include/using statement. */
  importNodeTypes: ReadonlySet<string>;
  /** Extract import edges from an import node (one node → 0..n edges). */
  importsOf: (node: TSNode) => ImportEdge[];
}

// ============================================================
// Shared helpers
// ============================================================

/** Strip surrounding quote characters from a string literal's text. */
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

/** Strip the angle brackets / quotes around a C/C++ include path. */
function stripInclude(text: string): string {
  return text.replace(/^[<"]/, '').replace(/[>"]$/, '');
}

function lastDotSegment(s: string): string {
  const parts = s.split('.');
  return parts[parts.length - 1] || s;
}

function lastSlashSegment(s: string): string {
  const parts = s.split('/');
  return parts[parts.length - 1] || s;
}

/** Name from the `name` field — the common case across grammars. */
function nameField(node: TSNode): string | null {
  const n = node.childForFieldName('name');
  return n ? n.text : null;
}

/** Build a callee resolver for grammars whose call node has a
 * `function` field that is either a plain identifier or a member /
 * attribute / selector access whose property lives in `propField`. */
function functionFieldCallee(
  memberType: string,
  propField: string
): (call: TSNode) => string | null {
  return (call: TSNode): string | null => {
    const fn = call.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return fn.text;
    if (fn.type === memberType) {
      const prop = fn.childForFieldName(propField);
      return prop ? prop.text : null;
    }
    // C++ free/qualified call: `ns::fn()` — name is the qualified tail.
    if (fn.type === 'qualified_identifier') {
      const nm = fn.childForFieldName('name');
      return nm ? nm.text : null;
    }
    return null;
  };
}

// ── JavaScript / TypeScript ─────────────────────────────────

/** JS/TS name resolution — `name` field, method `property_identifier`
 * fallback, and `const x = () => {}` (name on the declarator). */
function jsNameOf(node: TSNode, kind: SymbolKind): string | null {
  const n = node.childForFieldName('name');
  if (n) return n.text;
  if (kind === 'method') {
    const first = node.namedChildren[0];
    if (first && first.type === 'property_identifier') return first.text;
  }
  if (node.type === 'variable_declarator') {
    const nm = node.childForFieldName('name');
    if (nm) return nm.text;
  }
  return null;
}

function jsScopeName(node: TSNode): string | null {
  const nameFieldNode = node.childForFieldName('name');
  if (nameFieldNode) return nameFieldNode.text;
  const first = node.namedChildren[0];
  if (first && first.type === 'property_identifier') return first.text;
  if (node.parent && node.parent.type === 'variable_declarator') {
    const parentName = node.parent.childForFieldName('name');
    if (parentName) return parentName.text;
  }
  return null;
}

/** Recursively collect imported names from a JS/TS import clause. */
function collectImportNames(node: TSNode, out: string[]): void {
  switch (node.type) {
    case 'identifier':
      out.push(node.text);
      break;
    case 'namespace_import': {
      const alias = node.namedChildren[0];
      if (alias && alias.type === 'identifier') out.push(alias.text);
      break;
    }
    case 'named_imports':
      for (const child of node.namedChildren) collectImportNames(child, out);
      break;
    case 'import_specifier': {
      const alias = node.childForFieldName('alias');
      const name = alias ?? node.childForFieldName('name');
      if (name) out.push(name.text);
      break;
    }
    case 'import_clause':
      for (const child of node.namedChildren) collectImportNames(child, out);
      break;
    default:
      break;
  }
}

function jsImports(node: TSNode): ImportEdge[] {
  const moduleNode = node.childForFieldName('source');
  const module = moduleNode ? stripQuotes(moduleNode.text) : '';
  const names: string[] = [];
  for (const child of node.namedChildren) collectImportNames(child, names);
  return [{ module, names, line: node.startPosition.row + 1 }];
}

const JS_KINDS: Readonly<Record<string, SymbolKind | KindResolver>> = {
  function_declaration: 'function',
  function_expression: 'function',
  arrow_function: 'function',
  class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  variable_declarator: (node) => {
    const value = node.childForFieldName('value');
    return value && (value.type === 'arrow_function' || value.type === 'function_expression')
      ? 'function'
      : null;
  },
};

const JS_SCOPE_NODES = new Set([
  'function_declaration',
  'method_definition',
  'class_declaration',
  'function_expression',
  'arrow_function',
]);

function jsConfig(grammar: unknown): LanguageConfig {
  return {
    grammar,
    symbolKinds: JS_KINDS,
    nameOf: jsNameOf,
    scopeNodeTypes: JS_SCOPE_NODES,
    scopeName: jsScopeName,
    callNodeTypes: new Set(['call_expression']),
    calleeOf: functionFieldCallee('member_expression', 'property'),
    importNodeTypes: new Set(['import_statement']),
    importsOf: jsImports,
  };
}

// ── Python ──────────────────────────────────────────────────

function pythonImports(node: TSNode): ImportEdge[] {
  const line = node.startPosition.row + 1;
  const edges: ImportEdge[] = [];
  if (node.type === 'import_statement') {
    for (const c of node.namedChildren) {
      if (c.type === 'dotted_name') {
        edges.push({ module: c.text, names: [lastDotSegment(c.text)], line });
      } else if (c.type === 'aliased_import') {
        const nm = c.childForFieldName('name');
        const alias = c.childForFieldName('alias');
        const module = nm ? nm.text : '';
        const bound = alias ? alias.text : nm ? lastDotSegment(nm.text) : '';
        edges.push({ module, names: bound ? [bound] : [], line });
      }
    }
  } else {
    // import_from_statement: module_name field + name fields
    const moduleNode = node.childForFieldName('module_name');
    const module = moduleNode ? moduleNode.text : '';
    const names: string[] = [];
    for (const c of node.namedChildren) {
      if (c === moduleNode) continue;
      if (c.type === 'dotted_name') names.push(lastDotSegment(c.text));
      else if (c.type === 'aliased_import') {
        const alias = c.childForFieldName('alias');
        const nm = c.childForFieldName('name');
        if (alias) names.push(alias.text);
        else if (nm) names.push(lastDotSegment(nm.text));
      }
    }
    edges.push({ module, names, line });
  }
  return edges;
}

const PYTHON_CONFIG: LanguageConfig = {
  grammar: TreeSitterPython,
  symbolKinds: {
    function_definition: (_node, ctx) => (ctx.insideType ? 'method' : 'function'),
    class_definition: 'class',
  },
  nameOf: nameField,
  scopeNodeTypes: new Set(['function_definition', 'class_definition']),
  scopeName: nameField,
  callNodeTypes: new Set(['call']),
  calleeOf: functionFieldCallee('attribute', 'attribute'),
  importNodeTypes: new Set(['import_statement', 'import_from_statement']),
  importsOf: pythonImports,
};

// ── Java ────────────────────────────────────────────────────

function javaImports(node: TSNode): ImportEdge[] {
  const line = node.startPosition.row + 1;
  for (const c of node.namedChildren) {
    if (c.type === 'scoped_identifier' || c.type === 'identifier') {
      return [{ module: c.text, names: [lastDotSegment(c.text)], line }];
    }
  }
  return [];
}

const JAVA_CONFIG: LanguageConfig = {
  grammar: TreeSitterJava,
  symbolKinds: {
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    record_declaration: 'class',
    annotation_type_declaration: 'interface',
    method_declaration: 'method',
    constructor_declaration: 'method',
  },
  nameOf: nameField,
  scopeNodeTypes: new Set(['method_declaration', 'constructor_declaration', 'class_declaration']),
  scopeName: nameField,
  callNodeTypes: new Set(['method_invocation']),
  // method_invocation carries the called method in its `name` field.
  calleeOf: (call) => {
    const n = call.childForFieldName('name');
    return n ? n.text : null;
  },
  importNodeTypes: new Set(['import_declaration']),
  importsOf: javaImports,
};

// ── C# ──────────────────────────────────────────────────────

function csharpImports(node: TSNode): ImportEdge[] {
  const line = node.startPosition.row + 1;
  for (const c of node.namedChildren) {
    if (c.type === 'qualified_name' || c.type === 'identifier') {
      return [{ module: c.text, names: [lastDotSegment(c.text)], line }];
    }
  }
  return [];
}

const CSHARP_CONFIG: LanguageConfig = {
  grammar: TreeSitterCSharp,
  symbolKinds: {
    class_declaration: 'class',
    interface_declaration: 'interface',
    struct_declaration: 'class',
    enum_declaration: 'enum',
    record_declaration: 'class',
    record_struct_declaration: 'class',
    method_declaration: 'method',
    constructor_declaration: 'method',
  },
  nameOf: nameField,
  scopeNodeTypes: new Set(['method_declaration', 'constructor_declaration', 'class_declaration']),
  scopeName: nameField,
  callNodeTypes: new Set(['invocation_expression']),
  calleeOf: functionFieldCallee('member_access_expression', 'name'),
  importNodeTypes: new Set(['using_directive']),
  importsOf: csharpImports,
};

// ── Go ──────────────────────────────────────────────────────

function goImports(node: TSNode): ImportEdge[] {
  const specs: TSNode[] = [];
  const collect = (n: TSNode): void => {
    if (n.type === 'import_spec') specs.push(n);
    else for (const c of n.namedChildren) collect(c);
  };
  collect(node);
  return specs.map((s) => {
    const pathNode = s.childForFieldName('path');
    const module = pathNode ? stripQuotes(pathNode.text) : '';
    const nameNode = s.childForFieldName('name');
    const name = nameNode ? nameNode.text : lastSlashSegment(module);
    return { module, names: name ? [name] : [], line: s.startPosition.row + 1 };
  });
}

const GO_CONFIG: LanguageConfig = {
  grammar: TreeSitterGo,
  symbolKinds: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_spec: (node) => {
      const t = node.childForFieldName('type');
      if (t && t.type === 'interface_type') return 'interface';
      if (t && t.type === 'struct_type') return 'class';
      return 'type';
    },
  },
  nameOf: nameField,
  scopeNodeTypes: new Set(['function_declaration', 'method_declaration']),
  scopeName: nameField,
  callNodeTypes: new Set(['call_expression']),
  calleeOf: functionFieldCallee('selector_expression', 'field'),
  importNodeTypes: new Set(['import_declaration']),
  importsOf: goImports,
};

// ── Scala ───────────────────────────────────────────────────

function scalaImports(node: TSNode): ImportEdge[] {
  const line = node.startPosition.row + 1;
  const parts: string[] = [];
  for (const c of node.namedChildren) {
    if (c.type === 'identifier' || c.type === 'stable_identifier') parts.push(c.text);
  }
  const module = parts.join('.');
  return [{ module, names: parts.length ? [parts[parts.length - 1]] : [], line }];
}

const SCALA_CONFIG: LanguageConfig = {
  grammar: TreeSitterScala,
  symbolKinds: {
    class_definition: 'class',
    object_definition: 'class',
    trait_definition: 'interface',
    function_definition: (_node, ctx) => (ctx.insideType ? 'method' : 'function'),
    function_declaration: (_node, ctx) => (ctx.insideType ? 'method' : 'function'),
  },
  nameOf: nameField,
  scopeNodeTypes: new Set([
    'function_definition',
    'function_declaration',
    'class_definition',
    'object_definition',
    'trait_definition',
  ]),
  scopeName: nameField,
  callNodeTypes: new Set(['call_expression']),
  calleeOf: functionFieldCallee('field_expression', 'field'),
  importNodeTypes: new Set(['import_declaration']),
  importsOf: scalaImports,
};

// ── C / C++ ─────────────────────────────────────────────────

/** C/C++ put the declared name inside (possibly nested) declarators
 * rather than a `name` field: `function_definition → declarator →
 * function_declarator → declarator → identifier|field_identifier`. */
function cFunctionName(node: TSNode): string | null {
  let d: TSNode | null = node.childForFieldName('declarator');
  const seen = new Set<TSNode>();
  while (d && d.type !== 'function_declarator') {
    if (seen.has(d)) break;
    seen.add(d);
    d = d.childForFieldName('declarator');
  }
  if (!d) return null;
  let inner: TSNode | null = d.childForFieldName('declarator');
  const seen2 = new Set<TSNode>();
  while (
    inner &&
    inner.type !== 'identifier' &&
    inner.type !== 'field_identifier' &&
    inner.type !== 'qualified_identifier' &&
    inner.type !== 'destructor_name' &&
    inner.type !== 'operator_name'
  ) {
    if (seen2.has(inner)) break;
    seen2.add(inner);
    inner = inner.childForFieldName('declarator');
  }
  if (!inner) return null;
  if (inner.type === 'qualified_identifier') {
    const nm = inner.childForFieldName('name');
    return nm ? nm.text : inner.text;
  }
  return inner.text;
}

function cNameOf(node: TSNode, _kind: SymbolKind): string | null {
  if (node.type === 'function_definition') return cFunctionName(node);
  return nameField(node);
}

function cScopeName(node: TSNode): string | null {
  if (node.type === 'function_definition') return cFunctionName(node);
  return nameField(node);
}

function includeImports(node: TSNode): ImportEdge[] {
  const pathNode = node.childForFieldName('path');
  if (!pathNode) return [];
  return [
    {
      module: stripInclude(pathNode.text),
      names: [],
      line: node.startPosition.row + 1,
    },
  ];
}

const C_CONFIG: LanguageConfig = {
  grammar: TreeSitterC,
  symbolKinds: {
    function_definition: 'function',
    struct_specifier: 'class',
    union_specifier: 'class',
    enum_specifier: 'enum',
  },
  nameOf: cNameOf,
  scopeNodeTypes: new Set(['function_definition']),
  scopeName: cScopeName,
  callNodeTypes: new Set(['call_expression']),
  calleeOf: functionFieldCallee('field_expression', 'field'),
  importNodeTypes: new Set(['preproc_include']),
  importsOf: includeImports,
};

const CPP_CONFIG: LanguageConfig = {
  grammar: TreeSitterCpp,
  symbolKinds: {
    function_definition: (_node, ctx) => (ctx.insideType ? 'method' : 'function'),
    class_specifier: 'class',
    struct_specifier: 'class',
    union_specifier: 'class',
    enum_specifier: 'enum',
  },
  nameOf: cNameOf,
  scopeNodeTypes: new Set(['function_definition']),
  scopeName: cScopeName,
  callNodeTypes: new Set(['call_expression']),
  calleeOf: functionFieldCallee('field_expression', 'field'),
  importNodeTypes: new Set(['preproc_include']),
  importsOf: includeImports,
};

// ============================================================
// Language registry + detection
// ============================================================

const LANG_CONFIGS: Readonly<Record<SupportedLanguage, LanguageConfig>> = {
  typescript: jsConfig(TreeSitterTypeScript.typescript),
  tsx: jsConfig(TreeSitterTypeScript.tsx),
  javascript: jsConfig(TreeSitterJavaScript),
  python: PYTHON_CONFIG,
  java: JAVA_CONFIG,
  csharp: CSHARP_CONFIG,
  go: GO_CONFIG,
  scala: SCALA_CONFIG,
  c: C_CONFIG,
  cpp: CPP_CONFIG,
};

let cachedParser: Parser | null = null;
function getParser(): Parser {
  if (cachedParser) return cachedParser;
  cachedParser = new Parser();
  return cachedParser;
}

/** Heuristic mapping from a path → SupportedLanguage. Returns null
 * when the extension is not supported; callers treat unknown
 * extensions as "no symbols". */
export function detectLanguage(itemId: string): SupportedLanguage | null {
  const lower = itemId.toLowerCase();
  if (lower.endsWith('.ts')) return 'typescript';
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
    return 'javascript';
  if (lower.endsWith('.jsx')) return 'tsx';
  if (lower.endsWith('.py') || lower.endsWith('.pyi')) return 'python';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.cs')) return 'csharp';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.scala') || lower.endsWith('.sc')) return 'scala';
  // C++ first — its extensions are unambiguous; bare .h defaults to C.
  if (
    lower.endsWith('.cpp') ||
    lower.endsWith('.cxx') ||
    lower.endsWith('.cc') ||
    lower.endsWith('.hpp') ||
    lower.endsWith('.hxx') ||
    lower.endsWith('.hh')
  )
    return 'cpp';
  if (lower.endsWith('.c') || lower.endsWith('.h')) return 'c';
  return null;
}

// ============================================================
// parseCode — symbols + edges in one parse
// ============================================================

/** Parse source once and extract both symbols and code-graph edges.
 *
 * Symbols: top-level + class-method declarations; nested function
 * bodies are skipped.
 *
 * Edges:
 * - imports: each import/using/include → module + bound names.
 * - calls: every call expression anywhere in the tree. Callee
 *   resolution is name-based only (no type resolution — approximate is
 *   expected). `CallEdge.from` names the immediately-enclosing
 *   declaration, or `null` for module top-level calls. */
export function parseCode(
  language: SupportedLanguage,
  source: string
): { symbols: SymbolEntry[]; edges: CodeEdges } {
  const cfg = LANG_CONFIGS[language];
  const parser = getParser();
  parser.setLanguage(cfg.grammar as Parameters<Parser['setLanguage']>[0]);
  const tree = parser.parse(source);

  const symbols: SymbolEntry[] = [];
  walk(tree.rootNode as unknown as TSNode, symbols, cfg, { insideType: false });

  const imports: ImportEdge[] = [];
  const calls: CodeEdges['calls'] = [];
  walkEdges(tree.rootNode as unknown as TSNode, imports, calls, null, cfg);

  return { symbols, edges: { imports, calls } };
}

/** Convenience wrapper — symbols only. */
export function parseSymbols(language: SupportedLanguage, source: string): SymbolEntry[] {
  return parseCode(language, source).symbols;
}

function walk(node: TSNode, out: SymbolEntry[], cfg: LanguageConfig, ctx: WalkCtx): void {
  const spec = cfg.symbolKinds[node.type];
  let kind: SymbolKind | null = null;
  if (spec) kind = typeof spec === 'function' ? spec(node, ctx) : spec;

  if (kind) {
    const name = cfg.nameOf(node, kind);
    if (name) {
      out.push({
        name,
        kind,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }
  }

  // Don't descend into a callable's body — we capture top-level and
  // class-member declarations, not nested locals.
  if (kind === 'function' || kind === 'method') return;

  const childCtx: WalkCtx = kind === 'class' || kind === 'interface' ? { insideType: true } : ctx;
  for (const child of node.namedChildren) walk(child, out, cfg, childCtx);
}

function walkEdges(
  node: TSNode,
  imports: ImportEdge[],
  calls: CodeEdges['calls'],
  enclosingSymbol: string | null,
  cfg: LanguageConfig
): void {
  if (cfg.importNodeTypes.has(node.type)) {
    for (const edge of cfg.importsOf(node)) imports.push(edge);
    return; // import nodes don't contain calls
  }

  if (cfg.callNodeTypes.has(node.type)) {
    const callee = cfg.calleeOf(node);
    if (callee) {
      calls.push({
        from: enclosingSymbol,
        to: callee,
        line: node.startPosition.row + 1,
      });
    }
    // continue — calls nest (e.g. `foo(bar())`)
  }

  let nextEnclosing = enclosingSymbol;
  if (cfg.scopeNodeTypes.has(node.type)) {
    const name = cfg.scopeName(node);
    if (name !== null) nextEnclosing = name;
  }

  for (const child of node.namedChildren) walkEdges(child, imports, calls, nextEnclosing, cfg);
}

// ============================================================
// findSymbols — lazy-parse + scoped search over the store
// ============================================================

export interface FindScope {
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
  maxResults?: number;
  match?: 'substring' | 'exact';
  store?: ContextStore;
}

const DEFAULT_FIND_MAX = 50;

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

/** Get the symbols for a `(sourceId, version, itemId)`, lazily parsing
 * on miss. Returns null when the item has no cached content, or an
 * empty list when no language is detected for the path. */
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
    store.setSymbols(key, []);
    return [];
  }
  const symbols = parseSymbols(language, content);
  store.setSymbols(key, symbols);
  return symbols;
}

/** Get the code-graph edges for a `(sourceId, version, itemId)`,
 * lazily parsing on miss. Returns an empty graph for non-code items,
 * and null when the item has no cached content. */
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
