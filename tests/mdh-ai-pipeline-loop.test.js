import { describe, it, expect, vi } from 'vitest';
import { runAiPipeline } from '../src/mdh/aiPipelineLoop.js';
import { FIX_ANGLES } from '../src/mdh/llmPipeline.js';

const reply = (s) => ({ messages: [{ role: 'user', content: 'q' }, { role: 'system', content: s }] });
const gen = (pipeline) => reply(JSON.stringify(pipeline));
const verify = (obj) => reply(JSON.stringify(obj));

function fakeApi({ llm = [], agg = [], find = { result: [] } } = {}) {
  const llmQ = [...llm]; const aggQ = [...agg];
  return {
    llmChat: vi.fn(async () => { if (!llmQ.length) throw new Error('llm underflow'); return llmQ.shift(); }),
    aggregate: vi.fn(async () => { const n = aggQ.shift(); if (n instanceof Error) throw n; return n; }),
    find: vi.fn(async () => find),
  };
}
const base = { request: 'top vendors', fields: ['a'], collection: 'C', currentPipeline: '[]' };
const pass = (i = 1) => verify({ candidates: [{ index: i, answersRequest: true, score: 90, issue: '' }], best: i, reasoning: 'ok' });

describe('runAiPipeline (escalation-gated)', () => {
  it('happy path = 1 generate + 1 verify; applies the capped candidate', async () => {
    const api = fakeApi({ llm: [gen([{ $match: { a: 1 } }]), pass()], agg: [{ result: [{ a: 1 }] }] });
    const { pipelineText, trace } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $match: { a: 1 } }, { $limit: 50 }]);
    expect(api.llmChat).toHaveBeenCalledTimes(2); // generate + verify
    expect(api.aggregate).toHaveBeenCalledTimes(1);
    expect(trace.status).toBe('ok');
    expect(trace.summary).toContain('AI-checked');
    expect(trace.summary).not.toContain('Best of');
    expect(trace.calls.map((c) => c.kind)).toEqual(['generate', 'verify']);
    expect(trace.calls[0].status).toBe('ok');
    expect(trace.calls[1].status).toBe('passed');
    expect(trace.calls[0].group).not.toBe(trace.calls[1].group); // sequential, distinct groups
  });

  it('verifier flags an ok-but-wrong candidate → one correction (minimal) → improved applied', async () => {
    const api = fakeApi({
      llm: [gen([{ $match: { wrong: 1 } }]),
        verify({ candidates: [{ index: 1, answersRequest: false, score: 20, issue: 'wrong field' }], best: 1, reasoning: '' }),
        gen([{ $match: { good: true } }]),
        verify({ candidates: [{ index: 1, answersRequest: false, score: 20, issue: '' }, { index: 2, answersRequest: true, score: 95, issue: '' }], best: 2, reasoning: '' })],
      agg: [{ result: [{ wrong: 1 }] }, { result: [{ good: 1 }] }],
    });
    const { pipelineText, trace } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $match: { good: true } }, { $limit: 50 }]);
    expect(trace.corrected).toBe(true);
    expect(api.llmChat).toHaveBeenCalledTimes(4); // gen + verify + fix + re-verify
    expect(trace.calls.map((c) => c.kind)).toEqual(['generate', 'verify', 'fix', 'verify']);
    expect(trace.calls[2].angle).toBe('minimal'); // first correction angle
    // the fix prompt carried the full failure history + reviewer issue
    const fixPrompt = api.llmChat.mock.calls[2][0][0].content;
    expect(fixPrompt).toContain('do not repeat them');
    expect(fixPrompt).toContain('wrong field');
    expect(fixPrompt).toContain(FIX_ANGLES.minimal);
  });

  it('error skips verify and escalates straight to a correction', async () => {
    const err = Object.assign(new Error("Unrecognized stage '$srt'"), { status: 400 });
    const api = fakeApi({
      llm: [gen([{ $srt: {} }]), gen([{ $match: { a: 2 } }]), pass(2)],
      agg: [err, { result: [{ a: 2 }] }],
    });
    const { pipelineText, trace } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $match: { a: 2 } }, { $limit: 50 }]);
    expect(trace.status).toBe('ok');
    // round 1 errored → NO verify node for it; then fix + verify
    expect(trace.calls.map((c) => c.kind)).toEqual(['generate', 'fix', 'verify']);
    expect(trace.calls[0].status).toBe('error');
  });

  it('empty result escalates with sample docs fed into the fix prompt', async () => {
    const api = fakeApi({
      llm: [gen([{ $match: { x: 9 } }]), gen([{ $match: { x: 1 } }]), pass(2)],
      agg: [{ result: [] }, { result: [{ x: 1 }] }],
      find: { result: [{ x: 1 }] },
    });
    const { trace } = await runAiPipeline({ api, ...base, samples: [{ x: 1 }] });
    expect(trace.calls.map((c) => c.kind)).toEqual(['generate', 'fix', 'verify']);
    expect(trace.calls[0].status).toBe('empty');
  });

  it('progressive angles minimal→rethink; caps at MAX_ROUNDS (≤2 corrections); worst case 6 calls', async () => {
    const flag = verify({ candidates: [{ index: 1, answersRequest: false, score: 10, issue: 'no' }, { index: 2, answersRequest: false, score: 10, issue: 'no' }], best: 1, reasoning: '' });
    const api = fakeApi({
      llm: [gen([{ $match: { n: 1 } }]),
        verify({ candidates: [{ index: 1, answersRequest: false, score: 10, issue: 'no' }], best: 1, reasoning: '' }),
        gen([{ $match: { n: 2 } }]), flag, gen([{ $match: { n: 3 } }]), flag],
      agg: [{ result: [{ n: 1 }] }, { result: [{ n: 2 }] }, { result: [{ n: 3 }] }],
    });
    const { trace } = await runAiPipeline({ api, ...base });
    expect(api.llmChat).toHaveBeenCalledTimes(6); // gen+verify + fix+verify + fix+verify
    expect(api.llmChat.mock.calls[2][0][0].content).toContain(FIX_ANGLES.minimal);
    expect(api.llmChat.mock.calls[4][0][0].content).toContain(FIX_ANGLES.rethink);
    expect(trace.calls.filter((c) => c.kind === 'fix').map((c) => c.angle)).toEqual(['minimal', 'rethink']);
  });

  it('stops early when a fix merely repeats an already-tried pipeline', async () => {
    const p = [{ $match: { x: 1 } }];
    const api = fakeApi({
      llm: [gen(p),
        verify({ candidates: [{ index: 1, answersRequest: false, score: 10, issue: 'no' }], best: 1, reasoning: '' }),
        gen(p)], // fix repeats round-1 → no progress → stop
      agg: [{ result: [{ x: 1 }] }],
    });
    await runAiPipeline({ api, ...base });
    expect(api.llmChat).toHaveBeenCalledTimes(3); // gen + verify + 1 stale fix → stop
  });

  it('verify parse-fail → ONE compact retry (different prompt) then succeeds', async () => {
    const api = fakeApi({
      llm: [gen([{ $match: { a: 1 } }]), reply('not json'), pass()],
      agg: [{ result: [{ a: 1 }] }],
    });
    const { trace } = await runAiPipeline({ api, ...base });
    expect(api.llmChat).toHaveBeenCalledTimes(3); // gen + verify(fail) + verify(compact retry)
    // the retry used the compact prompt variant
    expect(api.llmChat.mock.calls[2][0][0].content).toContain('compact JSON');
    expect(trace.status).toBe('ok');
  });

  it('verify unparseable even after retry → mechanical fallback (never worse)', async () => {
    const api = fakeApi({
      llm: [gen([{ $match: { a: 1 } }]), reply('nope'), reply('still nope')],
      agg: [{ result: [{ a: 1 }] }],
    });
    const { pipelineText, trace } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $match: { a: 1 } }, { $limit: 50 }]);
    expect(trace.summary).not.toContain('AI-checked'); // fallback → not marked checked
    expect(trace.calls[1].status).toBe('parse-fail');
  });

  it('no collection → single generate, applied capped, no execute/verify', async () => {
    const api = fakeApi({ llm: [gen([{ $limit: 5 }])] });
    const { pipelineText, trace } = await runAiPipeline({ api, ...base, collection: null });
    expect(JSON.parse(pipelineText)).toEqual([{ $limit: 5 }]);
    expect(api.aggregate).not.toHaveBeenCalled();
    expect(api.llmChat).toHaveBeenCalledTimes(1);
    expect(trace.calls.map((c) => c.kind)).toEqual(['generate']);
  });

  it('non-array output → applied as-is, not executed', async () => {
    const api = fakeApi({ llm: [reply('cannot do that')] });
    const { pipelineText } = await runAiPipeline({ api, ...base });
    expect(pipelineText).toBe('cannot do that');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('enforces the 50-row cap when the candidate omits $limit', async () => {
    const api = fakeApi({ llm: [gen([{ $match: { a: 1 } }]), pass()], agg: [{ result: [{ a: 1 }] }] });
    await runAiPipeline({ api, ...base });
    expect(api.aggregate.mock.calls[0][1]).toEqual([{ $match: { a: 1 } }, { $limit: 50 }]);
  });

  it('propagates AbortError', async () => {
    const api = { llmChat: vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }), aggregate: vi.fn(), find: vi.fn() };
    await expect(runAiPipeline({ api, ...base })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rethrows a 403 so the caller can hide the feature', async () => {
    const api = { llmChat: vi.fn(async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); }), aggregate: vi.fn(), find: vi.fn() };
    await expect(runAiPipeline({ api, ...base })).rejects.toMatchObject({ status: 403 });
  });

  it('emits human-readable phase labels for the new flow', async () => {
    const api = fakeApi({ llm: [gen([{ $limit: 5 }]), pass()], agg: [{ result: [{ a: 1 }] }] });
    const phases = [];
    await runAiPipeline({ api, ...base, onPhase: (p) => phases.push(p) });
    expect(phases).toContain('Generating the query');
    expect(phases).toContain('Checking the result');
    expect(phases).not.toContain('generating'); // no internal keys leak
  });

  it('correction labels carry the round number ("Refining (1 of 2)")', async () => {
    const api = fakeApi({
      llm: [gen([{ $match: { n: 1 } }]),
        verify({ candidates: [{ index: 1, answersRequest: false, score: 10, issue: 'no' }], best: 1, reasoning: '' }),
        gen([{ $match: { n: 2 } }]), pass(2)],
      agg: [{ result: [{ n: 1 }] }, { result: [{ n: 2 }] }],
    });
    const phases = [];
    await runAiPipeline({ api, ...base, onPhase: (p) => phases.push(p) });
    expect(phases).toContain('Refining (1 of 2)');
  });

  it('records a failed fix node when a correction generation errors (non-fatal)', async () => {
    const api = {
      llmChat: vi.fn()
        .mockResolvedValueOnce(gen([{ $match: { a: 1 } }]))
        .mockResolvedValueOnce(verify({ candidates: [{ index: 1, answersRequest: false, score: 10, issue: 'no' }], best: 1, reasoning: '' }))
        .mockRejectedValueOnce(new Error('boom')),
      aggregate: vi.fn().mockResolvedValue({ result: [{ a: 1 }] }),
      find: vi.fn(async () => ({ result: [] })),
    };
    const { trace } = await runAiPipeline({ api, ...base });
    const fixNode = trace.calls.find((c) => c.kind === 'fix');
    expect(fixNode).toBeTruthy();
    expect(fixNode.status).toBe('failed');
    expect(api.llmChat).toHaveBeenCalledTimes(3); // generate + verify(flag) + failed fix → stop
  });
});
