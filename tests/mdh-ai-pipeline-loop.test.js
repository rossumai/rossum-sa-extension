import { describe, it, expect, vi } from 'vitest';
import { runAiPipeline } from '../src/mdh/aiPipelineLoop.js';

// Fake llmchat response: reply is the last message's content.
function llmRes(pipeline) {
  return { messages: [{ role: 'user', content: 'q' }, { role: 'system', content: JSON.stringify(pipeline) }] };
}
function fakeApi({ llm = [], agg = [], find = { result: [] } } = {}) {
  const llmQ = [...llm];
  const aggQ = [...agg];
  return {
    llmChat: vi.fn(async () => llmQ.shift()),
    aggregate: vi.fn(async () => { const n = aggQ.shift(); if (n instanceof Error) throw n; return n; }),
    find: vi.fn(async () => find),
  };
}
const base = { request: 'top 5', fields: ['a'], collection: 'C', currentPipeline: '[]' };

describe('runAiPipeline', () => {
  it('ok on the first try: applies the pipeline, no fix call', async () => {
    const api = fakeApi({ llm: [llmRes([{ $limit: 5 }])], agg: [{ result: [{ a: 1 }] }] });
    const { pipelineText } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $limit: 5 }]);
    expect(api.llmChat).toHaveBeenCalledTimes(1);
    expect(api.aggregate).toHaveBeenCalledTimes(1);
  });

  it('enforces a 50-row cap when the model omits a $limit', async () => {
    const api = fakeApi({ llm: [llmRes([{ $match: { a: 1 } }])], agg: [{ result: [{ a: 1 }] }] });
    const { pipelineText } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $match: { a: 1 } }, { $limit: 50 }]);
    // the probe ran the capped pipeline
    expect(api.aggregate.mock.calls[0][1]).toEqual([{ $match: { a: 1 } }, { $limit: 50 }]);
  });

  it('error → fix → ok', async () => {
    const err = Object.assign(new Error("Unrecognized stage '$srt'"), { status: 400 });
    const api = fakeApi({ llm: [llmRes([{ $srt: {} }]), llmRes([{ $sort: { a: -1 } }])], agg: [err, { result: [{ a: 1 }] }] });
    const { pipelineText } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $sort: { a: -1 } }, { $limit: 50 }]);
    expect(api.llmChat).toHaveBeenCalledTimes(2);
  });

  it('empty → fetch samples → fix → ok', async () => {
    const api = fakeApi({
      llm: [llmRes([{ $match: { s: 'California' } }]), llmRes([{ $match: { s: 'CA' } }])],
      agg: [{ result: [] }, { result: [{ s: 'CA' }] }], find: { result: [{ s: 'CA' }] },
    });
    const { pipelineText } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $match: { s: 'CA' } }, { $limit: 50 }]);
    expect(api.find).toHaveBeenCalledTimes(1);
  });

  it('legit empty (no progress) → stops after one fix attempt', async () => {
    const same = [{ $match: { q: { $gt: 999 } } }];
    const api = fakeApi({ llm: [llmRes(same), llmRes(same)], agg: [{ result: [] }], find: { result: [{}] } });
    await runAiPipeline({ api, ...base });
    expect(api.llmChat).toHaveBeenCalledTimes(2); // initial + one fix, then no-progress stop
    expect(api.aggregate).toHaveBeenCalledTimes(1);
  });

  it('no collection: applies without probing', async () => {
    const api = fakeApi({ llm: [llmRes([{ $limit: 5 }])] });
    const { pipelineText } = await runAiPipeline({ api, ...base, collection: null });
    expect(JSON.parse(pipelineText)).toEqual([{ $limit: 5 }]);
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('non-array output: applies as-is without probing', async () => {
    const api = { llmChat: vi.fn(async () => ({ messages: [{ role: 'system', content: 'sorry, cannot' }] })), aggregate: vi.fn(), find: vi.fn() };
    const { pipelineText } = await runAiPipeline({ api, ...base });
    expect(pipelineText).toBe('sorry, cannot');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('passes seed samples into the initial prompt', async () => {
    const api = fakeApi({ llm: [llmRes([{ $match: { a: 1 } }, { $limit: 50 }])], agg: [{ result: [{ a: 1 }] }] });
    await runAiPipeline({ api, ...base, samples: [{ a: 'CA' }] });
    expect(api.llmChat.mock.calls[0][0][0].content).toContain('"a":"CA"');
  });

  it('reuses seed samples on an empty-retry instead of calling find', async () => {
    const api = fakeApi({
      llm: [llmRes([{ $match: { s: 'X' } }]), llmRes([{ $match: { s: 'CA' } }])],
      agg: [{ result: [] }, { result: [{ s: 'CA' }] }],
    });
    await runAiPipeline({ api, ...base, samples: [{ s: 'CA' }] });
    expect(api.find).not.toHaveBeenCalled();
  });

  it('reports phases via onPhase', async () => {
    const api = fakeApi({ llm: [llmRes([{ $limit: 5 }])], agg: [{ result: [{ a: 1 }] }] });
    const phases = [];
    await runAiPipeline({ api, ...base, onPhase: (p) => phases.push(p) });
    expect(phases.length).toBeGreaterThan(0);
  });
});
