import { describe, it, expect, beforeEach } from 'vitest';
import { grep, contextStore } from '../src/index.js';

const REPO_A = 'https://github.com/acme/charts';
const VERSION = 'aigency/TP-5';

beforeEach(() => {
  contextStore.clearAll();
});

function prime(sourceId: string, itemId: string, content: string): void {
  contextStore.setContent({ sourceId, version: VERSION, itemId }, content);
}

describe('grep', () => {
  it('finds substring matches with surrounding context', () => {
    prime(
      REPO_A,
      'src/x.ts',
      [
        'line 1 before',
        'line 2 before',
        'this contains needle and more',
        'line 4 after',
        'line 5 after',
      ].join('\n')
    );
    const hits = grep('needle', {
      sources: [{ sourceId: REPO_A, version: VERSION }],
    });
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit.lineNumber).toBe(3);
    expect(hit.line).toBe('this contains needle and more');
    expect(hit.contextBefore).toEqual(['line 1 before', 'line 2 before']);
    expect(hit.contextAfter).toEqual(['line 4 after', 'line 5 after']);
  });

  it('matches multiple occurrences across multiple items', () => {
    prime(REPO_A, 'a.ts', 'foo\nbar\nfoo\n');
    prime(REPO_A, 'b.ts', 'baz\nfoo\n');
    const hits = grep('foo', {
      sources: [{ sourceId: REPO_A, version: VERSION }],
    });
    expect(hits).toHaveLength(3);
  });

  it('respects case-sensitivity by default', () => {
    prime(REPO_A, 'x.ts', 'Foo\nfoo\nFOO\n');
    const sensitive = grep('foo', {
      sources: [{ sourceId: REPO_A, version: VERSION }],
    });
    expect(sensitive).toHaveLength(1);
    expect(sensitive[0].line).toBe('foo');

    const insensitive = grep(
      'foo',
      { sources: [{ sourceId: REPO_A, version: VERSION }] },
      { ignoreCase: true }
    );
    expect(insensitive).toHaveLength(3);
  });

  it('returns empty when no cached items match', () => {
    prime(REPO_A, 'x.ts', 'unrelated');
    expect(grep('foo', { sources: [{ sourceId: REPO_A, version: VERSION }] })).toEqual([]);
  });

  it('returns empty when nothing is cached at all', () => {
    expect(grep('anything', { sources: [{ sourceId: REPO_A, version: VERSION }] })).toEqual([]);
  });

  it('caps results at maxResults', () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push('match here');
    prime(REPO_A, 'many.ts', lines.join('\n'));
    const hits = grep(
      'match',
      { sources: [{ sourceId: REPO_A, version: VERSION }] },
      { maxResults: 7 }
    );
    expect(hits).toHaveLength(7);
  });

  it('diminishes the budget across files — the cap binds mid-file, not per file', () => {
    // A call site passing the full max per file (instead of the
    // remaining capacity) would return 6 hits here, not 5.
    prime(REPO_A, 'aa.ts', 'match\nmatch\nmatch');
    prime(REPO_A, 'bb.ts', 'match\nmatch\nmatch');
    const hits = grep(
      'match',
      { sources: [{ sourceId: REPO_A, version: VERSION }] },
      { maxResults: 5 }
    );
    expect(hits).toHaveLength(5);
    expect(hits.map((h) => h.itemId)).toEqual(['aa.ts', 'aa.ts', 'aa.ts', 'bb.ts', 'bb.ts']);
  });

  it('handles content with no trailing newline', () => {
    prime(REPO_A, 'x.ts', 'first\nsecond');
    const hits = grep('second', {
      sources: [{ sourceId: REPO_A, version: VERSION }],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].lineNumber).toBe(2);
  });

  it('respects contextLines override', () => {
    prime(REPO_A, 'x.ts', ['1', '2', '3', '4 hit', '5', '6', '7'].join('\n'));
    const hits = grep(
      'hit',
      { sources: [{ sourceId: REPO_A, version: VERSION }] },
      { contextLines: 1 }
    );
    expect(hits[0].contextBefore).toEqual(['3']);
    expect(hits[0].contextAfter).toEqual(['5']);
  });
});
