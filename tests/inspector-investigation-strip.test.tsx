// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/inspector/store.js';
import InvestigationStrip from '../src/inspector/components/InvestigationStrip.jsx';

function mount() { const el = document.createElement('div'); render(<InvestigationStrip />, el); return el; }

describe('InvestigationStrip', () => {
  beforeEach(() => { store.attributions.value = {}; store.synthesis.value = null; store.evidence.value = null; });
  it('gathering shows source progress and pending later stages', () => {
    store.investigation.value = { stage: 'gathering', sourcesDone: 3, sourcesTotal: 9, activity: '' };
    const el = mount();
    expect(el.textContent).toContain('3/9');
    expect(el.querySelectorAll('.inspector-inv-st.pend').length).toBe(2);
  });
  it('attributing shows AI finding progress and live activity', () => {
    store.investigation.value = { stage: 'attributing', sourcesDone: 9, sourcesTotal: 9, activity: '' };
    store.attributions.value = {
      a: { status: 'done', source: 'ai' }, b: { status: 'loading', source: 'ai', phase: 'reading extension code' }, c: { status: 'done', source: 'programmatic' },
    };
    const el = mount();
    expect(el.textContent).toContain('1 of 2');
    expect(el.textContent).toContain('reading extension code');
  });
  it('complete collapses to a stat line', () => {
    store.investigation.value = { stage: 'complete', sourcesDone: 9, sourcesTotal: 9, activity: '' };
    store.attributions.value = { a: { status: 'done', source: 'ai' } };
    const el = mount();
    expect(el.textContent).toMatch(/9 sources/);
    expect(el.textContent).toMatch(/1 attribution/);
  });
  it('idle renders nothing', () => {
    store.investigation.value = { stage: 'idle', sourcesDone: 0, sourcesTotal: 0, activity: '' };
    expect(mount().textContent).toBe('');
  });
});
