// tests/audit-fabry-panel.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import narrativeStyles from '../src/ui/fabry/FabryNarrative.module.css';
import aiStyles from '../src/ui/aiInput.module.css';

const askAuditFabry = vi.fn();
const runDefaultSummary = vi.fn();
const refreshSummary = vi.fn();
// Mutable — tests point it at whatever "current view" they want; the mocked
// viewSignature() always returns the live value, so mutating it between
// renders simulates the filters changing underneath the panel.
let sigValue = 'sig-1';
const viewSignatureSpy = vi.fn(() => sigValue);
vi.mock('../src/audit/index.jsx', () => ({
  askAuditFabry: (...a: any[]) => askAuditFabry(...a),
  runDefaultSummary: (...a: any[]) => runDefaultSummary(...a),
  refreshSummary: (...a: any[]) => refreshSummary(...a),
  viewSignature: (...a: any[]) => (viewSignatureSpy as any)(...a),
}));

import FabryPanel, { previewText } from '../src/audit/components/FabryPanel.jsx';
import * as store from '../src/audit/store.js';

const fireInput = (el: any, v: any) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const fireEnter = (el: any) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

let root: any;
beforeEach(() => {
  vi.clearAllMocks();
  store.resetFabry();
  store.availability.value = 'available';
  sigValue = 'sig-1';
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});
function mount() {
  render(<FabryPanel />, root);
  return root;
}
function expandToggle(el: any) {
  act(() => {
    el.querySelector('.audit-fabry-toggle').click();
  });
}

describe('FabryPanel', () => {
  it('collapsed by default: shows the toggle but no ask input or turns', () => {
    const el = mount();
    expect(el.querySelector('.audit-fabry-toggle')).toBeTruthy();
    expect(el.querySelector('.' + aiStyles.input)).toBeFalsy();
    expect(el.querySelector('.audit-fabry-turn')).toBeFalsy();
  });

  it('collapsed bar shows the Fabry-generated takeaway line as the preview, dropping the rest', () => {
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [
        {
          id: 1,
          question: null,
          text: 'Quiet page: 42 events.\n- a\n- b\nNext step: x.',
          reasoning: '',
          tools: [],
          state: 'done',
        },
      ],
    };
    const el = mount();
    const preview = el.querySelector('.audit-fabry-preview');
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('Quiet page: 42 events.');
    expect(preview.textContent).not.toContain('Next step');
  });

  it('collapsed bar shows a streaming placeholder while the summary is still generating', () => {
    store.fabry.value = {
      status: 'running',
      chatId: null,
      error: null,
      forView: null,
      turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'streaming' }],
    };
    const el = mount();
    const preview = el.querySelector('.audit-fabry-preview');
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('summarizing');
  });

  it('preview is hidden once the band is expanded', () => {
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [
        { id: 1, question: null, text: 'Quiet page.', reasoning: '', tools: [], state: 'done' },
      ],
    };
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
    expect(el.querySelector('.' + aiStyles.input)).toBeTruthy();
    expect(runDefaultSummary).toHaveBeenCalledTimes(1);
  });

  it('expanding when a summary already exists does not re-run it', () => {
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [
        {
          id: 1,
          question: null,
          text: 'Takeaway.\n- one\nNext step: go.',
          reasoning: 'r',
          tools: [],
          state: 'done',
        },
      ],
    };
    const el = mount();
    expandToggle(el);
    expect(el.querySelector('.' + aiStyles.input)).toBeTruthy();
    expect(el.querySelector('.audit-fabry-turn')).toBeTruthy();
    expect(runDefaultSummary).not.toHaveBeenCalled();
  });

  it('renders the default summary and a Q&A turn when expanded', () => {
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [
        {
          id: 1,
          question: null,
          text: 'Takeaway.\n- one\n- two\nNext step: go.',
          reasoning: 'r',
          tools: ['search'],
          state: 'done',
        },
        { id: 2, question: 'why?', text: 'Because.', reasoning: '', tools: [], state: 'done' },
      ],
    };
    const el = mount();
    expandToggle(el);
    expect(el.querySelectorAll('.' + narrativeStyles.list + ' li').length).toBe(2);
    const roles = [...el.querySelectorAll('.inspector-followup-role')].map((n) => n.textContent);
    expect(roles[0]).toContain('Latest activity');
    expect(roles[1]).toContain('You');
    expect(el.textContent).toContain('why?');
    expect(el.querySelector('.inspector-diag-credit').textContent).toContain('Mr. Fabry');
  });

  it('chat order: the thread reads top-down with the ask input last', () => {
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [
        {
          id: 1,
          question: null,
          text: 'Takeaway.\n- one\nNext step: go.',
          reasoning: '',
          tools: [],
          state: 'done',
        },
        { id: 2, question: 'why?', text: 'Because.', reasoning: '', tools: [], state: 'done' },
      ],
    };
    const el = mount();
    expandToggle(el);
    const body = el.querySelector('.audit-fabry-body');
    const turns = [...body.querySelectorAll('.audit-fabry-turn')];
    expect(turns.length).toBe(2);
    // The input wrapper is the body's last child, after every turn.
    expect(body.lastElementChild.querySelector('.' + aiStyles.input)).toBeTruthy();
    const lastTurn = turns[turns.length - 1];
    // Sanity: the last turn precedes the input in document order.
    expect(
      lastTurn.compareDocumentPosition(body.lastElementChild) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('an error turn shows an honest note when expanded', () => {
    store.fabry.value = {
      status: 'error',
      chatId: null,
      error: 'x',
      forView: null,
      turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'error' }],
    };
    const el = mount();
    expandToggle(el);
    expect(el.textContent).toMatch(/could not answer/i);
  });

  it('Enter in the ask input calls askAuditFabry with the value', () => {
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [{ id: 1, question: null, text: 'x', reasoning: '', tools: [], state: 'done' }],
    };
    const el = mount();
    expandToggle(el);
    const input = el.querySelector('.' + aiStyles.input);
    fireInput(input, 'who deleted users');
    fireEnter(input);
    expect(askAuditFabry).toHaveBeenCalledWith('who deleted users');
  });

  it('View investigation lives in the bar (sibling of the toggle, never nested inside it) and only shows once expanded with a done turn', () => {
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [
        {
          id: 1,
          question: null,
          text: 'x',
          reasoning: 'because search',
          tools: ['search'],
          state: 'done',
        },
      ],
    };
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
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [
        {
          id: 1,
          question: null,
          text: 'x',
          reasoning: 'because search',
          tools: ['search'],
          state: 'done',
        },
      ],
    };
    const el = mount();
    expandToggle(el);
    const btn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent.includes('View investigation'),
    );
    await act(() => {
      btn.click();
    });
    expect(el.textContent).toContain('because search');
  });

  it('collapsing again hides the body', () => {
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: null,
      turns: [{ id: 1, question: null, text: 'x', reasoning: '', tools: [], state: 'done' }],
    };
    const el = mount();
    expandToggle(el); // expand
    expect(el.querySelector('.' + aiStyles.input)).toBeTruthy();
    expandToggle(el); // collapse
    expect(el.querySelector('.' + aiStyles.input)).toBeFalsy();
  });
});

describe('FabryPanel — stale summary (view changed since it was computed)', () => {
  it('collapsed + stale (forView mismatches the live view signature): shows the "view changed" marker next to the preview', () => {
    sigValue = 'sig-A';
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: 'sig-OLD',
      turns: [
        { id: 1, question: null, text: 'Quiet page.', reasoning: '', tools: [], state: 'done' },
      ],
    };
    const el = mount();
    expect(el.querySelector('.audit-fabry-preview')).toBeTruthy();
    expect(el.querySelector('.audit-fabry-stale')).toBeTruthy();
  });

  it('collapsed + not stale (forView matches the live view signature): no marker', () => {
    sigValue = 'sig-A';
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: 'sig-A',
      turns: [
        { id: 1, question: null, text: 'Quiet page.', reasoning: '', tools: [], state: 'done' },
      ],
    };
    const el = mount();
    expect(el.querySelector('.audit-fabry-preview')).toBeTruthy();
    expect(el.querySelector('.audit-fabry-stale')).toBeFalsy();
  });

  it('expanding a stale summary calls refreshSummary, not runDefaultSummary', () => {
    // Note: this drives toggle()'s explicit `else if (stale) refreshSummary()`
    // branch. The bare mock here has no side effect on store.fabry, so the
    // auto-refresh effect (open && stale && avail==='available' && !busy)
    // also fires on the same open transition and calls it again — in the
    // real implementation refreshSummary marks a turn 'streaming' synchronously
    // (before its first await), so by the time the effect re-evaluates `busy`
    // it is already true and the effect no-ops. Assert "called", not an exact
    // count, since that synchronous self-guard isn't modeled by a bare mock.
    sigValue = 'sig-A';
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: 'sig-OLD',
      turns: [
        { id: 1, question: null, text: 'Quiet page.', reasoning: '', tools: [], state: 'done' },
      ],
    };
    const el = mount();
    expandToggle(el);
    expect(refreshSummary).toHaveBeenCalled();
    expect(runDefaultSummary).not.toHaveBeenCalled();
  });

  it('expanding a summary that is NOT stale re-runs neither runDefaultSummary nor refreshSummary', () => {
    sigValue = 'sig-A';
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: 'sig-A',
      turns: [
        { id: 1, question: null, text: 'Quiet page.', reasoning: '', tools: [], state: 'done' },
      ],
    };
    const el = mount();
    expandToggle(el);
    expect(refreshSummary).not.toHaveBeenCalled();
    expect(runDefaultSummary).not.toHaveBeenCalled();
  });

  it('already open: becomes stale once rows land (availability -> available) and auto-triggers refreshSummary via the effect', async () => {
    sigValue = 'sig-1';
    store.availability.value = 'unknown'; // refetch in flight — must not seed yet
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: 'sig-1',
      turns: [
        { id: 1, question: null, text: 'Quiet page.', reasoning: '', tools: [], state: 'done' },
      ],
    };
    const el = mount();
    expandToggle(el); // open; not stale yet (forView === sigValue) so no call from toggle()
    expect(refreshSummary).not.toHaveBeenCalled();

    sigValue = 'sig-2'; // the filters changed underneath the open panel
    await act(async () => {
      store.availability.value = 'available';
    }); // new rows have landed
    expect(refreshSummary).toHaveBeenCalledTimes(1);
  });

  it('does not auto-refresh while a turn is already streaming, even once stale and available', async () => {
    sigValue = 'sig-1';
    store.availability.value = 'available';
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: 'sig-1',
      turns: [
        { id: 1, question: null, text: 'Quiet page.', reasoning: '', tools: [], state: 'done' },
      ],
    };
    const el = mount();
    expandToggle(el); // open; not stale, so no call yet
    expect(refreshSummary).not.toHaveBeenCalled();

    sigValue = 'sig-2'; // now stale
    await act(async () => {
      store.fabry.value = {
        ...store.fabry.value,
        status: 'running',
        turns: [
          ...store.fabry.value.turns,
          { id: 2, question: null, text: '', reasoning: '', tools: [], state: 'streaming' },
        ],
      };
    });
    // stale + open + available, but busy (a turn is streaming) — the effect must not fire.
    expect(refreshSummary).not.toHaveBeenCalled();
  });

  it('preview shows the LAST summary turn once a refresh has appended a second one', () => {
    sigValue = 'sig-1';
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: 'sig-1',
      turns: [
        {
          id: 1,
          question: null,
          text: 'Old takeaway.\n- a\nNext step: x.',
          reasoning: '',
          tools: [],
          state: 'done',
        },
        {
          id: 2,
          question: null,
          text: 'New takeaway.\n- b\nNext step: y.',
          reasoning: '',
          tools: [],
          state: 'done',
        },
      ],
    };
    const el = mount();
    const preview = el.querySelector('.audit-fabry-preview');
    expect(preview.textContent).toContain('New takeaway.');
    expect(preview.textContent).not.toContain('Old takeaway.');
  });

  // Fix 1: an unbounded auto-retry loop. A failed refresh leaves `forView`
  // stale-mismatched forever; without a give-up marker the effect (stale &&
  // available && !busy) would re-fire the instant `busy` flips back to false.
  it('auto-refresh effect skips a view whose refreshFailedFor already matches the live signature; re-arms once filters change again', async () => {
    sigValue = 'sig-1';
    store.availability.value = 'available';
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: null,
      forView: 'sig-1',
      refreshFailedFor: null,
      turns: [
        { id: 1, question: null, text: 'Quiet page.', reasoning: '', tools: [], state: 'done' },
      ],
    };
    const el = mount();
    expandToggle(el); // open while NOT stale (forView === sigValue) -> toggle() takes no action
    expect(refreshSummary).not.toHaveBeenCalled();

    // A refresh for the CURRENT view just failed: forView is now stale again,
    // and refreshFailedFor marks this exact signature as already attempted —
    // the effect must not auto-retry it.
    await act(async () => {
      store.fabry.value = {
        ...store.fabry.value,
        status: 'error',
        error: 'boom',
        forView: 'sig-OLD-before-fail',
        refreshFailedFor: 'sig-1',
      };
    });
    expect(refreshSummary).not.toHaveBeenCalled();

    // The user changes filters again -> new live signature -> the stale
    // refreshFailedFor ('sig-1') no longer matches -> auto-refresh re-arms.
    sigValue = 'sig-2';
    await act(async () => {
      store.fabry.value = { ...store.fabry.value };
    }); // force a render pass
    expect(refreshSummary).toHaveBeenCalledTimes(1);
  });

  it('expand-click still retries manually even when refreshFailedFor already matches the live signature', () => {
    sigValue = 'sig-1';
    store.availability.value = 'available';
    store.fabry.value = {
      status: 'error',
      chatId: 'c1',
      error: 'boom',
      forView: 'sig-OLD',
      refreshFailedFor: 'sig-1',
      turns: [
        { id: 1, question: null, text: 'Quiet page.', reasoning: '', tools: [], state: 'error' },
      ],
    };
    const el = mount();
    expandToggle(el); // open while already stale -> toggle()'s explicit branch retries regardless of refreshFailedFor
    expect(refreshSummary).toHaveBeenCalled();
  });
});

describe('previewText', () => {
  it('null when there are no turns yet', () => {
    expect(previewText({ turns: [] })).toBeNull();
  });
  it('null when turn 0 is a Q&A turn (question set), not the default summary', () => {
    expect(
      previewText({ turns: [{ question: 'why?', state: 'done', text: 'Because.' }] }),
    ).toBeNull();
  });
  it('"summary unavailable" when turn 0 errored', () => {
    expect(previewText({ turns: [{ question: null, state: 'error', text: '' }] })).toBe(
      'summary unavailable',
    );
  });
  it('the first line of the text when present', () => {
    expect(
      previewText({
        turns: [
          { question: null, state: 'done', text: 'Takeaway line.\n- bullet\nNext step: go.' },
        ],
      }),
    ).toBe('Takeaway line.');
  });
  it('a streaming placeholder while text is still empty', () => {
    expect(previewText({ turns: [{ question: null, state: 'streaming', text: '' }] })).toMatch(
      /summarizing/,
    );
  });
  it('"summary unavailable" when turn 0 finished with no text (honest gap, not the idle hint)', () => {
    expect(previewText({ turns: [{ question: null, state: 'done', text: '' }] })).toBe(
      'summary unavailable',
    );
  });
  it('returns the LAST summary turn (question:null) when a refresh appended one after Q&A turns', () => {
    expect(
      previewText({
        turns: [
          { question: null, state: 'done', text: 'Old.\n- a\nNext step: x.' },
          { question: 'why?', state: 'done', text: 'Because.' },
          { question: null, state: 'done', text: 'New.\n- b\nNext step: y.' },
        ],
      }),
    ).toBe('New.');
  });

  // Fix 2: the last attempt can itself be a failure while an earlier summary
  // already produced good text — that earlier takeaway must not be masked.
  it('falls back to the last GOOD summary when the latest refresh attempt errored', () => {
    expect(
      previewText({
        turns: [
          { question: null, state: 'done', text: 'Old takeaway.\n- x' },
          { question: null, state: 'error', text: '' },
        ],
      }),
    ).toBe('Old takeaway.');
  });
  it('"summary unavailable" when the only summary ever attempted errored', () => {
    expect(previewText({ turns: [{ question: null, state: 'error', text: '' }] })).toBe(
      'summary unavailable',
    );
  });
  it('while a refresh is streaming, shows the streaming placeholder even though an earlier summary has good text', () => {
    expect(
      previewText({
        turns: [
          { question: null, state: 'done', text: 'Old.\n- x' },
          { question: null, state: 'streaming', text: '' },
        ],
      }),
    ).toMatch(/summarizing/);
  });
});
