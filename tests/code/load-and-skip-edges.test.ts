import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { loadGrammar, findSymbols, edgesForItem, type SkippedItem } from '../../src/code/index.js';
import { grammarLoaderForTests } from '../../src/code/grammars.js';
import { createContextStore } from '../../src/index.js';

const realRequire = createRequire(import.meta.url);
const SCOPE = { sources: [{ sourceId: 's', version: 'v' }] };

beforeEach(() => grammarLoaderForTests.setRequire(null));
afterEach(() => grammarLoaderForTests.setRequire(null));

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

// Must match TRANSIENT_CODES in src/code/grammars.ts.
const TRANSIENT = ['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EIO', 'EINTR', 'ETIMEDOUT'];
const PERMANENT = ['EACCES', 'ERR_DLOPEN_FAILED', 'ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE'];

describe('transient load failures are not cached', () => {
  it.each(TRANSIENT)('%s: the failure is reported as grammar-load-failed', (code) => {
    grammarLoaderForTests.setRequire(() => {
      throw withCode(`${code}: boom`, code);
    });

    expect(loadGrammar('python').kind).toBe('grammar-load-failed');
  });

  it.each(TRANSIENT)('%s: the next call retries and can succeed', (code) => {
    let calls = 0;
    grammarLoaderForTests.setRequire((id) => {
      calls += 1;
      if (calls === 1) throw withCode(`${code}: boom`, code);
      return realRequire(id);
    });

    loadGrammar('python');

    expect(loadGrammar('python').kind).toBe('loaded');
  });
});

describe('permanent load failures are cached', () => {
  it.each(PERMANENT)('%s: the require runs once across repeated loads', (code) => {
    let calls = 0;
    grammarLoaderForTests.setRequire(() => {
      calls += 1;
      throw withCode(`${code}: boom`, code);
    });

    loadGrammar('python');
    loadGrammar('python');

    expect(calls).toBe(1);
  });

  it('a grammar with top-level await (ERR_REQUIRE_ASYNC_MODULE) is a named grammar-load-failed', () => {
    const err = withCode(
      'require() cannot be used on an ESM graph with top-level await',
      'ERR_REQUIRE_ASYNC_MODULE'
    );
    grammarLoaderForTests.setRequire(() => {
      throw err;
    });

    const r = loadGrammar('csharp');

    expect(r.kind === 'grammar-load-failed' && r.cause).toBe(err);
  });
});

describe('loadGrammar does not throw on hostile thrown values', () => {
  const hostileToString = {
    toString: () => {
      throw new Error('toString threw');
    },
  };
  const throwingCode = Object.defineProperty(new Error('x'), 'code', {
    get() {
      throw new Error('code getter threw');
    },
  });
  const noMessage = Object.defineProperty(withCode('x', 'MODULE_NOT_FOUND'), 'message', {
    value: undefined,
  });
  const cases: Array<[string, unknown]> = [
    ['an object whose toString throws', hostileToString],
    ['a null-prototype object', Object.create(null)],
    ['an error whose code getter throws', throwingCode],
    ['a MODULE_NOT_FOUND error with no message', noMessage],
    ['undefined', undefined],
  ];

  it.each(cases)('%s', (_name, thrown) => {
    grammarLoaderForTests.setRequire(() => {
      throw thrown;
    });

    expect(() => loadGrammar('go')).not.toThrow();
  });

  it.each(cases)('%s: is grammar-load-failed', (_name, thrown) => {
    grammarLoaderForTests.setRequire(() => {
      throw thrown;
    });

    expect(loadGrammar('go').kind).toBe('grammar-load-failed');
  });
});

describe('onSkip carries the original error as cause', () => {
  it('findSymbols: a grammar failure passes the very error require threw', () => {
    const err = new Error('boom');
    const store = createContextStore();
    store.setContent({ sourceId: 's', version: 'v', itemId: 'T.java' }, 'class T {}');
    grammarLoaderForTests.setRequire(() => {
      throw err;
    });
    const skips: SkippedItem[] = [];

    findSymbols('t', SCOPE, { store, onSkip: (s) => skips.push(s) });

    expect(skips[0].cause).toBe(err);
  });

  describe('parse-failed (non-string content makes the real python parse throw)', () => {
    const key = { sourceId: 's', version: 'v', itemId: 'a.py' };
    function storeWithBadContent() {
      const store = createContextStore();
      store.setContent(key, 42 as unknown as string);
      return store;
    }

    it('findSymbols: cause is the thrown TypeError', () => {
      const skips: SkippedItem[] = [];

      findSymbols('a', SCOPE, { store: storeWithBadContent(), onSkip: (s) => skips.push(s) });

      expect(skips[0].cause).toBeInstanceOf(TypeError);
    });

    it('findSymbols: reason is the cause message', () => {
      const skips: SkippedItem[] = [];

      findSymbols('a', SCOPE, { store: storeWithBadContent(), onSkip: (s) => skips.push(s) });

      expect(skips[0].reason).toBe((skips[0].cause as Error).message);
    });

    it('edgesForItem: cause is the thrown TypeError', () => {
      const skips: SkippedItem[] = [];

      edgesForItem(storeWithBadContent(), 's', 'v', 'a.py', { onSkip: (s) => skips.push(s) });

      expect(skips[0].cause).toBeInstanceOf(TypeError);
    });
  });
});
