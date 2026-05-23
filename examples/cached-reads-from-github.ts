/**
 * Cached reads against GitHub: first call fetches, second call hits
 * the in-process cache. Demonstrates the bridge between
 * @verevoir/sources/github and @verevoir/context.
 *
 * Run:
 *
 *   GITHUB_TOKEN=ghp_... npx tsx examples/cached-reads-from-github.ts
 *
 * Requires @verevoir/sources to be installed alongside @verevoir/context.
 */

import { envFromProcessEnv } from '@verevoir/sources';
import { cachedReadFile } from '@verevoir/context/sources';
import { contextStore } from '@verevoir/context';

async function main(): Promise<void> {
  const env = envFromProcessEnv();
  if (!env) {
    console.error('GITHUB_TOKEN not set.');
    process.exit(1);
  }

  const REPO = 'https://github.com/verevoir/llm';
  const PATH = 'README.md';

  console.time('first read');
  const a = await cachedReadFile(env, REPO, PATH);
  console.timeEnd('first read');
  console.log(`  → ${a.length} bytes`);

  console.time('second read');
  const b = await cachedReadFile(env, REPO, PATH);
  console.timeEnd('second read');
  console.log(`  → ${b.length} bytes (from cache; no HTTP call)`);

  // What's actually cached.
  console.log(`Cached items for ${REPO}:`, contextStore.listIndexedItems(REPO, ''));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
