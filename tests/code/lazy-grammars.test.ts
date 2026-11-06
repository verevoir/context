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
  it('loadGrammar returns the named outcome, with the original error as cause', () => {
    const err = absent('tree-sitter-c-sharp');
    grammarLoaderForTests.setRequire(failingRequire(err).fn);

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

    expect(tryParseCode('csharp', 'class A {}').kind).toBe('grammar-not-installed');
  });

  it('the outcome is frozen', () => {
    grammarLoaderForTests.setRequire((id) => {
      throw absent(id);
    });

    const failure = loadGrammar('csharp');

    expect(Object.isFrozen(failure)).toBe(true);
    expect(() => {
      (failure as { kind: string }).kind = 'loaded';
    }).toThrow(TypeError);
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
    // tree-sitter-typescript is picked by name; `{}` has no `typescript`.
    grammarLoaderForTests.setRequire(() => ({}));

    expect(loadGrammar('typescript').kind).toBe('grammar-load-failed');
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
      if (!installed) throw absent(id);
      return realRequire(id);
    });

    expect(loadGrammar('python').kind).toBe('grammar-not-installed');
    installed = true;
    expect(loadGrammar('python').kind).toBe('grammar-not-installed');
    expect(calls).toEqual(['tree-sitter-python']);
  });

  it('keeps the failure until the test seam resets it', () => {
    let installed = false;
    grammarLoaderForTests.setRequire((id) => {
      if (!installed) throw absent(id);
      return realRequire(id);
    });
    expect(loadGrammar('python').kind).toBe('grammar-not-installed');
    installed = true;

    grammarLoaderForTests.reset();

    expect(loadGrammar('python').kind).toBe('loaded');
  });

  it('does not cache a transient failure (EMFILE): the next call retries and can succeed', () => {
    let calls = 0;
    grammarLoaderForTests.setRequire((id) => {
      calls += 1;
      if (calls === 1) throw withCode('EMFILE: too many open files', 'EMFILE');
      return realRequire(id);
    });

    const first = loadGrammar('python');
    const second = loadGrammar('python');

    expect(first.kind).toBe('grammar-load-failed');
    expect(second.kind).toBe('loaded');
    expect(calls).toBe(2);
  });

  it('caches EACCES as permanent (a permissions problem needs a fix and a restart)', () => {
    const req = failingRequire(withCode('EACCES: permission denied', 'EACCES'));
    grammarLoaderForTests.setRequire(req.fn);

    loadGrammar('python');
    loadGrammar('python');

    expect(req.calls).toEqual(['tree-sitter-python']);
  });
});

describe('GrammarUnavailableError from the sync parse functions', () => {
  const err = new Error('boom');
  function thrownBy(): unknown {
    grammarLoaderForTests.setRequire(failingRequire(err).fn);
    try {
      parseSymbols('java', 'class A {}');
    } catch (e) {
      return e;
    }
    return undefined;
  }

  it('is a GrammarUnavailableError', () => {
    expect(thrownBy()).toBeInstanceOf(GrammarUnavailableError);
  });

  it('carries the kind', () => {
    expect((thrownBy() as GrammarUnavailableError).kind).toBe('grammar-load-failed');
  });

  it('carries the language and reason', () => {
    const e = thrownBy() as GrammarUnavailableError;
    expect([e.language, e.reason]).toEqual(['java', 'boom']);
  });

  it('carries the original error as cause', () => {
    expect((thrownBy() as GrammarUnavailableError).cause).toBe(err);
  });
});

describe('findSymbols / edgesForItem report a skipped file', () => {
  const key = { sourceId: 's', version: 'v', itemId: 'Thing.java' };

  function storeWithJava() {
    const store = createContextStore();
    store.setContent(key, 'class Thing { void run() {} }');
    return store;
  }

  it('findSymbols returns no hits and calls onSkip with the reason', () => {
    const store = storeWithJava();
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);
    const skips: SkippedItem[] = [];

    const hits = findSymbols('thing', SCOPE, { store, onSkip: (s) => skips.push(s) });

    expect(hits).toEqual([]);
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
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);

    findSymbols('thing', SCOPE, { store });

    expect(store.getSymbols(key)).toBeFalsy();
  });

  it('findSymbols finds the file once the grammar is available (empty was not cached)', () => {
    const store = storeWithJava();
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);
    findSymbols('thing', SCOPE, { store });

    grammarLoaderForTests.setRequire(null);
    const hits = findSymbols('thing', SCOPE, { store });

    expect(hits.map((h) => h.name)).toContain('Thing');
  });

  it('edgesForItem returns an empty graph and calls onSkip', () => {
    const store = storeWithJava();
    grammarLoaderForTests.setRequire((id) => {
      throw absent(id);
    });
    const skips: SkippedItem[] = [];

    const edges = edgesForItem(store, 's', 'v', 'Thing.java', { onSkip: (s) => skips.push(s) });

    expect(edges).toEqual({ imports: [], calls: [] });
    expect(skips.map((s) => [s.kind, s.language])).toEqual([['grammar-not-installed', 'java']]);
  });

  it('edgesForItem does not cache the empty graph', () => {
    const store = storeWithJava();
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);

    edgesForItem(store, 's', 'v', 'Thing.java');

    expect(store.getEdges(key)).toBeFalsy();
  });

  it('works unchanged without onSkip (additive)', () => {
    const store = storeWithJava();
    grammarLoaderForTests.setRequire(failingRequire(new Error('boom')).fn);

    expect(findSymbols('thing', SCOPE, { store })).toEqual([]);
    expect(edgesForItem(store, 's', 'v', 'Thing.java')).toEqual({ imports: [], calls: [] });
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

  it('findSymbols reports kind parse-failed through onSkip', () => {
    const store = storeWithBadContent();
    const skips: SkippedItem[] = [];

    const hits = findSymbols('a', SCOPE, { store, onSkip: (s) => skips.push(s) });

    expect(hits).toEqual([]);
    expect(skips.map((s) => [s.kind, s.language, s.itemId])).toEqual([
      ['parse-failed', 'python', 'a.py'],
    ]);
    expect(skips[0].reason.length).toBeGreaterThan(0);
  });

  it('findSymbols does not cache the empty result, so the next call reports again', () => {
    const store = storeWithBadContent();
    const skips: SkippedItem[] = [];
    const onSkip = (s: SkippedItem) => skips.push(s);

    findSymbols('a', SCOPE, { store, onSkip });
    findSymbols('a', SCOPE, { store, onSkip });

    expect(store.getSymbols(key)).toBeFalsy();
    expect(skips).toHaveLength(2);
  });

  it('edgesForItem reports kind parse-failed and returns an empty graph', () => {
    const store = storeWithBadContent();
    const skips: SkippedItem[] = [];

    const edges = edgesForItem(store, 's', 'v', 'a.py', { onSkip: (s) => skips.push(s) });

    expect(edges).toEqual({ imports: [], calls: [] });
    expect(skips.map((s) => s.kind)).toEqual(['parse-failed']);
  });

  it('edgesForItem does not cache the empty graph', () => {
    const store = storeWithBadContent();

    edgesForItem(store, 's', 'v', 'a.py');

    expect(store.getEdges(key)).toBeFalsy();
  });

  it('works without onSkip (additive): still empty, no throw', () => {
    const store = storeWithBadContent();

    expect(findSymbols('a', SCOPE, { store })).toEqual([]);
  });
});
