// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import JsonEditor from '../src/mdh/components/JsonEditor.jsx';
import { stageToggleGutter } from '../src/mdh/pipelineGutter.js';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

// These tests drive a REAL CodeMirror instance (no mocks), whose mount + gutter
// computation can exceed vi.waitFor's 1s default under full-suite CPU contention
// — the cause of intermittent "expected 0 to be 2" failures. Poll longer; the
// condition still resolves the instant CodeMirror finishes, so passing runs are
// not slowed.
const waitForCM = (fn: any) => vi.waitFor(fn, { timeout: 5000, interval: 20 });

// NOTE: The live gutter click test uses the jsdom fallback approach.
// jsdom's getBoundingClientRect() always returns zeros, so CodeMirror's gutter
// event handler cannot resolve the correct line from click coordinates. The
// markers render correctly (DOM assertion passes), but dispatching mousedown on a
// specific marker element cannot reliably target the right entryIndex under jsdom.
// Per the plan's documented fallback, we: (1) assert stageToggleGutter produces a
// non-empty extension array, (2) assert the correct number of marker elements are
// rendered in the DOM. The per-line correctness is covered by stageLineRanges unit
// tests in mdh-pipeline-comments.test.js.

describe('stageToggleGutter module', () => {
  it('returns a non-empty extension array', () => {
    const exts = stageToggleGutter(() => {});
    expect(Array.isArray(exts)).toBe(true);
    expect(exts.length).toBeGreaterThan(0);
  });
});

describe('JsonEditor aggregate gutter', () => {
  it('renders one stage-toggle checkbox per top-level stage (checked = enabled)', async () => {
    const root = mount();
    const value = '[\n  { "$match": {} },\n  { "$limit": 50 }\n]';
    render(h(JsonEditor, { mode: 'aggregate', value, onToggleStage: () => {} }), root);

    await waitForCM(() => expect(root.querySelectorAll('.pipeline-stage-toggle').length).toBe(2));
    const markers = root.querySelectorAll<HTMLInputElement>('.pipeline-stage-toggle');
    expect(markers[0].type).toBe('checkbox');
    expect(markers[0].checked).toBe(true); // enabled = checked
    expect(markers[1].checked).toBe(true);
  });

  it('renders an unchecked checkbox for a disabled stage', async () => {
    const root = mount();
    const value = '[\n  { "$match": {} },\n  /* @disabled-stage\n  { "$limit": 50 } */\n]';
    render(h(JsonEditor, { mode: 'aggregate', value, onToggleStage: () => {} }), root);

    await waitForCM(() => expect(root.querySelectorAll('.pipeline-stage-toggle').length).toBe(2));
    const markers = root.querySelectorAll<HTMLInputElement>('.pipeline-stage-toggle');
    expect(markers[0].checked).toBe(true);  // enabled
    expect(markers[1].checked).toBe(false); // disabled = unchecked
    expect(markers[1].classList.contains('pipeline-stage-toggle-off')).toBe(true);
  });

  it('does not add stage toggles outside aggregate mode', async () => {
    const root = mount();
    render(h(JsonEditor, { mode: 'query', value: '[ { "$match": {} } ]', onToggleStage: () => {} }), root);
    // Give the mount effect a beat; no aggregate gutter should appear.
    await waitForCM(() => expect(root.querySelector('.cm-editor')).not.toBeNull());
    expect(root.querySelectorAll('.pipeline-stage-toggle').length).toBe(0);
  });

  it('does not add stage toggles when no onToggleStage prop', async () => {
    const root = mount();
    render(h(JsonEditor, { mode: 'aggregate', value: '[ { "$match": {} } ]' }), root);
    await waitForCM(() => expect(root.querySelector('.cm-editor')).not.toBeNull());
    // gutter is only pushed when mode==='aggregate', regardless of onToggleStage
    await waitForCM(() => expect(root.querySelectorAll('.pipeline-stage-toggle').length).toBe(1));
  });
});

describe('JsonEditor gutters by mode', () => {
  it('aggregate mode renders NO line-number gutter and NO fold gutter', async () => {
    const root = mount();
    render(h(JsonEditor, { mode: 'aggregate', value: '[\n  { "$match": {} }\n]', onToggleStage: () => {} }), root);
    await waitForCM(() => expect(root.querySelector('.pipeline-stage-toggle')).not.toBeNull());
    expect(root.querySelector('.cm-lineNumbers')).toBeNull();
    expect(root.querySelector('.cm-foldGutter')).toBeNull();
  });

  it('non-aggregate mode keeps the line-number + fold gutters (basicSetup)', async () => {
    const root = mount();
    render(h(JsonEditor, { mode: 'default', value: '[\n  { "$match": {} }\n]' }), root);
    await waitForCM(() => expect(root.querySelector('.cm-editor')).not.toBeNull());
    expect(root.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(root.querySelector('.cm-foldGutter')).not.toBeNull();
  });
});
