// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import * as store from '../src/inspector/store.js';
import DiagnosisPanel from '../src/inspector/components/DiagnosisPanel.jsx';
import narrativeStyles from '../src/ui/fabry/FabryNarrative.module.css';
import aiStyles from '../src/ui/aiInput.module.css';

function mount() { const el = document.createElement('div'); render(h(DiagnosisPanel, null), el); return el; }
const EV = { items: [{ id: 'blocker:0', section: 'blockers', fact: 'f', reliability: 'verified', culprit: null }], verdict: {} };

describe('DiagnosisPanel', () => {
  beforeEach(() => { store.evidence.value = EV; });
  it('null synthesis (still attributing) → skeleton', () => {
    store.synthesis.value = null;
    store.investigation.value = { stage: 'attributing', sourcesDone: 9, sourcesTotal: 9, activity: '' };
    expect(mount().querySelector('.inspector-esec-skel')).toBeTruthy();
  });
  it('null synthesis never leaves the panel blank, whatever the stage', () => {
    store.synthesis.value = null;
    for (const stage of ['idle', 'gathering', 'synthesizing', 'complete', 'agent-offline']) {
      store.investigation.value = { stage, sourcesDone: 0, sourcesTotal: 0, activity: '' };
      expect(mount().querySelector('.inspector-esec-skel')).toBeTruthy();
    }
  });
  it('streaming text renders resolvable citation chips, unresolvable struck', () => {
    store.synthesis.value = { status: 'streaming', text: 'Blocked [e:blocker:0] and [e:nope:1].', reasoning: '', tools: [], error: null };
    const el = mount();
    const chips = el.querySelectorAll('.' + narrativeStyles.cite);
    expect(chips.length).toBe(2);
    expect(chips[0].classList.contains(narrativeStyles.unresolved)).toBe(false);
    expect(chips[1].classList.contains(narrativeStyles.unresolved)).toBe(true);
  });
  it('renders "- " lines as a bullet list and credits Mr. Fabry', () => {
    store.synthesis.value = { status: 'done', text: 'Takeaway.\n- first [e:blocker:0]\n- second\nNext step: fix it.', reasoning: '', tools: [], error: null };
    const el = mount();
    const items = el.querySelectorAll('.' + narrativeStyles.list + ' li');
    expect(items.length).toBe(2);
    expect(items[0].querySelector('.' + narrativeStyles.cite)).toBeTruthy();
    expect(el.querySelectorAll('.' + narrativeStyles.body + ' p').length).toBe(2); // takeaway + next step
    expect(el.querySelector('.inspector-diag-credit').textContent).toContain('Mr. Fabry');
  });
  it('offline / error states render honest notes', () => {
    store.synthesis.value = { status: 'offline', text: '', reasoning: '', tools: [], error: null };
    expect(mount().textContent).toMatch(/unavailable/i);
    store.synthesis.value = { status: 'error', text: '', reasoning: '', tools: [], error: 'boom' };
    expect(mount().textContent).toMatch(/failed/i);
  });
  it('done state shows View investigation toggle with reasoning', async () => {
    store.synthesis.value = { status: 'done', text: 'All good.', reasoning: 'because logs', tools: ['rossum_get_hook'], error: null };
    const el = mount();
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('View investigation'));
    await act(() => {
      btn.click();
    });
    expect(el.textContent).toContain('because logs');
  });
});

describe('FollowupThread', () => {
  it('done synthesis with a chatId shows the ask input; without one it does not', () => {
    store.synthesis.value = { status: 'done', text: 'Done.', reasoning: '', tools: [], chatId: 'c1', followups: [], error: null };
    expect(mount().querySelector('.inspector-ask input')).toBeTruthy();
    store.synthesis.value = { status: 'done', text: 'Done.', reasoning: '', tools: [], error: null };
    expect(mount().querySelector('.inspector-ask')).toBeFalsy();
  });
  it('renders the Q&A thread with citations and disables the input while streaming', () => {
    store.synthesis.value = { status: 'done', text: 'Done.', reasoning: '', tools: [], chatId: 'c1', error: null, followups: [
      { q: 'why empty?', text: 'Because [e:blocker:0].', status: 'done' },
      { q: 'and next?', text: '', status: 'streaming' },
    ] };
    const el = mount();
    const qs = el.querySelectorAll('.inspector-followup-q');
    expect(qs.length).toBe(2);
    expect(qs[0].textContent).toContain('why empty?');
    expect(el.querySelector('.inspector-followup .' + narrativeStyles.cite)).toBeTruthy();
    expect(el.querySelector('.inspector-ask input').disabled).toBe(true);
    expect(el.querySelector('.' + aiStyles.loader)).toBeTruthy();
  });
});
