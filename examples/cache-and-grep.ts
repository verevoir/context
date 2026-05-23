/**
 * Minimal example: populate the ContextStore with two files and
 * grep across them.
 *
 * Run:
 *
 *   npx tsx examples/cache-and-grep.ts
 *
 * No external deps required — pure in-memory cache + substring search.
 */

import { contextStore, grep } from '@verevoir/context';

const SOURCE = 'https://github.com/acme/example';

contextStore.setContent(
  { sourceId: SOURCE, version: '', itemId: 'README.md' },
  '# Example\n\nThis is the README for the example project.\n'
);

contextStore.setContent(
  { sourceId: SOURCE, version: '', itemId: 'src/auth.ts' },
  'export class AuthHandler {\n  authenticate() { return true; }\n}\n'
);

const hits = grep('authenticate', {
  sources: [{ sourceId: SOURCE, version: '' }],
});

console.log(`Found ${hits.length} match(es) for "authenticate":`);
for (const hit of hits) {
  console.log(`  ${hit.itemId}:${hit.lineNumber} — ${hit.line}`);
}
