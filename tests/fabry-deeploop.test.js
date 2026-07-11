import { describe, it, expect, vi } from 'vitest';
import { parseVerdict, buildCriticPrompt, buildReviewerMessage, runDeepTurn } from '../src/fabry/deepLoop.js';

describe('parseVerdict', () => {
  it('reads first-line PASS/FAIL and collects issue bullets', () => {
    expect(parseVerdict('VERDICT: PASS\nAll claims check out.')).toEqual({ verdict: 'pass', issues: [] });
    const v = parseVerdict('VERDICT: FAIL\n- count is wrong\n* threshold misread\nprose');
    expect(v.verdict).toBe('fail');
    expect(v.issues).toEqual(['count is wrong', 'threshold misread']);
  });
  it('finds a buried or lowercase verdict line', () => {
    expect(parseVerdict('Let me check.\nverdict: pass').verdict).toBe('pass');
  });
  it('FAIL with no bullets → inconclusive (no empty refine rounds)', () => {
    expect(parseVerdict('VERDICT: FAIL\nsomething is off but no list')).toEqual({ verdict: 'inconclusive', issues: [] });
  });
  it('missing verdict → inconclusive', () => {
    expect(parseVerdict('I looked around and things seem fine.').verdict).toBe('inconclusive');
    expect(parseVerdict('').verdict).toBe('inconclusive');
  });
});

describe('buildCriticPrompt / buildReviewerMessage', () => {
  it('critic prompt carries question, answer, tool instruction, verdict contract', () => {
    const p = buildCriticPrompt('How many queues?', 'There is 1 queue.');
    expect(p).toContain('How many queues?');
    expect(p).toContain('There is 1 queue.');
    expect(p).toMatch(/VERDICT: PASS/);
    expect(p).toMatch(/VERDICT: FAIL/);
    expect(p).toMatch(/tools/i);
    expect(p).toMatch(/read-only/i);
  });
  it('reviewer message starts with the marker and lists issues', () => {
    const m = buildReviewerMessage(['a', 'b']);
    expect(m.startsWith('[deep-verify reviewer]')).toBe(true);
    expect(m).toContain('- a');
    expect(m).toContain('- b');
  });
});

describe('runDeepTurn', () => {
  const phases = () => { const seen = []; return { seen, onPhase: (p) => seen.push(`${p.phase}:${p.round}`) }; };

  it('pass on first verify: one critic call, no refine', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue({ text: 'answer v1' });
    const runCriticTurn = vi.fn().mockResolvedValue('VERDICT: PASS');
    const { seen, onPhase } = phases();
    const out = await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase });
    expect(out).toEqual({ verdict: 'pass', issues: [], criticText: 'VERDICT: PASS', rounds: 0 });
    expect(sendMainTurn).toHaveBeenCalledTimes(1);
    expect(runCriticTurn).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['verify:0']);
  });

  it('fail → refine → pass: reviewer message goes to the main chat', async () => {
    const sendMainTurn = vi.fn()
      .mockResolvedValueOnce({ text: 'answer v1' })
      .mockResolvedValueOnce({ text: 'answer v2' });
    const runCriticTurn = vi.fn()
      .mockResolvedValueOnce('VERDICT: FAIL\n- wrong count')
      .mockResolvedValueOnce('VERDICT: PASS');
    const { seen, onPhase } = phases();
    const out = await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase });
    expect(out.verdict).toBe('pass');
    expect(out.rounds).toBe(1);
    expect(sendMainTurn.mock.calls[1][0]).toContain('[deep-verify reviewer]');
    expect(sendMainTurn.mock.calls[1][0]).toContain('- wrong count');
    expect(runCriticTurn.mock.calls[1][0]).toContain('answer v2'); // critic sees the LATEST answer
    expect(runCriticTurn.mock.calls[1][0]).toContain('q'); // and the ORIGINAL question
    expect(seen).toEqual(['verify:0', 'refine:1', 'verify:1']);
  });

  it('persistent fail stops at the round cap with issues surfaced', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue({ text: 'answer' });
    const runCriticTurn = vi.fn().mockResolvedValue('VERDICT: FAIL\n- still wrong');
    const out = await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase: () => {} });
    expect(out.verdict).toBe('fail');
    expect(out.issues).toEqual(['still wrong']);
    expect(out.rounds).toBe(2);
    expect(runCriticTurn).toHaveBeenCalledTimes(3); // initial + after each of 2 refines
    expect(sendMainTurn).toHaveBeenCalledTimes(3); // question + 2 reviewer messages
  });

  it('critic throw → inconclusive, answer kept, no refine', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue({ text: 'answer' });
    const runCriticTurn = vi.fn().mockRejectedValue(Object.assign(new Error('429'), { status: 429 }));
    const out = await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase: () => {} });
    expect(out.verdict).toBe('inconclusive');
    expect(sendMainTurn).toHaveBeenCalledTimes(1);
  });

  it('aborted main turn (null) → returns null immediately', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue(null);
    const runCriticTurn = vi.fn();
    expect(await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase: () => {} })).toBeNull();
    expect(runCriticTurn).not.toHaveBeenCalled();
  });

  it('aborted critic (null) → returns null', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue({ text: 'a' });
    const runCriticTurn = vi.fn().mockResolvedValue(null);
    expect(await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase: () => {} })).toBeNull();
  });
});
