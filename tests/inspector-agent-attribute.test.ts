import { describe, it, expect, vi } from 'vitest';
import { buildAttributionPrompt, buildAttributionPrompt as _bap, parseAttribution, runAttribution, parseFieldBatch, buildFieldBatchPrompt, runFieldBatchAttribution } from '../src/inspector/agentAttribute.js';

describe('buildAttributionPrompt', () => {
  const base = {
    annotation: { id: 42, status: 'rejected' },
    candidates: [{ id: 7, name: 'Rejector', type: 'function', events: ['annotation_content.confirm'], code: 'if (x) annotation.reject()', settings: { a: 1 } }],
    logs: [{ hook: 7, action: 'annotation_content.confirm', log_level: 'ERROR', request_id: 'r1' }],
    fields: { total: '10' },
  };
  it('label prompt is read-only, names the label + candidate, instructs tool use, and does NOT seed code, demanding JSON-only', () => {
    const p = buildAttributionPrompt({ kind: 'label', target: { id: 3, name: 'Urgent' }, ...base });
    expect(p).toMatch(/READ-ONLY/);
    expect(p).toMatch(/label "Urgent"/);
    expect(p).toMatch(/hook #7 "Rejector"/);                    // compact candidate (id/name/type/events)
    expect(p).toMatch(/read-only tools to fetch/i);             // agent fetches code/logs itself
    expect(p).not.toMatch(/if \(x\) annotation\.reject\(\)/);   // code is NOT seeded into the prompt
    expect(p).toMatch(/ONLY this JSON object/);
  });
  it('reject prompt states the reject question + reason', () => {
    const p = buildAttributionPrompt({ kind: 'reject', target: { rejectedAt: '2026-01-01', reason: 'bad total' }, ...base });
    expect(p).toMatch(/which extension rejected/i);
    expect(p).toMatch(/bad total/);
  });
  it('includes the queue id so the agent can search that queue with its tools', () => {
    const p = buildAttributionPrompt({ kind: 'reject', target: {}, annotation: { id: 42, status: 'rejected', queueId: '3927215' }, candidates: [] });
    expect(p).toMatch(/queue 3927215/);
    expect(p).toMatch(/opaque/); // the read-only tool instruction still frames unreadable webhooks as opaque
  });
  it('caps the prompt under the agent 50k-char limit even with a huge candidate list, keeping the JSON instruction', () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `Extension number ${i} with a fairly long descriptive name`, type: 'function', events: ['annotation_content.updated'] }));
    const p = buildAttributionPrompt({ kind: 'label', target: { id: 1, name: 'L' }, annotation: { id: 1, status: 'x' }, candidates: many });
    expect(p.length).toBeLessThanOrEqual(48000);
    expect(p).toMatch(/ONLY this JSON object/);              // tail (JSON instruction) preserved
    expect(p).toMatch(/omitted to stay within the length limit/); // truncation noted, not silent
    const pf = buildFieldBatchPrompt(Array.from({ length: 6 }, (_, i) => ({ schemaId: `f${i}`, value: 'v' })), { annotation: { id: 1, status: 'x' }, candidates: many });
    expect(pf.length).toBeLessThanOrEqual(48000);
    expect(pf).toMatch(/"fields":\[/);
  });
});

describe('parseAttribution', () => {
  it('parses a valid verdict', () => {
    expect(parseAttribution('{"culprit":{"kind":"hook","id":7,"name":"Rejector"},"confidence":"high","explanation":"it calls reject()"}'))
      .toEqual({ culprit: { kind: 'hook', id: 7, name: 'Rejector' }, confidence: 'high', explanation: 'it calls reject()' });
  });
  it('maps unknown culprit to null and clamps bad confidence to low', () => {
    expect(parseAttribution('prose {"culprit":{"kind":"unknown"},"confidence":"???","explanation":"n/a"} tail'))
      .toEqual({ culprit: null, confidence: 'low', explanation: 'n/a' });
  });
  it('returns null when there is no JSON object', () => {
    expect(parseAttribution('I could not determine this.')).toBeNull();
  });
  it('extracts the first complete object even when prose with a stray brace follows', () => {
    const reply = '{"culprit":{"kind":"hook","id":7,"name":"R"},"confidence":"high","explanation":"e"}\n\nNote: see {the docs}.';
    expect(parseAttribution(reply)).toEqual({ culprit: { kind: 'hook', id: 7, name: 'R' }, confidence: 'high', explanation: 'e' });
  });
});

function mockAgentApi(reply: any) {
  return {
    createChat: vi.fn(async () => 'chat_i'),
    streamMessage: vi.fn(async (_id, content, { onEvent }) => {
      if (content === '/persona cautious') return;
      onEvent({ type: 'text-delta', delta: reply });
      onEvent({ type: 'finish' });
    }),
  };
}

describe('runAttribution', () => {
  const ctx = { annotation: { id: 1, status: 'rejected' }, target: { rejectedAt: 't' }, candidates: [] };
  it('primes the cautious persona then returns the parsed verdict', async () => {
    const agentApi = mockAgentApi('{"culprit":{"kind":"hook","id":7,"name":"Rejector"},"confidence":"high","explanation":"x"}');
    const { verdict } = await runAttribution({ agentApi, kind: 'reject', context: ctx });
    expect(agentApi.streamMessage).toHaveBeenCalledWith('chat_i', '/persona cautious', expect.anything());
    expect(verdict.culprit).toEqual({ kind: 'hook', id: 7, name: 'Rejector' });
    expect(verdict.confidence).toBe('high');
  });
  it('falls back to a null-culprit verdict (raw reply) when unparseable', async () => {
    const agentApi = mockAgentApi('I cannot tell.');
    const { verdict } = await runAttribution({ agentApi, kind: 'reject', context: ctx });
    expect(verdict.culprit).toBeNull();
    expect(verdict.explanation).toBe('I cannot tell.');
  });
  it('reports live progress via onPhase as the agent reasons and calls tools (deduped on change)', async () => {
    const agentApi = {
      createChat: vi.fn(async () => 'chat_i'),
      streamMessage: vi.fn(async (_id, content, { onEvent }) => {
        if (content === '/persona cautious') return;
        onEvent({ type: 'reasoning-start' });            // → 'thinking' (same as initial → no dup)
        onEvent({ type: 'reasoning-delta', delta: 'h' }); // no status change → no phase
        onEvent({ type: 'tool-input-start', toolName: 'rossum_list_hook_logs' });
        onEvent({ type: 'tool-input-start', toolName: 'rossum_get_hook' });
        onEvent({ type: 'text-delta', delta: '{"culprit":{"kind":"hook","id":7,"name":"R"},"confidence":"high","explanation":"e"}' });
        onEvent({ type: 'finish' });
      }),
    };
    const phases: any = [];
    await runAttribution({ agentApi, kind: 'reject', context: ctx, onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(['thinking', 'reading extension logs', 'reading extension code']);
  });
});

describe('buildAttributionPrompt new kinds', () => {
  it('frames a message question read-only + JSON-only', () => {
    const p = _bap({ kind: 'message', annotation: { id: 1, status: 'to_review' }, target: { level: 'error', content: 'Total mismatch', schemaId: 'amount_due' }, candidates: [] });
    expect(p).toMatch(/READ-ONLY/);
    expect(p).toMatch(/message/i);
    expect(p).toMatch(/Total mismatch/);
    expect(p).toMatch(/ONLY this JSON object/);
  });
  it('frames a blocker explanation and an export question', () => {
    expect(_bap({ kind: 'blocker', target: { type: 'custom_x', schemaId: 'iban' }, candidates: [] })).toMatch(/custom_x/);
    expect(_bap({ kind: 'export', target: { error: 'HTTP 500' }, candidates: [] })).toMatch(/HTTP 500/);
  });
});

describe('parseFieldBatch', () => {
  it('parses a fields array; unknown culprit → null; bad confidence → low', () => {
    const out = parseFieldBatch('{"fields":[{"schema_id":"terms","culprit":{"kind":"rule","id":7,"name":"R"},"confidence":"high","explanation":"e"},{"schema_id":"iban","culprit":{"kind":"unknown"},"confidence":"bogus","explanation":"x"}]}');
    expect(out.fields[0]).toEqual({ schema_id: 'terms', culprit: { kind: 'rule', id: 7, name: 'R' }, confidence: 'high', explanation: 'e' });
    expect(out.fields[1]).toEqual({ schema_id: 'iban', culprit: null, confidence: 'low', explanation: 'x' });
  });
  it('returns {fields:[]} on unparseable', () => {
    expect(parseFieldBatch('nope')).toEqual({ fields: [] });
  });
});

describe('runFieldBatchAttribution', () => {
  it('returns a verdict per field from the agent reply', async () => {
    const agentApi = {
      createChat: vi.fn(async () => 'c1'),
      streamMessage: vi.fn(async (_id, content, { onEvent }) => {
        if (content === '/persona cautious') return;
        onEvent({ type: 'text-delta', delta: '{"fields":[{"schema_id":"terms","culprit":{"kind":"rule","id":7,"name":"R"},"confidence":"medium","explanation":"e"}]}' });
        onEvent({ type: 'finish' });
      }),
    };
    const { verdicts } = await runFieldBatchAttribution({ agentApi, items: [{ key: 'field:terms', schemaId: 'terms', value: '2/10' }], context: { annotation: {}, candidates: [], fields: {} } });
    expect(agentApi.streamMessage).toHaveBeenCalledWith('c1', '/persona cautious', expect.anything()); // read-only priming
    expect(verdicts).toEqual([{ schema_id: 'terms', culprit: { kind: 'rule', id: 7, name: 'R' }, confidence: 'medium', explanation: 'e' }]);
  });
});
