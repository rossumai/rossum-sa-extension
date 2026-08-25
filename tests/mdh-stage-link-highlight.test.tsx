// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { h, render } from 'preact';
import { EditorState } from '@codemirror/state';
import JsonEditor, { linkedStageDecos } from '../src/mdh/components/JsonEditor.jsx';
import type { JsonEditorHandle } from '../src/mdh/components/JsonEditor.jsx';
import StageLinkOverlay from '../src/mdh/components/StageLinkOverlay.jsx';
import { hoveredStage, caretStage, stagesAutoscroll } from '../src/mdh/store.js';
import { rect } from './support/dom.js';

// These drive a REAL CodeMirror instance (no mocks). Its mount can exceed
// vi.waitFor's 1s default under full-suite CPU contention, so poll longer — the
// condition still resolves the instant CodeMirror finishes.
const waitForCM = (fn: any) => vi.waitFor(fn, { timeout: 5000, interval: 20 });

const PIPELINE =
  '[\n  { "$match": { "a": 1 } },\n  { "$group": {\n    "_id": "$x"\n  } },\n  { "$limit": 50 }\n]';

let roots: any = [];
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
const bandedLines = (root: any) => {
  const lines = [...root.querySelectorAll('.cm-line')];
  return lines.reduce(
    (acc, el, i) => (el.classList.contains('cm-linked-stage') ? [...acc, i + 1] : acc),
    [],
  );
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
  it("bands only the requested stage's lines", async () => {
    const root = mount();
    const editorRef: { current: JsonEditorHandle | null } = { current: null };
    render(<JsonEditor mode="aggregate" value={PIPELINE} editorRef={editorRef} />, root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(5));

    editorRef.current!.highlightStage(1); // $group, lines 3-5
    await waitForCM(() => expect(bandedLines(root)).toEqual([3, 4, 5]));
  });

  it('moves the band when a different stage is highlighted', async () => {
    const root = mount();
    const editorRef: { current: JsonEditorHandle | null } = { current: null };
    render(<JsonEditor mode="aggregate" value={PIPELINE} editorRef={editorRef} />, root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(5));

    editorRef.current!.highlightStage(1);
    await waitForCM(() => expect(bandedLines(root)).toEqual([3, 4, 5]));
    editorRef.current!.highlightStage(0); // $match, line 2
    await waitForCM(() => expect(bandedLines(root)).toEqual([2]));
  });

  it('clears the band on null', async () => {
    const root = mount();
    const editorRef: { current: JsonEditorHandle | null } = { current: null };
    render(<JsonEditor mode="aggregate" value={PIPELINE} editorRef={editorRef} />, root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(5));

    editorRef.current!.highlightStage(2);
    await waitForCM(() => expect(bandedLines(root).length).toBeGreaterThan(0));
    editorRef.current!.highlightStage(null);
    await waitForCM(() => expect(bandedLines(root)).toEqual([]));
  });

  it('bands a DISABLED stage too (entry indices include them)', async () => {
    const root = mount();
    const editorRef: { current: JsonEditorHandle | null } = { current: null };
    const value = '[\n  { "$match": {} },\n  /* @disabled-stage\n  { "$limit": 50 } */\n]';
    render(<JsonEditor mode="aggregate" value={value} editorRef={editorRef} />, root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(3));

    editorRef.current!.highlightStage(1); // the disabled block
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
    const editorRef: { current: JsonEditorHandle | null } = { current: null };
    render(<JsonEditor mode="aggregate" value={PIPELINE} editorRef={editorRef} />, root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(5));

    editorRef.current!.highlightStage(2); // $limit, line 6
    await waitForCM(() => expect(bandedLines(root)).toEqual([6]));

    // Insert a line ABOVE the banded stage; it must ride down with it, not stay
    // on line 6 and not disappear.
    editorRef.current!.setValue(PIPELINE.replace('  { "$match"', '  // note\n  { "$match"'));
    await waitForCM(() => expect(bandedLines(root)).toEqual([7]));
  });

  it('is a no-op when the buffer stops parsing, and recovers when it parses again', async () => {
    const root = mount();
    const editorRef: { current: JsonEditorHandle | null } = { current: null };
    render(<JsonEditor mode="aggregate" value={PIPELINE} editorRef={editorRef} />, root);
    await waitForCM(() => expect(root.querySelectorAll('.cm-line').length).toBeGreaterThan(5));

    editorRef.current!.highlightStage(0);
    await waitForCM(() => expect(bandedLines(root)).toEqual([2]));

    editorRef.current!.setValue('[ { "$match": '); // unparseable
    await waitForCM(() => expect(bandedLines(root)).toEqual([]));
    editorRef.current!.setValue(PIPELINE); // parses again
    await waitForCM(() => expect(bandedLines(root)).toEqual([2]));
  });
});

describe('StageLinkOverlay drives the band', () => {
  function mountOverlay(editorApi: any) {
    const root = mount();
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    render(
      <StageLinkOverlay editorRef={{ current: editorApi }} panelRef={{ current: panel }} />,
      root,
    );
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
  function mountWithSections(editorApi: any, entries = [0, 1, 2]) {
    const root = mount();
    const panel = document.createElement('div');
    entries.forEach((i) => {
      const sec = document.createElement('div');
      sec.setAttribute('data-entry', String(i));
      panel.appendChild(sec);
    });
    document.body.appendChild(panel);
    render(
      <StageLinkOverlay editorRef={{ current: editorApi }} panelRef={{ current: panel }} />,
      root,
    );
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

  // Owner request 2026-08-14: keep the tether when the section is off screen. It
  // used to be suppressed, which mattered once the editor stopped scrolling the
  // pane — the section can now stay out of view indefinitely.
  it('still draws the line for a section scrolled out of the pane, ending in an arrow', async () => {
    const api = fakeEditor();
    const root = mount();
    const panel = document.createElement('div');
    const pane = document.createElement('div');
    pane.className = 'pipeline-inspect-scroll';
    pane.getBoundingClientRect = () =>
      rect({ top: 200, bottom: 700, left: 400, right: 900, width: 500, height: 500 });
    const sec = document.createElement('div');
    sec.setAttribute('data-entry', '1');
    sec.getBoundingClientRect = () =>
      rect({ top: -400, bottom: -200, left: 420, right: 880, width: 460, height: 200 });
    pane.appendChild(sec);
    panel.appendChild(pane);
    panel.getBoundingClientRect = () =>
      rect({ top: 0, bottom: 900, left: 0, right: 1200, width: 1200, height: 900 });
    document.body.appendChild(panel);
    render(<StageLinkOverlay editorRef={{ current: api }} panelRef={{ current: panel }} />, root);

    caretStage.value = { entryIndex: 1 };

    await vi.waitFor(() => expect(root.querySelector('.stage-link-line')).toBeTruthy());
    expect(root.querySelector('.stage-link-arrow')).toBeTruthy();
    // One endpoint marker, not two: the arrow REPLACES the section-end dot.
    expect(root.querySelectorAll('.stage-link-dot').length).toBe(1);
  });

  // The editor end, same rule (owner 2026-08-14): a stage scrolled out of the
  // editor's own box must not put the line outside it, over the pipeline header.
  it('keeps the editor end inside the editor box when the stage is scrolled out of it', async () => {
    const api = fakeEditor();
    // The stage's line reports coordinates ABOVE the editor's clip box — what
    // CodeMirror really does for a scrolled-out line.
    api.stageScreenRect = () => ({ top: -40, bottom: -24, left: 30, right: 90, hEnd: 60 });
    (api as any).clipRect = () => ({ top: 100, bottom: 500, left: 20, right: 300 });
    const root = mount();
    const panel = document.createElement('div');
    const pane = document.createElement('div');
    pane.className = 'pipeline-inspect-scroll';
    pane.getBoundingClientRect = () => rect({ top: 100, bottom: 500, left: 400, right: 900 });
    const sec = document.createElement('div');
    sec.setAttribute('data-entry', '1');
    sec.getBoundingClientRect = () => rect({ top: 200, bottom: 360, left: 420, right: 880 });
    pane.appendChild(sec);
    panel.appendChild(pane);
    panel.getBoundingClientRect = () => rect({ top: 0, bottom: 600, left: 0, right: 1000 });
    document.body.appendChild(panel);
    render(<StageLinkOverlay editorRef={{ current: api }} panelRef={{ current: panel }} />, root);

    caretStage.value = { entryIndex: 1 };

    await vi.waitFor(() => expect(root.querySelector('.stage-link-line')).toBeTruthy());
    const d = root.querySelector('.stage-link-line')!.getAttribute('d');
    const ys = d!
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number)
      .filter((_, i) => i % 2 === 1);
    // Panel-relative, and the panel starts at viewport 0 — so the clip box's top
    // (100) is the floor every point must respect.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(100);
    // The editor end is an arrow now; the section end (in view) keeps its dot.
    expect(root.querySelectorAll('.stage-link-arrow').length).toBe(1);
    expect(root.querySelectorAll('.stage-link-dot').length).toBe(1);
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

// Source-level guard, because jsdom has no layout and no paint order: it cannot
// see that a background on `.cm-line` hides CodeMirror's text selection. The
// selection is drawn by drawSelection() into `.cm-selectionLayer`, a layer whose
// z-index is NEGATIVE (measured: -2), i.e. below the in-flow line backgrounds —
// so a filled `.cm-linked-stage` line made a selected pipeline invisible, and
// drawSelection's `::selection { background: transparent !important }` left no
// native highlight either. The band therefore has to be a pseudo-element painted
// under that layer. Verified in Chrome by pixel sampling; asserted here so the
// rule cannot quietly regress to a plain background.
describe('linked-stage band paints below the selection layer', () => {
  const css = readFileSync('src/console/console.css', 'utf8');
  // The declaration block for a selector, comments already stripped.
  const blockFor = (selector: any) => {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const m = new RegExp(
      `(^|})\\s*${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\{([^}]*)\\}`,
      'm',
    ).exec(body);
    return m ? m[2] : null;
  };

  it('does not fill the line element itself', () => {
    const block = blockFor('.cm-linked-stage');
    expect(block).not.toBeNull();
    expect(block).not.toMatch(/background/);
  });

  it('fills a pseudo-element that sits under the selection layer', () => {
    const block = blockFor('.cm-linked-stage::before');
    expect(block).not.toBeNull();
    expect(block).toMatch(/background:\s*var\(--info-bg\)/);
    expect(block).toMatch(/position:\s*absolute/);
    const z = /z-index:\s*(-?\d+)/.exec(block!);
    expect(z).not.toBeNull();
    // Below `.cm-selectionLayer` (-2), and negative z resolves against
    // `.cm-scroller` only while the line stays a non-stacking-context.
    expect(Number(z![1])).toBeLessThan(-2);
    expect(blockFor('.cm-linked-stage')).toMatch(/position:\s*relative/);
  });
});
