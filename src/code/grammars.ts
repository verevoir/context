// Internal to @verevoir/context/code — lazy tree-sitter grammar loading.
// Not a package entry: `exports` maps only `./code` → dist/code/index.js,
// which re-exports the public names. `grammarLoaderForTests` is not.
//
// Each grammar is `require`d on first use through
// `createRequire(import.meta.url)`, not statically imported (a static
// import loads every grammar up front, and tree-sitter-c-sharp 0.23.5 —
// "type": "module", extensionless "main" — makes the ESM resolver emit
// DEP0151).
//
// Outcomes: `loaded`; `grammar-not-installed` (MODULE_NOT_FOUND /
// ERR_MODULE_NOT_FOUND naming the grammar package itself);
// `grammar-load-failed` (anything else, including `parser.setLanguage`
// rejecting the grammar). Failures are frozen and carry the original
// error as `cause`. Permanent failures are cached per language for the
// process (a later install needs a restart); transient ones
// (TRANSIENT_CODES) are returned but not cached, so the next call retries.
//
// An ES-module grammar needs require(esm): Node >= 20.19.0 on 20.x and
// >= 22.12.0 on 22.x (Node docs, "Loading ECMAScript modules using
// require()"; the same range is vite's `engines` in package-lock.json).
// Older Node: `grammar-load-failed` with ERR_REQUIRE_ESM.

import { createRequire } from 'node:module';
import type { SupportedLanguage } from './index.js';

/** Package + export selector per language: ten languages, nine packages
 * (tree-sitter-typescript serves both `typescript` and `tsx`). */
const GRAMMAR_SOURCES: Readonly<
  Record<SupportedLanguage, { pkg: string; pick?: (mod: any) => unknown }>
> = {
  typescript: { pkg: 'tree-sitter-typescript', pick: (m) => m.typescript },
  tsx: { pkg: 'tree-sitter-typescript', pick: (m) => m.tsx },
  javascript: { pkg: 'tree-sitter-javascript' },
  python: { pkg: 'tree-sitter-python' },
  java: { pkg: 'tree-sitter-java' },
  csharp: { pkg: 'tree-sitter-c-sharp' },
  go: { pkg: 'tree-sitter-go' },
  scala: { pkg: 'tree-sitter-scala' },
  c: { pkg: 'tree-sitter-c' },
  cpp: { pkg: 'tree-sitter-cpp' },
};

/** Error codes that may clear on their own (descriptor exhaustion, a busy
 * or momentarily unreadable file); a failure with one of these is not
 * cached. Everything else (package absent, ERR_REQUIRE_ESM,
 * ERR_DLOPEN_FAILED, no usable export, setLanguage rejection) is
 * permanent for the process. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'EMFILE',
  'ENFILE',
  'EAGAIN',
  'EBUSY',
  'EIO',
  'EINTR',
  'ETIMEDOUT',
  'EACCES',
]);

/** The grammar package is not installed. */
export interface GrammarNotInstalled {
  kind: 'grammar-not-installed';
  language: SupportedLanguage;
  reason: string;
  /** The original error from `require`. */
  cause: unknown;
}

/** The grammar package is present but failed to load or to be used. */
export interface GrammarLoadFailed {
  kind: 'grammar-load-failed';
  language: SupportedLanguage;
  reason: string;
  /** The original error from `require`, the export pick, or `setLanguage`. */
  cause: unknown;
}

export type GrammarFailure = GrammarNotInstalled | GrammarLoadFailed;

export type GrammarLoadResult =
  | { kind: 'loaded'; language: SupportedLanguage; grammar: unknown }
  | GrammarFailure;

/** Thrown by the sync `parseCode` / `parseSymbols` when the grammar is
 * unavailable; carries the failure's `kind`, `language`, `reason`, and the
 * original error as `cause`. */
export class GrammarUnavailableError extends Error {
  readonly kind: GrammarFailure['kind'];
  readonly language: SupportedLanguage;
  readonly reason: string;
  constructor(failure: GrammarFailure) {
    super(`tree-sitter grammar for ${failure.language}: ${failure.kind} (${failure.reason})`, {
      cause: failure.cause,
    });
    this.name = 'GrammarUnavailableError';
    this.kind = failure.kind;
    this.language = failure.language;
    this.reason = failure.reason;
  }
}

type RequireFn = (id: string) => unknown;

const defaultRequire: RequireFn = createRequire(import.meta.url);
let requireFn: RequireFn = defaultRequire;
const grammarCache = new Map<SupportedLanguage, unknown>();
const failureCache = new Map<SupportedLanguage, GrammarFailure>();

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function failureFor(
  language: SupportedLanguage,
  kind: GrammarFailure['kind'],
  err: unknown
): GrammarFailure {
  return Object.freeze({
    kind,
    language,
    reason: describeError(err),
    cause: err,
  }) as GrammarFailure;
}

/** True when `err` is a not-found error for the grammar package ITSELF
 * (first message line names it in quotes), not for something it requires. */
function isPackageAbsent(err: unknown, pkg: string): boolean {
  const code = errorCode(err);
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') return false;
  return (err as Error).message.split('\n')[0].includes(`'${pkg}'`);
}

/** `require(esm)` returns the namespace, which Node marks `__esModule:
 * true` when the module has a default export (Node docs, same section as
 * above). Unwrap to the default so an ES-module grammar yields the same
 * object a CommonJS one does. LIMIT: exercised only on Node 26.5.1
 * (tests/code/dep0151.test.ts logs the Node); not run on 20.19 / 22.12. */
function unwrapDefault(mod: unknown): unknown {
  if (mod && typeof mod === 'object' && (mod as { __esModule?: unknown }).__esModule === true) {
    if ('default' in mod) return (mod as { default: unknown }).default;
  }
  return mod;
}

/** Record (and cache) that a language's grammar loaded but cannot be
 * used — e.g. `parser.setLanguage` threw on an ABI mismatch. Replaces any
 * cached success for the language. */
export function recordLoadFailure(language: SupportedLanguage, err: unknown): GrammarLoadFailed {
  const failure = failureFor(language, 'grammar-load-failed', err) as GrammarLoadFailed;
  grammarCache.delete(language);
  failureCache.set(language, failure);
  return failure;
}

/** Load (first use) and cache the grammar for a language. Never throws.
 * A permanent failure is cached and the same frozen object returned next
 * time; a transient one is returned uncached. */
export function loadGrammar(language: SupportedLanguage): GrammarLoadResult {
  if (grammarCache.has(language)) {
    return { kind: 'loaded', language, grammar: grammarCache.get(language) };
  }
  const failed = failureCache.get(language);
  if (failed) return failed;

  const source = GRAMMAR_SOURCES[language];
  try {
    const mod = unwrapDefault(requireFn(source.pkg));
    const grammar = source.pick ? source.pick(mod) : mod;
    if (!grammar) throw new Error(`${source.pkg} did not export a ${language} grammar`);
    grammarCache.set(language, grammar);
    return { kind: 'loaded', language, grammar };
  } catch (err) {
    const kind = isPackageAbsent(err, source.pkg) ? 'grammar-not-installed' : 'grammar-load-failed';
    const failure = failureFor(language, kind, err);
    const code = errorCode(err);
    if (code === undefined || !TRANSIENT_CODES.has(code)) failureCache.set(language, failure);
    return failure;
  }
}

/** TEST SEAM — internal, not exported from the package. `setRequire` swaps
 * the `require` used to load grammars (null restores the real one) and
 * clears both caches; `reset` clears both caches. */
export const grammarLoaderForTests = {
  setRequire(fn: RequireFn | null): void {
    requireFn = fn ?? defaultRequire;
    grammarCache.clear();
    failureCache.clear();
  },
  reset(): void {
    grammarCache.clear();
    failureCache.clear();
  },
};
