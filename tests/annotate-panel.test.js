// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createPanel } from '../src/rossum/annotate/panel.js';

beforeEach(() => { document.body.innerHTML = ''; });

describe('createPanel', () => {
  it('shows an error', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    panel.showError('boom');
    expect(panel.el.textContent).toContain('boom');
  });
});

describe('panel result view', () => {
  it('shows applied + remaining and wires Undo/Reload', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    let undone = 0; let reloaded = 0;
    panel.onUndo(() => { undone++; }); panel.onReload(() => { reloaded++; });
    panel.showResult({
      applied: [{ schemaId: 'd', datapointId: 1, oldValue: 'a', newValue: 'b', boxSource: 'ocr', reason: 'r', valueChanged: true, boxChanged: false }],
      remaining: [{ type: 'error', content: 'still bad', datapointId: 2, schemaId: 'x' }],
    });
    expect(panel.el.textContent).toContain('Applied 1');
    expect(panel.el.textContent).toContain('still bad');
    const btns = panel.el.querySelectorAll('button');
    const undo = [...btns].find((b) => /undo/i.test(b.textContent));
    const reload = [...btns].find((b) => /reload/i.test(b.textContent));
    undo.click(); reload.click();
    expect(undone).toBe(1); expect(reloaded).toBe(1);
  });
});

describe('panel UX: bottom-right position + live transcript', () => {
  it('docks above the bottom-right button (not top-right)', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    const style = document.getElementById('rossum-sa-extension-annotate-style');
    expect(style.textContent).toContain('bottom:64px');
    expect(style.textContent).not.toContain('top:64px');
  });
  it('streams transcript text with auto-reveal, labels highlighted', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    const t = panel.el.querySelector('.rossum-sa-extension-annotate-transcript');
    expect(t.style.display).not.toBe('block'); // hidden (stylesheet) until first content
    panel.appendTranscript('── Mr. Fabry ──\n', true);
    panel.appendTranscript('thinking about the page');
    expect(t.style.display).toBe('block');
    expect(t.textContent).toContain('Mr. Fabry');
    expect(t.textContent).toContain('thinking about the page');
    expect(t.querySelector('.rossum-sa-extension-annotate-transcript-label')).toBeTruthy();
  });
  it('labeled appends normalize spacing: no leading blank at start, one blank line between blocks', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    const t = panel.el.querySelector('.rossum-sa-extension-annotate-transcript');
    panel.appendTranscript('── Mr. Fabry ──\n', true);
    expect(t.textContent.startsWith('──')).toBe(true); // no leading newline on first content
    panel.appendTranscript('reasoning ends without newline.'); // streamed delta, no trailing \n
    panel.appendTranscript('↳ reply:\n', true);
    panel.appendTranscript('```json\n[]\n```');
    expect(t.textContent).toContain('reasoning ends without newline.\n\n↳ reply:\n```json');
    panel.appendTranscript('── Mr. Fabry ──\n', true); // next turn after a trailing newline
    expect(t.textContent).toContain('```\n\n── Mr. Fabry ──'); // exactly one blank line, not two
  });
});

describe('panel minimal chrome: no narration, pulse until first content', () => {
  it('has no status/activity narration API and shows a textless pulse initially', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    expect(panel.setActivity).toBeUndefined(); // narration API removed by design
    expect(panel.el.querySelector('.rossum-sa-extension-annotate-pulse')).toBeTruthy();
    expect(panel.el.textContent).toBe(''); // no words while working
  });
  it('removes the pulse on first transcript content', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    panel.appendTranscript('thinking');
    expect(panel.el.querySelector('.rossum-sa-extension-annotate-pulse')).toBeNull();
  });
  it('removes the pulse on results and renders the note line when present', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    panel.showResult({ applied: [], remaining: [], note: 'AI analysis failed or timed out — deterministic box tightening was still applied.' });
    expect(panel.el.querySelector('.rossum-sa-extension-annotate-pulse')).toBeNull();
    expect(panel.el.textContent).toContain('deterministic box tightening');
  });
  it('removes the pulse on error', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    panel.showError('boom');
    expect(panel.el.querySelector('.rossum-sa-extension-annotate-pulse')).toBeNull();
  });
});

describe('panel unboxed-values transparency', () => {
  it('lists valued fields left without a box, with the reason', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    panel.showResult({ applied: [], remaining: [], unboxed: [{ schemaId: 'currency', rowIndex: null }, { schemaId: 'item_quantity', rowIndex: 2 }] });
    expect(panel.el.textContent).toContain('Without a box');
    expect(panel.el.textContent).toContain('currency');
    expect(panel.el.textContent).toContain('item_quantity r2');
  });
});
