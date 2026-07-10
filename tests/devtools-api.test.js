import { describe, it, expect, vi, afterEach } from 'vitest';
import * as api from '../src/devtools/api.js';

function stubFetch(status, jsonBody, textBody) {
  globalThis.fetch = vi.fn(() => Promise.resolve({
    ok: status >= 200 && status < 300, status,
    json: () => Promise.resolve(jsonBody), text: () => Promise.resolve(textBody ?? ''),
  }));
}
afterEach(() => { delete globalThis.fetch; });

describe('devtools api', () => {
  it('getJson builds an absolute URL with Token auth', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    stubFetch(200, { id: 1 });
    const out = await api.getJson('/api/v1/queues/1');
    expect(out).toEqual({ id: 1 });
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://acme.rossum.app/api/v1/queues/1');
    expect(opts.headers.Authorization).toBe('Token TKN');
  });

  it('patch sends PATCH with body and carries status+body on error', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    stubFetch(400, null, 'bad');
    const err = await api.patch('/api/v1/queues/1', { name: 'x' }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.body).toBe('bad');
  });

  it('rejects invalid paths without fetching', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    stubFetch(200, {});
    await expect(api.getJson('/evil')).rejects.toThrow('Invalid API path');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('patch sends a PATCH with JSON body + Content-Type on success', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    stubFetch(200, { id: 1, name: 'x' });
    const out = await api.patch('/api/v1/queues/1', { name: 'x' });
    expect(out).toEqual({ id: 1, name: 'x' });
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://acme.rossum.app/api/v1/queues/1');
    expect(opts.method).toBe('PATCH');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers.Authorization).toBe('Token TKN');
    expect(JSON.parse(opts.body)).toEqual({ name: 'x' });
  });

  it('patch returns {} on 204', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')), text: () => Promise.resolve('') }));
    expect(await api.patch('/api/v1/queues/1', {})).toEqual({});
  });

  it('getJson attaches status and body on error', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    stubFetch(500, null, 'boom');
    const err = await api.getJson('/api/v1/queues/1').catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.body).toBe('boom');
  });
});

describe('getResource', () => {
  function mockRes({ status = 200, contentType, disposition, json, blob, text }) {
    const headers = new Map();
    if (contentType) headers.set('Content-Type', contentType);
    if (disposition) headers.set('Content-Disposition', disposition);
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: status >= 200 && status < 300, status, headers,
      json: () => Promise.resolve(json), blob: () => Promise.resolve(blob), text: () => Promise.resolve(text ?? ''),
    }));
  }

  it('returns parsed JSON when the content-type is JSON', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    mockRes({ contentType: 'application/json', json: { a: 1 } });
    expect(await api.getResource('/api/v1/queues/1')).toEqual({ kind: 'json', data: { a: 1 } });
  });

  it('returns a blob descriptor for a non-JSON content-type (Content-Disposition filename)', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    const blob = { size: 2048, type: 'application/pdf' };
    mockRes({ contentType: 'application/pdf', disposition: 'attachment; filename="doc.pdf"', blob });
    expect(await api.getResource('/api/v1/documents/5/content'))
      .toEqual({ kind: 'blob', contentType: 'application/pdf', size: 2048, filename: 'doc.pdf', blob });
  });

  it('derives a filename from the path + content-type when Content-Disposition is absent', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    mockRes({ contentType: 'image/png', blob: { size: 10, type: 'image/png' } });
    expect((await api.getResource('/api/v1/pages/9/content')).filename).toBe('content.png');
  });

  it('treats an OK response with no Content-Type as a blob', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    mockRes({ blob: { size: 5, type: '' } }); // no Content-Type header
    const r = await api.getResource('/api/v1/documents/5/content');
    expect(r.kind).toBe('blob');
    expect(r.contentType).toBe('');
  });

  it('throws {status, body} on a non-OK response (same shape as getJson)', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    mockRes({ status: 404, text: 'nope' });
    const err = await api.getResource('/api/v1/documents/5/content').catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.body).toBe('nope');
  });

  it('rejects an invalid path without fetching', async () => {
    api.init('https://acme.rossum.app', 'TKN');
    globalThis.fetch = vi.fn();
    await expect(api.getResource('/nope')).rejects.toThrow('Invalid API path');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
