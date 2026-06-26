import { describe, it, expect } from 'vitest';
import {
  buildPipelineMessages, extractReply, stripFences, classifyProbe, MONGO_SYSTEM_INSTRUCTION,
  verdictFor, safeParseArray, samePipeline, buildFixMessages, ensureRowLimit,
  prependAiComment, stripAiComment, detectNumericStringFields, leafStringFields, summarizeSearchIndexes,
  leafFieldTypes, arrayLeafPaths, extendedJsonType, ANGLES,
  buildVerifyMessages, parseVerification,
  buildTrace, FIX_ANGLES,
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
  it('one user message carrying the FULL attempt history + reasons + request', () => {
    const msgs = buildFixMessages({
      fields: ['a'], request: 'top 5',
      attempts: [
        { pipelineText: '[{"$srt":{}}]', reason: "failed with error: Unrecognized stage '$srt'." },
        { pipelineText: '[{"$match":{"a":1}}]', reason: 'returned 0 matching documents. Reviewer: filter too narrow.' },
      ],
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain(MONGO_SYSTEM_INSTRUCTION);
    expect(msgs[0].content).toContain('do not repeat them');
    // BOTH prior attempts (not just the latest) and their reasons are present
    expect(msgs[0].content).toContain('[{"$srt":{}}]');
    expect(msgs[0].content).toContain("Unrecognized stage '$srt'");
    expect(msgs[0].content).toContain('[{"$match":{"a":1}}]');
    expect(msgs[0].content).toContain('Reviewer: filter too narrow');
    expect(msgs[0].content).toContain('Original request: top 5');
  });
  it('includes the angle instruction and sample documents', () => {
    const minimal = buildFixMessages({ fields: ['s'], request: 'x', angle: 'minimal',
      attempts: [{ pipelineText: '[]', reason: 'no rows' }], samples: [{ s: 'CA' }] });
    expect(minimal[0].content).toContain(FIX_ANGLES.minimal);
    expect(minimal[0].content).not.toContain(FIX_ANGLES.rethink);
    expect(minimal[0].content).toContain('"s":"CA"');
    const rethink = buildFixMessages({ request: 'x', angle: 'rethink', attempts: [{ pipelineText: '[]', reason: 'r' }] });
    expect(rethink[0].content).toContain(FIX_ANGLES.rethink);
  });
  it('omits the history block when there are no attempts', () => {
    const c = buildFixMessages({ request: 'x', attempts: [] })[0].content;
    expect(c).not.toContain('do not repeat them');
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

describe('leafFieldTypes', () => {
  it('maps scalar leaf paths to a type, descends objects, excludes _id, marks arrays', () => {
    const out = leafFieldTypes([{ _id: { x: 1 }, name: 'A', amount: 5, ok: true, addr: { zip: '10' }, tags: ['x'] }]);
    expect(out).toEqual({ name: 'string', amount: 'number', ok: 'boolean', 'addr.zip': 'string', tags: 'array' });
    expect(out._id).toBeUndefined();
  });
  it('marks a field seen with >1 non-null type as mixed', () => {
    expect(leafFieldTypes([{ x: 1 }, { x: 'a' }]).x).toBe('mixed');
  });
  it('excludes a path that is an object in any record (reports only its leaves)', () => {
    expect(leafFieldTypes([{ addr: { zip: '10' } }, { addr: null }])).toEqual({ 'addr.zip': 'string' });
  });
  it('reports a field that is null in every record as null', () => {
    expect(leafFieldTypes([{ x: null }, { x: null }])).toEqual({ x: 'null' });
  });
});

describe('arrayLeafPaths', () => {
  it('returns element leaf paths for arrays of objects and bare path[] for scalar arrays; excludes _id', () => {
    const out = arrayLeafPaths([{ _id: { a: [1] }, line_items: [{ sku: 'A', qty: 1 }], tags: ['x'] }]);
    expect(out).toEqual(['line_items[].qty', 'line_items[].sku', 'tags[]']);
  });
});

describe('MongoDB extended-JSON awareness (no leaked field.$date)', () => {
  const recs = [{
    _id: { $oid: 'abc' },
    name: 'ACME',
    createdAt: { $date: '2026-01-01T00:00:00Z' },
    balance: { $numberDecimal: '99.50' },
    visits: { $numberLong: '42' },
    addr: { city: 'NY' },
    stamps: [{ $date: '2026-01-02T00:00:00Z' }],
    lines: [{ sku: 'A', at: { $date: '2026-01-03' } }],
  }];
  it('extendedJsonType classifies wrappers and ignores plain objects', () => {
    expect(extendedJsonType({ $date: 'x' })).toBe('date');
    expect(extendedJsonType({ $oid: 'x' })).toBe('objectId');
    expect(extendedJsonType({ $numberLong: '1' })).toBe('number');
    expect(extendedJsonType({ $numberDecimal: '1.5' })).toBe('number');
    expect(extendedJsonType({ city: 'NY' })).toBeNull();
    expect(extendedJsonType({ $date: 'x', extra: 1 })).toBeNull(); // not a clean wrapper
    expect(extendedJsonType('x')).toBeNull();
  });
  it('leafFieldTypes reports the semantic type, never a .$date sub-path', () => {
    const t = leafFieldTypes(recs);
    expect(t.createdAt).toBe('date');
    expect(t.balance).toBe('number');
    expect(t.visits).toBe('number');
    expect(t['addr.city']).toBe('string'); // real nested objects still descend
    expect(t['createdAt.$date']).toBeUndefined();
    expect(t._id).toBeUndefined();
  });
  it('leafStringFields excludes extended-JSON typed fields', () => {
    const s = leafStringFields(recs);
    expect(s).toContain('name');
    expect(s).toContain('addr.city');
    expect(s).not.toContain('createdAt.$date');
    expect(s).not.toContain('createdAt');
  });
  it('detectNumericStringFields does not flag $number* wrappers', () => {
    const n = detectNumericStringFields(recs);
    expect(n).not.toContain('visits.$numberLong');
    expect(n).not.toContain('visits');
  });
  it('arrayLeafPaths treats arrays of $date wrappers as scalar arrays', () => {
    const a = arrayLeafPaths(recs);
    expect(a).toContain('stamps[]');
    expect(a).not.toContain('stamps[].$date');
    expect(a).toContain('lines[].sku');
    expect(a).toContain('lines[].at'); // the date sub-field is a leaf, not lines[].at.$date
    expect(a).not.toContain('lines[].at.$date');
  });
});

describe('angles + collection + richer hints', () => {
  it('adds the Collection line and the selected angle instruction', () => {
    const c = buildPipelineMessages({ fields: ['a'], request: 'x', collection: 'vendors', angle: 'tolerant' })[0].content;
    expect(c).toContain('Collection: vendors');
    expect(c).toContain(ANGLES.tolerant);
    expect(c).not.toContain(ANGLES.exact);
  });
  it('omits collection/angle lines when absent (backward-compatible)', () => {
    const c = buildPipelineMessages({ fields: ['a'], request: 'x' })[0].content;
    expect(c).not.toContain('Collection:');
    expect(c).not.toContain(ANGLES.exact);
    expect(c).not.toContain(ANGLES.tolerant);
  });
  it('renders field-types, ranges, array-paths, and top-values blocks', () => {
    const c = buildPipelineMessages({
      fields: ['amount'], request: 'x',
      fieldTypes: { amount: 'number', name: 'string' },
      ranges: { amount: { min: 1, max: 999 } },
      arrayPaths: ['line_items[].sku'],
      topValues: { country: { values: ['US', 'DE'], more: 40 } },
    })[0].content;
    expect(c).toContain('amount:number');
    expect(c).toContain('amount: 1…999');
    expect(c).toContain('line_items[].sku');
    expect(c).toContain('country often ∈ {US, DE} (+40 more)');
    expect(c).not.toContain('extended JSON'); // no ext-json note when no date/objectId fields
  });
  it('adds the extended-JSON note when a date/objectId field is present', () => {
    const c = buildPipelineMessages({ fields: ['createdAt'], request: 'x', fieldTypes: { createdAt: 'date' } })[0].content;
    expect(c).toContain('createdAt:date');
    expect(c).toContain('extended JSON');
    expect(c).toContain('there is no ".$date" sub-field');
  });
});

describe('buildVerifyMessages', () => {
  it('embeds the request, each candidate pipeline + sample, and asks for JSON', () => {
    const c = buildVerifyMessages({
      request: 'top vendors', collection: 'vendors', fields: ['a'],
      candidates: [
        { pipelineText: '[{"$limit":5}]', rowCount: 5, sample: [{ a: 1 }] },
        { pipelineText: '[{"$match":{}}]', rowCount: 0, error: 'boom', sample: [] },
      ],
    })[0].content;
    expect(c).toContain('Request: top vendors');
    expect(c).toContain('Candidate 1');
    expect(c).toContain('Candidate 2');
    expect(c).toContain('"a":1');
    expect(c).toContain('boom');
    expect(c.toLowerCase()).toContain('output only json');
  });
  it('asks for decision fields first and short strings (non-compact)', () => {
    const c = buildVerifyMessages({ request: 'x', candidates: [{ pipelineText: '[]', rowCount: 1, sample: [] }] })[0].content;
    expect(c).toContain('"candidates"');
    expect(c.indexOf('"best"')).toBeLessThan(c.indexOf('"reasoning"')); // best before reasoning
    expect(c.toLowerCase()).toContain('short');
  });
  it('compact mode drops issue/reasoning from the requested shape', () => {
    const c = buildVerifyMessages({ request: 'x', compact: true, candidates: [{ pipelineText: '[]', rowCount: 1, sample: [] }] })[0].content;
    expect(c).toContain('"answersRequest"');
    expect(c).not.toContain('"reasoning"');
    expect(c).not.toContain('"issue"');
  });
});

describe('parseVerification', () => {
  const good = '{"candidates":[{"index":1,"answersRequest":true,"score":90,"issue":""}],"best":1,"reasoning":"ok"}';
  it('parses a valid judgment', () => {
    expect(parseVerification(good).best).toBe(1);
  });
  it('parses fenced JSON', () => {
    expect(parseVerification('```json\n' + good + '\n```').best).toBe(1);
  });
  it('returns null for prose / malformed / wrong shape', () => {
    expect(parseVerification('sorry, I cannot')).toBeNull();
    expect(parseVerification('{"candidates":[]}')).toBeNull(); // no integer best
    expect(parseVerification(null)).toBeNull();
  });
  it('recovers candidates+best from a response truncated mid-reasoning', () => {
    const truncated = '{"candidates":[{"index":1,"answersRequest":false,"score":0,"issue":"wrong op"}],"best":1,"reasoning":"the pipeline uses string compar';
    const v = parseVerification(truncated);
    expect(v).not.toBeNull();
    expect(v.best).toBe(1);
    expect(v.candidates[0].answersRequest).toBe(false);
  });
  it('defaults best to 1 for a single candidate when best is null/missing', () => {
    expect(parseVerification('{"candidates":[{"index":1,"answersRequest":false,"score":0,"issue":"x"}],"best":null,"reasoning":"cut').best).toBe(1);
  });
  it('still returns null when best is missing among multiple candidates', () => {
    expect(parseVerification('{"candidates":[{"index":1},{"index":2}],"best":nul')).toBeNull();
  });
});

describe('buildTrace', () => {
  const c1 = { angle: 'exact', pipelineText: '[]', verdict: 'ok', rowCount: 12 };
  const c2 = { angle: 'tolerant', pipelineText: '[]', verdict: 'empty', rowCount: 0 };
  const initial = (picked, verification) => ({ kind: 'initial', candidates: [c1, c2], picked, verification });
  it('ok, verified, best-of-2 summary + applied flag', () => {
    const t = buildTrace({ request: 'q', rounds: [initial(c1, { reasoning: 'one is right' })], chosen: c1,
      verification: { reasoning: 'one is right' }, hints: { collection: 'C', fieldCount: 3 } });
    expect(t.status).toBe('ok');
    expect(t.summary).toBe('Best of 2 · AI-checked · 12 rows');
    expect(t.rounds).toHaveLength(1);
    expect(t.rounds[0].kind).toBe('initial');
    const applied = t.rounds[0].candidates.find((c) => c.applied);
    expect(applied.angle).toBe('exact');
    expect(applied.picked).toBe(true); // c1 was both this round's pick and the applied one
    expect(t.verifierReasoning).toBe('one is right');
    expect(t.hints.collection).toBe('C');
  });
  it('drops the verified marker and reasoning on a mechanical fallback', () => {
    const t = buildTrace({ request: 'q', rounds: [initial(c1, null)], chosen: c1, verification: null, hints: {} });
    expect(t.summary).toBe('Best of 2 · 12 rows');
    expect(t.verifierReasoning).toBeUndefined();
  });
  it('records the full round history (initial + correction), only the final is applied', () => {
    const fix = { angle: 'correction', pipelineText: '[]', verdict: 'ok', rowCount: 5 };
    const t = buildTrace({
      request: 'q',
      rounds: [initial(c1, { reasoning: 'r1' }),
        { kind: 'correction', trigger: 'empty', candidates: [c1, fix], picked: fix, verification: { reasoning: 'r2' } }],
      chosen: fix, verification: { reasoning: 'r2' }, hints: {}, corrected: true,
    });
    expect(t.rounds).toHaveLength(2);
    expect(t.rounds[1].kind).toBe('correction');
    expect(t.rounds[1].trigger).toBe('empty');
    expect(t.rounds[1].reasoning).toBe('r2');
    // exactly one applied across all rounds — the final fix
    const appliedAll = t.rounds.flatMap((r) => r.candidates).filter((c) => c.applied);
    expect(appliedAll).toHaveLength(1);
    expect(appliedAll[0].angle).toBe('correction');
    // c1 was picked in round 0 but NOT applied
    expect(t.rounds[0].candidates.find((c) => c.angle === 'exact').picked).toBe(true);
    expect(t.rounds[0].candidates.find((c) => c.angle === 'exact').applied).toBe(false);
    expect(t.corrected).toBe(true);
  });
  it('error and empty statuses', () => {
    const err = { angle: 'exact', pipelineText: '[]', verdict: 'error', rowCount: 0, error: 'bad stage' };
    expect(buildTrace({ rounds: [{ kind: 'initial', candidates: [err], picked: err }], chosen: err, hints: {} }).status).toBe('error');
    expect(buildTrace({ rounds: [{ kind: 'initial', candidates: [c2], picked: c2 }], chosen: c2, hints: {} }).status).toBe('empty');
  });
  it('no usable candidate → unverified status + message', () => {
    const t = buildTrace({ rounds: [], chosen: null, hints: {} });
    expect(t.status).toBe('unverified');
    expect(t.summary).toContain('No usable');
  });
  it('passes the calls timeline through unchanged', () => {
    const calls = [{ seq: 0, kind: 'generate', round: 1, status: 'ok', group: 'g0' },
                   { seq: 1, kind: 'verify', round: 1, status: 'passed', group: 'g1' }];
    const t = buildTrace({ request: 'q', rounds: [initial(c1, { reasoning: 'ok' })], chosen: c1, verification: { reasoning: 'ok' }, hints: {}, calls });
    expect(t.calls).toEqual(calls);
  });
});
