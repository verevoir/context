import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Module-graph check. Every grammar package is mocked with a factory that
// records that it was EVALUATED. A static `import ... from 'tree-sitter-*'`
// anywhere in the module graph of src/code/index.ts would run its factory
// at import time and put an entry in `evaluated`; the lazy path goes
// through `createRequire`, which bypasses the mock registry, so it never
// does. CAVEAT (observed in a mutation run): esbuild elides an UNUSED
// import, so an unused static grammar import does not run its factory and
// the first test stays green; a USED one should turn it red (not yet
// watched). The source scan in the second test catches both (watched red).
const evaluated = vi.hoisted(() => [] as string[]);

vi.mock('tree-sitter-typescript', () => {
  evaluated.push('tree-sitter-typescript');
  return { default: {} };
});
vi.mock('tree-sitter-javascript', () => {
  evaluated.push('tree-sitter-javascript');
  return { default: {} };
});
vi.mock('tree-sitter-python', () => {
  evaluated.push('tree-sitter-python');
  return { default: {} };
});
vi.mock('tree-sitter-java', () => {
  evaluated.push('tree-sitter-java');
  return { default: {} };
});
vi.mock('tree-sitter-c-sharp', () => {
  evaluated.push('tree-sitter-c-sharp');
  return { default: {} };
});
vi.mock('tree-sitter-go', () => {
  evaluated.push('tree-sitter-go');
  return { default: {} };
});
vi.mock('tree-sitter-scala', () => {
  evaluated.push('tree-sitter-scala');
  return { default: {} };
});
vi.mock('tree-sitter-c', () => {
  evaluated.push('tree-sitter-c');
  return { default: {} };
});
vi.mock('tree-sitter-cpp', () => {
  evaluated.push('tree-sitter-cpp');
  return { default: {} };
});

describe('importing the module loads no grammar', () => {
  it('evaluates no tree-sitter-* grammar package in the import graph', async () => {
    vi.resetModules();
    evaluated.length = 0;

    const mod = await import('../../src/code/index.js');
    await import('../../src/code/grammars.js');

    expect(typeof mod.parseSymbols).toBe('function');
    expect(evaluated).toEqual([]);
  });

  it('has no static or dynamic-import of a grammar package in src/code', () => {
    const files = ['index.ts', 'grammars.ts'].map((f) =>
      fileURLToPath(new URL(`../../src/code/${f}`, import.meta.url))
    );
    const offending = /(?:from\s+|import\s*\(\s*|import\s+)['"]tree-sitter-/;
    for (const file of files) {
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
      expect(
        lines.filter((l) => offending.test(l)),
        file
      ).toEqual([]);
    }
  });
});
