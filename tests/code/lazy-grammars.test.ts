import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import {
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

const realRequire = createRequire(import.meta.url);

/** A require that records every id it is asked for. */
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
function failingRequire(err: Error): { fn: (id: string) => unknown; calls: string[] } {
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

beforeEach(() => grammarLoaderForTests.setRequire(null));
afterEach(() => grammarLoaderForTests.setRequire(null));

describe('lazy loading and the per-language cache', () => {
  it('loads a language on its first parse', () => {
    const req = countingRequire();
    grammarLoaderForTests.setRequire(req.fn);
    expect(req.calls).toEqual([]);

    parseSymbols('python', 'def a():\n    pass\n');

    expect(req.calls).toEqual(['tree-sitter-python']);
    expect(grammarLoaderForTests.loadedLanguages()).toEqual(['python']);
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
    expect(grammarLoaderForTests.loadedLanguages()).toEqual(['go']);
  });
});

describe('grammar-not-installed (package absent)', () => {
  const absent = (id: string) =>
    withCode(`Cannot find module '${id}'\nRequire stack:\n- /x/y.js`, 'MODULE_NOT_FOUND');

  it('loadGrammar returns the named outcome, with the original error as cause', () => {
    const err = absent('tree-sitter-c-sharp');
    grammarLoaderForTests.setRequire(() => {
      throw err;
    });

    const result = loadGrammar('csharp');

    expect(result.kind).toBe('grammar-not-installed');
    if (result.kind !== 'grammar-not-installed') return;
    expect(result.language).toBe('csharp');
    expect(result.reason).toContain("Cannot find module 'tree-sitter-c-sharp'");
    expect(result.cause).toBe(err);
  });

  it('tryParseCode returns the named outcome instead of throwing', () => {
    grammarLoaderForTests.setRequire((id) => {
      throw absent(id);
    });

    const result = tryParseCode('csharp', 'class A {}');

    expect(result.kind).toBe('grammar-not-installed');
  });

  it('does not count as loaded', () => {
    grammarLoaderForTests.setRequire((id) => {
      throw absent(id);
    });
    loadGrammar('csharp');
    expect(grammarLoaderForTests.loadedLanguages()).toEqual([]);
  });
});

describe('grammar-load-failed (package present but broken)', () => {
  it('classifies a native load error as grammar-load-failed, with cause', () => {
    const err = withCode(
      'The module was compiled against a different Node.js version',
      'ERR_DLOPEN_FAILED'
    );
    grammarLoaderForTests.setRequire(failingRequire(err).fn);

    const result = loadGrammar('java');

    expect(result.kind).toBe('grammar-load-failed');
    if (result.kind !== 'grammar-load-failed') return;
    expect(result.cause).toBe(err);
    expect(result.reason).toContain('compiled against a different Node.js version');
  });

  it('classifies a MODULE_NOT_FOUND for a NESTED dependency as grammar-load-failed', () => {
    const err = withCode("Cannot find module 'node-gyp-build'", 'MODULE_NOT_FOUND');
    grammarLoaderForTests.setRequire(failingRequire(err).fn);

    expect(loadGrammar('java').kind).toBe('grammar-load-failed');
  });

  it('classifies a package with no usable export as grammar-load-failed', () => {
    grammarLoaderForTests.setRequire(() => ({}));

    // tree-sitter-typescript is picked by name; `{}` has no `typescript`.
    expect(loadGrammar('typescript').kind).toBe('grammar-load-failed');
  });

  it('tryParseCode surfaces grammar-load-failed rather than throwing', () => {
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);
    expect(tryParseCode('java', 'class A {}').kind).toBe('grammar-load-failed');
  });
});

describe('failure caching', () => {
  it('runs the failing require once per language, not once per file', () => {
    const req = failingRequire(
      withCode("Cannot find module 'tree-sitter-java'", 'MODULE_NOT_FOUND')
    );
    grammarLoaderForTests.setRequire(req.fn);

    const first = loadGrammar('java');
    const second = loadGrammar('java');
    tryParseCode('java', 'class A {}');
    tryParseCode('java', 'class B {}');

    expect(req.calls).toEqual(['tree-sitter-java']);
    expect(second).toBe(first);
    expect(grammarLoaderForTests.failedLanguages()).toEqual(['java']);
  });

  it('caches per language: one language failing does not stop another loading', () => {
    grammarLoaderForTests.setRequire((id) => {
      if (id === 'tree-sitter-java') throw new Error('boom');
      return realRequire(id);
    });

    expect(loadGrammar('java').kind).toBe('grammar-load-failed');
    expect(loadGrammar('python').kind).toBe('loaded');
  });

  it('keeps the failure for the process: a package that appears later is not picked up', () => {
    let installed = false;
    const calls: string[] = [];
    grammarLoaderForTests.setRequire((id) => {
      calls.push(id);
      if (!installed) throw withCode(`Cannot find module '${id}'`, 'MODULE_NOT_FOUND');
      return realRequire(id);
    });

    expect(loadGrammar('python').kind).toBe('grammar-not-installed');
    installed = true;
    expect(loadGrammar('python').kind).toBe('grammar-not-installed');
    expect(calls).toEqual(['tree-sitter-python']);
  });

  it('is cleared only by the test seam', () => {
    let installed = false;
    grammarLoaderForTests.setRequire((id) => {
      if (!installed) throw withCode(`Cannot find module '${id}'`, 'MODULE_NOT_FOUND');
      return realRequire(id);
    });
    expect(loadGrammar('python').kind).toBe('grammar-not-installed');
    installed = true;

    grammarLoaderForTests.reset();

    expect(loadGrammar('python').kind).toBe('loaded');
  });
});

describe('sync parseSymbols with an unavailable grammar', () => {
  it('constructs nothing at set-up: the loader is not called until a parse asks', () => {
    const req = failingRequire(new Error('boom'));
    grammarLoaderForTests.setRequire(req.fn);

    expect(req.calls).toEqual([]);
    expect(grammarLoaderForTests.failedLanguages()).toEqual([]);
  });

  it('throws GrammarUnavailableError carrying kind, language, reason and cause', () => {
    const err = new Error('boom');
    grammarLoaderForTests.setRequire(failingRequire(err).fn);

    let thrown: unknown;
    try {
      parseSymbols('java', 'class A {}');
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(GrammarUnavailableError);
    const e = thrown as GrammarUnavailableError;
    expect(e.kind).toBe('grammar-load-failed');
    expect(e.language).toBe('java');
    expect(e.reason).toBe('boom');
    expect(e.cause).toBe(err);
  });
});

describe('findSymbols / edgesForItem report a skipped file', () => {
  const key = { sourceId: 's', version: 'v', itemId: 'Thing.java' };

  function storeWithJava() {
    const store = createContextStore();
    store.setContent(key, 'class Thing { void run() {} }');
    return store;
  }

  it('findSymbols returns no hits, calls onSkip with the reason, and does not cache empty symbols', () => {
    const store = storeWithJava();
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);
    const skips: SkippedItem[] = [];

    const hits = findSymbols(
      'thing',
      { sources: [{ sourceId: 's', version: 'v' }] },
      { store, onSkip: (s) => skips.push(s) }
    );

    expect(hits).toEqual([]);
    expect(skips).toEqual([
      {
        sourceId: 's',
        version: 'v',
        itemId: 'Thing.java',
        language: 'java',
        kind: 'grammar-load-failed',
        reason: 'boom',
      },
    ]);
    expect(store.getSymbols(key)).toBeFalsy();
  });

  it('findSymbols finds the file once the grammar is available (empty was not cached)', () => {
    const store = storeWithJava();
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);
    findSymbols('thing', { sources: [{ sourceId: 's', version: 'v' }] }, { store });

    grammarLoaderForTests.setRequire(null);
    const hits = findSymbols('thing', { sources: [{ sourceId: 's', version: 'v' }] }, { store });

    expect(hits.map((h) => h.name)).toContain('Thing');
  });

  it('edgesForItem returns an empty graph, calls onSkip, and does not cache it', () => {
    const store = storeWithJava();
    grammarLoaderForTests.setRequire((id) => {
      throw withCode(`Cannot find module '${id}'`, 'MODULE_NOT_FOUND');
    });
    const skips: SkippedItem[] = [];

    const edges = edgesForItem(store, 's', 'v', 'Thing.java', { onSkip: (s) => skips.push(s) });

    expect(edges).toEqual({ imports: [], calls: [] });
    expect(skips).toHaveLength(1);
    expect(skips[0].kind).toBe('grammar-not-installed');
    expect(skips[0].language).toBe('java');
    expect(store.getEdges(key)).toBeFalsy();
  });

  it('works unchanged without onSkip (additive)', () => {
    const store = storeWithJava();
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);

    expect(findSymbols('thing', { sources: [{ sourceId: 's', version: 'v' }] }, { store })).toEqual(
      []
    );
    expect(edgesForItem(store, 's', 'v', 'Thing.java')).toEqual({ imports: [], calls: [] });
  });
});
