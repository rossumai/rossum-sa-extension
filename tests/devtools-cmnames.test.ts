// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { rossumNames } from '../src/devtools/cmNames.js';

function mountDoc(doc: any, nameFor: any, ensure: (url: string, onDone: () => void) => void = () => {}) {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [rossumNames(nameFor, ensure)] }),
    parent: document.body,
  });
}
async function waitFor(fn: any, tries = 200) { for (let i = 0; i < tries; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 0)); } throw new Error('waitFor timed out'); }

const line = (url: any) => `  "queue": "${url}",\n`;

describe('cmNames', () => {
  it('renders a dimmed name widget at the line end for a resolved link', () => {
    const url = 'https://acme.rossum.app/api/v1/queues/3';
    const view = mountDoc(line(url), () => ({ status: 'done', name: 'Invoices EU' }));
    const w = view.dom.querySelector('.rawjson-name');
    expect(w).not.toBeNull();
    expect(w!.textContent).toBe('Invoices EU');
    view.destroy();
  });
  it('adds no widget but calls ensure while loading/unresolved', () => {
    const url = 'https://acme.rossum.app/api/v1/queues/3';
    const ensure = vi.fn();
    const view = mountDoc(line(url), () => ({ status: 'none', name: null }), ensure);
    expect(view.dom.querySelector('.rawjson-name')).toBeNull();
    expect(ensure).toHaveBeenCalledWith(url, expect.any(Function));
    view.destroy();
  });
  it('skips non-nameable URLs (nameFor null) without a widget or ensure', () => {
    const ensure = vi.fn();
    const view = mountDoc(line('https://acme.rossum.app/api/v1/annotations/1/content'), () => null, ensure);
    expect(view.dom.querySelector('.rawjson-name')).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
    view.destroy();
  });
  it('skips a resolved link that has no display name', () => {
    const view = mountDoc(line('https://acme.rossum.app/api/v1/queues/3'), () => ({ status: 'done', name: null }));
    expect(view.dom.querySelector('.rawjson-name')).toBeNull();
    view.destroy();
  });
  it('shows the name after async resolution (ensure → refresh effect → rebuild)', async () => {
    const url = 'https://acme.rossum.app/api/v1/queues/3';
    let resolved = false;
    const nameFor = () => (resolved ? { status: 'done', name: 'Later' } : { status: 'none', name: null });
    const ensure = (u: any, cb: any) => { resolved = true; setTimeout(cb, 0); }; // resolve, then notify
    const view = mountDoc(line(url), nameFor, ensure);
    expect(view.dom.querySelector('.rawjson-name')).toBeNull(); // not yet resolved
    await waitFor(() => view.dom.querySelector('.rawjson-name'));
    expect(view.dom.querySelector('.rawjson-name')!.textContent).toBe('Later');
    view.destroy();
  });
  it('joins multiple names on one line with a middot', () => {
    const a = 'https://acme.rossum.app/api/v1/hooks/5';
    const b = 'https://acme.rossum.app/api/v1/hooks/6';
    const doc = `  "hooks": ["${a}", "${b}"],\n`;
    const view = mountDoc(doc, (u: any) => ({ status: 'done', name: u.endsWith('5') ? 'Alpha' : 'Beta' }));
    expect(view.dom.querySelector('.rawjson-name')!.textContent).toBe('Alpha · Beta');
    view.destroy();
  });
});
