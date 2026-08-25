import { describe, it, expect } from 'vitest';
import {
  createSseParser,
  toolLabel,
  newAcc,
  foldEvents,
  replyText,
  extractPipeline,
  fallbackNotice,
} from '../src/agent/agentStream.js';

const sse = (obj: any) => `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;

describe('createSseParser', () => {
  it('parses whole events and yields [DONE] as __done__', () => {
    const p = createSseParser();
    const evs = p.feed(
      sse({ type: 'start' }) + sse({ type: 'text-delta', delta: 'hi' }) + sse('[DONE]'),
    );
    expect(evs.map((e) => e.type)).toEqual(['start', 'text-delta', '__done__']);
  });

  it('tolerates a chunk boundary in the middle of an event', () => {
    const p = createSseParser();
    const full = sse({ type: 'text-delta', delta: 'hello' });
    const cut = Math.floor(full.length / 2);
    expect(p.feed(full.slice(0, cut))).toEqual([]); // incomplete
    const evs = p.feed(full.slice(cut));
    expect(evs).toEqual([{ type: 'text-delta', delta: 'hello' }]);
  });

  it('skips non-JSON data lines without throwing', () => {
    const p = createSseParser();
    expect(p.feed('data: not-json\n\n')).toEqual([]);
  });

  it('flush() returns a trailing event with no blank-line terminator', () => {
    const p = createSseParser();
    expect(p.feed('data: {"type":"finish"}')).toEqual([]);
    expect(p.flush()).toEqual([{ type: 'finish' }]);
  });

  it('handles CRLF-framed events', () => {
    const p = createSseParser();
    const evs = p.feed(
      'data: {"type":"start"}\r\n\r\ndata: {"type":"text-delta","delta":"hi"}\r\n\r\n',
    );
    expect(evs).toEqual([{ type: 'start' }, { type: 'text-delta', delta: 'hi' }]);
  });
});

describe('toolLabel', () => {
  it('maps known tools and falls back', () => {
    expect(toolLabel('list_datasets')).toBe('listing datasets');
    expect(toolLabel('data_storage_aggregate')).toBe('querying the collection');
    expect(toolLabel('load_skill')).toBe('consulting reference');
    expect(toolLabel('something_weird')).toBe('working');
    expect(toolLabel('')).toBe('working');
  });
  it('maps the Rossum resource tools used by the Inspector attribution agent', () => {
    expect(toolLabel('rossum_get_hook')).toBe('reading extension code');
    expect(toolLabel('rossum_list_hook_logs')).toBe('reading extension logs');
    expect(toolLabel('rossum_list_hooks')).toBe('listing extensions');
    expect(toolLabel('rossum_get_annotation_content')).toBe('reading field values');
  });
});

describe('foldEvents / replyText', () => {
  it('accumulates text, sets status from tools, prefers finalAnswer', () => {
    const acc = newAcc();
    foldEvents(acc, [
      { type: 'reasoning-start' },
      { type: 'tool-input-start', toolName: 'list_datasets' },
      { type: 'text-delta', delta: 'a' },
      { type: 'text-delta', delta: 'b' },
    ]);
    expect(acc.status).toBe('listing datasets');
    expect(replyText(acc)).toBe('ab');
    foldEvents(acc, [{ type: 'data-final-answer', data: { text: 'FINAL' } }, { type: '__done__' }]);
    expect(replyText(acc)).toBe('FINAL');
    expect(acc.done).toBe(true);
  });

  it("folds a 'finish' event to done", () => {
    const acc = newAcc();
    foldEvents(acc, [{ type: 'finish' }]);
    expect(acc.done).toBe(true);
  });
});

describe('extractPipeline', () => {
  it('extracts a fenced json block', () => {
    const out = extractPipeline('```json\n[{"$match":{"a":1}}]\n```');
    expect(JSON.parse(out!)).toEqual([{ $match: { a: 1 } }]);
  });
  it('extracts a fenced block surrounded by prose', () => {
    const out = extractPipeline(
      'Here you go:\n```json\n[{"$sort":{"x":-1}}]\n```\nHope that helps!',
    );
    expect(JSON.parse(out!)).toEqual([{ $sort: { x: -1 } }]);
  });
  it('extracts a bare array', () => {
    expect(JSON.parse(extractPipeline('[{"$limit":5}]')!)).toEqual([{ $limit: 5 }]);
  });
  it('extracts a bare array even when other brackets precede it', () => {
    expect(JSON.parse(extractPipeline('See [docs](url) and item [1]: [{"$limit":5}]')!)).toEqual([
      { $limit: 5 },
    ]);
  });
  it('returns null for prose with no array', () => {
    expect(extractPipeline('I cannot do that.')).toBeNull();
  });
});

describe('foldEvents — interactive elements', () => {
  it('captures data-agent-question into acc.questions', () => {
    const acc = newAcc();
    foldEvents(acc, [
      {
        type: 'data-agent-question',
        data: { questions: [{ question: 'Name?', options: [], multi_select: false }] },
      },
    ]);
    expect(acc.questions).toEqual([{ question: 'Name?', options: [], multi_select: false }]);
  });
  it('captures unknown data-* into acc.unhandled (deduped by type), leaves known data-* alone', () => {
    const acc = newAcc();
    foldEvents(acc, [
      { type: 'data-agent-confirmation', data: { prompt: 'ok?' } },
      { type: 'data-agent-confirmation', data: { prompt: 'again' } },
      { type: 'data-final-answer', data: { text: 'x' } },
    ]);
    expect(acc.unhandled.map((u) => u.type)).toEqual(['data-agent-confirmation']);
    expect(acc.finalAnswer).toBe('x'); // known data-* still handled, not in unhandled
  });
  it('treats data-task-snapshot and data-file-created as benign — not pushed to unhandled — while a genuinely-unknown data-foo still is', () => {
    const acc = newAcc();
    foldEvents(acc, [
      { type: 'data-task-snapshot', data: { plan: [] } },
      { type: 'data-file-created', data: { filename: 'report.csv' } },
      { type: 'data-foo', data: { x: 1 } },
    ]);
    expect(acc.unhandled.map((u) => u.type)).toEqual(['data-foo']);
  });
  it('leaves acc.questions null when data-agent-question carries an empty questions array', () => {
    const acc = newAcc();
    foldEvents(acc, [{ type: 'data-agent-question', data: { questions: [] } }]);
    expect(acc.questions).toBeNull();
  });
  it('captures error and tool-output-error into acc.error', () => {
    const acc = newAcc();
    foldEvents(acc, [{ type: 'error', errorText: 'boom' }]);
    expect(acc.error).toBe('boom');
    const acc2 = newAcc();
    foldEvents(acc2, [{ type: 'tool-output-error', errorText: 'tool failed' }]);
    expect(acc2.error).toBe('tool failed');
  });
});

describe('fallbackNotice', () => {
  it('null when text or questions present', () => {
    expect(fallbackNotice({ text: 'hi' })).toBeNull();
    expect(fallbackNotice({ text: '', questions: [{ question: 'q' }] })).toBeNull();
  });
  it('error > unsupported > empty priority', () => {
    expect(fallbackNotice({ text: '', error: 'boom' })).toEqual({ kind: 'error', text: 'boom' });
    expect(fallbackNotice({ text: '', unhandled: [{ type: 'data-x', data: 1 }] })).toEqual({
      kind: 'unsupported',
      types: ['data-x'],
      payloads: [{ type: 'data-x', data: 1 }],
    });
    expect(fallbackNotice({ text: '' })).toEqual({ kind: 'empty' });
  });
});
