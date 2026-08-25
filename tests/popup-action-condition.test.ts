import { describe, it, expect } from 'vitest';
import { evalCondition, __testing } from '../src/popup/actionCondition.js';

const { tokenize, parse, evalNode } = __testing;

// ── Tokenizer ─────────────────────────────────────────

describe('tokenize', () => {
  it('produces STRING tokens for single- and double-quoted literals', () => {
    expect(tokenize('\'foo\' "bar"')).toEqual([
      { type: 'STRING', value: 'foo' },
      { type: 'STRING', value: 'bar' },
    ]);
  });

  it('handles common escape sequences inside strings', () => {
    expect(tokenize("'a\\nb' 'c\\td' 'q\\'s'")).toEqual([
      { type: 'STRING', value: 'a\nb' },
      { type: 'STRING', value: 'c\td' },
      { type: 'STRING', value: "q's" },
    ]);
  });

  it('throws on an unterminated string', () => {
    expect(() => tokenize("'foo")).toThrow(/unterminated/);
  });

  it('parses integers and floats as NUMBER', () => {
    expect(tokenize('42 3.14')).toEqual([
      { type: 'NUMBER', value: 42 },
      { type: 'NUMBER', value: 3.14 },
    ]);
  });

  it('parses comparison and arithmetic-unary operators', () => {
    expect(tokenize('== != <= >= < > -')).toEqual([
      { type: 'OP', value: '==' },
      { type: 'OP', value: '!=' },
      { type: 'OP', value: '<=' },
      { type: 'OP', value: '>=' },
      { type: 'OP', value: '<' },
      { type: 'OP', value: '>' },
      { type: 'OP', value: '-' },
    ]);
  });

  it('rejects unknown characters', () => {
    expect(() => tokenize('a $ b')).toThrow(/unexpected/);
  });
});

// ── Parser ────────────────────────────────────────────

describe('parse', () => {
  it('parses a simple inequality', () => {
    const ast = parse("'foo' != 'True'");
    expect(ast).toEqual({
      type: 'cmp',
      op: '!=',
      left: { type: 'literal', value: 'foo' },
      right: { type: 'literal', value: 'True' },
    });
  });

  it('parses `not in` as a single comparison operator', () => {
    const ast = parse("'a' not in ['b', 'c']");
    expect(ast.type).toBe('cmp');
    expect((ast as any).op).toBe('not in');
  });

  it('parses `not` as a unary boolean operator outside `not in`', () => {
    const ast = parse('not True');
    expect(ast).toEqual({ type: 'not', child: { type: 'literal', value: true } });
  });

  it('parses unary minus on a number', () => {
    const ast = parse('-5');
    expect(ast).toEqual({ type: 'neg', child: { type: 'literal', value: 5 } });
  });

  it('parses parens and respects precedence (or below and)', () => {
    const ast = parse('True or False and False');
    // `and` binds tighter, so this is True or (False and False)
    expect(ast.type).toBe('or');
    expect((ast as any).right.type).toBe('and');
  });

  it('throws on a trailing token', () => {
    expect(() => parse('True True')).toThrow(/trailing/);
  });

  it('throws on an unknown identifier', () => {
    expect(() => parse('foo')).toThrow(/unknown identifier/);
  });
});

// ── Evaluator ─────────────────────────────────────────

describe('evalCondition', () => {
  it('returns true for the empty / whitespace expression (no condition)', () => {
    expect(evalCondition('')).toEqual({ result: true, error: null });
    expect(evalCondition('   ')).toEqual({ result: true, error: null });
  });

  it('returns true for the literal True', () => {
    expect(evalCondition('True')).toEqual({ result: true, error: null });
  });

  it('returns false for the literal False', () => {
    expect(evalCondition('False')).toEqual({ result: false, error: null });
  });

  it('evaluates the real-world example after text substitution (x not == True)', () => {
    expect(evalCondition("'foo' != 'True'")).toEqual({ result: true, error: null });
    expect(evalCondition("'True' != 'True'")).toEqual({ result: false, error: null });
  });

  it('evaluates the same example with an empty (missing-placeholder) substitution', () => {
    expect(evalCondition("'' != 'True'")).toEqual({ result: true, error: null });
  });

  it('does not cross-compare string and number (Python semantics)', () => {
    expect(evalCondition("'1' == 1")).toEqual({ result: false, error: null });
    expect(evalCondition("'1' != 1")).toEqual({ result: true, error: null });
  });

  it('treats True == 1 and False == 0 per Python', () => {
    expect(evalCondition('True == 1')).toEqual({ result: true, error: null });
    expect(evalCondition('False == 0')).toEqual({ result: true, error: null });
  });

  it('evaluates numeric ordering', () => {
    expect(evalCondition('3 < 10')).toEqual({ result: true, error: null });
    expect(evalCondition('3 >= 3')).toEqual({ result: true, error: null });
    expect(evalCondition('-1 < 0')).toEqual({ result: true, error: null });
  });

  it('evaluates string ordering', () => {
    expect(evalCondition("'aa' < 'ab'")).toEqual({ result: true, error: null });
  });

  it('errors on mixed-type ordering', () => {
    const r = evalCondition("'aa' < 1");
    expect(r.result).toBe(null);
    expect(r.error).toMatch(/compare/);
  });

  it('handles `in` against a string and a list', () => {
    expect(evalCondition("'US' in 'US,CA,MX'")).toEqual({ result: true, error: null });
    expect(evalCondition("'DE' in ['US', 'CA']")).toEqual({ result: false, error: null });
    expect(evalCondition("'CA' in ['US', 'CA']")).toEqual({ result: true, error: null });
  });

  it('handles `not in`', () => {
    expect(evalCondition("'DE' not in ['US', 'CA']")).toEqual({ result: true, error: null });
  });

  it('handles `and` / `or` with short-circuiting truthiness', () => {
    expect(evalCondition("True and 'foo' == 'foo'")).toEqual({ result: true, error: null });
    expect(evalCondition("False and 'foo' == 'foo'")).toEqual({ result: false, error: null });
    expect(evalCondition("True or 'foo' == 'bar'")).toEqual({ result: true, error: null });
    expect(evalCondition("False or 'foo' == 'bar'")).toEqual({ result: false, error: null });
  });

  it('handles `not` on truthy / falsy values', () => {
    expect(evalCondition('not True')).toEqual({ result: false, error: null });
    expect(evalCondition("not ''")).toEqual({ result: true, error: null });
    expect(evalCondition("not 'x'")).toEqual({ result: false, error: null });
  });

  it('returns Python truthiness for a bare value', () => {
    expect(evalCondition("'x'")).toEqual({ result: true, error: null });
    expect(evalCondition("''")).toEqual({ result: false, error: null });
    expect(evalCondition('0')).toEqual({ result: false, error: null });
    expect(evalCondition('1')).toEqual({ result: true, error: null });
    expect(evalCondition('None')).toEqual({ result: false, error: null });
  });

  it('respects parens for precedence', () => {
    expect(evalCondition('(True or False) and False')).toEqual({ result: false, error: null });
    expect(evalCondition('True or False and False')).toEqual({ result: true, error: null });
  });

  it('reports parse errors as { result: null, error }', () => {
    const r = evalCondition('foo == 1');
    expect(r.result).toBe(null);
    expect(r.error).toMatch(/unknown identifier/);
  });

  it('reports tokenizer errors as { result: null, error }', () => {
    const r = evalCondition("'unterminated");
    expect(r.result).toBe(null);
    expect(r.error).toMatch(/unterminated/);
  });

  it('treats non-string input as an error', () => {
    expect(evalCondition(null).result).toBe(null);
    expect(evalCondition(42).result).toBe(null);
  });
});

// ── Direct AST eval (regression spot-check) ──────────

describe('evalNode (direct AST eval)', () => {
  it('returns the value of a literal node', () => {
    expect(evalNode({ type: 'literal', value: 'x' })).toBe('x');
  });
});
