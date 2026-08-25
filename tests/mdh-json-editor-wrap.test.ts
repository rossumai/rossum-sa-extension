// @vitest-environment jsdom
//
// The aggregation pipeline editor must NOT soft-wrap: a long stage scrolls
// horizontally instead of folding into several visual lines, so the pipeline stays
// a scannable one-stage-per-line list. Every OTHER JsonEditor keeps wrapping —
// index definitions, stage definitions, modal editors — so this pins both
// directions. Asserting on the real `cm-lineWrapping` class rather than on the
// extension array, because the class is what actually changes the layout.
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import JsonEditor from '../src/mdh/components/JsonEditor.jsx';

function mount(props: any) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(JsonEditor, props), root);
  return root;
}

// A real CodeMirror mount can exceed vi.waitFor's 1s default under full-suite CPU
// contention; poll longer, and passing runs are not slowed.
const waitForCM = (fn: any) => vi.waitFor(fn, { timeout: 5000, interval: 20 });

const LONG_STAGE = '[{ "$match": { "vendor_name": "a very long value that would wrap in a narrow pane" } }]';

describe('JsonEditor soft wrapping', () => {
  it('does not wrap in aggregate mode', async () => {
    const root = mount({ value: LONG_STAGE, mode: 'aggregate' });
    await waitForCM(() => expect(root.querySelector('.cm-content')).not.toBeNull());
    expect(root.querySelector('.cm-content')!.classList.contains('cm-lineWrapping')).toBe(false);
  });

  it('still wraps in the default mode', async () => {
    const root = mount({ value: LONG_STAGE });
    await waitForCM(() => expect(root.querySelector('.cm-content')).not.toBeNull());
    expect(root.querySelector('.cm-content')!.classList.contains('cm-lineWrapping')).toBe(true);
  });

  it('still wraps a read-only compact definition view', async () => {
    // This is the shape the index cards and the Stages view definitions use; they
    // are prose-ish JSON blocks in narrow columns, where wrapping is wanted.
    const root = mount({ value: LONG_STAGE, compact: true, readOnly: true, minHeight: '0' });
    await waitForCM(() => expect(root.querySelector('.cm-content')).not.toBeNull());
    expect(root.querySelector('.cm-content')!.classList.contains('cm-lineWrapping')).toBe(true);
  });

  it('keeps the scroller able to scroll horizontally in aggregate mode', async () => {
    // jsdom has no layout, so this asserts the CAPABILITY (overflow rule), not a
    // measured range — the real range is confirmed in a browser.
    const root = mount({ value: LONG_STAGE, mode: 'aggregate' });
    await waitForCM(() => expect(root.querySelector('.cm-scroller')).not.toBeNull());
    const scroller = root.querySelector('.cm-scroller');
    expect(['auto', 'scroll']).toContain(getComputedStyle(scroller!).overflowX);
  });
});
