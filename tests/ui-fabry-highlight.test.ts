import { describe, it, expect } from 'vitest';
import { highlightCode } from '../src/ui/fabry/highlight.js';

const types = (tokens: any) => tokens.map((t: any) => t.type);
const text = (tokens: any) => tokens.map((t: any) => t.text).join('');

describe('highlightCode', () => {
  it('round-trips the source text exactly for every language', () => {
    const py = 'def f(x):\n    # add\n    return x + 1\n';
    expect(text(highlightCode(py, 'python'))).toBe(py);
    const js = 'const a = `t${x}`; // c\n';
    expect(text(highlightCode(js, 'javascript'))).toBe(js);
    const json = '{"a": [1, true, null]}';
    expect(text(highlightCode(json, 'json'))).toBe(json);
  });

  it('python: keywords, strings, comments, decorators, literals', () => {
    const tokens = highlightCode('@app\ndef f():\n    # hi\n    return "s" if True else None', 'python');
    const byType = Object.fromEntries(tokens.filter((t) => t.type !== 'plain').map((t) => [t.type + ':' + t.text, true]));
    expect(byType['dec:@app']).toBe(true);
    expect(byType['kw:def']).toBe(true);
    expect(byType['com:# hi']).toBe(true);
    expect(byType['str:"s"']).toBe(true);
    expect(byType['kw:if']).toBe(true);
    expect(byType['lit:True']).toBe(true);
    expect(byType['lit:None']).toBe(true);
  });

  it('json: keys vs string values vs literals vs numbers', () => {
    const tokens = highlightCode('{"name": "TEST", "n": 42, "ok": true}', 'json');
    expect(tokens.find((t) => t.text === '"name"')!.type).toBe('key');
    expect(tokens.find((t) => t.text === '"TEST"')!.type).toBe('str');
    expect(tokens.find((t) => t.text === '42')!.type).toBe('num');
    expect(tokens.find((t) => t.text === 'true')!.type).toBe('lit');
  });

  it('unknown language falls through as one plain token', () => {
    expect(highlightCode('graph TD\n  A --> B', 'mermaid')).toEqual([{ type: 'plain', text: 'graph TD\n  A --> B' }]);
    expect(highlightCode('x', '')).toEqual([{ type: 'plain', text: 'x' }]);
  });

  it('sql keywords are case-insensitive', () => {
    expect(types(highlightCode('SELECT 1', 'sql'))).toContain('kw');
  });
});
