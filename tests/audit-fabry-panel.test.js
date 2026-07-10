// tests/audit-fabry-panel.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

const askAuditFabry = vi.fn();
const runDefaultSummary = vi.fn();
vi.mock('../src/audit/index.jsx', () => ({
  askAuditFabry: (...a) => askAuditFabry(...a),
  runDefaultSummary: (...a) => runDefaultSummary(...a),
}));

import FabryPanel, { previewText } from '../src/audit/components/FabryPanel.jsx';
import * as store from '../src/audit/store.js';

const fireInput = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const fireEnter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

let root;
beforeEach(() => { vi.clearAllMocks(); store.resetFabry(); root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });
function mount() { render(h(FabryPanel, null), root); return root; }
function expandToggle(el) { act(() => { el.querySelector('.audit-fabry-toggle').click(); }); }

describe('FabryPanel', () => {
  it('collapsed by default: shows the toggle but no ask input or turns', () => {
    const el = mount();
    expect(el.querySelector('.audit-fabry-toggle')).toBeTruthy();
    expect(el.querySelector('.nl-search-input')).toBeFalsy();
    expect(el.querySelector('.audit-fabry-turn')).toBeFalsy();
  });

  it('collapsed bar shows the Fabry-generated takeaway line as the preview, dropping the rest', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [
      { id: 1, question: null, text: 'Quiet page: 42 events.\n- a\n- b\nNext step: x.', reasoning: '', tools: [], state: 'done' },
    ] };
    const el = mount();
    const preview = el.querySelector('.audit-fabry-preview');
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('Quiet page: 42 events.');
    expect(preview.textContent).not.toContain('Next step');
  });

  it('collapsed bar shows a streaming placeholder while the summary is still generating', () => {
    store.fabry.value = { status: 'running', chatId: null, error: null, turns: [
      { id: 1, question: null, text: '', reasoning: '', tools: [], state: 'streaming' },
    ] };
    const el = mount();
    const preview = el.querySelector('.audit-fabry-preview');
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('summarizing');
  });

  it('preview is hidden once the band is expanded', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [
      { id: 1, question: null, text: 'Quiet page.', reasoning: '', tools: [], state: 'done' },
    ] };
    const el = mount();
    expandToggle(el);
    expect(el.querySelector('.audit-fabry-preview')).toBeFalsy();
  });

  it('collapsed bar shows a hint (not a preview) when idle with no summary yet', () => {
    store.resetFabry();
    const el = mount();
    expect(el.querySelector('.audit-fabry-hint')).toBeTruthy();
    expect(el.querySelector('.audit-fabry-preview')).toBeFalsy();
  });

  it('expanding while idle triggers the lazy default summary exactly once', () => {
    const el = mount();
    expandToggle(el);
    expect(el.querySelector('.nl-search-input')).toBeTruthy();
    expect(runDefaultSummary).toHaveBeenCalledTimes(1);
  });

  it('expanding when a summary already exists does not re-run it', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [
      { id: 1, question: null, text: 'Takeaway.\n- one\nNext step: go.', reasoning: 'r', tools: [], state: 'done' },
    ] };
    const el = mount();
    expandToggle(el);
    expect(el.querySelector('.nl-search-input')).toBeTruthy();
    expect(el.querySelector('.audit-fabry-turn')).toBeTruthy();
    expect(runDefaultSummary).not.toHaveBeenCalled();
  });

  it('renders the default summary and a Q&A turn when expanded', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [
      { id: 1, question: null, text: 'Takeaway.\n- one\n- two\nNext step: go.', reasoning: 'r', tools: ['search'], state: 'done' },
      { id: 2, question: 'why?', text: 'Because.', reasoning: '', tools: [], state: 'done' },
    ] };
    const el = mount();
    expandToggle(el);
    expect(el.querySelectorAll('.inspector-diag-list li').length).toBe(2);
    const roles = [...el.querySelectorAll('.inspector-followup-role')].map((n) => n.textContent);
    expect(roles[0]).toContain('Latest activity');
    expect(roles[1]).toContain('You');
    expect(el.textContent).toContain('why?');
    expect(el.querySelector('.inspector-diag-credit').textContent).toContain('Mr. Fabry');
  });

  it('chat order: the thread reads top-down with the ask input last', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [
      { id: 1, question: null, text: 'Takeaway.\n- one\nNext step: go.', reasoning: '', tools: [], state: 'done' },
      { id: 2, question: 'why?', text: 'Because.', reasoning: '', tools: [], state: 'done' },
    ] };
    const el = mount();
    expandToggle(el);
    const body = el.querySelector('.audit-fabry-body');
    const turns = [...body.querySelectorAll('.audit-fabry-turn')];
    expect(turns.length).toBe(2);
    // The input wrapper is the body's last child, after every turn.
    expect(body.lastElementChild.querySelector('.nl-search-input')).toBeTruthy();
    const lastTurn = turns[turns.length - 1];
    // Sanity: the last turn precedes the input in document order.
    expect(lastTurn.compareDocumentPosition(body.lastElementChild) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('an error turn shows an honest note when expanded', () => {
    store.fabry.value = { status: 'error', chatId: null, error: 'x', turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'error' }] };
    const el = mount();
    expandToggle(el);
    expect(el.textContent).toMatch(/could not answer/i);
  });

  it('Enter in the ask input calls askAuditFabry with the value', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [{ id: 1, question: null, text: 'x', reasoning: '', tools: [], state: 'done' }] };
    const el = mount();
    expandToggle(el);
    const input = el.querySelector('.nl-search-input');
    fireInput(input, 'who deleted users');
    fireEnter(input);
    expect(askAuditFabry).toHaveBeenCalledWith('who deleted users');
  });

  it('View investigation lives in the bar (sibling of the toggle, never nested inside it) and only shows once expanded with a done turn', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [{ id: 1, question: null, text: 'x', reasoning: 'because search', tools: ['search'], state: 'done' }] };
    const el = mount();
    // Collapsed: no "View investigation" affordance at all.
    expect(el.querySelector('.audit-fabry-tx')).toBeFalsy();
    expandToggle(el);
    const bar = el.querySelector('.audit-fabry-bar');
    const btn = bar.querySelector('.audit-fabry-tx');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('View investigation');
    // Must be a sibling of the toggle button, not nested inside it.
    const toggle = bar.querySelector('.audit-fabry-toggle');
    expect(toggle.contains(btn)).toBe(false);
    expect(btn.tagName).toBe('BUTTON');
    expect(toggle.tagName).toBe('BUTTON');
  });

  it('View investigation opens the transcript with the last done turn reasoning', async () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [{ id: 1, question: null, text: 'x', reasoning: 'because search', tools: ['search'], state: 'done' }] };
    const el = mount();
    expandToggle(el);
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('View investigation'));
    await act(() => { btn.click(); });
    expect(el.textContent).toContain('because search');
  });

  it('collapsing again hides the body', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [{ id: 1, question: null, text: 'x', reasoning: '', tools: [], state: 'done' }] };
    const el = mount();
    expandToggle(el); // expand
    expect(el.querySelector('.nl-search-input')).toBeTruthy();
    expandToggle(el); // collapse
    expect(el.querySelector('.nl-search-input')).toBeFalsy();
  });
});

describe('previewText', () => {
  it('null when there are no turns yet', () => {
    expect(previewText({ turns: [] })).toBeNull();
  });
  it('null when turn 0 is a Q&A turn (question set), not the default summary', () => {
    expect(previewText({ turns: [{ question: 'why?', state: 'done', text: 'Because.' }] })).toBeNull();
  });
  it('"summary unavailable" when turn 0 errored', () => {
    expect(previewText({ turns: [{ question: null, state: 'error', text: '' }] })).toBe('summary unavailable');
  });
  it('the first line of the text when present', () => {
    expect(previewText({ turns: [{ question: null, state: 'done', text: 'Takeaway line.\n- bullet\nNext step: go.' }] })).toBe('Takeaway line.');
  });
  it('a streaming placeholder while text is still empty', () => {
    expect(previewText({ turns: [{ question: null, state: 'streaming', text: '' }] })).toMatch(/summarizing/);
  });
  it('"summary unavailable" when turn 0 finished with no text (honest gap, not the idle hint)', () => {
    expect(previewText({ turns: [{ question: null, state: 'done', text: '' }] })).toBe('summary unavailable');
  });
});
