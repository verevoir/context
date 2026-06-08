// Per-language coverage for the code parser: each language asserts the
// symbols it surfaces (kind + name), the import edges, and the call
// edges (caller → callee). Tests what a `find_symbol` / `code_graph`
// caller actually receives — not the AST shape.
import { describe, it, expect } from 'vitest';
import { parseCode, detectLanguage } from '../../src/code/index.js';
import type { SymbolEntry, CodeEdges } from '../../src/index.js';

function kindOf(symbols: SymbolEntry[], name: string): string | undefined {
  return symbols.find((s) => s.name === name)?.kind;
}

function hasCall(edges: CodeEdges, from: string | null, to: string): boolean {
  return edges.calls.some((c) => c.from === from && c.to === to);
}

function importModules(edges: CodeEdges): string[] {
  return edges.imports.map((i) => i.module);
}

function importNames(edges: CodeEdges, module: string): string[] {
  return edges.imports.find((i) => i.module === module)?.names ?? [];
}

describe('detectLanguage — added languages', () => {
  it.each([
    ['svc/app.py', 'python'],
    ['stubs/app.pyi', 'python'],
    ['src/Main.java', 'java'],
    ['src/Meter.cs', 'csharp'],
    ['cmd/main.go', 'go'],
    ['src/Meter.scala', 'scala'],
    ['build.sc', 'scala'],
    ['lib/util.c', 'c'],
    ['lib/util.h', 'c'],
    ['lib/util.cpp', 'cpp'],
    ['lib/util.cc', 'cpp'],
    ['lib/util.hpp', 'cpp'],
  ])('maps %s to %s', (path, expected) => {
    expect(detectLanguage(path)).toBe(expected);
  });
});

describe('Python', () => {
  const src = `import os
from typing import List, Dict as D

class Meter:
    def tick(self):
        return self.count

async def generate_and_install_shim(name):
    write_failing_shim(name)
    return name
`;
  const { symbols, edges } = parseCode('python', src);

  it('extracts classes, methods and async functions', () => {
    expect(kindOf(symbols, 'Meter')).toBe('class');
    expect(kindOf(symbols, 'tick')).toBe('method');
    // async def is still a function_definition — must be captured.
    expect(kindOf(symbols, 'generate_and_install_shim')).toBe('function');
  });

  it('extracts plain and aliased imports', () => {
    expect(importModules(edges)).toContain('os');
    expect(importNames(edges, 'typing')).toEqual(expect.arrayContaining(['List', 'D']));
  });

  it('records calls with their enclosing function', () => {
    expect(hasCall(edges, 'generate_and_install_shim', 'write_failing_shim')).toBe(true);
  });
});

describe('Java', () => {
  const src = `package x;
import java.util.List;

public class KataApi {
  public KataApi(int n) {}
  public int book(String id) {
    return repo.save(id);
  }
}
interface Repo { void save(String s); }
`;
  const { symbols, edges } = parseCode('java', src);

  it('extracts class, interface, methods and constructor', () => {
    expect(kindOf(symbols, 'KataApi')).toBe('class');
    expect(kindOf(symbols, 'Repo')).toBe('interface');
    expect(kindOf(symbols, 'book')).toBe('method');
  });

  it('extracts qualified imports', () => {
    expect(importModules(edges)).toContain('java.util.List');
  });

  it('resolves method_invocation callees', () => {
    expect(hasCall(edges, 'book', 'save')).toBe(true);
  });
});

describe('C#', () => {
  const src = `using System;

namespace Kata {
  public class Meter {
    public int Tick() { return Compute(); }
    private int Compute() => repo.Save();
  }
  interface IRepo { void Save(); }
  struct Cost { public int Cents; }
}
`;
  const { symbols, edges } = parseCode('csharp', src);

  it('extracts class, interface, struct and methods', () => {
    expect(kindOf(symbols, 'Meter')).toBe('class');
    expect(kindOf(symbols, 'IRepo')).toBe('interface');
    expect(kindOf(symbols, 'Cost')).toBe('class');
    expect(kindOf(symbols, 'Tick')).toBe('method');
  });

  it('extracts using directives', () => {
    expect(importModules(edges)).toContain('System');
  });

  it('resolves invocation_expression callees (plain + member)', () => {
    expect(hasCall(edges, 'Tick', 'Compute')).toBe(true);
    expect(hasCall(edges, 'Compute', 'Save')).toBe(true);
  });
});

describe('Go', () => {
  const src = `package main
import (
  "fmt"
  m "math"
)
type Repo struct { n int }
type Saver interface { Save() }
func (r Repo) Save() int { return compute() }
func compute() int { fmt.Println("x"); return m.Max(1,2) }
`;
  const { symbols, edges } = parseCode('go', src);

  it('extracts struct (class), interface, func and method', () => {
    expect(kindOf(symbols, 'Repo')).toBe('class');
    expect(kindOf(symbols, 'Saver')).toBe('interface');
    expect(kindOf(symbols, 'Save')).toBe('method');
    expect(kindOf(symbols, 'compute')).toBe('function');
  });

  it('extracts imports with alias as bound name', () => {
    expect(importModules(edges)).toEqual(expect.arrayContaining(['fmt', 'math']));
    expect(importNames(edges, 'math')).toContain('m');
  });

  it('resolves plain and selector_expression callees', () => {
    expect(hasCall(edges, 'Save', 'compute')).toBe(true);
    expect(hasCall(edges, 'compute', 'Max')).toBe(true);
  });
});

describe('Scala', () => {
  const src = `package x
import scala.collection.mutable

class Meter {
  def tick(): Int = compute()
  private def compute(): Int = repo.save()
}
object App { def main(): Unit = new Meter().tick() }
trait Repo { def save(): Int }
`;
  const { symbols, edges } = parseCode('scala', src);

  it('extracts class, object, trait and methods', () => {
    expect(kindOf(symbols, 'Meter')).toBe('class');
    expect(kindOf(symbols, 'App')).toBe('class');
    expect(kindOf(symbols, 'Repo')).toBe('interface');
    expect(kindOf(symbols, 'tick')).toBe('method');
  });

  it('extracts imports', () => {
    expect(importModules(edges)).toContain('scala.collection.mutable');
  });

  it('resolves call and field_expression callees', () => {
    expect(hasCall(edges, 'main', 'tick')).toBe(true);
    expect(hasCall(edges, 'compute', 'save')).toBe(true);
  });
});

describe('C', () => {
  const src = `#include <stdio.h>
#include "local.h"

int compute(int n) { return n * 2; }
int main(void) {
  printf("%d", compute(3));
  return 0;
}
`;
  const { symbols, edges } = parseCode('c', src);

  it('extracts functions (name nested in the declarator)', () => {
    expect(kindOf(symbols, 'compute')).toBe('function');
    expect(kindOf(symbols, 'main')).toBe('function');
  });

  it('extracts system and local includes', () => {
    expect(importModules(edges)).toEqual(expect.arrayContaining(['stdio.h', 'local.h']));
  });

  it('resolves call edges with enclosing function', () => {
    expect(hasCall(edges, 'main', 'compute')).toBe(true);
  });
});

describe('C++', () => {
  const src = `#include <vector>
namespace kata {
class Meter {
public:
  int tick() { return compute(); }
private:
  int compute() { return repo.save(); }
};
}
int main() { kata::Meter m; m.tick(); }
`;
  const { symbols, edges } = parseCode('cpp', src);

  it('extracts class, methods and a free function', () => {
    expect(kindOf(symbols, 'Meter')).toBe('class');
    expect(kindOf(symbols, 'tick')).toBe('method');
    // free function in a namespace, not a method
    expect(kindOf(symbols, 'main')).toBe('function');
  });

  it('extracts includes', () => {
    expect(importModules(edges)).toContain('vector');
  });

  it('resolves call and field_expression callees', () => {
    expect(hasCall(edges, 'main', 'tick')).toBe(true);
    expect(hasCall(edges, 'compute', 'save')).toBe(true);
  });
});
