// Internal to @verevoir/context/code — lazy tree-sitter grammar loading.
// The loading semantics are described HERE, once; index.ts and the docs
// refer to this file.
//
// Not a package entry point: `package.json` `exports` maps only
// `./code` → `dist/code/index.js`, which re-exports the public names
// below. The test seam (`grammarLoaderForTests`) is deliberately NOT
// re-exported from `index.ts`.
//
// Each grammar is `require`d on FIRST USE for its language through
// `createRequire(import.meta.url)` and cached per language — success AND
// failure. A static ESM `import` would load every grammar when the
// module is imported, and tree-sitter-c-sharp 0.23.5 ("type": "module",
// extensionless "main": "bindings/node") makes Node's ESM resolver emit
// DEP0151.
//
// Outcomes (`GrammarLoadResult`):
// - `loaded`                — grammar object, cached.
// - `grammar-not-installed` — `require` failed with MODULE_NOT_FOUND /
//                             ERR_MODULE_NOT_FOUND naming the grammar
//                             package itself.
// - `grammar-load-failed`   — anything else: the package is present but
//                             throws while loading (ABI mismatch, bad
//                             `main`, a missing nested dependency, no
//                             usable export, `require(esm)` unsupported)
//                             or `parser.setLanguage` rejects the grammar
//                             (`recordLoadFailure`).
// Failures carry the original error as `cause`, are frozen, and are
// cached for the life of the process: the doomed `require` is not re-run
// for every file, and installing / fixing the package needs a process
// restart. The only in-process clear is the test seam.
//
// A grammar package that is itself an ES module needs `require(esm)`,
// which is unflagged from Node 20.19.0 / 22.12.0; on older Node it fails
// as `grammar-load-failed` (ERR_REQUIRE_ESM).

import { createRequire } from 'node:module';
import type { SupportedLanguage } from './index.js';

/** Package + export selector for each language's grammar. Ten
 * languages, nine packages (tree-sitter-typescript serves both
 * `typescript` and `tsx`). */
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

/** Thrown by the sync `parseCode` / `parseSymbols` when the grammar for
 * the requested language is unavailable. `kind` is the failure's kind;
 * the original error is on `cause`. */
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

/** True when `err` is a MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND for the
 * grammar package ITSELF (first line of the message names it in
 * quotes), not for something the package requires. */
function isPackageAbsent(err: unknown, pkg: string): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') return false;
  return err.message.split('\n')[0].includes(`'${pkg}'`);
}

/** `require(esm)` returns the namespace; Node marks a default-exporting
 * ES module with `__esModule: true`. Unwrap to the default so an
 * ESM-flavoured grammar package yields the same object a CJS one does.
 * (tests/code/dep0151.test.ts logs the Node it verified this on.) */
function unwrapDefault(mod: unknown): unknown {
  if (mod && typeof mod === 'object' && (mod as { __esModule?: unknown }).__esModule === true) {
    if ('default' in mod) return (mod as { default: unknown }).default;
  }
  return mod;
}

/** Record (and cache) that a language's grammar loaded but cannot be
 * used — e.g. `parser.setLanguage` threw on an ABI mismatch. Replaces
 * any cached success for the language. */
export function recordLoadFailure(language: SupportedLanguage, err: unknown): GrammarLoadFailed {
  const failure = Object.freeze<GrammarLoadFailed>({
    kind: 'grammar-load-failed',
    language,
    reason: describeError(err),
    cause: err,
  });
  grammarCache.delete(language);
  failureCache.set(language, failure);
  return failure;
}

/** Load (first use) and cache the grammar for a language. Never throws;
 * a failure is cached too and the same frozen object is returned next
 * time. */
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
    if (isPackageAbsent(err, source.pkg)) {
      const failure = Object.freeze<GrammarNotInstalled>({
        kind: 'grammar-not-installed',
        language,
        reason: describeError(err),
        cause: err,
      });
      failureCache.set(language, failure);
      return failure;
    }
    return recordLoadFailure(language, err);
  }
}

/** TEST SEAM — internal, not exported from the package. `setRequire`
 * swaps the `require` used to load grammars (null restores the real
 * one) and clears the success AND failure caches; `reset` clears both. */
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
  loadedLanguages(): SupportedLanguage[] {
    return [...grammarCache.keys()];
  },
  failedLanguages(): SupportedLanguage[] {
    return [...failureCache.keys()];
  },
};
