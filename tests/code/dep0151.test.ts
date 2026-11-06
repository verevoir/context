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
//
// Which outcome the loader must give for the stub depends on the Node
// running the tests (require(esm) is unflagged from 20.19.0 / 22.12.0 / 23.0.0),
// so the branch is chosen BY NODE VERSION and logged, and exactly one of
// the two loader tests runs. The loaded branch also pins that Node marks
// the require(esm) namespace `__esModule` (what unwrapDefault relies on);
// that is only observed on the Node the log line names.
//
// The loader's requirer is placed under a `node_modules` path to mirror an
// installed package's layout. UNVERIFIED: no source read for this work says
// Node suppresses its require(esm) warning inside node_modules, and this
// test does not rely on it; on a Node that still warns by default (22.12.x)
// the clean-stderr assertion is relaxed, see noDefaultWarning().
//
// Which branch runs where (do not read this as coverage we lack): the
// LOADED test runs on Node >= 20.19 / 22.12 (.github/workflows/ci.yml:19
// pins `node-version: 20`, a floating major; I have not observed which 20.x
// it resolves to); the LOAD-FAILED test runs only on older Node and has not
// been run by anyone on this work. Observed so far: Node v26.5.1, LOADED.
// Which error older Node throws is unconfirmed, so that branch asserts the
// kind and logs the code rather than pinning one.

function nodeHasRequireEsm(): boolean {
  const flag = (process.features as unknown as { require_module?: unknown }).require_module;
  if (typeof flag === 'boolean') return flag;
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22) return true;
  if (major === 22) return minor >= 12;
  if (major === 20) return minor >= 19;
  return false;
}

/** Per the Node docs cited in grammars.ts, require(esm) stops warning by
 * default from 20.19.0 / 22.13.0 / 23.5.0. */
function noDefaultWarning(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 23) return true;
  if (major === 23) return minor >= 5;
  if (major === 22) return minor >= 13;
  if (major === 20) return minor >= 19;
  return false;
}

const hasRequireEsm = nodeHasRequireEsm();
const NODE = `node ${process.version} (process.features.require_module=${String(
  (process.features as unknown as { require_module?: unknown }).require_module
)})`;

let tmp: string;

beforeAll(() => {
  console.log(
    `[dep0151] ${NODE}; branch under test: ${
      hasRequireEsm
        ? 'require(esm) SUPPORTED -> the stub must LOAD (default export unwrapped)'
        : 'require(esm) UNSUPPORTED -> the stub must be grammar-load-failed'
    }`
  );
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

/** Load the stub through the loader's createRequire path, collecting
 * every process warning emitted meanwhile. */
async function loadStubCollectingWarnings() {
  grammarLoaderForTests.setRequire(
    createRequire(join(tmp, 'node_modules', '@verevoir', 'context', 'dist', 'code', 'grammars.js'))
  );
  const codes: string[] = [];
  const onWarning = (w: Error & { code?: string }): void => {
    codes.push(w.code ?? w.name);
  };
  process.on('warning', onWarning);
  try {
    const result = loadGrammar('csharp');
    await new Promise((resolve) => setImmediate(resolve));
    return { result, codes };
  } finally {
    process.off('warning', onWarning);
  }
}

describe('DEP0151 (stub with the tree-sitter-c-sharp 0.23.5 package shape)', () => {
  it('control: a native ESM import of the stub DOES emit DEP0151 (proves the stub reproduces it)', (ctx) => {
    const run = spawnSync(process.execPath, [join(tmp, 'probe.mjs')], {
      cwd: tmp,
      encoding: 'utf8',
    });
    const lastLine = run.stdout.trim().split('\n').pop();
    if (!lastLine) {
      throw new Error(
        `dep0151 probe printed nothing (status=${run.status}, signal=${run.signal}, ` +
          `error=${run.error?.message}, stderr=${run.stderr.slice(0, 500)})`
      );
    }
    let seen: string[];
    try {
      seen = JSON.parse(lastLine) as string[];
    } catch {
      throw new Error(`dep0151 probe printed non-JSON last line: ${lastLine.slice(0, 200)}`);
    }
    if (!seen.includes('DEP0151')) {
      const why = `${NODE} did not emit DEP0151 for the stub; saw ${JSON.stringify(seen)}`;
      console.log(`[dep0151] control SKIPPED: ${why}`);
      ctx.skip(why);
    }
    console.log(`[dep0151] control RAN on ${NODE}: native import emitted ${JSON.stringify(seen)}`);
    expect(seen).toContain('DEP0151');
  });

  it.runIf(hasRequireEsm)(
    'require(esm) branch: the loader LOADS the stub, unwraps its default and emits no DEP0151',
    async () => {
      const { result, codes } = await loadStubCollectingWarnings();
      console.log(`[dep0151] branch=LOADED on ${NODE}; warnings seen: ${JSON.stringify(codes)}`);

      expect(codes).not.toContain('DEP0151');
      // Clean stderr is only promised where the default warning is gone.
      if (noDefaultWarning()) expect(codes).toEqual([]);
      expect(result.kind).toBe('loaded');
      if (result.kind === 'loaded') expect(result.grammar).toEqual({ name: 'stub-csharp' });
    }
  );

  it.runIf(!hasRequireEsm)(
    'no-require(esm) branch: the loader reports the stub as grammar-load-failed and emits no DEP0151',
    async () => {
      const { result, codes } = await loadStubCollectingWarnings();
      console.log(
        `[dep0151] branch=LOAD-FAILED on ${NODE}; warnings seen: ${JSON.stringify(codes)}`
      );

      expect(codes).toEqual([]);
      expect(result.kind).toBe('grammar-load-failed');
      if (result.kind === 'grammar-load-failed') {
        console.log(`[dep0151] cause.code on ${NODE}: ${(result.cause as { code?: string }).code}`);
      }
    }
  );
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
