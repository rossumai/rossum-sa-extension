// tests/audit-fabry.test.js
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_QUESTION, seedRows, buildAuditPrompt, buildFollowupPrompt, buildRefreshPrompt, runAuditQuery, continueAuditQuery, refreshAuditSummary } from '../src/audit/fabry.js';

const FILTERS = { object_type: 'annotation', action: 'update-status', username: 'a@b.c', object_id: '', timestamp_after: '', timestamp_before: '' };

describe('buildAuditPrompt', () => {
  it('autonomous mode: read-only framing, filter context, tool instruction, format, no citations', () => {
    const p = buildAuditPrompt({ question: DEFAULT_QUESTION, filters: FILTERS, rows: [], mode: 'autonomous' });
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('object type=annotation');
    expect(p).toContain('username=a@b.c');
    expect(p).toMatch(/read-only tools/i);
    expect(p).toMatch(/takeaway/i);
    expect(p).toContain('"- "');
    expect(p).toContain('Next step:');
    expect(p).toContain('Do NOT include');
    expect(p).toContain('[e:');
    expect(p).toContain(DEFAULT_QUESTION);
  });
  it('seeded mode: embeds the loaded rows and forbids claims beyond them', () => {
    const p = buildAuditPrompt({ question: 'q', filters: FILTERS, rows: [{ _idx: 0, action: 'create', username: 'x@y.z' }], mode: 'seeded' });
    expect(p).toContain('"action":"create"');
    expect(p).not.toContain('_idx');
    expect(p).toMatch(/ONLY on these|do not claim/i);
    expect(p).not.toMatch(/read-only tools to fetch/i);
  });
});

describe('seedRows', () => {
  it('strips _idx and caps at 40 rows', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ _idx: i, n: i }));
    const out = seedRows(rows);
    expect(out).not.toContain('_idx');
    expect(JSON.parse(out.replace(/…\(truncated\)$/, '')).length).toBe(40);
  });
  it('truncates JSON at 12000 chars and appends …(truncated)', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ _idx: i, big: 'x'.repeat(400) }));
    const out = seedRows(rows);
    const suffix = '…(truncated)';
    expect(out.endsWith(suffix)).toBe(true);
    expect(out.slice(0, -suffix.length).length).toBe(12000);
    expect(out).not.toContain('_idx');
  });
});

describe('buildFollowupPrompt', () => {
  it('keeps read-only framing + question, no citations, no persona', () => {
    const p = buildFollowupPrompt('why so many deletes?');
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('why so many deletes?');
    expect(p).toMatch(/no \[e:/i);
    expect(p).not.toContain('/persona');
  });
});

describe('buildRefreshPrompt', () => {
  it('embeds the new rows, restricts to them, includes format lines and the default question, no persona', () => {
    const p = buildRefreshPrompt({ filters: FILTERS, rows: [{ _idx: 0, action: 'delete', username: 'z@z.z' }] });
    expect(p).toContain('"action":"delete"');
    expect(p).not.toContain('_idx');
    expect(p).toMatch(/ONLY on these/);
    expect(p).toContain(DEFAULT_QUESTION);
    expect(p).toMatch(/takeaway/i);
    expect(p).toContain('"- "');
    expect(p).toContain('Next step:');
    expect(p).toContain('Do NOT include');
    expect(p).toContain('[e:');
    expect(p).not.toContain('/persona');
  });
});

describe('runAuditQuery / continueAuditQuery', () => {
  it('runAuditQuery primes persona, streams text, returns chatId', async () => {
    const prompts = [];
    const agentApi = {
      createChat: vi.fn(async () => 'chatA'),
      streamMessage: vi.fn(async (_id, content, { onEvent }) => {
        prompts.push(content);
        if (content === '/persona cautious') return;
        onEvent({ type: 'reasoning-delta', delta: 'hmm' });
        onEvent({ type: 'tool-input-start', toolName: 'search' });
        onEvent({ type: 'text-delta', delta: 'Latest: 3 status changes.' });
        onEvent({ type: 'finish' });
      }),
    };
    const texts = [];
    const res = await runAuditQuery({ agentApi, question: 'q', filters: FILTERS, rows: [], mode: 'autonomous', onText: (t) => texts.push(t) });
    expect(prompts[0]).toBe('/persona cautious');
    expect(res.chatId).toBe('chatA');
    expect(res.text).toContain('Latest: 3 status changes.');
    expect(res.reasoning).toContain('hmm');
    expect(res.tools).toContain('search');
    expect(texts[texts.length - 1]).toContain('Latest');
  });
  it('continueAuditQuery reuses the chat without re-priming', async () => {
    const calls = [];
    const agentApi = {
      createChat: vi.fn(),
      streamMessage: vi.fn(async (id, content, { onEvent }) => {
        calls.push([id, content]);
        onEvent({ type: 'text-delta', delta: 'answer' });
        onEvent({ type: 'finish' });
      }),
    };
    const res = await continueAuditQuery({ agentApi, chatId: 'chatB', question: 'more?' });
    expect(agentApi.createChat).not.toHaveBeenCalled();
    expect(calls[0][0]).toBe('chatB');
    expect(calls[0][1]).toContain('more?');
    expect(calls[0][1]).not.toContain('/persona');
    expect(res.text).toContain('answer');
  });
  it('refreshAuditSummary reuses the chat (no createChat) and streams the refresh prompt onto it', async () => {
    const calls = [];
    const agentApi = {
      createChat: vi.fn(),
      streamMessage: vi.fn(async (id, content, { onEvent }) => {
        calls.push([id, content]);
        onEvent({ type: 'text-delta', delta: 'New summary.' });
        onEvent({ type: 'finish' });
      }),
    };
    const rows = [{ _idx: 0, action: 'update-status', username: 'q@q.q' }];
    const res = await refreshAuditSummary({ agentApi, chatId: 'chatC', filters: FILTERS, rows });
    expect(agentApi.createChat).not.toHaveBeenCalled();
    expect(calls[0][0]).toBe('chatC');
    expect(calls[0][1]).toContain('"action":"update-status"');
    expect(calls[0][1]).not.toContain('/persona');
    expect(res.text).toContain('New summary.');
  });
});
