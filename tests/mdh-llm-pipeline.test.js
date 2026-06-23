import { describe, it, expect } from 'vitest';
import {
  buildPipelineMessages, extractReply, stripFences, classifyProbe, MONGO_SYSTEM_INSTRUCTION,
  verdictFor, safeParseArray, samePipeline, buildFixMessages, ensureRowLimit,
  prependAiComment, stripAiComment, detectNumericStringFields, leafStringFields, summarizeSearchIndexes,
} from '../src/mdh/llmPipeline.js';

describe('buildPipelineMessages', () => {
  it('folds instruction + fields + pipeline + request into one user message', () => {
    const msgs = buildPipelineMessages({ fields: ['a', 'b'], currentPipeline: '[]', request: 'top 5' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain(MONGO_SYSTEM_INSTRUCTION);
    expect(msgs[0].content).toContain('Available fields: a, b');
    expect(msgs[0].content).toContain('Current pipeline:\n[]');
    expect(msgs[0].content).toContain('Request: top 5');
  });
  it('omits the fields line when there are no fields', () => {
    expect(buildPipelineMessages({ fields: [], request: 'x' })[0].content).not.toContain('Available fields');
  });
  it('defaults an empty/missing pipeline to []', () => {
    expect(buildPipelineMessages({ request: 'x' })[0].content).toContain('Current pipeline:\n[]');
  });
  it('includes sample documents when provided', () => {
    const msgs = buildPipelineMessages({ fields: ['a'], request: 'x', samples: [{ a: 'CA' }] });
    expect(msgs[0].content).toContain('Sample documents');
    expect(msgs[0].content).toContain('"a":"CA"');
  });
  it('omits the samples block when none provided', () => {
    expect(buildPipelineMessages({ fields: ['a'], request: 'x' })[0].content).not.toContain('Sample documents');
  });
  it('includes known values, numeric-string, and search-index hints', () => {
    const c = buildPipelineMessages({
      fields: ['uom'], request: 'x',
      knownValues: { uom: ['EA', 'FT'] },
      numericStringFields: ['vendorId'],
      searchIndexes: [{ name: 'default', fields: 'all', synonyms: false }],
    })[0].content;
    expect(c).toContain('uom ∈ {EA, FT}');
    expect(c).toContain('vendorId');
    expect(c.toLowerCase()).toContain('$search');
    expect(c).toContain('default');
  });
  it('omits hint blocks when not provided', () => {
    const c = buildPipelineMessages({ fields: ['a'], request: 'x' })[0].content;
    expect(c.toLowerCase()).not.toContain('$search');
    expect(c).not.toContain('Known values');
  });
});

describe('detectNumericStringFields', () => {
  it('flags string-of-digits leaf fields, not numbers or mixed strings', () => {
    const recs = [{ vendorId: '7440', id: { poId: 'J2-55', vendorId: '12760' }, quantity: 3, name: 'ACME' }];
    const out = detectNumericStringFields(recs);
    expect(out).toContain('vendorId');
    expect(out).toContain('id.vendorId');
    expect(out).not.toContain('id.poId');
    expect(out).not.toContain('quantity');
    expect(out).not.toContain('name');
  });
});

describe('leafStringFields', () => {
  it('returns string leaf paths, excludes _id, numbers, arrays, objects', () => {
    const recs = [{ _id: { $oid: 'x' }, name: 'A', n: 5, tags: ['a'], addr: { city: 'NY' } }];
    const out = leafStringFields(recs);
    expect(out).toContain('name');
    expect(out).toContain('addr.city');
    expect(out).not.toContain('_id');
    expect(out).not.toContain('_id.$oid');
    expect(out).not.toContain('n');
  });
});

describe('summarizeSearchIndexes', () => {
  it('summarizes name, dynamic→all, explicit fields, synonyms; drops non-queryable', () => {
    const raw = [
      { name: 'default', status: 'READY', queryable: true, latest_definition: { mappings: { dynamic: true } } },
      { name: 'desc', status: 'READY', queryable: true, latest_definition: { mappings: { dynamic: false, fields: { productDescription: {}, id: {} } }, synonyms: [{ name: 's' }] } },
      { name: 'building', status: 'BUILDING', queryable: false, latest_definition: { mappings: { dynamic: true } } },
    ];
    const out = summarizeSearchIndexes(raw);
    expect(out.find((i) => i.name === 'default').fields).toBe('all');
    const desc = out.find((i) => i.name === 'desc');
    expect(desc.fields).toEqual(['productDescription', 'id']);
    expect(desc.synonyms).toBe(true);
    expect(out.find((i) => i.name === 'building')).toBeUndefined();
  });
});

describe('extractReply', () => {
  it('returns the last message content', () => {
    expect(extractReply({ messages: [{ role: 'user', content: 'q' }, { role: 'system', content: 'A' }] })).toBe('A');
  });
  it('tolerates null/empty/garbage', () => {
    expect(extractReply(null)).toBe('');
    expect(extractReply({})).toBe('');
    expect(extractReply({ messages: [] })).toBe('');
  });
});

describe('stripFences', () => {
  it('strips ```json fences', () => {
    expect(stripFences('```json\n[{"$limit":5}]\n```')).toBe('[{"$limit":5}]');
  });
  it('strips bare fences', () => { expect(stripFences('```\n[]\n```')).toBe('[]'); });
  it('trims unfenced text', () => { expect(stripFences('  [] ')).toBe('[]'); });
  it('tolerates non-strings', () => { expect(stripFences(null)).toBe(''); });
});

describe('classifyProbe', () => {
  it('400 means available', () => { expect(classifyProbe(400)).toBe(true); });
  it('403/500/0 mean unavailable', () => {
    expect(classifyProbe(403)).toBe(false);
    expect(classifyProbe(500)).toBe(false);
    expect(classifyProbe(0)).toBe(false);
  });
});

describe('verdictFor', () => {
  it('error when not ok', () => { expect(verdictFor({ ok: false, rowCount: 0 })).toBe('error'); });
  it('empty when ok but 0 rows', () => { expect(verdictFor({ ok: true, rowCount: 0 })).toBe('empty'); });
  it('empty when rowCount missing', () => { expect(verdictFor({ ok: true })).toBe('empty'); });
  it('ok when rows present', () => { expect(verdictFor({ ok: true, rowCount: 3 })).toBe('ok'); });
});

describe('safeParseArray', () => {
  it('returns the array for a valid array', () => { expect(safeParseArray('[{"$limit":5}]')).toEqual([{ $limit: 5 }]); });
  it('null for a non-array JSON', () => { expect(safeParseArray('{"$limit":5}')).toBeNull(); });
  it('null for invalid JSON', () => { expect(safeParseArray('not json')).toBeNull(); });
  it('null for non-strings', () => { expect(safeParseArray(null)).toBeNull(); });
});

describe('ensureRowLimit', () => {
  it('appends $limit:50 when none present', () => {
    expect(ensureRowLimit([{ $match: { a: 1 } }])).toEqual([{ $match: { a: 1 } }, { $limit: 50 }]);
  });
  it('keeps an existing $limit (same reference)', () => {
    const p = [{ $sort: { a: -1 } }, { $limit: 5 }];
    expect(ensureRowLimit(p)).toBe(p);
  });
  it('leaves a $count pipeline untouched', () => {
    const p = [{ $count: 'n' }];
    expect(ensureRowLimit(p)).toBe(p);
  });
  it('caps an empty pipeline', () => {
    expect(ensureRowLimit([])).toEqual([{ $limit: 50 }]);
  });
});

describe('samePipeline', () => {
  it('true for canonically-equal arrays despite whitespace', () => {
    expect(samePipeline('[{"$limit":5}]', '[\n  { "$limit": 5 }\n]')).toBe(true);
  });
  it('false for different arrays', () => {
    expect(samePipeline('[{"$limit":5}]', '[{"$limit":6}]')).toBe(false);
  });
});

describe('buildFixMessages', () => {
  it('error problem: one user message with previous pipeline + error + request', () => {
    const msgs = buildFixMessages({
      fields: ['a'], request: 'top 5', previousPipeline: '[{"$srt":{}}]',
      problem: { type: 'error', message: "Unrecognized stage '$srt'" },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain(MONGO_SYSTEM_INSTRUCTION);
    expect(msgs[0].content).toContain('[{"$srt":{}}]');
    expect(msgs[0].content).toContain("Unrecognized stage '$srt'");
    expect(msgs[0].content).toContain('Original request: top 5');
  });
  it('empty problem with samples: includes the sample documents', () => {
    const msgs = buildFixMessages({
      fields: ['address.state'], request: 'vendors in California', previousPipeline: '[{"$match":{"address.state":"California"}}]',
      problem: { type: 'empty' }, samples: [{ address: { state: 'CA' } }],
    });
    expect(msgs[0].content).toContain('0 matching documents');
    expect(msgs[0].content).toContain('"state":"CA"');
  });
  it('stringifies a non-string previousPipeline', () => {
    const msgs = buildFixMessages({ fields: [], request: 'x', previousPipeline: [{ $limit: 5 }], problem: { type: 'empty' } });
    expect(msgs[0].content).toContain('[{"$limit":5}]');
  });
});

describe('AI request comment', () => {
  it('prepends a single-line request comment above the pipeline', () => {
    expect(prependAiComment('[\n  { "$limit": 5 }\n]', 'top 5 by amount'))
      .toBe('// 🤖 AI request: top 5 by amount\n[\n  { "$limit": 5 }\n]');
  });
  it('collapses a multi-line/whitespace request to one line', () => {
    expect(prependAiComment('[]', '  top\n5  ')).toBe('// 🤖 AI request: top 5\n[]');
  });
  it('replaces an existing AI comment instead of stacking', () => {
    const once = prependAiComment('[]', 'first');
    expect(prependAiComment(once, 'second')).toBe('// 🤖 AI request: second\n[]');
  });
  it('stripAiComment removes the leading comment (with or without blank separator)', () => {
    expect(stripAiComment('// 🤖 AI request: x\n\n[]')).toBe('[]');
    expect(stripAiComment('// 🤖 AI request: x\n[]')).toBe('[]');
  });
  it('stripAiComment leaves a plain pipeline untouched', () => {
    expect(stripAiComment('[\n  {}\n]')).toBe('[\n  {}\n]');
  });
});

describe('MONGO_SYSTEM_INSTRUCTION row cap', () => {
  it('instructs a 50-row maximum', () => {
    expect(MONGO_SYSTEM_INSTRUCTION).toMatch(/50/);
    expect(MONGO_SYSTEM_INSTRUCTION.toLowerCase()).toContain('limit');
  });
});
