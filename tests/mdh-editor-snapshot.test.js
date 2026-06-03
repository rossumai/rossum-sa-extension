// @vitest-environment jsdom
//
// useEditorSnapshot is the reactivity fix for the variables bug: the editor's
// text isn't reactive, so the Variables inputs / Pipeline Debug used to refresh
// only on a valid parse. This hook re-renders the consumer (debounced) on every
// recompute() call — including while the text is invalid JSON.
//
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import { useEditorSnapshot } from '../src/mdh/hooks/useEditorSnapshot.js';

// Mount the hook and expose the latest [snapshot, recompute] via a getter.
function setup(editorRef, computeFn) {
  let latest;
  render(
    h(() => {
      const [snapshot, recompute] = useEditorSnapshot(editorRef, computeFn);
      latest = { snapshot, recompute };
      return null;
    }, null),
    document.createElement('div'),
  );
  return () => latest;
}

// Real timers: the hook debounces 250ms, so wait past it then let Preact commit.
async function flushDebounce() {
  await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setTimeout(r, 0));
}

describe('useEditorSnapshot', () => {
  it('starts with an empty snapshot', () => {
    const get = setup({ current: { getValue: () => '' } }, () => ({}));
    expect(get().snapshot).toEqual({ text: '', placeholders: [], parsed: null });
  });

  it('updates the snapshot from editorRef + computeFn after the debounce', async () => {
    const text = '[{"$match":{"x":{a}}}]';
    const editorRef = { current: { getValue: () => text } };
    const computeFn = () => ({ placeholders: ['a'], parsed: null });
    const get = setup(editorRef, computeFn);

    get().recompute();
    await flushDebounce();

    expect(get().snapshot).toEqual({ text, placeholders: ['a'], parsed: null });
  });

  it('debounces rapid recompute() calls into a single editor read', async () => {
    let reads = 0;
    const editorRef = { current: { getValue: () => { reads++; return '[]'; } } };
    const get = setup(editorRef, () => ({ placeholders: [], parsed: [] }));

    get().recompute();
    get().recompute();
    get().recompute();
    await flushDebounce();

    expect(reads).toBe(1);
  });

  it('no-ops when the editor is not mounted yet', async () => {
    const computeFn = vi.fn(() => ({ placeholders: [], parsed: null }));
    const get = setup({ current: null }, computeFn);

    get().recompute();
    await flushDebounce();

    expect(computeFn).not.toHaveBeenCalled();
    expect(get().snapshot.text).toBe('');
  });
});
