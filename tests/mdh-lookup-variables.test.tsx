// @vitest-environment jsdom
// A lookup field's "$$name" variables (schema ui_configuration.type "lookup").
// The semantics asserted here were live-probed against the lookup engine: only
// an exact "$$name" string substitutes, typed, and "$$ROOT" is left alone.
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { usePipeline } from '../src/mdh/hooks/usePipeline.js';
import { lookupVarName, boundVarNames } from '../src/mdh/placeholderSyntax.js';
import { mapPlaceholdersToFields } from '../src/mdh/placeholderFields.js';
import PlaceholderInputs from '../src/mdh/components/PlaceholderInputs.jsx';

function getPipeline(): any {
  let api: any;
  const Probe = () => {
    api = usePipeline();
    return null;
  };
  render(<Probe />, document.createElement('div'));
  return api;
}

describe('lookupVarName', () => {
  it('accepts an exact $$name and rejects system variables', () => {
    expect(lookupVarName('$$sender_name')).toBe('sender_name');
    expect(lookupVarName('$$ROOT')).toBeNull();
    expect(lookupVarName('$$NOW')).toBeNull();
    expect(lookupVarName('R$$v')).toBeNull();
    // Confirmed on a saved lookup field: the engine searches "$$v " literally.
    expect(lookupVarName('$$v ')).toBeNull();
    expect(lookupVarName('$$v.x')).toBeNull();
    expect(lookupVarName('$field')).toBeNull();
  });
});

describe('boundVarNames', () => {
  it('collects $lookup.let, $let.vars, $map/$filter as, and $reduce', () => {
    const b = boundVarNames([
      { $lookup: { from: 'x', let: { po: '$po' }, pipeline: [], as: 'out' } },
      { $project: { a: { $let: { vars: { t: 1 }, in: '$$t' } } } },
      { $project: { b: { $map: { input: '$l', as: 'line', in: '$$line' } } } },
      { $project: { c: { $filter: { input: '$l', cond: '$$this' } } } },
      { $project: { d: { $reduce: { input: '$l', initialValue: 0, in: '$$value' } } } },
    ]);
    expect([...b].sort()).toEqual(['line', 'po', 't', 'this', 'value']);
  });
});

describe('usePipeline with $$name', () => {
  it('finds $$name variables alongside {name} ones', () => {
    const p = getPipeline();
    const text = '[{"$match":{"a":"$$va","b":"{vb}","c":"$$ROOT"}}]';
    expect(p.extractPlaceholders(text).sort()).toEqual(['va', 'vb']);
  });

  it('substitutes only the WHOLE string, typed like "{name}"', () => {
    const p = getPipeline();
    p.setPlaceholder('n', '17');
    p.setPlaceholder('s', 'Roll');
    const text = '[{"$match":{"id":"$$n","code":"$$s","keep":"R$$s"}}]';
    expect(p.computeEditorState(text).parsed).toEqual([
      { $match: { id: 17, code: 'Roll', keep: 'R$$s' } },
    ]);
    expect(p.computeEditorState(text, { n: 'string' }).parsed[0].$match.id).toBe('17');
  });

  it('substitutes inside $search and $expr', () => {
    const p = getPipeline();
    p.setPlaceholder('q', 'Acme');
    const text =
      '[{"$search":{"text":{"query":"$$q","path":"name"}}},' +
      '{"$match":{"$expr":{"$eq":["$name","$$q"]}}}]';
    expect(p.computeEditorState(text).parsed).toEqual([
      { $search: { text: { query: 'Acme', path: 'name' } } },
      { $match: { $expr: { $eq: ['$name', 'Acme'] } } },
    ]);
  });

  it('leaves names the pipeline binds itself alone', () => {
    const p = getPipeline();
    const text = '[{"$project":{"x":{"$filter":{"input":"$l","cond":{"$eq":["$$this","$$v"]}}}}}]';
    expect(p.extractPlaceholders(text)).toEqual(['v']);
    expect(p.computeEditorState(text).parsed[0].$project.x.$filter.cond.$eq[0]).toBe('$$this');
  });

  it('reports names written only as $$name', () => {
    const p = getPipeline();
    const text = '[{"$match":{"a":"$$va","b":"{vb}","c":"$$both","d":"{both}"}}]';
    expect(p.computeEditorState(text).lookupNames).toEqual(['va']);
  });
});

describe('mapPlaceholdersToFields with $$name', () => {
  it('maps a $$name to the field it is compared against', () => {
    expect(mapPlaceholdersToFields('[{"$match":{"code":"$$v"}}]')).toEqual({
      v: { field: 'code', collection: null, op: '$eq' },
    });
  });
  it('never reads "$$v" as a field path inside $expr', () => {
    expect(mapPlaceholdersToFields('[{"$match":{"$expr":{"$eq":["$$v","$code"]}}}]')).toEqual({
      v: { field: 'code', collection: null, op: '$eq' },
    });
  });
});

describe('PlaceholderInputs label', () => {
  it('labels a lookup variable as $$name and the rest as {name}', () => {
    const root = document.createElement('div');
    render(
      <PlaceholderInputs
        names={['va', 'vb']}
        lookupNames={['va']}
        values={{}}
        types={{}}
        onSetValue={() => {}}
        onSetType={() => {}}
        onRunQuery={() => {}}
        resolvedTypeFor={() => ({})}
      />,
      root,
    );
    const labels = [...root.querySelectorAll('.placeholder-name')].map((e) => e.textContent);
    expect(labels).toEqual(['$$va', '{vb}']);
  });
});
