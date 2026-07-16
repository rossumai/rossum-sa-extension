import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiPatch } from '../src/popup/mdh-provenance.js';

afterEach(() => vi.unstubAllGlobals());

describe('apiPatch', () => {
  it('sends a JSON PATCH with token auth and returns the parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'to_review' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await apiPatch('https://x.example/api/v1/annotations/7', 'tok123', { status: 'to_review' });

    expect(out).toEqual({ status: 'to_review' });
    expect(fetchMock).toHaveBeenCalledWith('https://x.example/api/v1/annotations/7', {
      method: 'PATCH',
      headers: {
        Authorization: 'token tok123',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ status: 'to_review' }),
    });
  });

  it('throws Error("HTTP <status>") on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(apiPatch('https://x.example/a', 't', {})).rejects.toThrow('HTTP 403');
  });
});
