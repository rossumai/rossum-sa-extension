import { describe, it, expect, vi } from 'vitest';
import { buildSynthesisPrompt, buildFollowupPrompt, parseCitations, parseNarrative, runSynthesis, continueSynthesis } from '../src/inspector/synthesize.js';

const EV = {
  verdict: { state: 'blocked', headline: 'Not automated — 1 blocking error', reasons: [{ fact: 'f', evidenceId: 'blocker:0' }] },
  items: [
    { id: 'blocker:0', section: 'blockers', fact: 'automation blocker error_message', reliability: 'verified', culprit: { kind: 'rule', id: 7, name: 'PO required' } },
    { id: 'gap:hookLogs', section: 'blockers', fact: 'hook logs unavailable', reliability: 'unavailable', culprit: null },
  ],
};

describe('buildSynthesisPrompt', () => {
  it('contains verdict, evidence lines with ids, citation + read-only instructions', () => {
    const p = buildSynthesisPrompt(EV, { id: 1, status: 'to_review', queueId: '5' });
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('[blocker:0] (verified)');
    expect(p).toContain('[e:<id>]');
    expect(p).toContain('Not automated');
    expect(p.length).toBeLessThan(48001);
  });
});

describe('parseCitations', () => {
  it('splits text and cite segments', () => {
    const seg = parseCitations('Blocked by a rule [e:blocker:0] and logs are gone [e:gap:hookLogs].');
    expect(seg.filter((s) => s.type === 'cite').map((s) => s.id)).toEqual(['blocker:0', 'gap:hookLogs']);
    expect(seg[0]).toEqual({ type: 'text', text: 'Blocked by a rule ' });
    expect(seg[seg.length - 1].text).toContain('.');
  });
  it('no markers → single text segment; empty → []', () => {
    expect(parseCitations('plain')).toEqual([{ type: 'text', text: 'plain' }]);
    expect(parseCitations('')).toEqual([]);
  });
});

describe('buildSynthesisPrompt — bullet format', () => {
  it('instructs a takeaway line, "- " bullets, and a Next step line', () => {
    const p = buildSynthesisPrompt(EV, { id: 1, status: 'to_review', queueId: '5' });
    expect(p).toMatch(/takeaway/i);
    expect(p).toContain('"- "');
    expect(p).toContain('Next step:');
  });
});

describe('parseNarrative', () => {
  it('splits lines into paragraph and bullet blocks with citation segments', () => {
    const blocks = parseNarrative('Blocked by one rule.\n- Rule fired [e:blocker:0]\n- Logs gone [e:gap:hookLogs]\nNext step: fill the PO.');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'li', 'li', 'p']);
    expect(blocks[1].segments.some((s) => s.type === 'cite' && s.id === 'blocker:0')).toBe(true);
    expect(blocks[3].segments[0].text).toContain('Next step');
  });
  it('tolerates blank lines, • bullets, and a partial streaming line', () => {
    const blocks = parseNarrative('Take away\n\n• first bullet\n- second bul');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'li', 'li']);
    expect(blocks[2].segments[0].text).toBe('second bul');
  });
  it('empty/non-string → []', () => {
    expect(parseNarrative('')).toEqual([]);
    expect(parseNarrative(null)).toEqual([]);
  });
});

describe('runSynthesis', () => {
  it('primes persona, streams text via onText, returns transcript', async () => {
    const prompts = [];
    const agentApi = {
      createChat: vi.fn(async () => 'chat1'),
      streamMessage: vi.fn(async (_id, content, { onEvent }) => {
        prompts.push(content);
        if (content === '/persona cautious') return;
        onEvent({ type: 'reasoning-start' });
        onEvent({ type: 'reasoning-delta', delta: 'thinking about it' });
        onEvent({ type: 'text-delta', delta: 'Blocked [e:blocker:0]' });
        onEvent({ type: 'finish' });
      }),
    };
    const texts = [];
    const phases = [];
    const res = await runSynthesis({ agentApi, evidence: EV, annotation: { id: 1, status: 'to_review', queueId: '5' }, onPhase: (p) => phases.push(p), onText: (t) => texts.push(t) });
    expect(prompts[0]).toBe('/persona cautious');
    expect(res.text).toBe('Blocked [e:blocker:0]');
    expect(res.reasoning).toContain('thinking');
    expect(texts[texts.length - 1]).toBe('Blocked [e:blocker:0]');
    expect(phases[0]).toBe('thinking');
  });
});

describe('continueSynthesis', () => {
  it('runSynthesis returns the chatId; continueSynthesis reuses it without re-priming', async () => {
    const prompts = [];
    const agentApi = {
      createChat: vi.fn(async () => 'chat9'),
      streamMessage: vi.fn(async (id, content, { onEvent }) => {
        prompts.push([id, content]);
        if (content === '/persona cautious') return;
        onEvent({ type: 'text-delta', delta: 'answer [e:blocker:0]' });
        onEvent({ type: 'finish' });
      }),
    };
    const run = await runSynthesis({ agentApi, evidence: EV, annotation: { id: 1, status: 'to_review' }, onPhase: () => {}, onText: () => {} });
    expect(run.chatId).toBe('chat9');
    const texts = [];
    const res = await continueSynthesis({ agentApi, chatId: run.chatId, question: 'why is po_number empty?', onText: (t) => texts.push(t) });
    expect(agentApi.createChat).toHaveBeenCalledTimes(1); // no new chat
    const followup = prompts[prompts.length - 1];
    expect(followup[0]).toBe('chat9');
    expect(followup[1]).toContain('why is po_number empty?');
    expect(followup[1]).toContain('READ-ONLY');
    expect(followup[1]).not.toContain('/persona'); // no re-prime
    expect(res.text).toContain('answer');
    expect(texts[texts.length - 1]).toContain('answer');
  });
  it('buildFollowupPrompt keeps the citation + honesty instructions', () => {
    const p = buildFollowupPrompt('q?');
    expect(p).toContain('[e:<id>]');
    expect(p).toMatch(/not recorded/i);
  });
});
