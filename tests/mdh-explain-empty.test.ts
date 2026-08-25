import { describe, it, expect, beforeEach } from 'vitest';
import {
  firstEmptyStage,
  explainSignature,
  buildEmptyStagePrompt,
  cachedExplanation,
  cacheExplanation,
  _resetExplanationCache,
} from '../src/mdh/agent/explainEmpty.js';

describe('firstEmptyStage', () => {
  it('returns the first ACTIVE stage whose preview came back empty', () => {
    const previews = { 0: { docs: [{ _id: 1 }] }, 1: { docs: [] }, 2: { docs: [] } };
    expect(firstEmptyStage(previews, 3)).toBe(1);
  });

  it('returns -1 when nothing is empty', () => {
    expect(firstEmptyStage({ 0: { docs: [{}] }, 1: { docs: [{}] } }, 2)).toBe(-1);
  });

  it('waits for a still-loading stage rather than reporting a later empty one', () => {
    // Stage 0 has not resolved. Reporting stage 1 here would explain a stage that
    // may not be the culprit once stage 0 lands.
    expect(firstEmptyStage({ 1: { docs: [] } }, 2)).toBe(-1);
  });

  it('does not treat an errored stage as empty (it shows its own message)', () => {
    expect(firstEmptyStage({ 0: { error: { message: 'boom' } }, 1: { docs: [] } }, 2)).toBe(-1);
  });

  it('ignores previews beyond the active stage count', () => {
    expect(firstEmptyStage({ 0: { docs: [{}] }, 1: { docs: [] } }, 1)).toBe(-1);
  });
});

describe('explainSignature', () => {
  const stages = [{ $match: { a: 1 } }, { $group: { _id: '$x' } }, { $sort: { n: -1 } }];

  it('covers only the stages up to and including the empty one', () => {
    // Editing a LATER stage cannot change why an earlier one was empty, so the
    // signature must not change — otherwise the explanation would re-run.
    const a = explainSignature('vendors', stages, 1);
    const b = explainSignature('vendors', [...stages.slice(0, 2), { $sort: { n: 1 } }], 1);
    expect(a).toBe(b);
  });

  it('changes when a stage at or before the empty one changes', () => {
    const a = explainSignature('vendors', stages, 1);
    const b = explainSignature('vendors', [{ $match: { a: 2 } }, ...stages.slice(1)], 1);
    expect(a).not.toBe(b);
  });

  it('changes with the collection', () => {
    expect(explainSignature('vendors', stages, 1)).not.toBe(explainSignature('orders', stages, 1));
  });

  it('is null when there is nothing to explain', () => {
    expect(explainSignature('vendors', stages, -1)).toBeNull();
    expect(explainSignature('', stages, 1)).toBeNull();
  });
});

describe('buildEmptyStagePrompt', () => {
  const base = {
    collection: 'vendors',
    stages: [{ $match: { country: 'DE' } }, { $group: { _id: '$x' } }, { $sort: { n: -1 } }],
    emptyIndex: 0,
    counts: [0],
    inputCount: 1204,
  };

  it('includes only the stages up to and including the empty one', () => {
    const p = buildEmptyStagePrompt(base);
    expect(p).toContain('$match');
    expect(p).toContain('country');
    // Later stages are irrelevant to why this one emptied, and sending them
    // invites the agent to diagnose the wrong stage.
    expect(p).not.toContain('$sort');
    expect(p).not.toContain('$group');
  });

  it('states the collection, the input count and the per-stage counts', () => {
    const p = buildEmptyStagePrompt({ ...base, emptyIndex: 1, counts: [87, 0] });
    expect(p).toContain('vendors');
    expect(p).toContain('1204');
    expect(p).toContain('0. $match -> 87 docs');
    expect(p).toContain('1. $group -> 0 docs');
  });

  it('says "unknown" for a count that has not arrived rather than inventing one', () => {
    const p = buildEmptyStagePrompt({ ...base, counts: [] });
    expect(p).toContain('$match -> unknown docs');
  });

  it('forbids the meta-preamble that made answers open with scope disclaimers', () => {
    const p = buildEmptyStagePrompt(base);
    expect(p).toContain('Do NOT open with a preamble');
    expect(p).toContain('caveat about scope');
    expect(p).toContain('Start with the cause.');
  });

  it('asks for Markdown, which is what the panel now renders', () => {
    const p = buildEmptyStagePrompt(base);
    expect(p).toContain('Markdown');
    expect(p).toContain('backticks');
    expect(p).toContain('No headings');
  });

  it('sends derived schema hints, never whole documents', () => {
    const p = buildEmptyStagePrompt({
      ...base,
      hints: {
        knownValues: { country: ['DEU', 'FRA'] },
        topValues: {},
        ranges: {},
        numericStringFields: [],
        searchIndexes: [],
        fieldTypes: {},
        arrayPaths: [],
      },
    });
    expect(p).toContain('DEU');
    expect(p).toContain('Data summary for this collection');
  });

  it('omits the hints section entirely when there are none', () => {
    expect(buildEmptyStagePrompt(base)).not.toContain('Data summary for this collection');
  });

  it('forbids inventing values and forbids suggesting a write stage', () => {
    const p = buildEmptyStagePrompt(base);
    expect(p).toContain('do not invent field names or values');
    expect(p).toContain('$out');
    expect(p).toContain('$merge');
  });

  it('asks for the shape the panel renders (bullets + a Next step line)', () => {
    const p = buildEmptyStagePrompt(base);
    expect(p).toContain('"- " bullets');
    expect(p).toContain('Next step:');
  });
});

describe('explanation cache', () => {
  beforeEach(() => _resetExplanationCache());

  it('returns nothing for an unknown or null signature', () => {
    expect(cachedExplanation('nope')).toBeNull();
    expect(cachedExplanation(null)).toBeNull();
  });

  it('round-trips a stored answer, so a remount reuses it instead of re-asking', () => {
    cacheExplanation('sig-a', 'because country holds DEU');
    expect(cachedExplanation('sig-a')).toBe('because country holds DEU');
  });

  it('never caches an empty answer (there is nothing to reuse)', () => {
    cacheExplanation('sig-b', '');
    expect(cachedExplanation('sig-b')).toBeNull();
  });

  it('evicts the least recently stored entry past the cap', () => {
    for (let i = 0; i < 21; i++) cacheExplanation(`s${i}`, `answer ${i}`);
    expect(cachedExplanation('s0')).toBeNull(); // evicted
    expect(cachedExplanation('s20')).toBe('answer 20');
  });

  it('re-storing an entry refreshes its recency rather than duplicating it', () => {
    for (let i = 0; i < 20; i++) cacheExplanation(`s${i}`, `answer ${i}`);
    cacheExplanation('s0', 'answer 0'); // touch the oldest
    cacheExplanation('new', 'answer new'); // forces one eviction
    expect(cachedExplanation('s0')).toBe('answer 0'); // survived
    expect(cachedExplanation('s1')).toBeNull(); // evicted instead
  });
});

describe('the agent is told what it is looking at', () => {
  const base = {
    collection: 'vendors',
    stages: [{ $match: { country: '' } }],
    emptyIndex: 0,
    counts: [0],
    inputCount: 1204,
  };

  it('frames the task as Rossum Master Data Hub, not a generic MongoDB question', () => {
    // The agent is a Rossum-platform persona and REFUSED an unframed prompt:
    // "this isn't related to the Rossum document processing platform".
    const p = buildEmptyStagePrompt(base);
    expect(p).toContain('Master Data Hub');
    expect(p).toContain('Rossum');
    expect(p).toContain("Rossum's Data Storage");
    expect(p).toContain('This IS a Rossum question');
    expect(p).toContain('Do NOT question whether the topic is in scope');
  });

  it('shows the pipeline AS WRITTEN alongside the substituted form', () => {
    const p = buildEmptyStagePrompt({
      ...base,
      rawStages: [{ $match: { country: '{country}' } }],
    });
    expect(p).toContain('AS WRITTEN');
    expect(p).toContain('{country}');
    expect(p).toContain('AS RUN');
  });

  it('falls back to the substituted form alone when the raw form is unavailable', () => {
    const p = buildEmptyStagePrompt(base);
    expect(p).not.toContain('AS WRITTEN');
    expect(p).toContain('up to and including the stage that came back empty');
  });

  it('ignores a raw form whose stage count disagrees (it would misalign)', () => {
    const p = buildEmptyStagePrompt({ ...base, rawStages: [{ $match: {} }, { $sort: {} }] });
    expect(p).not.toContain('AS WRITTEN');
  });

  it('lists variables, marking an unset one, and explains what that renders as', () => {
    const p = buildEmptyStagePrompt({
      ...base,
      rawStages: [{ $match: { country: '{country}' } }],
      variables: [
        { name: 'country', value: '', isSet: false, type: 'auto' },
        { name: 'qty', value: 5, isSet: true, type: 'number' },
      ],
    });
    expect(p).toContain('{country} = NOT SET');
    expect(p).toContain('{qty} = 5');
    expect(p).toContain('(type: number)');
    // The insight the raw form exists to enable.
    expect(p).toContain('An UNSET variable substitutes as an empty string');
    expect(p).toContain('the fix is to fill the variable in');
    expect(p).toContain('type-aware');
  });

  it('omits the variables section when the pipeline has none', () => {
    const p = buildEmptyStagePrompt(base);
    expect(p).not.toContain('Variables in this pipeline');
  });
});

describe('explainSignature includes the written form', () => {
  const run = [{ $match: { country: 'DE' } }];

  it('distinguishes a literal from a variable that renders identically', () => {
    // Both run as {country:"DE"}, but the right advice differs.
    const asLiteral = explainSignature('vendors', run, 0, [{ $match: { country: 'DE' } }]);
    const asVariable = explainSignature('vendors', run, 0, [{ $match: { country: '{country}' } }]);
    expect(asLiteral).not.toBe(asVariable);
  });

  it('is stable when the raw form is absent', () => {
    expect(explainSignature('vendors', run, 0)).toBe(explainSignature('vendors', run, 0));
  });
});
