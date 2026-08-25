// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';
import PreviewPane from '../src/devtools/PreviewPane.jsx';

async function waitFor(fn: any, tries = 200) { for (let i = 0; i < tries; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 0)); } throw new Error('waitFor timed out'); }
const blob = () => ({ size: 2048 });

let created: any, revoked: any;
beforeEach(() => {
  created = []; revoked = [];
  globalThis.URL.createObjectURL = vi.fn((b) => { const u = `blob:mock/${created.length}`; created.push(b); return u; });
  globalThis.URL.revokeObjectURL = vi.fn((u) => revoked.push(u));
});
afterEach(() => { vi.restoreAllMocks(); });

function mountPreview(preview: any) { const root = document.createElement('div'); render(<PreviewPane preview={preview} />, root); return root; }

describe('PreviewPane', () => {
  it('renders an <img> for an image content-type', async () => {
    const root = mountPreview({ kind: 'blob', contentType: 'image/png', size: 2048, filename: 'p.png', blob: blob() });
    await waitFor(() => root.querySelector('img'));
    expect(root.querySelector('img')!.getAttribute('src')).toMatch(/^blob:/);
    render(null, root);
  });

  it('renders an <iframe> for a pdf content-type', async () => {
    const root = mountPreview({ kind: 'blob', contentType: 'application/pdf', size: 2048, filename: 'd.pdf', blob: blob() });
    await waitFor(() => root.querySelector('iframe'));
    expect(root.querySelector('iframe')!.getAttribute('src')).toMatch(/^blob:/);
    render(null, root);
  });

  it('renders a file-info card + Download/Open for a non-renderable type', async () => {
    const root = mountPreview({ kind: 'blob', contentType: 'application/octet-stream', size: 2048, filename: 'x.bin', blob: blob() });
    await waitFor(() => root.querySelector('a[download]')); // actions appear once the object URL is ready
    expect(root.querySelector('.rawjson-preview-card')).not.toBeNull();
    expect(root.textContent).toContain('application/octet-stream');
    expect(root.textContent).toContain('2 KB');
    expect(root.textContent).toContain('x.bin');
    expect(root.querySelector('a[download]')!.getAttribute('download')).toBe('x.bin');
    expect(root.querySelector('a[target="_blank"]')).not.toBeNull();
    render(null, root);
  });

  it('creates one object URL and revokes it on unmount', async () => {
    const root = mountPreview({ kind: 'blob', contentType: 'image/png', size: 1, filename: 'p.png', blob: blob() });
    await waitFor(() => root.querySelector('img')); // img appears only after the effect created the URL
    expect(created.length).toBe(1);
    render(null, root);
    await waitFor(() => revoked.length === 1);
    expect(revoked[0]).toMatch(/^blob:/);
  });
});
