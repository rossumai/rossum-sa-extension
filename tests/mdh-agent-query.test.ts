import { describe, it, expect, vi } from 'vitest';
import {
  runAgentQuery,
  continueAgentQuery,
  buildGenPrompt,
  buildFixPrompt,
  capRows,
  MAX_CORRECTIONS,
  MAX_ROWS,
} from '../src/mdh/agent/agentQuery.js';

// Mock agent transport: `/persona cautious` primes (no output); every other turn
// pops the next scripted final-answer text and streams it as a text-delta.
function makeAgentApi(replies: any) {
  const q = [...replies];
  return {
    createChat: vi.fn(async () => 'chat_x'),
    streamMessage: vi.fn(async (_id, content, { onEvent }) => {
      if (content === '/persona cautious') return;
      if (/answersRequest/.test(content)) {
        // semantic-verify turn → auto-pass
        onEvent({ type: 'text-delta', delta: '{"answersRequest":true,"score":100}' });
        onEvent({ type: 'finish' });
        return;
      }
      onEvent({ type: 'text-delta', delta: q.shift() ?? '' });
      onEvent({ type: 'finish' });
    }),
  };
}
// Mock Data Storage client: each aggregate() pops the next scripted result
// ({ result: [...] }) or throws a scripted Error.
function makeApi(results: any) {
  const q = [...results];
  return {
    aggregate: vi.fn(async () => {
      const r = q.shift();
      if (r instanceof Error) throw r;
      return r;
    }),
  };
}

describe('runAgentQuery', () => {
  it('verifies a good pipeline (rows > 0), row-caps it, and primes the cautious persona', async () => {
    const agentApi = makeAgentApi(['```json\n[{"$match":{"a":1}}]\n```']);
    const api = makeApi([{ result: [{ a: 1 }, { a: 1 }] }]);
    const { pipelineText, note, transcript } = await runAgentQuery({
      api,
      agentApi,
      request: 'x',
      collection: 'c',
      fields: ['a'],
    });
    expect(JSON.parse(pipelineText!)).toEqual([{ $match: { a: 1 } }, { $limit: MAX_ROWS }]); // capped
    expect(note).toEqual({ kind: 'verified', rowCount: 2 });
    expect(agentApi.streamMessage).toHaveBeenCalledWith(
      'chat_x',
      '/persona cautious',
      expect.anything(),
    );
    // the executed (verified) pipeline is the capped one
    expect(api.aggregate).toHaveBeenCalledWith(
      'c',
      [{ $match: { a: 1 } }, { $limit: MAX_ROWS }],
      expect.anything(),
    );
    // transcript captures request → agent reply → run verdict → semantic review
    expect(transcript[0]).toMatchObject({ role: 'user', text: 'x' });
    expect(transcript.some((t) => t.role === 'system' && /2 rows/.test(t.text))).toBe(true);
    expect(transcript.some((t) => t.role === 'system' && /answers the request/.test(t.text))).toBe(
      true,
    );
  });

  it('refines when the semantic review says the result does not answer the request', async () => {
    const gens = ['[{"$match":{"a":1}}]', '[{"$match":{"a":2}}]'];
    let verifyCall = 0;
    const agentApi = {
      createChat: vi.fn(async () => 'c'),
      streamMessage: vi.fn(async (_id, content, { onEvent }) => {
        if (content === '/persona cautious') return;
        if (/answersRequest/.test(content)) {
          const verdict =
            verifyCall++ === 0
              ? '{"answersRequest":false,"score":10,"issue":"wrong field"}'
              : '{"answersRequest":true,"score":90}';
          onEvent({ type: 'text-delta', delta: verdict });
          onEvent({ type: 'finish' });
          return;
        }
        onEvent({ type: 'text-delta', delta: gens.shift() ?? '' });
        onEvent({ type: 'finish' });
      }),
    };
    const api = makeApi([{ result: [{ a: 1 }] }, { result: [{ a: 2 }] }]);
    const { pipelineText, note, transcript } = await runAgentQuery({
      api,
      agentApi,
      request: 'x',
      collection: 'c',
    });
    expect(note.kind).toBe('refined');
    expect(JSON.parse(pipelineText!)).toEqual([{ $match: { a: 2 } }, { $limit: MAX_ROWS }]);
    expect(
      transcript.some((t) => t.role === 'system' && /needs refinement.*wrong field/.test(t.text)),
    ).toBe(true);
  });

  it('refines on an empty result, then verifies', async () => {
    const agentApi = makeAgentApi(['[{"$match":{"s":"open"}}]', '[{"$match":{"s":"Open"}}]']);
    const api = makeApi([{ result: [] }, { result: [{ s: 'Open' }] }]);
    const { pipelineText, note } = await runAgentQuery({
      api,
      agentApi,
      request: 'x',
      collection: 'c',
    });
    expect(JSON.parse(pipelineText!)).toEqual([{ $match: { s: 'Open' } }, { $limit: MAX_ROWS }]);
    expect(note).toEqual({ kind: 'refined', rowCount: 1 });
  });

  it('refines on an execution error, then verifies', async () => {
    const agentApi = makeAgentApi(['[{"$bad":1}]', '[{"$match":{}}]']);
    const api = makeApi([new Error('unknown stage $bad'), { result: [{}] }]);
    expect((await runAgentQuery({ api, agentApi, request: 'x', collection: 'c' })).note.kind).toBe(
      'refined',
    );
  });

  it('returns no-pipeline (and never executes) when the agent replies prose', async () => {
    const agentApi = makeAgentApi(['I can only help with Rossum data queries.']);
    const api = makeApi([]);
    const { pipelineText, note } = await runAgentQuery({
      api,
      agentApi,
      request: 'x',
      collection: 'c',
    });
    expect(pipelineText).toBeNull();
    expect(note).toEqual({ kind: 'no-pipeline' });
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('returns declined (never executes) when the agent outputs an empty array', async () => {
    const agentApi = makeAgentApi(['[]']);
    const api = makeApi([]);
    const { pipelineText, note } = await runAgentQuery({
      api,
      agentApi,
      request: 'delete everything',
      collection: 'c',
    });
    expect(pipelineText).toBeNull();
    expect(note).toEqual({ kind: 'declined' });
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('BLOCKS a write pipeline ($out/$merge): never executed, never applied', async () => {
    const agentApi = makeAgentApi(['[{"$match":{}},{"$out":"stolen"}]']);
    const api = makeApi([]);
    const { pipelineText, note } = await runAgentQuery({
      api,
      agentApi,
      request: 'copy the collection',
      collection: 'c',
    });
    expect(pipelineText).toBeNull();
    expect(note).toEqual({ kind: 'blocked' });
    expect(api.aggregate).not.toHaveBeenCalled(); // the read client is NEVER handed a write pipeline
  });

  it('captures the agent reasoning AND full reply in the transcript', async () => {
    const agentApi = {
      createChat: vi.fn(async () => 'c'),
      streamMessage: vi.fn(async (_id, content, { onEvent }) => {
        if (content === '/persona cautious') return;
        onEvent({ type: 'reasoning-delta', delta: 'The user wants open invoices.' });
        onEvent({ type: 'text-delta', delta: '```json\n[{"$match":{"status":"open"}}]\n```' });
        onEvent({ type: 'finish' });
      }),
    };
    const api = makeApi([{ result: [{}] }]);
    const { transcript } = await runAgentQuery({
      api,
      agentApi,
      request: 'open invoices',
      collection: 'c',
    });
    const assistant = transcript.find((t) => t.role === 'assistant')!;
    expect(assistant.reasoning).toBe('The user wants open invoices.');
    expect(assistant.text).toContain('```json'); // FULL reply verbatim (fences kept)
  });

  it('continueAgentQuery reuses the existing chat (no createChat / no persona prime) and appends the transcript', async () => {
    const agentApi = makeAgentApi(['[{"$match":{"amount":{"$gt":10}}}]']);
    const api = makeApi([{ result: [{ amount: 20 }] }]);
    const prior = [
      { role: 'user', text: 'first request' },
      { role: 'assistant', text: '[]' },
    ];
    const { pipelineText, note, transcript, chatId } = await continueAgentQuery({
      api,
      agentApi,
      chatId: 'existing_chat',
      request: 'now only over 10',
      collection: 'c',
      currentPipeline: '[{"$match":{}}]', // Only role/text are read back in this assertion; the rest of a Turn is irrelevant here.
      transcript: prior as any,
    });
    expect(agentApi.createChat).not.toHaveBeenCalled();
    expect(agentApi.streamMessage).not.toHaveBeenCalledWith(
      'existing_chat',
      '/persona cautious',
      expect.anything(),
    );
    expect(chatId).toBe('existing_chat');
    expect(note.kind).toBe('verified');
    expect(JSON.parse(pipelineText!)).toEqual([
      { $match: { amount: { $gt: 10 } } },
      { $limit: MAX_ROWS },
    ]);
    expect(transcript.length).toBeGreaterThan(prior.length); // appended
    expect(transcript[0]).toEqual({ role: 'user', text: 'first request' }); // prior preserved
    expect(prior.length).toBe(2); // did not mutate the caller's array
  });

  it('BLOCKS a write stage anywhere in the pipeline, not just the terminal one', async () => {
    const agentApi = makeAgentApi(['[{"$merge":{"into":"victim"}},{"$match":{}}]']);
    const api = makeApi([]);
    const { pipelineText, note } = await runAgentQuery({
      api,
      agentApi,
      request: 'x',
      collection: 'c',
    });
    expect(pipelineText).toBeNull();
    expect(note.kind).toBe('blocked');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('gives up after MAX_CORRECTIONS on a persistently empty result', async () => {
    const agentApi = makeAgentApi([
      '[{"$match":{"a":1}}]',
      '[{"$match":{"a":2}}]',
      '[{"$match":{"a":3}}]',
    ]);
    const api = makeApi([{ result: [] }, { result: [] }, { result: [] }]);
    const { note } = await runAgentQuery({ api, agentApi, request: 'x', collection: 'c' });
    expect(note.kind).toBe('empty');
    expect(api.aggregate).toHaveBeenCalledTimes(MAX_CORRECTIONS + 1);
  });

  it('marks unrun when no collection is selected', async () => {
    const agentApi = makeAgentApi(['[{"$match":{}}]']);
    const api = makeApi([]);
    const { note } = await runAgentQuery({ api, agentApi, request: 'x', collection: null });
    expect(note.kind).toBe('unrun');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('emits stable onPhase keys as the loop advances (generate → run → verify, refine only on a correction)', async () => {
    // happy path: no refine key
    let phases: any = [];
    let agentApi = makeAgentApi(['[{"$match":{"a":1}}]']);
    let api = makeApi([{ result: [{ a: 1 }] }]);
    await runAgentQuery({
      api,
      agentApi,
      request: 'x',
      collection: 'c',
      onPhase: (p) => phases.push(p),
    });
    expect(phases).toEqual(['generate', 'run', 'verify']);

    // empty first result: a correction turn emits 'refine', then re-runs + re-verifies
    phases = [];
    agentApi = makeAgentApi(['[{"$match":{"s":"open"}}]', '[{"$match":{"s":"Open"}}]']);
    api = makeApi([{ result: [] }, { result: [{ s: 'Open' }] }]);
    await runAgentQuery({
      api,
      agentApi,
      request: 'x',
      collection: 'c',
      onPhase: (p) => phases.push(p),
    });
    expect(phases).toEqual(['generate', 'run', 'refine', 'run', 'verify']);
  });
});

describe('capRows', () => {
  it('appends $limit:MAX_ROWS when the pipeline has no $limit/$count', () => {
    expect(capRows([{ $match: { a: 1 } }])).toEqual([{ $match: { a: 1 } }, { $limit: MAX_ROWS }]);
  });
  it('leaves a pipeline that already limits or counts unchanged', () => {
    expect(capRows([{ $limit: 5 }])).toEqual([{ $limit: 5 }]);
    expect(capRows([{ $count: 'n' }])).toEqual([{ $count: 'n' }]);
  });
});

describe('buildGenPrompt / buildFixPrompt', () => {
  it('gen prompt carries the design rules: JSON-only, read-only, row cap, no-tools, samples, current pipeline', () => {
    const p = buildGenPrompt({
      request: 'top vendors',
      collection: 'v',
      fields: ['name'],
      samples: [{ name: 'x' }],
      currentPipeline: '[{"$match":{"a":1}}]',
    });
    expect(p).toMatch(/READ-ONLY/);
    expect(p).toMatch(/\$out, \$merge/);
    expect(p).toMatch(new RegExp(`at most ${MAX_ROWS}`));
    expect(p).toMatch(/Do NOT call any tools/);
    expect(p).toMatch(/ONLY the pipeline: a single valid JSON array/);
    expect(p).toMatch(/Available fields: name/);
    expect(p).toMatch(/Current pipeline:\n\[\{"\$match":\{"a":1\}\}\]/);
    expect(p).toMatch(/top vendors/);
  });
  it('gen prompt includes data-driven schema hints when provided', () => {
    const p = buildGenPrompt({
      request: 'x',
      collection: 'c',
      knownValues: { status: ['closed', 'open'] },
      numericStringFields: ['vendorId'],
      searchIndexes: [{ name: 'descIdx', fields: ['description'], synonyms: false }],
      ranges: { amount: { min: 1, max: 99 } },
    });
    expect(p).toMatch(/Known values.*status ∈ \{closed, open\}/);
    expect(p).toMatch(/strings of digits.*\$toInt.*vendorId/);
    expect(p).toMatch(/Atlas Search indexes available.*'descIdx'/);
    expect(p).toMatch(/Numeric ranges.*amount: 1…99/);
  });

  it('fix prompt reflects the verdict and re-states the read-only / JSON-only rules', () => {
    expect(buildFixPrompt({ verdict: { kind: 'error', error: 'boom' } })).toMatch(
      /failed with error: boom/,
    );
    expect(buildFixPrompt({ verdict: { kind: 'empty' } })).toMatch(/0 matching documents/);
    expect(buildFixPrompt({ verdict: { kind: 'mismatch', issue: 'wrong sort' } })).toMatch(
      /do not correctly answer.*wrong sort/,
    );
    expect(buildFixPrompt({ verdict: { kind: 'empty' } })).toMatch(
      /READ-ONLY.*ONLY the JSON array/s,
    );
  });
});
