import { describe, it, expect } from 'vitest';
import { snapshotText } from '../src/changelog/snapshotText.js';

describe('snapshotText', () => {
  it('sorts keys at every depth so key order is never a change', () => {
    const a = snapshotText({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } });
    const b = snapshotText({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe(
      [
        '{',
        '  "a": {',
        '    "c": null,',
        '    "d": [',
        '      {',
        '        "x": 2,',
        '        "y": 1',
        '      }',
        '    ]',
        '  },',
        '  "b": 1',
        '}',
      ].join('\n'),
    );
  });

  it('keeps multi-line strings as JSON strings', () => {
    expect(snapshotText({ code: 'a\nb' })).toBe('{\n  "code": "a\\nb"\n}');
  });
});
