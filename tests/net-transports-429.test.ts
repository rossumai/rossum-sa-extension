// tests/net-transports-429.test.ts
// @vitest-environment jsdom
// Spec 2026-10-13-api-call-reduction-design.md §4.1: one 429 shape from every transport.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as inspectorApi from '../src/inspector/api.js';
import * as galaxyApi from '../src/galaxy/api.js';
import { fetchJson, apiPatch } from '../src/popup/mdh-provenance.js';

const throttled = (retryAfter: string | null) => ({
  ok: false,
  status: 429,
  headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) },
  json: async () => ({ detail: 'Request was throttled.' }),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a 429 from each transport', () => {
  it('inspector get rejects with status 429, retryAfter and the server detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => throttled('12')),
    );
    inspectorApi.init('https://x.rossum.ai', 't');
    await expect(inspectorApi.get('/api/v1/hooks')).rejects.toMatchObject({
      status: 429,
      retryAfter: 12,
      message: 'Request was throttled.',
    });
  });

  it('inspector safeListAll does not swallow a 429 into []', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => throttled(null)),
    );
    inspectorApi.init('https://x.rossum.ai', 't');
    await expect(inspectorApi.safeListAll('/api/v1/hooks')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('galaxy get rejects with status 429 and retryAfter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => throttled('4')),
    );
    galaxyApi.init('https://x.rossum.ai', 't');
    await expect(galaxyApi.get('/api/v1/hooks/')).rejects.toMatchObject({
      status: 429,
      retryAfter: 4,
    });
  });

  it('popup fetchJson rejects with status 429 and retryAfter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => throttled(null)),
    );
    await expect(fetchJson('https://x.rossum.ai/api/v1/hooks', 't')).rejects.toMatchObject({
      status: 429,
      retryAfter: null,
    });
  });

  it('popup fetchJson keeps its message and now carries status on other errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await expect(fetchJson('https://x.rossum.ai/api/v1/hooks', 't')).rejects.toMatchObject({
      status: 500,
      message: 'HTTP 500',
    });
  });
});

describe('popup apiPatch', () => {
  it('rejects with status 429 and retryAfter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => throttled('6')),
    );
    await expect(
      apiPatch('https://x.rossum.ai/api/v1/annotations/5', 't', {}),
    ).rejects.toMatchObject({
      status: 429,
      retryAfter: 6,
    });
  });

  it('carries status on other errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await expect(
      apiPatch('https://x.rossum.ai/api/v1/annotations/5', 't', {}),
    ).rejects.toMatchObject({
      status: 500,
      message: 'HTTP 500',
    });
  });
});

describe('429 message fallback', () => {
  const messageOnly = {
    ok: false,
    status: 429,
    headers: { get: () => null },
    json: async () => ({ message: 'Slow down.' }),
  };
  it('inspector get falls back to data.message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => messageOnly),
    );
    inspectorApi.init('https://x.rossum.ai', 't');
    await expect(inspectorApi.get('/api/v1/hooks')).rejects.toMatchObject({
      message: 'Slow down.',
    });
  });
  it('galaxy get falls back to data.message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => messageOnly),
    );
    galaxyApi.init('https://x.rossum.ai', 't');
    await expect(galaxyApi.get('/api/v1/hooks/')).rejects.toMatchObject({ message: 'Slow down.' });
  });
});
