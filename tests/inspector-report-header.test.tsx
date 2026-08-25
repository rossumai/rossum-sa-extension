// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/inspector/store.js';
import ReportHeader from '../src/inspector/components/ReportHeader.jsx';
import VerdictCard from '../src/inspector/components/VerdictCard.jsx';

function mount(vnode: any) { const el = document.createElement('div'); render(vnode, el); return el; }

describe('ReportHeader', () => {
  it('renders overview + timeline inside one card', () => {
    store.data.value = { annotation: { id: 9, status: 'to_review', created_at: '2026-07-01T09:14:00Z' }, blocker: null, content: null, resolved: { usersById: {}, hooksById: {} } };
    const el = mount(<ReportHeader />);
    expect(el.querySelector('.inspector-rephead')).toBeTruthy();
    expect(el.textContent).toContain('#9');
    expect(el.textContent).toContain('Created');
  });
});

describe('VerdictCard', () => {
  beforeEach(() => { store.evidence.value = null; });
  it('null evidence → renders nothing', () => {
    expect(mount(<VerdictCard />).textContent).toBe('');
  });
  it('renders headline, severity class, reasons with culprits', () => {
    store.evidence.value = { items: [], verdict: { state: 'blocked', severity: 'danger', headline: 'Not automated — 1 blocking error',
      reasons: [{ fact: 'po_number is empty', culprit: { kind: 'rule', id: 7, name: 'PO required' }, reliability: 'verified', evidenceId: 'blocker:0' }] } };
    const el = mount(<VerdictCard />);
    expect(el.querySelector('.inspector-verdict.sev-danger')).toBeTruthy();
    expect(el.textContent).toContain('Not automated');
    expect(el.textContent).toContain('PO required');
  });
});
