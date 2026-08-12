// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h, render } from 'preact';
import { EditorState } from '@codemirror/state';
import JsonEditor, { linkedStageDecos } from '../src/mdh/components/JsonEditor.jsx';
import StageLinkOverlay from '../src/mdh/components/StageLinkOverlay.jsx';
import { hoveredStage, caretStage, stagesAutoscroll } from '../src/mdh/store.js';

// These drive a REAL CodeMirror instance (no mocks). Its mount can exceed
// vi.waitFor's 1s default under full-suite CPU contention, so poll longer — the
// condition still resolves the instant CodeMirror finishes.
const waitForCM = (fn) => vi.waitFor(fn, { timeout: 5000, interval: 20 });

const PIPELINE = '[\n  { "$match": { "a": 1 } },\n  { "$group": {\n    "_id": "$x"\n  } },\n  { "$limit": 50 }\n]';

let roots = [];
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const r of roots) render(null, r);
  roots = [];
  document.body.innerHTML = '';
  hoveredStage.value = null;
  caretStage.value = null;
  stagesAutoscroll.value = true;
});

// Which 1-based line numbers carry the band. Reading the class off `.cm-line`
// elements in document order is what the user actually sees.
const bandedLines = (root) => {
  const lines = [...root.querySelectorAll('.cm-line')];
  return lines.reduce((acc, el, i) => (el.classList.contains('cm-linked-stage') ? [...acc, i + 1] : acc), []);
};

describe('linkedStageDecos (pure — state only, no view)', () => {
  const state = () => EditorState.create({ doc: PIPELINE });

  it('returns no decorations for a null index', () => {
    expect(linkedStageDecos(state(), null).size).toBe(0);
  });

  it('returns no decorations for an index past the last stage', () => {
    expect(linkedStageDecos(state(), 99).size).toBe(0);
  });

  it('returns no decorations when the buffer does not parse', () => {
    const broken = EditorState.create({ doc: '[ { "$match": ' });
    expect(linkedStageDecos(broken, 0).size).toBe(0);
  });

  it('covers every line of a multi-line stage, not just its first', () => {
    // $group spans lines 3-5 of PIPELINE.
    expect(linkedStageDecos(state(), 1).size).toBe(3);
  });

  it('covers exactly one line for a single-line stage', () => {
    expect(linkedStageDecos(state(), 0).size).toBe(1);
  });
});

describe('JsonEditor.highlightStage', () => {
  it('bands only the requested stage\'s lines', async () => {
    const root = mount();
    const editorRef = { current: null };
    render(h(JsonEditor, { mode: 'aggregate', value: PIPELINE, editorRef }), root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(5));

    editorRef.current.highlightStage(1); // $group, lines 3-5
    await waitForCM(() => expect(bandedLines(root)).toEqual([3, 4, 5]));
  });

  it('moves the band when a different stage is highlighted', async () => {
    const root = mount();
    const editorRef = { current: null };
    render(h(JsonEditor, { mode: 'aggregate', value: PIPELINE, editorRef }), root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(5));

    editorRef.current.highlightStage(1);
    await waitForCM(() => expect(bandedLines(root)).toEqual([3, 4, 5]));
    editorRef.current.highlightStage(0); // $match, line 2
    await waitForCM(() => expect(bandedLines(root)).toEqual([2]));
  });

  it('clears the band on null', async () => {
    const root = mount();
    const editorRef = { current: null };
    render(h(JsonEditor, { mode: 'aggregate', value: PIPELINE, editorRef }), root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(5));

    editorRef.current.highlightStage(2);
    await waitForCM(() => expect(bandedLines(root).length).toBeGreaterThan(0));
    editorRef.current.highlightStage(null);
    await waitForCM(() => expect(bandedLines(root)).toEqual([]));
  });

  it('bands a DISABLED stage too (entry indices include them)', async () => {
    const root = mount();
    const editorRef = { current: null };
    const value = '[\n  { "$match": {} },\n  /* @disabled-stage\n  { "$limit": 50 } */\n]';
    render(h(JsonEditor, { mode: 'aggregate', value, editorRef }), root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(3));

    editorRef.current.highlightStage(1); // the disabled block
    await waitForCM(() => expect(bandedLines(root).length).toBeGreaterThan(0));
    // It must be the disabled block's lines, not $match's on line 2.
    expect(bandedLines(root)).not.toContain(2);
  });

  it('follows the stage across an edit instead of vanishing', async () => {
    // Regression guard: the band is keyed on the ENTRY INDEX and re-derived from
    // the current document, so an edit cannot leave it stranded or drop it.
    // Mapping the decorations instead would drop the band outright, because
    // LineDecoration maps with MapMode.TrackBefore.
    const root = mount();
    const editorRef = { current: null };
    render(h(JsonEditor, { mode: 'aggregate', value: PIPELINE, editorRef }), root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(5));

    editorRef.current.highlightStage(2); // $limit, line 6
    await waitForCM(() => expect(bandedLines(root)).toEqual([6]));

    // Insert a line ABOVE the banded stage; it must ride down with it, not stay
    // on line 6 and not disappear.
    editorRef.current.setValue(PIPELINE.replace('  { "$match"', '  // note\n  { "$match"'));
    await waitForCM(() => expect(bandedLines(root)).toEqual([7]));
  });

  it('is a no-op when the buffer stops parsing, and recovers when it parses again', async () => {
    const root = mount();
    const editorRef = { current: null };
    render(h(JsonEditor, { mode: 'aggregate', value: PIPELINE, editorRef }), root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(5));

    editorRef.current.highlightStage(0);
    await waitForCM(() => expect(bandedLines(root)).toEqual([2]));

    editorRef.current.setValue('[ { "$match": ');       // unparseable
    await waitForCM(() => expect(bandedLines(root)).toEqual([]));
    editorRef.current.setValue(PIPELINE);               // parses again
    await waitForCM(() => expect(bandedLines(root)).toEqual([2]));
  });
});

describe('StageLinkOverlay drives the band', () => {
  function mountOverlay(editorApi) {
    const root = mount();
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    render(h(StageLinkOverlay, { editorRef: { current: editorApi }, panelRef: { current: panel } }), root);
    return root;
  }
  const fakeEditor = () => ({
    highlightStage: vi.fn(),
    revealStage: vi.fn(),
    stageScreenRect: () => ({ top: 10, bottom: 22, left: 30, right: 90, hEnd: 60 }),
  });

  it('highlights the hovered stage and clears it on un-hover', async () => {
    const api = fakeEditor();
    mountOverlay(api);
    const section = document.createElement('div');
    document.body.appendChild(section);

    hoveredStage.value = { entryIndex: 2, el: section };
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenCalledWith(2));

    hoveredStage.value = null;
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenLastCalledWith(null));
  });

  it('highlights even when Auto-scroll is off (that option gates scrolling only)', async () => {
    const api = fakeEditor();
    mountOverlay(api);
    const section = document.createElement('div');
    document.body.appendChild(section);
    stagesAutoscroll.value = false;

    hoveredStage.value = { entryIndex: 1, el: section };
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenCalledWith(1));
    expect(api.revealStage).not.toHaveBeenCalled(); // scrolling stayed gated
  });

  it('still reveals the stage when Auto-scroll is on (unchanged behaviour)', async () => {
    const api = fakeEditor();
    mountOverlay(api);
    const section = document.createElement('div');
    document.body.appendChild(section);
    stagesAutoscroll.value = true;

    hoveredStage.value = { entryIndex: 1, el: section };
    await vi.waitFor(() => expect(api.revealStage).toHaveBeenCalledWith(1));
  });
});

describe('the caret drives the same link, from the other end', () => {
  // The caret carries no DOM node, so the overlay resolves the section itself
  // from [data-entry] inside the panel — which is also why nothing is drawn when
  // the Stages view is closed and no such element exists.
  function mountWithSections(editorApi, entries = [0, 1, 2]) {
    const root = mount();
    const panel = document.createElement('div');
    entries.forEach((i) => {
      const sec = document.createElement('div');
      sec.setAttribute('data-entry', String(i));
      panel.appendChild(sec);
    });
    document.body.appendChild(panel);
    render(h(StageLinkOverlay, { editorRef: { current: editorApi }, panelRef: { current: panel } }), root);
    return { root, panel };
  }
  const fakeEditor = () => ({
    highlightStage: vi.fn(),
    revealStage: vi.fn(),
    stageScreenRect: () => ({ top: 10, bottom: 22, left: 30, right: 90, hEnd: 60 }),
  });

  it('highlights the stage the caret sits in', async () => {
    const api = fakeEditor();
    mountWithSections(api);
    caretStage.value = { entryIndex: 2 };
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenCalledWith(2));
  });

  it('never scrolls the editor for the caret \u2014 the caret is already on screen', async () => {
    const api = fakeEditor();
    mountWithSections(api);
    stagesAutoscroll.value = true; // would reveal on hover
    caretStage.value = { entryIndex: 1 };
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenCalledWith(1));
    expect(api.revealStage).not.toHaveBeenCalled();
  });

  it('clears when the caret leaves every stage', async () => {
    const api = fakeEditor();
    mountWithSections(api);
    caretStage.value = { entryIndex: 1 };
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenCalledWith(1));
    caretStage.value = null;
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenLastCalledWith(null));
  });

  it('hover wins while hovering, and falls back to the caret afterwards', async () => {
    const api = fakeEditor();
    const { panel } = mountWithSections(api);
    caretStage.value = { entryIndex: 2 };
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenLastCalledWith(2));

    hoveredStage.value = { entryIndex: 0, el: panel.querySelector('[data-entry="0"]') };
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenLastCalledWith(0));

    hoveredStage.value = null; // pointer leaves; the caret is still where it was
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenLastCalledWith(2));
  });

  it('draws nothing when the Stages view is closed (no section to link to)', async () => {
    const api = fakeEditor();
    mountWithSections(api, []); // no [data-entry] elements
    caretStage.value = { entryIndex: 1 };
    await vi.waitFor(() => expect(api.highlightStage).toHaveBeenCalledWith(null));
    expect(api.highlightStage).not.toHaveBeenCalledWith(1);
  });
});
