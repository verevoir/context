// Internal to @verevoir/context/code — lazy tree-sitter grammar loading.
// `exports` maps only `./code` → dist/code/index.js, which re-exports the
// public names; `grammarLoaderForTests` is not among them.
//
// Each grammar is `require`d on first use via `createRequire`, never
// statically imported (that loads every grammar up front, and
// tree-sitter-c-sharp 0.23.5 — "type": "module", extensionless "main" —
// makes the ESM resolver emit DEP0151).
//
// Outcomes: `loaded`; `grammar-not-installed` (MODULE_NOT_FOUND /
// ERR_MODULE_NOT_FOUND naming the grammar package itself);
// `grammar-load-failed` (anything else, incl. `parser.setLanguage`
// rejecting it). Failures are frozen and carry the original error as
// `cause`. Permanent ones are cached per language for the process (a later
// install needs a restart); TRANSIENT_CODES are returned uncached.
//
// ES-module grammars need require(esm). Per Node's modules docs
// (https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require,
// read by the coordinator via a summarising fetch on 2026-11-06 — a
// summary, not a raw read): it works without a flag from 20.19.0 / 22.12.0 /
// 23.0.0; the default experimental warning stops from 20.19.0 / 22.13.0 /
// 23.5.0 (so 22.12.x may warn); top-level await anywhere in the graph throws
// ERR_REQUIRE_ASYNC_MODULE, which lands here as `grammar-load-failed`.
// Which error older Node throws is not confirmed by that read.

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

/** Codes that clear on their own (descriptor exhaustion, busy resource, I/O
 * hiccup, timeout, interrupt); a failure with one is not cached. EACCES is
 * deliberately NOT here: a permissions problem needs someone to fix it, and
 * retrying would re-run the failing require for every file meanwhile. */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'EMFILE',
  'ENFILE',
  'EAGAIN',
  'EBUSY',
  'EIO',
  'EINTR',
  'ETIMEDOUT',
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
  /** The original error from `require`, or from `setLanguage`. When the
   * package loads but exports no usable grammar nothing was thrown, so it
   * is the synthetic `Error` we construct ("<pkg> did not export a <language>
   * grammar"). */
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

/** Never throws: a thrown value can have a throwing getter / toString. */
export function describeError(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err);
  } catch {
    return '[unprintable error]';
  }
}

function errorCode(err: unknown): string | undefined {
  try {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
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
  return describeError(err).split('\n')[0].includes(`'${pkg}'`);
}

/** Per the docs read above, Node adds `__esModule: true` to a require(esm)
 * namespace only when it has a `default` export (and the property is for
 * tools). Unwrap that default so an ES-module grammar yields the same
 * object a CommonJS one does; a namespace without `default` (so without
 * `__esModule`) is returned as-is. LIMIT: the real marking was observed only
 * on Node 26.5.1 (tests/code/dep0151.test.ts logs the Node). */
function unwrapDefault(mod: unknown): unknown {
  if (mod && typeof mod === 'object' && (mod as { __esModule?: unknown }).__esModule === true) {
    if ('default' in mod) return (mod as { default: unknown }).default;
  }
  return mod;
}

/** Record (and cache) that a language's grammar loaded but cannot be
 * used — e.g. `parser.setLanguage` threw on an ABI mismatch. Replaces any
 * cached success for the language. Cached unconditionally, with no
 * TRANSIENT_CODES check: `setLanguage` does no I/O, so its failure is a
 * property of the grammar object and would recur identically. */
export function recordLoadFailure(language: SupportedLanguage, err: unknown): GrammarLoadFailed {
  const failure = failureFor(language, 'grammar-load-failed', err) as GrammarLoadFailed;
  grammarCache.delete(language);
  failureCache.set(language, failure);
  return failure;
}

/** Load (first use) and cache the grammar for a language. Does not throw
 * for any SupportedLanguage: every failure path, including inspecting a
 * hostile thrown value, is guarded. A permanent failure is cached and the
 * same frozen object returned next time; a transient one is uncached. */
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
