import { describe, it, expect } from 'vitest';
import { parseSymbols, detectLanguage } from '../../src/code/index.js';
import type { SymbolEntry } from '../../src/index.js';

function names(entries: SymbolEntry[]): string[] {
  return entries.map((e) => e.name);
}

function byKind(entries: SymbolEntry[], kind: SymbolEntry['kind']): string[] {
  return entries.filter((e) => e.kind === kind).map((e) => e.name);
}

describe('detectLanguage', () => {
  it.each([
    ['src/x.ts', 'typescript'],
    ['src/x.tsx', 'tsx'],
    ['src/x.jsx', 'tsx'],
    ['src/x.js', 'javascript'],
    ['src/x.mjs', 'javascript'],
    ['src/x.cjs', 'javascript'],
  ])('maps %s to %s', (path, expected) => {
    expect(detectLanguage(path)).toBe(expected);
  });

  it('returns null for unknown extensions', () => {
    expect(detectLanguage('Cargo.toml')).toBeNull();
    expect(detectLanguage('Dockerfile')).toBeNull();
    expect(detectLanguage('src/main.rb')).toBeNull();
    expect(detectLanguage('query.sql')).toBeNull();
  });
});

describe('parseSymbols (TypeScript)', () => {
  it('extracts function declarations', () => {
    const source = `
export function add(a: number, b: number): number {
  return a + b;
}

function helper() {
  return 1;
}
`;
    const entries = parseSymbols('typescript', source);
    expect(byKind(entries, 'function').sort()).toEqual(['add', 'helper']);
  });

  it('extracts class declarations and their methods', () => {
    const source = `
class AuthHandler {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  authenticate(req: Request): boolean {
    return Boolean(this.token);
  }
}
`;
    const entries = parseSymbols('typescript', source);
    expect(byKind(entries, 'class')).toEqual(['AuthHandler']);
    expect(byKind(entries, 'method').sort()).toEqual(['authenticate', 'constructor']);
  });

  it('extracts interface and type aliases', () => {
    const source = `
export interface User {
  id: string;
  email: string;
}

export type UserId = string;
`;
    const entries = parseSymbols('typescript', source);
    expect(byKind(entries, 'interface')).toEqual(['User']);
    expect(byKind(entries, 'type')).toEqual(['UserId']);
  });

  it('extracts enum declarations', () => {
    const source = `
export enum Status {
  Open = 'open',
  Closed = 'closed',
}
`;
    const entries = parseSymbols('typescript', source);
    expect(byKind(entries, 'enum')).toEqual(['Status']);
  });

  it('captures arrow functions assigned to a const as named functions', () => {
    const source = `
const greet = (name: string) => "hello " + name;
const compute = function(x: number) { return x * 2; };
`;
    const entries = parseSymbols('typescript', source);
    expect(byKind(entries, 'function').sort()).toEqual(['compute', 'greet']);
  });

  it('records 1-indexed line numbers for the declaration span', () => {
    const source = ['', '', 'export function foo() {', '  return 1;', '}', ''].join('\n');
    const entries = parseSymbols('typescript', source);
    const foo = entries.find((e) => e.name === 'foo');
    expect(foo?.startLine).toBe(3);
    expect(foo?.endLine).toBe(5);
  });

  it('skips nested function declarations inside another function body', () => {
    const source = `
function outer() {
  function inner() {
    return 1;
  }
  return inner();
}
`;
    const entries = parseSymbols('typescript', source);
    expect(byKind(entries, 'function')).toEqual(['outer']);
  });

  it('skips anonymous arrow functions / function expressions', () => {
    const source = `
[1, 2, 3].map((x) => x + 1);
[1, 2, 3].forEach(function() { return; });
`;
    const entries = parseSymbols('typescript', source);
    expect(entries).toHaveLength(0);
  });
});

describe('parseSymbols (TSX)', () => {
  it('handles JSX inside .tsx files without confusion', () => {
    const source = `
import React from 'react';

export function Greeting({ name }: { name: string }) {
  return <div className="hello">Hi {name}</div>;
}

export class Counter extends React.Component {
  render() {
    return <button onClick={() => this.forceUpdate()}>{this.state.n}</button>;
  }
}
`;
    const entries = parseSymbols('tsx', source);
    expect(byKind(entries, 'function')).toContain('Greeting');
    expect(byKind(entries, 'class')).toContain('Counter');
    expect(byKind(entries, 'method')).toContain('render');
  });
});

describe('parseSymbols (JavaScript)', () => {
  it('extracts function + class from plain JS', () => {
    const source = `
function add(a, b) { return a + b; }

class Box {
  constructor(width) { this.width = width; }
  area() { return this.width * this.width; }
}
`;
    const entries = parseSymbols('javascript', source);
    expect(names(entries).sort()).toEqual(['Box', 'add', 'area', 'constructor']);
  });
});

describe('parseSymbols — robustness', () => {
  it('returns an empty list for empty source', () => {
    expect(parseSymbols('typescript', '')).toEqual([]);
  });

  it('returns what it can from partially-malformed source (does not throw)', () => {
    const source = `
export function valid() { return 1; }
export function broken( // missing close-paren
  return 2;
}
export function alsoValid() { return 3; }
`;
    const entries = parseSymbols('typescript', source);
    const fnNames = byKind(entries, 'function');
    expect(fnNames).toContain('valid');
    expect(fnNames).toContain('alsoValid');
  });
});
