import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  detectLanguage,
  loadGrammar,
  parseSymbols,
  tryParseCode,
  findSymbols,
  edgesForItem,
  GrammarUnavailableError,
  type SkippedItem,
} from '../../src/code/index.js';
import { grammarLoaderForTests } from '../../src/code/grammars.js';
import { createContextStore } from '../../src/index.js';

// Why the tests drive grammar loading through `grammarLoaderForTests`: the
// loader's only external effect is `require`, and the behaviours under test
// (first use, reuse, failure caching, classification) are exactly what is
// observable at that boundary. The seam is internal (src/code/grammars.ts,
// not re-exported) and replacing it would mean installing/removing real
// packages mid-test.

const realRequire = createRequire(import.meta.url);

/** A require that records every id it is asked for, then loads it for real. */
function countingRequire(): { fn: (id: string) => unknown; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fn: (id) => {
      calls.push(id);
      return realRequire(id);
    },
  };
}

/** A require that always throws `err`, recording each call. */
function failingRequire(err: unknown): { fn: (id: string) => unknown; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fn: (id) => {
      calls.push(id);
      throw err;
    },
  };
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

const absent = (id: string) =>
  withCode(`Cannot find module '${id}'\nRequire stack:\n- /x/y.js`, 'MODULE_NOT_FOUND');

const SCOPE = { sources: [{ sourceId: 's', version: 'v' }] };

beforeEach(() => grammarLoaderForTests.setRequire(null));
afterEach(() => grammarLoaderForTests.setRequire(null));

describe('lazy loading and the per-language cache', () => {
  it('loads a language on its first parse', () => {
    const req = countingRequire();
    grammarLoaderForTests.setRequire(req.fn);

    parseSymbols('python', 'def a():\n    pass\n');

    expect(req.calls).toEqual(['tree-sitter-python']);
  });

  it('reuses the cached grammar on the second parse', () => {
    const req = countingRequire();
    grammarLoaderForTests.setRequire(req.fn);

    parseSymbols('python', 'def a():\n    pass\n');
    parseSymbols('python', 'def b():\n    pass\n');

    expect(req.calls).toEqual(['tree-sitter-python']);
  });

  it('does not load grammars for languages that were not used', () => {
    const req = countingRequire();
    grammarLoaderForTests.setRequire(req.fn);

    parseSymbols('go', 'package main\nfunc main() {}\n');

    expect(req.calls).toEqual(['tree-sitter-go']);
  });
});

describe('code-free paths never call the loader', () => {
  it('detectLanguage, a non-code item and a code-free search leave the loader untouched', () => {
    const req = failingRequire(new Error('boom'));
    grammarLoaderForTests.setRequire(req.fn);
    const store = createContextStore();
    store.setContent({ sourceId: 's', version: 'v', itemId: 'notes.txt' }, 'Thing');

    detectLanguage('a/b.ts');
    findSymbols('thing', SCOPE, { store });
    edgesForItem(store, 's', 'v', 'notes.txt');

    expect(req.calls).toEqual([]);
  });
});

describe('grammar-not-installed (package absent)', () => {
  const err = absent('tree-sitter-c-sharp');
  function result() {
    grammarLoaderForTests.setRequire(failingRequire(err).fn);
    return loadGrammar('csharp');
  }

  it('loadGrammar names the outcome', () => {
    expect(result().kind).toBe('grammar-not-installed');
  });

  it('carries the language', () => {
    const r = result();
    expect(r.kind !== 'loaded' && r.language).toBe('csharp');
  });

  it('carries the reason', () => {
    const r = result();
    expect(r.kind !== 'loaded' && r.reason).toContain("Cannot find module 'tree-sitter-c-sharp'");
  });

  it('carries the original error as cause', () => {
    const r = result();
    expect(r.kind !== 'loaded' && r.cause).toBe(err);
  });

  it('tryParseCode returns the named outcome instead of throwing', () => {
    grammarLoaderForTests.setRequire((id) => {
      throw absent(id);
    });

    expect(tryParseCode('csharp', 'class A {}').kind).toBe('grammar-not-installed');
  });

  it('the outcome is frozen', () => {
    expect(Object.isFrozen(result())).toBe(true);
  });

  it('the outcome rejects mutation by a caller', () => {
    const failure = result();

    expect(() => {
      (failure as { kind: string }).kind = 'loaded';
    }).toThrow(TypeError);
  });
});

describe('grammar-load-failed (package present but broken)', () => {
  const nativeErr = withCode(
    'The module was compiled against a different Node.js version',
    'ERR_DLOPEN_FAILED'
  );
  function nativeResult() {
    grammarLoaderForTests.setRequire(failingRequire(nativeErr).fn);
    return loadGrammar('java');
  }

  it('classifies a native load error as grammar-load-failed', () => {
    expect(nativeResult().kind).toBe('grammar-load-failed');
  });

  it('keeps the native load error as cause', () => {
    const r = nativeResult();
    expect(r.kind !== 'loaded' && r.cause).toBe(nativeErr);
  });

  it('uses the native load error message as the reason', () => {
    const r = nativeResult();
    expect(r.kind !== 'loaded' && r.reason).toContain('compiled against a different Node.js');
  });

  it('classifies a MODULE_NOT_FOUND for a NESTED dependency as grammar-load-failed', () => {
    const err = withCode("Cannot find module 'node-gyp-build'", 'MODULE_NOT_FOUND');
    grammarLoaderForTests.setRequire(failingRequire(err).fn);

    expect(loadGrammar('java').kind).toBe('grammar-load-failed');
  });

  it('classifies a package with no usable export as grammar-load-failed', () => {
    // tree-sitter-typescript is picked by name; `{}` has no `typescript`.
    grammarLoaderForTests.setRequire(() => ({}));

    expect(loadGrammar('typescript').kind).toBe('grammar-load-failed');
  });

  it('for no usable export, cause is the synthetic Error we construct (nothing was thrown)', () => {
    grammarLoaderForTests.setRequire(() => ({}));

    const r = loadGrammar('typescript');

    expect(r.kind !== 'loaded' && (r.cause as Error).message).toBe(
      'tree-sitter-typescript did not export a typescript grammar'
    );
  });

  it('tryParseCode surfaces grammar-load-failed rather than throwing', () => {
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);

    expect(tryParseCode('java', 'class A {}').kind).toBe('grammar-load-failed');
  });
});

describe('failure caching', () => {
  const javaAbsent = () => failingRequire(absent('tree-sitter-java'));

  it('runs the failing require once per language, not once per file', () => {
    const req = javaAbsent();
    grammarLoaderForTests.setRequire(req.fn);

    loadGrammar('java');
    loadGrammar('java');
    tryParseCode('java', 'class A {}');
    tryParseCode('java', 'class B {}');

    expect(req.calls).toEqual(['tree-sitter-java']);
  });

  it('returns the same cached outcome object on later calls', () => {
    grammarLoaderForTests.setRequire(javaAbsent().fn);

    const first = loadGrammar('java');

    expect(loadGrammar('java')).toBe(first);
  });

  it('caches a load error such as ERR_REQUIRE_ESM too', () => {
    const req = failingRequire(withCode('require() of ES Module', 'ERR_REQUIRE_ESM'));
    grammarLoaderForTests.setRequire(req.fn);

    loadGrammar('csharp');
    loadGrammar('csharp');

    expect(req.calls).toEqual(['tree-sitter-c-sharp']);
  });

  function javaFailsPythonLoads() {
    grammarLoaderForTests.setRequire((id) => {
      if (id === 'tree-sitter-java') throw new Error('boom');
      return realRequire(id);
    });
  }

  it('caches per language: the failing language stays failed', () => {
    javaFailsPythonLoads();

    expect(loadGrammar('java').kind).toBe('grammar-load-failed');
  });

  it('caches per language: another language still loads', () => {
    javaFailsPythonLoads();
    loadGrammar('java');

    expect(loadGrammar('python').kind).toBe('loaded');
  });

  function appearsLater() {
    const state = { installed: false, calls: [] as string[] };
    grammarLoaderForTests.setRequire((id) => {
      state.calls.push(id);
      if (!state.installed) throw absent(id);
      return realRequire(id);
    });
    return state;
  }

  it('keeps the failure for the process: a package that appears later is not picked up', () => {
    const state = appearsLater();
    loadGrammar('python');
    state.installed = true;

    expect(loadGrammar('python').kind).toBe('grammar-not-installed');
  });

  it('does not re-run the require for a package that appears later', () => {
    const state = appearsLater();
    loadGrammar('python');
    state.installed = true;
    loadGrammar('python');

    expect(state.calls).toEqual(['tree-sitter-python']);
  });

  it('keeps the failure until the test seam resets it', () => {
    const state = appearsLater();
    loadGrammar('python');
    state.installed = true;

    grammarLoaderForTests.reset();

    expect(loadGrammar('python').kind).toBe('loaded');
  });
});

describe('GrammarUnavailableError from the sync parse functions', () => {
  const err = new Error('boom');
  function thrownBy(): GrammarUnavailableError {
    grammarLoaderForTests.setRequire(failingRequire(err).fn);
    try {
      parseSymbols('java', 'class A {}');
    } catch (e) {
      return e as GrammarUnavailableError;
    }
    throw new Error('parseSymbols did not throw');
  }

  it('is a GrammarUnavailableError', () => {
    expect(thrownBy()).toBeInstanceOf(GrammarUnavailableError);
  });

  it('carries the kind', () => {
    expect(thrownBy().kind).toBe('grammar-load-failed');
  });

  it('carries the language', () => {
    expect(thrownBy().language).toBe('java');
  });

  it('carries the reason', () => {
    expect(thrownBy().reason).toBe('boom');
  });

  it('carries the original error as cause', () => {
    expect(thrownBy().cause).toBe(err);
  });
});

describe('findSymbols / edgesForItem report a skipped file', () => {
  const key = { sourceId: 's', version: 'v', itemId: 'Thing.java' };

  function storeWithJava() {
    const store = createContextStore();
    store.setContent(key, 'class Thing { void run() {} }');
    return store;
  }
  function boomRequire() {
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);
  }

  it('findSymbols returns no hits', () => {
    boomRequire();

    expect(findSymbols('thing', SCOPE, { store: storeWithJava() })).toEqual([]);
  });

  it('findSymbols calls onSkip with the file, language, kind and reason', () => {
    boomRequire();
    const skips: SkippedItem[] = [];

    findSymbols('thing', SCOPE, { store: storeWithJava(), onSkip: (s) => skips.push(s) });

    expect(skips).toEqual([
      {
        sourceId: 's',
        version: 'v',
        itemId: 'Thing.java',
        language: 'java',
        kind: 'grammar-load-failed',
        reason: 'boom',
        cause: expect.objectContaining({ message: 'boom' }),
      },
    ]);
  });

  it('findSymbols does not cache the empty symbols', () => {
    const store = storeWithJava();
    boomRequire();

    findSymbols('thing', SCOPE, { store });

    expect(store.getSymbols(key)).toBeFalsy();
  });

  it('findSymbols finds the file once the grammar is available (empty was not cached)', () => {
    const store = storeWithJava();
    boomRequire();
    findSymbols('thing', SCOPE, { store });

    grammarLoaderForTests.setRequire(null);
    const hits = findSymbols('thing', SCOPE, { store });

    expect(hits.map((h) => h.name)).toContain('Thing');
  });

  it('edgesForItem returns an empty graph', () => {
    grammarLoaderForTests.setRequire((id) => {
      throw absent(id);
    });

    expect(edgesForItem(storeWithJava(), 's', 'v', 'Thing.java')).toEqual({
      imports: [],
      calls: [],
    });
  });

  it('edgesForItem calls onSkip with the kind and language', () => {
    grammarLoaderForTests.setRequire((id) => {
      throw absent(id);
    });
    const skips: SkippedItem[] = [];

    edgesForItem(storeWithJava(), 's', 'v', 'Thing.java', { onSkip: (s) => skips.push(s) });

    expect(skips.map((s) => [s.kind, s.language])).toEqual([['grammar-not-installed', 'java']]);
  });

  it('edgesForItem does not cache the empty graph', () => {
    const store = storeWithJava();
    boomRequire();

    edgesForItem(store, 's', 'v', 'Thing.java');

    expect(store.getEdges(key)).toBeFalsy();
  });

  it('findSymbols works unchanged without onSkip (additive)', () => {
    boomRequire();

    expect(findSymbols('thing', SCOPE, { store: storeWithJava() })).toEqual([]);
  });

  it('edgesForItem works unchanged without onSkip (additive)', () => {
    boomRequire();

    expect(edgesForItem(storeWithJava(), 's', 'v', 'Thing.java')).toEqual({
      imports: [],
      calls: [],
    });
  });
});

describe('a parse that throws (not a grammar problem)', () => {
  // A non-string content makes the real python parse throw a TypeError
  // (Buffer.byteLength) AFTER the grammar has loaded, so it is a parse
  // failure, not a grammar failure.
  const key = { sourceId: 's', version: 'v', itemId: 'a.py' };
  function storeWithBadContent() {
    const store = createContextStore();
    store.setContent(key, 42 as unknown as string);
    return store;
  }
  function skipsFromFind(store = storeWithBadContent()): SkippedItem[] {
    const skips: SkippedItem[] = [];
    findSymbols('a', SCOPE, { store, onSkip: (s) => skips.push(s) });
    return skips;
  }

  it('findSymbols returns no hits', () => {
    expect(findSymbols('a', SCOPE, { store: storeWithBadContent() })).toEqual([]);
  });

  it('findSymbols reports kind parse-failed, language and item through onSkip', () => {
    expect(skipsFromFind().map((s) => [s.kind, s.language, s.itemId])).toEqual([
      ['parse-failed', 'python', 'a.py'],
    ]);
  });

  it('findSymbols reports a non-empty reason', () => {
    expect(skipsFromFind()[0].reason.length).toBeGreaterThan(0);
  });

  it('findSymbols does not cache the empty result', () => {
    const store = storeWithBadContent();
    skipsFromFind(store);

    expect(store.getSymbols(key)).toBeFalsy();
  });

  it('findSymbols reports again on the next call', () => {
    const store = storeWithBadContent();
    skipsFromFind(store);

    expect(skipsFromFind(store)).toHaveLength(1);
  });

  it('edgesForItem returns an empty graph', () => {
    expect(edgesForItem(storeWithBadContent(), 's', 'v', 'a.py')).toEqual({
      imports: [],
      calls: [],
    });
  });

  it('edgesForItem reports kind parse-failed', () => {
    const skips: SkippedItem[] = [];

    edgesForItem(storeWithBadContent(), 's', 'v', 'a.py', { onSkip: (s) => skips.push(s) });

    expect(skips.map((s) => s.kind)).toEqual(['parse-failed']);
  });

  it('edgesForItem does not cache the empty graph', () => {
    const store = storeWithBadContent();

    edgesForItem(store, 's', 'v', 'a.py');

    expect(store.getEdges(key)).toBeFalsy();
  });
});
