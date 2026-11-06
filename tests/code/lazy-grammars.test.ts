import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  loadGrammar,
  parseSymbols,
  tryParseCode,
  grammarLoaderForTests,
  GrammarNotInstalledError,
} from '../../src/code/index.js';

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

describe('lazy grammar loading', () => {
  beforeEach(() => grammarLoaderForTests.setRequire(null));
  afterEach(() => grammarLoaderForTests.setRequire(null));

  it('importing the module loads no grammar', async () => {
    vi.resetModules();
    const fresh = await import('../../src/code/index.js');
    expect(fresh.grammarLoaderForTests.loadedLanguages()).toEqual([]);
  });

  it('loads a language on first parse and reuses it on the second', () => {
    const req = countingRequire();
    grammarLoaderForTests.setRequire(req.fn);
    expect(req.calls).toEqual([]);

    parseSymbols('python', 'def a():\n    pass\n');
    expect(req.calls).toEqual(['tree-sitter-python']);
    expect(grammarLoaderForTests.loadedLanguages()).toEqual(['python']);

    parseSymbols('python', 'def b():\n    pass\n');
    expect(req.calls).toEqual(['tree-sitter-python']);
  });

  it('does not load grammars for languages that were not used', () => {
    const req = countingRequire();
    grammarLoaderForTests.setRequire(req.fn);
    parseSymbols('go', 'package main\nfunc main() {}\n');
    expect(req.calls).toEqual(['tree-sitter-go']);
  });

  it('returns a named grammar-not-installed outcome for a missing grammar', () => {
    grammarLoaderForTests.setRequire((id) => {
      throw new Error(`Cannot find module '${id}'`);
    });

    const loaded = loadGrammar('csharp');
    expect(loaded).toEqual({
      kind: 'grammar-not-installed',
      language: 'csharp',
      reason: "Cannot find module 'tree-sitter-c-sharp'",
    });

    const parsed = tryParseCode('csharp', 'class A {}');
    expect(parsed.kind).toBe('grammar-not-installed');
    expect(grammarLoaderForTests.loadedLanguages()).toEqual([]);
  });

  it('sync parseSymbols throws the named error only when called for a missing grammar', () => {
    grammarLoaderForTests.setRequire(() => {
      throw new Error('boom');
    });
    expect(() => parseSymbols('java', 'class A {}')).toThrow(GrammarNotInstalledError);
  });

  it('loading the c-sharp grammar emits no process warning (no DEP0151)', async () => {
    const warnings: Array<{ name: string; code?: string; message: string }> = [];
    const onWarning = (w: Error & { code?: string }): void => {
      warnings.push({ name: w.name, code: w.code, message: w.message });
    };
    process.on('warning', onWarning);
    try {
      const result = loadGrammar('csharp');
      expect(result.kind).toBe('loaded');
      // Warnings are emitted on a later tick.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings.filter((w) => w.code === 'DEP0151')).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
