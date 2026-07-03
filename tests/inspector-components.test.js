// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';
import ReliabilityBadge from '../src/inspector/components/ReliabilityBadge.jsx';
import IdInput from '../src/inspector/components/IdInput.jsx';
import IdLabel from '../src/inspector/components/IdLabel.jsx';
import LabelsPanel from '../src/inspector/components/LabelsPanel.jsx';
import BlockedPanel from '../src/inspector/components/BlockedPanel.jsx';
import PipelinePanel from '../src/inspector/components/PipelinePanel.jsx';
import FoldableCode from '../src/inspector/components/FoldableCode.jsx';
import App from '../src/inspector/components/App.jsx';
import * as store from '../src/inspector/store.js';

let root;
beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); store.reset(); });
afterEach(() => { render(null, root); root.remove(); });

describe('inspector components', () => {
  it('ReliabilityBadge shows only "Not recorded"; hides verified + best-effort', () => {
    render(h(ReliabilityBadge, { level: 'verified' }), root);
    expect(root.querySelector('.inspector-rb')).toBe(null);
    render(null, root);
    render(h(ReliabilityBadge, { level: 'best-effort' }), root);
    expect(root.querySelector('.inspector-rb')).toBe(null);
    render(null, root);
    render(h(ReliabilityBadge, { level: 'unavailable' }), root);
    expect(root.querySelector('.inspector-rb-unavailable')).toBeTruthy();
  });

  it('IdInput extracts the id from a Rossum URL', () => {
    const onSubmit = vi.fn();
    render(h(IdInput, { onSubmit }), root);
    const input = root.querySelector('input');
    input.value = 'https://acme.rossum.app/document/133641827';
    root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith('133641827');
  });

  it('IdLabel shows the name, keeps the id in a tooltip, and copies it on click', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(h(IdLabel, { name: 'Vendor Invoices — US', id: '3760880', prefix: 'queue ' }), root);
    const el = root.querySelector('.inspector-idlabel');
    expect(el.textContent).toContain('Vendor Invoices');
    expect(el.textContent).not.toContain('3760880'); // id is not shown as the label
    expect(el.getAttribute('title')).toContain('3760880'); // id is in the tooltip
    el.click();
    expect(writeText).toHaveBeenCalledWith('3760880');
  });

  it('IdLabel falls back to the id when no name resolved (never a wrong name)', () => {
    render(h(IdLabel, { name: null, id: '99', prefix: 'user ' }), root);
    expect(root.querySelector('.inspector-idlabel').textContent).toContain('user 99');
  });

  it('LabelsPanel attributes an applied label to its governing rule', () => {
    store.setAnnotationId('5');
    store.data.value = {
      annotation: { id: 5, labels: ['https://h/v1/labels/9898'] },
      blocker: null, content: { content: [] },
      resolved: {
        queue: null, schema: null, document: null, usersById: {}, hooksById: {}, rulesById: {},
        labelsById: { 9898: { id: '9898', name: 'Priority: High', color: '#ff0000' } },
        labelRules: [{ ruleId: 7, ruleName: 'Tag high value', trigger: 'field.amount_total > 10000', labelIds: ['9898'] }],
      },
    };
    render(h(LabelsPanel, null), root);
    expect(root.textContent).toContain('Priority: High');
    expect(root.textContent).toContain('Tag high value');
    expect(root.textContent).toContain('field.amount_total > 10000');
  });

  it('LabelsPanel defers a non-rule label to AI attribution (unavailable when the agent is offline)', () => {
    store.setAnnotationId('6');
    store.aiAvailable.value = false; // agent offline in this test — no regex fallback anymore
    store.data.value = {
      annotation: { id: 6, labels: ['https://h/v1/labels/3878'] },
      blocker: null, content: { content: [] },
      resolved: {
        queue: null, schema: null, document: null, usersById: {}, hooksById: {}, rulesById: {},
        labelsById: { 3878: { id: '3878', name: 'Needs review', color: '#16a34a' } },
        labelRules: [],
      },
    };
    render(h(LabelsPanel, null), root);
    expect(root.textContent).toContain('Needs review');
    expect(root.textContent).toContain('AI attribution unavailable');
    // The footer must not contradict the per-label attribution card: with a
    // label applied and no rule, it states only the verified rule fact and
    // never claims "no extension applies labels" / "set manually".
    expect(root.textContent).not.toContain('set manually');
    expect(root.textContent).not.toContain('extension applies labels');
    expect(root.textContent).toContain('No queue rule governs labels');
  });

  it('FoldableCode shows short code inline, folds long code behind a toggle', () => {
    render(h(FoldableCode, { code: 'field.x > 1' }), root);
    expect(root.querySelector('.inspector-code')).toBeTruthy();
    expect(root.querySelector('.inspector-fold-btn')).toBe(null);
    render(null, root);
    render(h(FoldableCode, { code: 'import math\nx = round(field.amount_total_base + field.amount_total_tax, 2)\nif x != field.amount_total: pass' }), root);
    expect(root.querySelector('.inspector-fold-btn')).toBeTruthy();
    expect(root.querySelector('.inspector-code-block')).toBe(null); // collapsed by default
  });

  it('applied label renders as a colored tag using its real color', () => {
    store.setAnnotationId('7');
    store.data.value = {
      annotation: { id: 7, labels: ['https://h/v1/labels/9898'] },
      blocker: null, content: { content: [] },
      resolved: {
        queue: null, schema: null, document: null, usersById: {}, hooksById: {}, rulesById: {},
        labelsById: { 9898: { id: '9898', name: 'Priority: High', color: '#dc2626' } },
        labelRules: [],
      },
    };
    render(h(LabelsPanel, null), root);
    const tag = root.querySelector('.inspector-label-tag');
    expect(tag).toBeTruthy();
    // jsdom normalizes #dc2626 -> rgb(220, 38, 38)
    expect(tag.getAttribute('style')).toContain('rgb(220, 38, 38)');
  });

  it('BlockedPanel separates blocking errors from non-blocking warnings/info', () => {
    store.setAnnotationId('8');
    store.data.value = {
      annotation: { id: 8, messages: [
        { type: 'error', content: 'Hard fail', detail: { hook_id: 1, hook_name: 'Pre: H', is_exception: true } },
        { type: 'warning', content: 'Soft note', detail: { rule_id: 2, rule_name: 'R', hook_name: 'rules' } },
      ] },
      blocker: { content: [] }, content: { content: [] },
      resolved: { queue: null, schema: null, document: null, usersById: {}, hooksById: {}, rulesById: {} },
    };
    render(h(BlockedPanel, null), root);
    const txt = root.textContent;
    expect(txt).toMatch(/Error messages \(1\)/);
    expect(txt).toMatch(/block automation/);
    expect(txt).toMatch(/Other messages \(1\)/);
    expect(txt).toMatch(/do not block automation/);
    expect(txt).toContain('Hard fail');
    expect(txt).toContain('Soft note');
  });

  it('PipelinePanel shows the extension pipeline with run-status overlay', () => {
    store.setAnnotationId('10');
    store.enrichment.value = { ...store.enrichment.value, hookLogs: [{ hook_id: 4, action: 'export', status: 'failed', log_level: 'ERROR', message: 'boom', start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T00:00:00.010Z' }] };
    store.data.value = {
      annotation: { id: 10, queue: 'https://h/v1/queues/3' }, blocker: null, content: { content: [] },
      resolved: {
        queue: null, schema: null, document: null, usersById: {}, rulesById: {}, _hooksLoaded: true,
        hooksById: {
          1: { id: 1, name: 'Init hook', type: 'function', active: true, events: ['annotation_content.initialize'], run_after: [] },
          4: { id: 4, name: 'Export push', type: 'webhook', active: true, events: ['annotation_content.export'], run_after: [] },
        },
      },
    };
    render(h(PipelinePanel, null), root);
    const txt = root.textContent;
    expect(txt).toContain('Init hook');
    expect(txt).toContain('Export push');
    expect(txt).toMatch(/failed/);
    expect(txt).toContain('boom');
  });

  it('App lists Field provenance as the last tab', () => {
    store.setAnnotationId('9');
    store.data.value = {
      annotation: { id: 9, status: 'to_review', automation_blocker: null, messages: [] },
      blocker: null, content: { content: [] },
      resolved: { queue: null, schema: null, document: null, usersById: {}, hooksById: {}, rulesById: {} },
    };
    render(h(App, { connected: true }), root);
    const tabs = [...root.querySelectorAll('.inspector-tab')].map((b) => b.textContent.trim());
    expect(tabs[tabs.length - 1]).toBe('Field provenance');
    expect(tabs).toContain('Why export failed');
  });

  it('App shows a not-connected message when connected=false', () => {
    render(h(App, { connected: false }), root);
    expect(root.textContent).toMatch(/not connected|reconnect|Rossum/i);
  });

  it('App nests content as .app-root > main.main > .inspector-root (so it is not laid out as a flex row)', () => {
    // Regression: .app-root is `display:flex` in console.css. Putting the
    // stacked report content directly on .app-root laid IdInput + report out
    // side-by-side. The content must live inside a nested column container.
    render(h(App, { connected: true }), root);
    const nested = root.querySelector('.app-root > main.main > .inspector-root');
    expect(nested).toBeTruthy();
    expect(nested.classList.contains('app-root')).toBe(false);
  });

  it('App renders the culprit of a hook message once data is loaded', () => {
    store.setAnnotationId('5');
    store.data.value = {
      annotation: {
        id: 5, status: 'to_review', automation_blocker: null,
        messages: [{ type: 'error', content: 'HostNotFound', detail: { hook_id: 1791439, hook_name: 'Pre: Duplicate detector', is_exception: true } }],
      },
      blocker: null,
      content: { content: [] },
      resolved: { queue: { automation_level: 'never' }, schema: null, usersById: {}, hooksById: {}, rulesById: {} },
    };
    render(h(App, { connected: true }), root);
    expect(root.textContent).toMatch(/Pre: Duplicate detector/);
  });
});
