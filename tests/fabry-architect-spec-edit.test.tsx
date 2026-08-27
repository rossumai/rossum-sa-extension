// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../src/fabry/architect/actions.js', () => ({ updateDeliverable: vi.fn() }));
// Every prop each editor was handed, so the wiring the paste path depends on can be asserted
// without mounting real CodeMirror (which architect-asset-paste.test.tsx does).
const seen = vi.hoisted(() => [] as any[]);
vi.mock('../src/fabry/architect/components/SourceEditor.jsx', () => ({
  default: ({ text, onChange, ...rest }: any) => {
    seen.push(rest);
    return (
      <textarea
        class="cm-mock"
        value={text}
        onInput={(e: Event) => onChange && onChange((e.currentTarget as HTMLTextAreaElement).value)}
      />
    );
  },
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
  seen.length = 0;
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

  // A paste reaches the ONE asset store and reports through this view's note channel (design
  // §5.5). Nothing else can catch a missed prop here: the store's own guard cannot see a component
  // that simply never received it.
  it('hands every editor the one asset store and the note channel', () => {
    mount();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((p) => p.assets === store.assets)).toBe(true);
    expect(seen.every((p) => typeof p.onNote === 'function')).toBe(true);
  });

  // ONE carrier for the whole column, cleared by the × and by nothing else. Every deliverable has
  // an editor and they all report into this one note, so a failure pasted into one has to survive a
  // success pasted into another — and dismissing is the only evidence the reader saw it.
  it('shares one failure carrier across editors and clears it on dismiss', () => {
    const root = mount();
    const carrier = seen[0].failures;
    expect(carrier).toBeTruthy();
    expect(seen.every((p) => p.failures === carrier)).toBe(true);

    carrier.current = { lines: ['x.png could not be added: 502 from the gateway'], hidden: 2 };
    act(() => {
      seen[0].onNote('Added assets/y.png · x.png could not be added: 502 from the gateway');
    });
    expect(root.querySelector('.fabry-arch-doc-note')!.textContent).toMatch(/could not be added/);

    act(() => {
      (root.querySelector('.fabry-arch-doc-warn-x') as HTMLElement).click();
    });
    expect(carrier.current).toEqual({ lines: [], hidden: 0 });
    expect(root.querySelector('.fabry-arch-doc-note')).toBeNull();
  });

  it('keeps the same chrome as preview mode', () => {
    const editHeaders = mount().querySelectorAll('.fabry-spec-sec-hd').length;
    document.body.innerHTML = '';
    store.docView.value = 'preview';
    expect(mount().querySelectorAll('.fabry-spec-sec-hd').length).toBe(editHeaders);
  });
});
