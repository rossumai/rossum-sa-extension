// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { rossumLinks, urlAt } from '../src/devtools/cmLinks.js';

const DOC = 'x "https://acme.rossum.app/api/v1/schemas/9" y';
describe('cmLinks', () => {
  it('urlAt returns the API URL under an offset inside it, else null', () => {
    const i = DOC.indexOf('schemas');
    expect(urlAt(DOC, i)).toBe('https://acme.rossum.app/api/v1/schemas/9');
    expect(urlAt(DOC, 0)).toBeNull();
  });
  it('mounts as a CodeMirror extension without error', () => {
    const el = document.createElement('div');
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: [basicSetup, rossumLinks(vi.fn())] }),
      parent: el,
    });
    expect(el.querySelector('.cm-editor')).not.toBeNull();
    view.destroy();
  });
  it('accepts onContextLink callback without error', () => {
    const el = document.createElement('div');
    const onContextLink = vi.fn();
    const view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: [basicSetup, rossumLinks(vi.fn(), onContextLink)],
      }),
      parent: el,
    });
    expect(el.querySelector('.cm-editor')).not.toBeNull();
    view.destroy();
  });
  it('contextmenu over a link fires onContextLink and preventDefaults (real handler)', () => {
    const onContext = vi.fn();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: [basicSetup, rossumLinks(vi.fn(), onContext)],
      }),
      parent: el,
    });
    view.posAtCoords = () => DOC.indexOf('schemas');
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 6,
    });
    view.contentDOM.dispatchEvent(ev);
    expect(onContext).toHaveBeenCalled();
    expect(onContext.mock.calls[0][0]).toBe('https://acme.rossum.app/api/v1/schemas/9');
    expect(ev.defaultPrevented).toBe(true);
    view.destroy();
    el.remove();
  });
  it('contextmenu NOT over a link does nothing (native menu preserved)', () => {
    const onContext = vi.fn();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: [basicSetup, rossumLinks(vi.fn(), onContext)],
      }),
      parent: el,
    });
    view.posAtCoords = () => 0;
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 1,
      clientY: 1,
    });
    view.contentDOM.dispatchEvent(ev);
    expect(onContext).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    view.destroy();
    el.remove();
  });
});
