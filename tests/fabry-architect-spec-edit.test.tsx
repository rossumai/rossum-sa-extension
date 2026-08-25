// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../src/fabry/architect/actions.js', () => ({ updateDeliverable: vi.fn() }));
vi.mock('../src/fabry/architect/components/SourceEditor.jsx', () => ({
  default: ({ text, onChange }: any) => (
    <textarea
      class="cm-mock"
      value={text}
      onInput={(e: Event) => onChange && onChange((e.currentTarget as HTMLTextAreaElement).value)}
    />
  ),
}));

vi.mock('../src/mdh/smoothScroll.js', async (orig) => ({
  ...(await orig()),
  animateScrollTop: vi.fn(),
}));

import * as store from '../src/fabry/architect/store.js';
import { updateDeliverable } from '../src/fabry/architect/actions.js';
import SpecView from '../src/fabry/architect/components/SpecView.jsx';
import { deliverable } from './support/architect.js';

const D = [
  deliverable({ id: 'd1', text: '# One\n\nalpha\n', order: 1, title: '', titleSource: '' }),
  deliverable({ id: 'd2', text: '# Two\n\nbeta\n', order: 2, title: '', titleSource: '' }),
];
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => {
    render(<SpecView />, root);
  });
  return root;
}
const fields = (root: any) => [...root.querySelectorAll('.cm-mock')];
function type(el: any, value: any) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
  store.deliverables.value = D;
  store.results.value = {};
  store.docView.value = 'edit';
  store.railOpen.value = true;
  store.spyTarget.value = 'd1';
  store.settledTarget.value = 'd1';
  store.pinnedTarget.value = null;
});

describe('edit mode', () => {
  it('mounts an editor for EVERY deliverable straight away — no click to activate', () => {
    const root = mount();
    expect(fields(root)).toHaveLength(2);
    expect(fields(root).map((t) => t.value)).toEqual(['# One\n\nalpha\n', '# Two\n\nbeta\n']);
    // one editor host per deliverable, each inside the ported column box
    expect(root.querySelectorAll('.fabry-spec-edit.markdown-body').length).toBe(2);
  });

  it('carries the same column box as Preview, so switching mode does not move the text', () => {
    const root = mount();
    // `.markdown-body` IS the ported column rule; carrying it on the host is what guarantees parity.
    expect(root.querySelector('.fabry-spec-edit')!.classList.contains('markdown-body')).toBe(true);
    store.docView.value = 'preview';
    act(() => {});
    expect(root.querySelector('.markdown-body')).toBeTruthy();
  });

  it('saves through the same action the pane used, so version capture is unchanged', async () => {
    const root = mount();
    type(fields(root)[0], '# One\n\nedited\n');
    await vi.waitFor(() =>
      expect(updateDeliverable).toHaveBeenCalledWith('d1', '# One\n\nedited\n'),
    );
  });

  it('keeps a pending edit PER deliverable — editing two fields must not drop either', () => {
    vi.useFakeTimers();
    const root = mount();
    type(fields(root)[0], 'first edited\n');
    type(fields(root)[1], 'second edited\n');
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(updateDeliverable).toHaveBeenCalledWith('d1', 'first edited\n');
    expect(updateDeliverable).toHaveBeenCalledWith('d2', 'second edited\n');
    vi.useRealTimers();
  });

  it('flushes pending edits when the column unmounts (a mode switch)', () => {
    const root = mount();
    type(fields(root)[1], 'switched away\n');
    act(() => {
      store.docView.value = 'preview';
    });
    expect(updateDeliverable).toHaveBeenCalledWith('d2', 'switched away\n');
  });

  it('passes an EXTERNAL text change (a restore) down to the editor', () => {
    const root = mount();
    act(() => {
      store.deliverables.value = [deliverable({ ...D[0], text: '# One\n\nrestored\n' }), D[1]];
    });
    expect(fields(root)[0].value).toBe('# One\n\nrestored\n');
  });

  it('keeps the same chrome as preview mode', () => {
    const editHeaders = mount().querySelectorAll('.fabry-spec-sec-hd').length;
    document.body.innerHTML = '';
    store.docView.value = 'preview';
    expect(mount().querySelectorAll('.fabry-spec-sec-hd').length).toBe(editHeaders);
  });
});
