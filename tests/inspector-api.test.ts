// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as api from '../src/inspector/api.js';

function mockFetch(sequence: any) {
  let i = 0;
  globalThis.fetch = vi.fn(async () => {
    const r = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  }) as any;
}

describe('inspector api', () => {
  beforeEach(() => {
    api.init('https://api.example.rossum.ai', 'TKN');
  });

  it('buildQuery skips null/empty', () => {
    expect(api.buildQuery({ a: 1, b: null, c: '', d: 'x' })).toBe('a=1&d=x');
  });

  it('get attaches Bearer + maps 401 to Session expired', async () => {
    mockFetch([{ status: 401, body: {} }]);
    await expect(api.get('/api/v1/annotations/1')).rejects.toThrow(/Session expired/);
    const [, opts] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect((opts!.headers as Record<string, string>).Authorization).toBe('Bearer TKN');
  });

  it('get flags 403 as featureUnavailable', async () => {
    mockFetch([{ status: 403, body: { detail: 'no' } }]);
    await expect(api.get('/x')).rejects.toMatchObject({ status: 403, featureUnavailable: true });
  });

  it('listAll follows pagination.next', async () => {
    mockFetch([
      {
        status: 200,
        body: { results: [1, 2], pagination: { next: 'https://api.example.rossum.ai/p2' } },
      },
      { status: 200, body: { results: [3], pagination: { next: null } } },
    ]);
    expect(await api.listAll('/api/v1/notes?annotation=9')).toEqual([1, 2, 3]);
  });

  it('safeListAll swallows 403 to []', async () => {
    mockFetch([{ status: 403, body: {} }]);
    expect(await api.safeListAll('/api/v1/audit_logs')).toEqual([]);
  });

  it('getAnnotation hits the annotation path', async () => {
    mockFetch([{ status: 200, body: { id: 5, status: 'to_review' } }]);
    const a = await api.getAnnotation(5);
    expect(a.id).toBe(5);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe(
      'https://api.example.rossum.ai/api/v1/annotations/5',
    );
  });
});

describe('workflow + relation endpoints', () => {
  beforeEach(() => {
    api.init('https://api.example.rossum.ai', 'TKN');
  });

  it('listWorkflowRuns hits /workflow_runs?', async () => {
    const calls: any = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ results: [], pagination: {} }) };
    }) as any;
    await api.listWorkflowRuns(42);
    expect(calls[0]).toContain('/api/v1/workflow_runs?');
    expect(calls[0]).toContain('annotation=42');
  });

  it('listWorkflowSteps filters by workflow id', async () => {
    const calls: any = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ results: [], pagination: {} }) };
    }) as any;
    await api.listWorkflowSteps(5);
    expect(calls[0]).toContain('/api/v1/workflow_steps?');
    expect(calls[0]).toContain('workflow=5');
  });

  it('listEmails is gone', () => {
    // The assertion is that the export no longer exists, so it cannot be named directly.
    expect((api as any).listEmails).toBeUndefined();
  });

  it('listAnnotationsByIds sends a csv id filter with sideload', async () => {
    const calls: any = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [], documents: [], queues: [] }),
      };
    }) as any;
    await api.listAnnotationsByIds(['1', '2']);
    expect(calls[0]).toContain('/api/v1/annotations?');
    expect(calls[0]).toContain('id=1%2C2');
    expect(calls[0]).toContain('sideload=documents%2Cqueues');
  });

  it('listPages hits /pages?annotation=', async () => {
    const calls: any = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ results: [], pagination: {} }) };
    }) as any;
    await api.listPages(42);
    expect(calls[0]).toContain('/api/v1/pages?');
    expect(calls[0]).toContain('annotation=42');
  });

  it('getBlob sends the auth header and returns the blob', async () => {
    const blob = { size: 3 };
    let seenAuth = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      seenAuth = opts.headers.Authorization;
      return { ok: true, status: 200, blob: async () => blob };
    }) as any;
    const out = await api.getBlob('https://api.example.rossum.ai/api/v1/pages/1/content');
    expect(seenAuth).toBe('Bearer TKN');
    expect(out).toBe(blob);
  });
});
