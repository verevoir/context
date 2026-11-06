import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// The guarantee "importing the module loads no grammar" is carried by a
// source scan of all of src/: no static `import ... from 'tree-sitter-*'`,
// bare `import 'tree-sitter-*'` or `import('tree-sitter-*')` outside
// comments. A module-graph test (mocking every grammar package and
// asserting no factory ran) was deleted: esbuild elides an UNUSED import,
// so a re-added unused static import left it green (observed in a mutation
// run), while this scan went red on the same mutation.
const OFFENDING = /(?:from\s+|import\s*\(\s*|import\s+)['"]tree-sitter-/;

function isCode(line: string): boolean {
  const t = line.trim();
  return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
}

function offendingLines(source: string): string[] {
  return source.split('\n').filter((l) => isCode(l) && OFFENDING.test(l));
}

describe('importing the module loads no grammar', () => {
  it('the scan flags a static, bare and dynamic grammar import (it can fail)', () => {
    expect(offendingLines("import TreeSitterCSharp from 'tree-sitter-c-sharp';")).toHaveLength(1);
    expect(offendingLines("import 'tree-sitter-go';")).toHaveLength(1);
    expect(offendingLines("const m = await import('tree-sitter-java');")).toHaveLength(1);
    expect(offendingLines("import Parser from 'tree-sitter';")).toHaveLength(0);
    expect(offendingLines("// import X from 'tree-sitter-go';")).toHaveLength(0);
  });

  it('no file under src/ imports a tree-sitter-* grammar package', () => {
    const srcDir = fileURLToPath(new URL('../../src', import.meta.url));
    const files = (readdirSync(srcDir, { recursive: true }) as string[]).filter((f) =>
      f.endsWith('.ts')
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(offendingLines(readFileSync(join(srcDir, f), 'utf8')), f).toEqual([]);
    }
  });
});
