// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import DocumentStrip from '../src/sidepanel/components/DocumentStrip.jsx';

// Condition-based wait — never fixed timeouts (repo rule).
async function waitFor(cond: any, timeout = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const CTX = { domain: 'https://org.rossum.app', token: 'tok' };
let root: any;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('DocumentStrip', () => {
  it('says no document is open when there is no annotation', () => {
    render(h(DocumentStrip, { ctx: CTX, annotationId: null }), root);
    expect(root.textContent).toContain('No document open');
    expect(root.querySelector('.sp-live')).toBeNull();
  });

  it('paints the id immediately, before any request resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(h(DocumentStrip, { ctx: CTX, annotationId: '1250417' }), root);
    expect(root.textContent).toContain('#1250417');
    expect(root.querySelector('.sp-live')).not.toBeNull();
  });

  it('upgrades to the file name when the sideload resolves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{}], documents: [{ original_file_name: 'invoice-4471.pdf' }] }),
    })));
    render(h(DocumentStrip, { ctx: CTX, annotationId: '1250417' }), root);
    await waitFor(() => root.textContent.includes('invoice-4471.pdf'));
    expect(root.textContent).toContain('#1250417');
  });

  it('keeps the id when the name lookup fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    render(h(DocumentStrip, { ctx: CTX, annotationId: '99' }), root);
    await waitFor(() => fetchMock.mock.calls.length > 0);
    expect(root.textContent).toContain('#99');
    expect(root.textContent).toContain('Document');
  });

  it('does not fetch without a token', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(h(DocumentStrip, { ctx: { domain: CTX.domain, token: null }, annotationId: '5' }), root);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(root.textContent).toContain('#5');
  });
});
