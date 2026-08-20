import { describe, it, expect } from 'vitest';
import {
  parseEntries,
  parsePipelineDoc,
} from '../src/mdh/pipelineComments.js';

const A = '[\n  { "$match": { "x": 1 } },\n  { "$limit": 50 }\n]';

describe('parseEntries', () => {
  it('parses an all-active pipeline in order', () => {
    const { entries, ok } = parseEntries(A);
    expect(ok).toBe(true);
    expect(entries).toEqual([
      { disabled: false, stage: { $match: { x: 1 } } },
      { disabled: false, stage: { $limit: 50 } },
    ]);
  });

  it('parses a disabled block interleaved at its position', () => {
    const text = '[\n  { "$match": { "x": 1 } },\n  /* @disabled-stage\n  {\n    "$sort": { "a": -1 }\n  } */\n  { "$limit": 50 }\n]';
    const { entries, ok } = parseEntries(text);
    expect(ok).toBe(true);
    expect(entries.map((e) => e.disabled)).toEqual([false, true, false]);
    expect(entries[1].stage).toEqual({ $sort: { a: -1 } });
    expect(entries[2].stage).toEqual({ $limit: 50 });
  });

  it('does not treat a sentinel inside a string literal as a disabled stage', () => {
    const text = '[ { "$match": { "note": "/* @disabled-stage */" } } ]';
    const { entries, ok } = parseEntries(text);
    expect(ok).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].disabled).toBe(false);
  });

  it('ignores a @disabled-stage block nested inside a stage (depth > 1)', () => {
    const text = '[ { "$match": { "x": 1 } /* @disabled-stage {"$sort":{}} */ } ]';
    const { entries, ok } = parseEntries(text);
    expect(ok).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].disabled).toBe(false);
  });

  it('returns ok:false for invalid JSON5', () => {
    expect(parseEntries('[ { "$match": ').ok).toBe(false);
  });

  it('returns ok:false for a non-array top level', () => {
    expect(parseEntries('{ "$match": {} }').ok).toBe(false);
  });

  it('keeps a disabled block whose inner JSON is invalid (forgiving), stage=null + raw', () => {
    const text = '[ /* @disabled-stage { "$sort": */ { "$limit": 1 } ]';
    const { entries, ok } = parseEntries(text);
    expect(ok).toBe(true);
    expect(entries[0].disabled).toBe(true);
    expect(entries[0].stage).toBeNull();
    expect(entries[0].raw).toContain('$sort');
  });
});

// --- Task 2 tests (appended) ---
import {
  setStageDisabled,
  applyMutationToText,
  normalizeEffectivePipelineText,
  beautifyText,
  stageLineRanges,
  entryIndexAtOffset,
} from '../src/mdh/pipelineComments.js';
import { applySortToPipeline, applyFilterDeltaToPipeline, applySkipToPipeline } from '../src/mdh/pipelineOps.js';
import JSON5 from 'json5';

describe('setStageDisabled (verbatim wrap/unwrap)', () => {
  it('disables a stage by wrapping its verbatim span, preserving other stages exactly', () => {
    const text = '[\n  { "$match": { "x": 1 } },\n  { "$sort": { "a": -1 } },\n  { "$limit": 50 }\n]';
    const out = setStageDisabled(text, 1, true);
    expect(JSON5.parse(out)).toEqual([{ $match: { x: 1 } }, { $limit: 50 }]);
    expect(out).toContain('/* @disabled-stage');
    // the $match and $limit bytes are untouched
    expect(out).toContain('{ "$match": { "x": 1 } }');
    expect(out).toContain('{ "$limit": 50 }');
    // round-trips back to the exact original stage
    const re = parseEntries(out);
    expect(re.entries[1].disabled).toBe(true);
    expect(re.entries[1].stage).toEqual({ $sort: { a: -1 } });
  });

  it('enables a disabled block by restoring its inner verbatim', () => {
    const text = '[\n  { "$match": { "x": 1 } },\n  /* @disabled-stage\n{ "$sort": { "a": -1 } } */\n  { "$limit": 50 }\n]';
    const out = setStageDisabled(text, 1, false);
    expect(JSON5.parse(out)).toEqual([{ $match: { x: 1 } }, { $sort: { a: -1 } }, { $limit: 50 }]);
    expect(out).not.toContain('@disabled-stage');
  });

  it('round-trips a value containing "*/" through disable+enable', () => {
    const text = '[\n  { "$match": { "p": "src/**/*.js" } },\n  { "$limit": 5 }\n]';
    const disabled = setStageDisabled(text, 0, true);
    expect(JSON5.parse(disabled)).toEqual([{ $limit: 5 }]); // stays valid
    const enabled = setStageDisabled(disabled, 0, false);
    expect(JSON5.parse(enabled)).toEqual([{ $match: { p: 'src/**/*.js' } }, { $limit: 5 }]);
  });

  it('RE-ENABLES an invalid disabled block (shows the error) rather than no-op', () => {
    const text = '[ /* @disabled-stage { "$sort": */ { "$limit": 1 } ]';
    const re = parseEntries(text);
    expect(re.entries[0].disabled).toBe(true);
    expect(re.entries[0].stage).toBeNull();
    const out = setStageDisabled(text, 0, false);
    // the invalid inner is restored as an active element -> the whole text is now invalid JSON5
    expect(out).not.toContain('@disabled-stage');
    expect(out).toContain('{ "$sort":');
    expect(parsePipelineDoc(out).ok).toBe(false); // editor will surface the parse error
  });

  it('is a no-op for a bad index', () => {
    const text = '[ { "$match": {} } ]';
    expect(setStageDisabled(text, 9, true)).toBe(text);
  });

  it('stays valid JSON5 when the separator comma is on its own line', () => {
    const text = '[\n  { "$match": {} }\n  ,\n  { "$limit": 5 }\n]';
    const out = setStageDisabled(text, 0, true);
    expect(parsePipelineDoc(out).ok).toBe(true);
    expect(JSON5.parse(out)).toEqual([{ $limit: 5 }]);
  });

  it('wraps an inline comment before the separator comma into the block and restores it on enable', () => {
    const text = '[\n  { "$match": {} } /* keep */,\n  { "$limit": 5 }\n]';
    const out = setStageDisabled(text, 0, true);
    expect(parsePipelineDoc(out).ok).toBe(true);
    expect(JSON5.parse(out)).toEqual([{ $limit: 5 }]);
    // the inline comment is now inside the disabled block (its */ escaped so it
    // doesn't close the block early); enabling restores it verbatim.
    const back = setStageDisabled(out, 0, false);
    expect(back).toContain('/* keep */');
    expect(JSON5.parse(back)).toEqual([{ $match: {} }, { $limit: 5 }]);
  });

  it('enabling both stages of an all-disabled pair stays valid (leading comma added)', () => {
    const text = '[\n  /* @disabled-stage\n{ "$a": 1 } */\n  /* @disabled-stage\n{ "$b": 2 } */\n]';
    const afterA = setStageDisabled(text, 0, false); // enable A (now first visible, no comma yet)
    expect(parsePipelineDoc(afterA).ok).toBe(true);
    const afterB = setStageDisabled(afterA, 1, false); // enable B — needs a leading comma before it
    expect(parsePipelineDoc(afterB).ok).toBe(true);
    expect(JSON5.parse(afterB)).toEqual([{ $a: 1 }, { $b: 2 }]);
  });

  it('renders the disabled block indented with its trailing comma kept in the content', () => {
    const text = '[\n  { "$match": {} },\n  { "$sort": { "a": -1 } },\n  { "$limit": 50 }\n]';
    const out = setStageDisabled(text, 1, true);
    // body aligns under /* (indented) and carries the trailing comma
    expect(out).toContain('/* @disabled-stage\n  { "$sort": { "a": -1 } }, */');
    // parsePipelineDoc still extracts the stage despite the in-content comma
    expect(parseEntries(out).entries[1].stage).toEqual({ $sort: { a: -1 } });
    // round-trips exactly
    expect(setStageDisabled(out, 1, false)).toBe(text);
  });

  it('keeps the comma in the comment for a multi-line stage and round-trips', () => {
    const text = '[\n  { "$match": {} },\n  {\n    "$sort": { "a": -1 }\n  },\n  { "$limit": 50 }\n]';
    const out = setStageDisabled(text, 1, true);
    expect(parsePipelineDoc(out).ok).toBe(true);
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $limit: 50 }]);
    expect(setStageDisabled(out, 1, false)).toBe(text); // exact verbatim round-trip
  });
});

describe('applyMutationToText (minimal edits preserve comments + formatting)', () => {
  it('replace-in-place preserves a comment on the line above the changed stage', () => {
    const text = '[\n  // only active\n  { "$match": { "active": true } },\n  // newest first\n  { "$sort": { "created": -1 } },\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { created: 1 }));
    expect(out).toContain('// only active');
    expect(out).toContain('// newest first');           // comment above the re-sorted stage survives
    expect(out).toContain('{ "$match": { "active": true } }'); // untouched stage verbatim
    expect(JSON5.parse(out)).toEqual([
      { $match: { active: true } }, { $sort: { created: 1 } }, { $skip: 0 },
    ]);
  });

  it('paginate (replace $skip) preserves leading + between + trailing comments', () => {
    const text = '[\n  // lead\n  { "$match": {} },\n  // mid\n  { "$skip": 0 },\n  { "$limit": 50 }\n  // tail\n]';
    const out = applyMutationToText(text, (p) => applySkipToPipeline(p, 100));
    expect(out).toContain('// lead');
    expect(out).toContain('// mid');
    expect(out).toContain('// tail');
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $skip: 100 }, { $limit: 50 }]);
  });

  it('preserves an untouched stage BETWEEN two changed stages (multi-change mutator)', () => {
    // handleSort does applySort + applySkip; a $group sits between $sort and $skip.
    const text = '[\n  { "$match": {} },\n  { "$sort": { "a": 1 } },\n  { "$group": { "_id": "$x" /* keep me */ } },\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => { applySortToPipeline(p, { b: -1 }); applySkipToPipeline(p, 25); });
    expect(out).toContain('/* keep me */'); // the untouched $group keeps its inner comment
    expect(JSON5.parse(out)).toEqual([
      { $match: {} }, { $sort: { b: -1 } }, { $group: { _id: '$x' } }, { $skip: 25 },
    ]);
  });

  it('preserves disabled stages through a mutation', () => {
    const text = '[\n  { "$match": {} },\n  /* @disabled-stage\n{ "$project": { "a": 1 } } */\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { a: -1 }));
    expect(parseEntries(out).entries.filter((e) => e.disabled)).toHaveLength(1);
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $sort: { a: -1 } }, { $skip: 0 }]);
  });

  it('insert keeps the following stage\'s leading comment attached to it', () => {
    const text = '[\n  { "$match": {} },\n  // pagination\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { a: 1 })); // inserts $sort after $match
    expect(out).toContain('// pagination');
    const parsed = JSON5.parse(out);
    expect(parsed).toEqual([{ $match: {} }, { $sort: { a: 1 } }, { $skip: 0 }]);
  });

  it('Limit B: removing a stage drops its leading comment', () => {
    const text = '[\n  { "$match": {} },\n  // newest first\n  { "$sort": { "a": -1 } },\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, {})); // clears the sort -> removes $sort
    expect(out).not.toContain('// newest first');
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $skip: 0 }]);
  });

  it('Limit A: the changed stage\'s OWN inner comment is reserialized away', () => {
    const text = '[\n  { "$sort": { "created": -1 /* tie-break later */ } }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { created: 1 }));
    expect(out).not.toContain('tie-break later');
    expect(JSON5.parse(out)).toEqual([{ $sort: { created: 1 } }]);
  });

  it('returns null when the text cannot be parsed', () => {
    expect(applyMutationToText('[ {', () => {})).toBeNull();
  });

  it('removing a stage whose predecessor is a disabled block stays valid JSON5', () => {
    const text = '[\n  /* @disabled-stage\n{ "$project": { "a": 1 } } */\n  { "$sort": { "a": -1 } },\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, {})); // clears the sort -> removes $sort
    expect(parsePipelineDoc(out).ok).toBe(true);
    expect(JSON5.parse(out)).toEqual([{ $skip: 0 }]);
    expect(parseEntries(out).entries.filter((e) => e.disabled)).toHaveLength(1); // disabled $project survives
  });

  it('removing the LAST active stage when preceded by a disabled block stays valid', () => {
    const text = '[\n  { "$match": {} },\n  /* @disabled-stage\n{ "$project": { "a": 1 } } */\n  { "$sort": { "a": -1 } }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, {}));
    expect(parsePipelineDoc(out).ok).toBe(true);
    expect(JSON5.parse(out)).toEqual([{ $match: {} }]);
    expect(parseEntries(out).entries.filter((e) => e.disabled)).toHaveLength(1);
  });

  it('appending a stage after a trailing disabled block stays valid (no double comma)', () => {
    const text = '[\n  { "$match": {} },\n  /* @disabled-stage\n{ "$z": 9 } */\n]';
    const out = applyMutationToText(text, (p) => applySkipToPipeline(p, 10)); // appends $skip
    expect(parsePipelineDoc(out).ok).toBe(true);
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $skip: 10 }]);
    expect(parseEntries(out).entries.filter((e) => e.disabled)).toHaveLength(1);
  });

  it('inserting before an active stage when a disabled block is first stays valid (no missing comma)', () => {
    const text = '[\n  /* @disabled-stage\n{ "$z": 9 } */\n  { "$skip": 0 }\n]';
    const out = applyMutationToText(text, (p) => applySortToPipeline(p, { a: 1 })); // inserts $sort before $skip
    expect(parsePipelineDoc(out).ok).toBe(true);
    expect(JSON5.parse(out)).toEqual([{ $sort: { a: 1 } }, { $skip: 0 }]);
    expect(parseEntries(out).entries.filter((e) => e.disabled)).toHaveLength(1);
  });
});

describe('normalizeEffectivePipelineText', () => {
  it('turns an empty pipeline into [{ $match: {} }]', () => {
    expect(normalizeEffectivePipelineText('[]')).toBe(JSON.stringify([{ $match: {} }]));
  });
  it('leaves a non-empty pipeline untouched', () => {
    expect(normalizeEffectivePipelineText('[{"$limit":5}]')).toBe('[{"$limit":5}]');
  });
  it('leaves unparseable text untouched', () => {
    expect(normalizeEffectivePipelineText('[ {')).toBe('[ {');
  });
});

describe('beautifyText (reformat stages, keep comments)', () => {
  it('canonicalizes stage bodies but preserves standalone/leading/trailing comments', () => {
    const text = '[\n  // lead\n  {"$match":{"a":1}},\n  // mid\n  {"$limit":5}\n  // tail\n]';
    const out = beautifyText(text);
    expect(out).toContain('// lead');
    expect(out).toContain('// mid');
    expect(out).toContain('// tail');
    // bodies reflowed to canonical 2-space
    expect(out).toContain('"$match": {\n      "a": 1\n    }');
    expect(JSON5.parse(out)).toEqual([{ $match: { a: 1 } }, { $limit: 5 }]);
  });

  it('keeps disabled blocks', () => {
    const text = '[{"$match":{}},/* @disabled-stage {"$sort":{"a":-1}} */{"$limit":5}]';
    const out = beautifyText(text);
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $limit: 5 }]);
    expect(parseEntries(out).entries.filter((e) => e.disabled)).toHaveLength(1);
  });

  it('returns null for invalid input', () => {
    expect(beautifyText('[ {')).toBeNull();
  });
});

describe('stageLineRanges', () => {
  it('returns 1-based line spans + entryIndex + disabled flag per top-level stage', () => {
    const text = '[\n  { "$match": {} },\n  /* @disabled-stage\n  { "$sort": { "a": -1 } } */\n  { "$limit": 50 }\n]';
    const ranges = stageLineRanges(text);
    expect(ranges).toMatchObject([
      { entryIndex: 0, disabled: false, lineStart: 2, lineEnd: 2 },
      { entryIndex: 1, disabled: true, lineStart: 3, lineEnd: 4 },
      { entryIndex: 2, disabled: false, lineStart: 5, lineEnd: 5 },
    ]);
    // Char offsets bound each stage: an active stage's `start` is its '{'.
    expect(text[ranges[0].start]).toBe('{');
    expect(text.slice(ranges[2].start, ranges[2].end)).toContain('$limit');
  });
  it('returns [] for invalid text', () => {
    expect(stageLineRanges('[ {')).toEqual([]);
  });
});

describe('disable robustness (review fixes)', () => {
  it('round-trips a stage whose string value contains "*/" when disabled', () => {
    const text = '[\n  { "$match": { "path": "src/**/*.js" } },\n  { "$limit": 50 }\n]';
    const out = setStageDisabled(text, 0, true);
    expect(JSON5.parse(out)).toEqual([{ $limit: 50 }]); // stays valid; comment dropped
    const re = parseEntries(out);
    expect(re.ok).toBe(true);
    expect(re.entries[0].disabled).toBe(true);
    expect(re.entries[0].stage).toEqual({ $match: { path: 'src/**/*.js' } });
  });

  it('reports ok:false for a non-object top-level element', () => {
    expect(parseEntries('[ 42, { "$limit": 5 } ]').ok).toBe(false);
  });
});

describe('parsePipelineDoc', () => {
  it('returns ordered segments with exact source spans + array bounds', () => {
    const text = '[\n  { "$match": {} },\n  { "$limit": 5 }\n]';
    const doc = parsePipelineDoc(text);
    expect(doc.ok).toBe(true);
    expect(doc.segments.map((s) => s.kind)).toEqual(['active', 'active']);
    // span slices back to the exact stage text
    expect(text.slice(doc.segments[0].start, doc.segments[0].end)).toBe('{ "$match": {} }');
    expect(text.slice(doc.segments[1].start, doc.segments[1].end)).toBe('{ "$limit": 5 }');
    expect(text[doc.arrayStart]).toBe('[');
    expect(text[doc.arrayEnd]).toBe(']');
  });

  it('captures a disabled block segment with its inner raw', () => {
    const text = '[\n  /* @disabled-stage\n{ "$sort": { "a": -1 } } */\n  { "$limit": 5 }\n]';
    const doc = parsePipelineDoc(text);
    expect(doc.ok).toBe(true);
    expect(doc.segments[0].kind).toBe('disabled');
    expect(doc.segments[0].stage).toEqual({ $sort: { a: -1 } });
    expect(doc.segments[0].raw).toBe('{ "$sort": { "a": -1 } }');
  });

  it('is ok:false for invalid JSON5 or a non-array', () => {
    expect(parsePipelineDoc('[ {').ok).toBe(false);
    expect(parsePipelineDoc('{ "$match": {} }').ok).toBe(false);
  });
});

describe('entryIndexAtOffset', () => {
  // An active stage, a disabled one, then another active one.
  const text = '[{"$match":{}},/* @disabled-stage {"$sort":{"a":-1}} */{"$limit":5}]';
  const ranges = stageLineRanges(text);

  it('counts EVERY entry, including disabled ones', () => {
    expect(entryIndexAtOffset(ranges, ranges[0].start + 1)).toBe(0);
    expect(entryIndexAtOffset(ranges, ranges[1].start + 1)).toBe(1); // the disabled stage
    expect(entryIndexAtOffset(ranges, ranges[2].start + 1)).toBe(2);
  });

  it('returns null outside every stage', () => {
    expect(entryIndexAtOffset(ranges, 0)).toBeNull();          // the '['
    expect(entryIndexAtOffset(ranges, text.length - 1)).toBeNull(); // the ']'
  });

  it('returns null for an unparseable document (no ranges)', () => {
    expect(entryIndexAtOffset(stageLineRanges('[{"$match":'), 3)).toBeNull();
  });
});
