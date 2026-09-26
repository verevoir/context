import { describe, expect, it } from 'vitest';
import { parseCode } from '../../src/code/index.js';

describe('React component wrappers', () => {
  it.each(['javascript', 'typescript', 'tsx'] as const)(
    'indexes wrapped definitions and their render calls in %s',
    (language) => {
      const { symbols, edges } = parseCode(
        language,
        `export const Button = forwardRef((props, ref) => {
  useTheme();
  return renderButton(props, ref);
});
export const Label = memo(function LabelRender() { return renderLabel(); });
export const Input = React.memo(React.forwardRef(function InputRender(props, ref) {
  return renderInput(props, ref);
}));`
      );
      expect(symbols).toEqual([
        { name: 'Button', kind: 'function', startLine: 1, endLine: 4 },
        { name: 'Label', kind: 'function', startLine: 5, endLine: 5 },
        { name: 'Input', kind: 'function', startLine: 6, endLine: 8 },
      ]);
      expect(edges.calls).toEqual([
        { from: null, to: 'forwardRef', line: 1 },
        { from: 'Button', to: 'useTheme', line: 2 },
        { from: 'Button', to: 'renderButton', line: 3 },
        { from: null, to: 'memo', line: 5 },
        { from: 'Label', to: 'renderLabel', line: 5 },
        { from: null, to: 'memo', line: 6 },
        { from: null, to: 'forwardRef', line: 6 },
        { from: 'Input', to: 'renderInput', line: 7 },
      ]);
    }
  );

  it('handles generic TSX wrappers and nested named function scopes', () => {
    const { symbols, edges } = parseCode(
      'tsx',
      `export const Button = React.forwardRef<HTMLButtonElement, Props>((props, ref) => {
  function handleClick() { save(); }
  useEffect(() => subscribe());
  return <button ref={ref} onClick={handleClick}>{label()}</button>;
});`
    );
    expect(symbols.map((s) => s.name)).toEqual(['Button']);
    expect(edges.calls).toEqual([
      { from: null, to: 'forwardRef', line: 1 },
      { from: 'handleClick', to: 'save', line: 2 },
      { from: 'Button', to: 'useEffect', line: 3 },
      { from: 'Button', to: 'subscribe', line: 3 },
      { from: 'Button', to: 'label', line: 4 },
    ]);
  });

  it('recognizes memo references without relabeling the original function', () => {
    const { symbols, edges } = parseCode(
      'typescript',
      `function Render() { draw(); }
export const Button = memo(Render);`
    );
    expect(symbols.map((s) => s.name)).toEqual(['Render', 'Button']);
    expect(edges.calls).toContainEqual({ from: 'Render', to: 'draw', line: 1 });
  });

  it('keeps comparison callbacks and wrapper arguments outside the render scope', () => {
    const { edges } = parseCode(
      'typescript',
      `const Button = memo(/* render */ () => render(), (a, b) => compare(a, b));
const Label = memo(() => label(), function equal(a, b) { return check(a, b); });`
    );
    expect(edges.calls).toEqual([
      { from: null, to: 'memo', line: 1 },
      { from: 'Button', to: 'render', line: 1 },
      { from: null, to: 'compare', line: 1 },
      { from: null, to: 'memo', line: 2 },
      { from: 'Label', to: 'label', line: 2 },
      { from: 'equal', to: 'check', line: 2 },
    ]);
  });

  it('does not classify arbitrary factories or malformed wrappers as components', () => {
    const { symbols, edges } = parseCode(
      'typescript',
      `const Value = factory(() => load());
const Other = cache.memo(() => calculate());
const Empty = memo();
const Numeric = forwardRef(42);
const Generated = memo(factory(() => build()));`
    );
    expect(symbols).toEqual([]);
    expect(edges.calls.every((call) => call.from === null)).toBe(true);
  });
});
