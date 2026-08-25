// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import DocView from '../src/docs/components/DocView.jsx';

const SECTIONS = [
  { id: 'd1', slug: 'data-model', text: '# Data model\n\n## 2. Scope\n\nalpha\n' },
  { id: 'd2', slug: 'intake', text: '# Intake\n\n## 2. Scope\n\nbeta\n' },
];
function mount(props = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => { render(h(DocView, { sections: SECTIONS, ...props }), root); });
  return root;
}
beforeEach(() => { document.body.innerHTML = ''; });

describe('DocView with many sections', () => {
  it('renders one section per deliverable, tagged with id and slug', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.querySelectorAll('section[data-deliverable]').length).toBe(2));
    expect([...root.querySelectorAll('section[data-deliverable]')].map((s) => (s as HTMLElement).dataset.slug))
      .toEqual(['data-model', 'intake']);
  });

  it('puts EVERY deliverable text in the DOM — this is what makes Cmd+F work', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.textContent).toMatch(/alpha/));
    expect(root.textContent).toMatch(/beta/);
  });

  it('namespaces colliding heading ids so a fragment can address one deliverable', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.querySelectorAll('h2[id]').length).toBe(2));
    expect([...root.querySelectorAll('h2[id]')].map((e) => e.id))
      .toEqual(['data-model--2-scope', 'intake--2-scope']);
  });

  it('keeps ONE scroller for the page and one body per section', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.querySelectorAll('.markdown-body').length).toBe(2));
    expect(root.querySelectorAll('.docs-root').length).toBe(1);
  });

  it('renders a host-supplied header inside each section', async () => {
    const root = mount({ headerFor: (s: any) => h('div', { class: 'mk-hd' }, s.slug) });
    await vi.waitFor(() => expect(root.querySelectorAll('.mk-hd').length).toBe(2));
    expect([...root.querySelectorAll('.mk-hd')].map((e) => e.textContent)).toEqual(['data-model', 'intake']);
  });

  it('exposes page-wide geometry for the scroll spy', async () => {
    const docRef = { current: null as any };
    mount({ docRef });
    await vi.waitFor(() => expect(docRef.current).toBeTruthy());
    expect(docRef.current.sectionTops().map((t: any) => t.id)).toEqual(['d1', 'd2']);
    expect(docRef.current.headingTops().map((h2: any) => h2.docId)).toContain('d2');
  });

  it('still serves the legacy single-document call, WITHOUT namespacing ids', async () => {
    const root = mount({ sections: null, docId: 'solo', text: '# Solo\n\n## 2. Scope\n' });
    await vi.waitFor(() => expect(root.querySelector('h2[id]')).toBeTruthy());
    expect(root.querySelector('h2[id]')!.id).toBe('2-scope');
  });
});
