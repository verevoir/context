import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadGrammar, tryParseCode, findSymbols, edgesForItem } from '../../src/code/index.js';
import type { SkippedItem } from '../../src/code/index.js';
import { grammarLoaderForTests } from '../../src/code/grammars.js';
import { createContextStore } from '../../src/index.js';

beforeEach(() => grammarLoaderForTests.setRequire(null));
afterEach(() => grammarLoaderForTests.setRequire(null));

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

const SCOPE = { sources: [{ sourceId: 's', version: 'v' }] };

describe('isPackageAbsent branches', () => {
  it('ERR_MODULE_NOT_FOUND naming the grammar package is grammar-not-installed', () => {
    grammarLoaderForTests.setRequire(() => {
      throw withCode(
        "Cannot find package 'tree-sitter-go' imported from /x/y.js",
        'ERR_MODULE_NOT_FOUND'
      );
    });
    expect(loadGrammar('go').kind).toBe('grammar-not-installed');
  });

  it('ERR_MODULE_NOT_FOUND naming a different package is grammar-load-failed', () => {
    grammarLoaderForTests.setRequire(() => {
      throw withCode(
        "Cannot find package 'node-gyp-build' imported from /x/y.js",
        'ERR_MODULE_NOT_FOUND'
      );
    });
    expect(loadGrammar('go').kind).toBe('grammar-load-failed');
  });

  it('an error that names the package but has another code is grammar-load-failed', () => {
    grammarLoaderForTests.setRequire(() => {
      throw withCode("ENOENT: cannot open 'tree-sitter-go'", 'ENOENT');
    });
    expect(loadGrammar('go').kind).toBe('grammar-load-failed');
  });
});

describe('export pick', () => {
  const both = () => ({ typescript: 'TS-GRAMMAR', tsx: 'TSX-GRAMMAR' });

  it('typescript picks the `typescript` export of tree-sitter-typescript', () => {
    grammarLoaderForTests.setRequire(both);
    const ts = loadGrammar('typescript');
    expect(ts.kind === 'loaded' && ts.grammar).toBe('TS-GRAMMAR');
  });

  it('tsx picks the `tsx` export of tree-sitter-typescript', () => {
    grammarLoaderForTests.setRequire(both);
    const tsx = loadGrammar('tsx');
    expect(tsx.kind === 'loaded' && tsx.grammar).toBe('TSX-GRAMMAR');
  });
});

describe('non-Error throws', () => {
  function result() {
    grammarLoaderForTests.setRequire(() => {
      throw 'plain string';
    });
    return loadGrammar('go');
  }

  it('is grammar-load-failed', () => {
    expect(result().kind).toBe('grammar-load-failed');
  });

  it('uses the string as the reason', () => {
    const r = result();
    expect(r.kind !== 'loaded' && r.reason).toBe('plain string');
  });

  it('keeps the string as the cause', () => {
    const r = result();
    expect(r.kind !== 'loaded' && r.cause).toBe('plain string');
  });
});

describe('unwrapDefault', () => {
  // Synthetic module shapes. That a REAL require(esm) namespace carries
  // `__esModule: true` was observed only in dep0151.test.ts, on the Node
  // that run logs (26.5.1 here); it is not run on 20.19 / 22.12.
  const grammar = { name: 'g' };

  it('unwraps the default of a module marked __esModule', () => {
    grammarLoaderForTests.setRequire(() => ({ __esModule: true, default: grammar }));
    const r = loadGrammar('go');
    expect(r.kind === 'loaded' && r.grammar).toBe(grammar);
  });

  it('leaves a module that merely has a `default` key alone (not __esModule)', () => {
    const mod = { default: grammar };
    grammarLoaderForTests.setRequire(() => mod);
    const r = loadGrammar('go');
    expect(r.kind === 'loaded' && r.grammar).toBe(mod);
  });

  it('leaves an __esModule module without a default alone', () => {
    const mod = { __esModule: true, other: 1 };
    grammarLoaderForTests.setRequire(() => mod);
    const r = loadGrammar('go');
    expect(r.kind === 'loaded' && r.grammar).toBe(mod);
  });

  it('leaves a namespace with named exports only (no default, no __esModule) alone', () => {
    const mod = { named: 1 };
    grammarLoaderForTests.setRequire(() => mod);
    const r = loadGrammar('go');
    expect(r.kind === 'loaded' && r.grammar).toBe(mod);
  });
});

describe('cached failures are frozen', () => {
  function failure() {
    grammarLoaderForTests.setRequire(() => {
      throw new Error('boom');
    });
    return loadGrammar('go');
  }

  it('is frozen', () => {
    expect(Object.isFrozen(failure())).toBe(true);
  });

  it('rejects mutation by a caller', () => {
    const f = failure();
    expect(() => {
      (f as { kind: string }).kind = 'loaded';
    }).toThrow(TypeError);
  });
});

describe('a grammar that loads but is rejected by parser.setLanguage', () => {
  // `{}` is a truthy "grammar" that node-tree-sitter refuses.
  it('tryParseCode returns grammar-load-failed', () => {
    grammarLoaderForTests.setRequire(() => ({}));

    expect(tryParseCode('python', 'def a():\n    pass\n').kind).toBe('grammar-load-failed');
  });

  it('the rejection is cached: later parses do not require the grammar again', () => {
    let calls = 0;
    grammarLoaderForTests.setRequire(() => {
      calls += 1;
      return {};
    });

    tryParseCode('python', 'def a():\n    pass\n');
    tryParseCode('python', 'def b():\n    pass\n');

    expect(calls).toBe(1);
  });

  it('and loadGrammar then reports the language as failed', () => {
    grammarLoaderForTests.setRequire(() => ({}));
    tryParseCode('python', 'def a():\n    pass\n');

    expect(loadGrammar('python').kind).toBe('grammar-load-failed');
  });

  it('findSymbols reports it through onSkip', () => {
    const key = { sourceId: 's', version: 'v', itemId: 'a.py' };
    const store = createContextStore();
    store.setContent(key, 'def a():\n    pass\n');
    grammarLoaderForTests.setRequire(() => ({}));
    const skips: SkippedItem[] = [];

    findSymbols('a', SCOPE, { store, onSkip: (s) => skips.push(s) });

    expect(skips.map((s) => s.kind)).toEqual(['grammar-load-failed']);
  });

  it('findSymbols does not cache "no symbols" for it', () => {
    const key = { sourceId: 's', version: 'v', itemId: 'a.py' };
    const store = createContextStore();
    store.setContent(key, 'def a():\n    pass\n');
    grammarLoaderForTests.setRequire(() => ({}));

    findSymbols('a', SCOPE, { store });

    expect(store.getSymbols(key)).toBeFalsy();
  });
});

describe('a throwing onSkip', () => {
  const key = { sourceId: 's', version: 'v', itemId: 'Thing.java' };
  function setup() {
    const store = createContextStore();
    store.setContent(key, 'class Thing {}');
    grammarLoaderForTests.setRequire(() => {
      throw new Error('boom');
    });
    return store;
  }
  const failing = () => {
    throw new Error('callback failed');
  };

  it('findSymbols lets the callback error reach the caller', () => {
    const store = setup();
    expect(() => findSymbols('thing', SCOPE, { store, onSkip: failing })).toThrow(
      'callback failed'
    );
  });

  it('findSymbols caches nothing when the callback throws', () => {
    const store = setup();
    try {
      findSymbols('thing', SCOPE, { store, onSkip: failing });
    } catch {
      /* expected */
    }
    expect(store.getSymbols(key)).toBeFalsy();
  });

  it('edgesForItem lets the callback error reach the caller', () => {
    const store = setup();
    expect(() => edgesForItem(store, 's', 'v', 'Thing.java', { onSkip: failing })).toThrow(
      'callback failed'
    );
  });

  it('edgesForItem caches nothing when the callback throws', () => {
    const store = setup();
    try {
      edgesForItem(store, 's', 'v', 'Thing.java', { onSkip: failing });
    } catch {
      /* expected */
    }
    expect(store.getEdges(key)).toBeFalsy();
  });
});
