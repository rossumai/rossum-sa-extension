// @vitest-environment jsdom
//
// The invariant this file exists for: THE PIPELINE TEXT EDITOR NEVER MOVES THE
// RIGHT PANE. Hovering a stage in the editor, or resting the caret in one, marks
// the matching Stages section (connector + band + [data-linked]) but must not
// scroll it into view — owner's call 2026-08-14, reversing the symmetric
// follow-scroll: an editor you are reading or typing in should not send the
// other half of the screen travelling.
//
// The other direction is unchanged and still tested in
// tests/mdh-stage-link-highlight.test.js: hovering a Stages section DOES scroll
// the editor to that stage while Auto-scroll is on.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

const mock = vi.hoisted(() => ({ text: '', onCursorStage: null as any }));
const scrollMock = vi.hoisted(() => ({ animateScrollTop: vi.fn() }));

globalThis.chrome = ({
  storage: { local: { get: (k: any, cb: any) => { if (cb) { cb({}); return; } return Promise.resolve({}); }, set: () => Promise.resolve(), remove: () => Promise.resolve() } },
  runtime: { onMessage: { addListener: () => {} } } as any,
} as any);

// Spying on the tween is what proves "no scroll": jsdom has no layout, so every
// rect is 0 and a scrollTop assertion would pass whether or not the code ran.
vi.mock('../src/mdh/smoothScroll.js', async (importOriginal) => ({
  ...(await importOriginal()),
  animateScrollTop: scrollMock.animateScrollTop,
}));

vi.mock('../src/mdh/api.js');
vi.mock('../src/mdh/components/PipelineEditor.jsx', () => ({
  default: ({ editorRef, onCursorStage }: any) => {
    mock.onCursorStage = onCursorStage;
    if (editorRef) {
      editorRef.current = {
        getValue: () => mock.text,
        setValue: (v: any) => { mock.text = v; },
        isValid: () => true,
        getParsed: () => [],
        focus: () => {}, refresh: () => {},
      };
    }
    return h('div', { 'data-testid': 'editor' });
  },
}));
vi.mock('../src/mdh/components/RecordList.jsx', () => ({ default: () => h('div', { 'data-testid': 'recordlist' }) }));
vi.mock('../src/mdh/components/PipelineDebug.jsx', () => ({ default: () => h('div', { 'data-testid': 'debug' }) }));

import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import DataPanel from '../src/mdh/components/DataPanel.jsx';
import StageLinkOverlay from '../src/mdh/components/StageLinkOverlay.jsx';
import {
  selectedCollection, records, resultsView, inspectTarget,
  caretStage, editorHoverStage, hoveredStage, stagesAutoscroll,
} from '../src/mdh/store.js';
import { rect } from './support/dom.js';

async function waitFor(condition: any, description = 'condition', timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = condition(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let roots: any = [];
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  return root;
}

// Unmount in afterEach, not beforeEach: DataPanel keeps timers and effects
// running, and a mount left alive past the LAST test in this file makes preact
// flush an effect after the environment is torn down — surfacing as
// "cancelAnimationFrame is not defined", blamed on whichever unrelated file the
// runner happened to be in. Observed while writing this file.
afterEach(() => {
  for (const r of roots) render(null, r);
  roots = [];
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidateAll();
  vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 0 }] });
  if (api.listCollections) vi.mocked(api.listCollections).mockResolvedValue({ result: [] });
  selectedCollection.value = 'vendors';
  records.value = [];
  mock.text = '';
  mock.onCursorStage = null;
  inspectTarget.value = null;
  caretStage.value = null;
  editorHoverStage.value = null;
  hoveredStage.value = null;
  resultsView.value = 'list';
  stagesAutoscroll.value = true; // the setting that used to make the pane follow
});

// A Stages pane: sections inside the scroller the overlay looks for.
function stagesPane(entries = [0, 1, 2]) {
  const panel = document.createElement('div');
  const pane = document.createElement('div');
  pane.className = 'pipeline-inspect-scroll';
  entries.forEach((i) => {
    const sec = document.createElement('div');
    sec.setAttribute('data-entry', String(i));
    pane.appendChild(sec);
  });
  panel.appendChild(pane);
  document.body.appendChild(panel);
  return panel;
}

const fakeEditor = () => ({
  highlightStage: vi.fn(),
  revealStage: vi.fn(),
  stageScreenRect: () => ({ top: 10, bottom: 22, left: 30, right: 90, hEnd: 60 }),
});

describe('hovering a stage in the editor', () => {
  it('marks the section but never scrolls the Stages pane', async () => {
    const api2 = fakeEditor();
    const panel = stagesPane();
    render(h(StageLinkOverlay, { editorRef: { current: api2 }, panelRef: { current: panel } }), mount());

    editorHoverStage.value = { entryIndex: 1 };

    // The link still happens — this is a scroll change, not a link change.
    await waitFor(() => api2.highlightStage.mock.calls.some(([i]) => i === 1), 'the band to light up');
    expect(panel.querySelector('[data-entry="1"]')!.hasAttribute('data-linked')).toBe(true);
    expect(scrollMock.animateScrollTop).not.toHaveBeenCalled();
  });

  it('does not scroll the pane even with Auto-scroll on and the section far down', async () => {
    const api2 = fakeEditor();
    const panel = stagesPane([0, 1, 2, 3, 4, 5]);
    const pane = panel.querySelector('.pipeline-inspect-scroll');
    // Real geometry: the target sits well below the pane's viewport, i.e. exactly
    // the case the old code scrolled for.
    pane!.getBoundingClientRect = () => rect({ top: 0, bottom: 300, left: 0, right: 400, width: 400, height: 300 });
    panel.querySelector('[data-entry="5"]')!.getBoundingClientRect = () => rect({ top: 900, bottom: 1100, left: 0, right: 400, width: 400, height: 200 });
    render(h(StageLinkOverlay, { editorRef: { current: api2 }, panelRef: { current: panel } }), mount());

    editorHoverStage.value = { entryIndex: 5 };

    await waitFor(() => api2.highlightStage.mock.calls.some(([i]) => i === 5), 'the band to light up');
    expect(scrollMock.animateScrollTop).not.toHaveBeenCalled();
  });
});

describe('the caret resting in a stage', () => {
  async function mountDataPanel() {
    const root = mount();
    render(h(DataPanel, null), root);
    await waitFor(() => mock.onCursorStage != null, 'DataPanel to wire up the editor');
    return root;
  }

  it('marks the stage without targeting the Stages view for a scroll', async () => {
    await mountDataPanel();
    resultsView.value = 'stages';

    mock.onCursorStage(1);

    expect(caretStage.value).toEqual({ entryIndex: 1 });
    expect(inspectTarget.value).toBeNull(); // no scroll, no flash
  });

  it('clears the mark when the caret leaves every stage', async () => {
    await mountDataPanel();
    resultsView.value = 'stages';

    mock.onCursorStage(2);
    expect(caretStage.value).toEqual({ entryIndex: 2 });

    mock.onCursorStage(null);
    expect(caretStage.value).toBeNull();
    expect(inspectTarget.value).toBeNull();
  });
});
