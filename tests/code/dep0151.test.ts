import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGrammar } from '../../src/code/index.js';
import { grammarLoaderForTests } from '../../src/code/grammars.js';

// DEP0151 is emitted by Node's ESM resolver for a package whose "main" is
// extensionless / a directory. tree-sitter-c-sharp 0.23.5 is exactly that
// ("type": "module", "main": "bindings/node"). The version this repo's own
// devDependencies install is 0.23.1 (CommonJS, no "type"), which never
// emits it — so the tests that matter here use a STUB package in a tmp
// node_modules with the 0.23.5 shape.
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dep0151-'));
  const pkg = join(tmp, 'node_modules', 'tree-sitter-c-sharp');
  mkdirSync(join(pkg, 'bindings', 'node'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'tree-sitter-c-sharp',
      version: '0.23.5',
      type: 'module',
      main: 'bindings/node',
    })
  );
  writeFileSync(
    join(pkg, 'bindings', 'node', 'index.js'),
    "export default { name: 'stub-csharp' };\n"
  );
  writeFileSync(
    join(tmp, 'probe.mjs'),
    [
      'const seen = [];',
      "process.on('warning', (w) => seen.push(w.code ?? w.name));",
      "try { await import('tree-sitter-c-sharp'); } catch (e) { seen.push('ERR:' + e.code); }",
      'await new Promise((r) => setImmediate(r));',
      'console.log(JSON.stringify(seen));',
    ].join('\n')
  );
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => grammarLoaderForTests.setRequire(null));

describe('DEP0151 (stub with the tree-sitter-c-sharp 0.23.5 package shape)', () => {
  it('control: a native ESM import of the stub DOES emit DEP0151 (proves the stub reproduces it)', (ctx) => {
    const run = spawnSync(process.execPath, [join(tmp, 'probe.mjs')], {
      cwd: tmp,
      encoding: 'utf8',
    });
    const seen = JSON.parse(run.stdout.trim().split('\n').pop() ?? '[]') as string[];
    if (!seen.includes('DEP0151')) {
      ctx.skip(
        `this Node (${process.version}) did not emit DEP0151 for the stub; saw ${JSON.stringify(seen)}`
      );
    }
    expect(seen).toContain('DEP0151');
  });

  it('loading the stub through the loader (createRequire) emits no DEP0151', async () => {
    grammarLoaderForTests.setRequire(createRequire(join(tmp, 'probe.js')));
    const codes: string[] = [];
    const onWarning = (w: Error & { code?: string }): void => {
      codes.push(w.code ?? w.name);
    };
    process.on('warning', onWarning);
    let result;
    try {
      result = loadGrammar('csharp');
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }

    expect(codes).not.toContain('DEP0151');
    // Where require(esm) is supported the ES module's default export is
    // unwrapped; where it is not, the failure is named and carries the cause.
    if (result.kind === 'loaded') {
      expect(result.grammar).toEqual({ name: 'stub-csharp' });
    } else {
      expect(result.kind).toBe('grammar-load-failed');
      expect((result.cause as { code?: string }).code).toBe('ERR_REQUIRE_ESM');
    }
  });
});

describe('installed tree-sitter-c-sharp (0.23.1 here — cannot reproduce DEP0151)', () => {
  it('loads with no process warning (a guard only; the stub tests above are the reproduction)', async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(`${w.name}: ${w.message}`);
    };
    process.on('warning', onWarning);
    try {
      expect(loadGrammar('csharp').kind).toBe('loaded');
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings).toEqual([]);
  });
});
