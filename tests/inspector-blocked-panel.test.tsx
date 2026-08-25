// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import BlockedPanel from '../src/inspector/components/BlockedPanel.jsx';
import { messageKey, blockerKey } from '../src/inspector/orchestrate.js';
import * as store from '../src/inspector/store.js';

let root: any;
beforeEach(() => { store.reset(); store.setAnnotationId('1'); root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });

describe('BlockedPanel message attribution', () => {
  it('renders a self-attributed error message culprit (verified, no agent)', () => {
    store.data.value = { annotation: { id: 1, messages: [{ type: 'error', content: 'Bad', detail: { hook_id: 5, hook_name: 'H' } }] }, blocker: { content: [] }, resolved: { queue: null } };
    render(<BlockedPanel />, root);
    expect(root.textContent).toContain('Bad');
    expect(root.textContent).toContain('H');
  });
  it('renders an orchestrator-fed AI culprit + explanation for an unattributed message', () => {
    store.data.value = { annotation: { id: 1, messages: [{ type: 'error', content: 'Mystery', detail: { request_id: 'r1' } }] }, blocker: { content: [] }, resolved: { queue: null } };
    store.setAttribution(messageKey(0), { status: 'done', verdict: { culprit: { kind: 'hook', id: 9, name: 'Guesser' }, confidence: 'medium', explanation: 'emits this on total mismatch' }, source: 'ai' });
    render(<BlockedPanel />, root);
    expect(root.textContent).toContain('Guesser');
    expect(root.textContent).toContain('emits this on total mismatch');
  });
  it('shows the live phase while an unattributed message is being reasoned', () => {
    store.data.value = { annotation: { id: 1, messages: [{ type: 'error', content: 'M', detail: {} }] }, blocker: { content: [] }, resolved: { queue: null } };
    store.setAttribution(messageKey(0), { status: 'loading', phase: 'reading extension logs', source: 'ai' });
    render(<BlockedPanel />, root);
    expect(root.textContent).toContain('reading extension logs');
  });
  it('renders a programmatic (verified) message culprit from its request_id correlation', () => {
    store.data.value = { annotation: { id: 1, messages: [{ type: 'error', content: 'M', detail: { request_id: 'r1' } }] }, blocker: { content: [] }, resolved: { queue: null } };
    store.setAttribution(messageKey(0), { status: 'done', verdict: { culprit: { kind: 'hook', id: 5, name: 'Correlated' }, confidence: null, explanation: '' }, reliability: 'best-effort', source: 'programmatic' });
    render(<BlockedPanel />, root);
    expect(root.textContent).toContain('Correlated'); // programmatic culprit rendered (no AI)
  });
  it('renders the AI explanation for a non-standard blocker', () => {
    store.data.value = { annotation: { id: 1, messages: [] }, blocker: { content: [{ type: 'custom_weird_blocker' }] }, resolved: { queue: null } };
    store.setAttribution(blockerKey(0), { status: 'done', verdict: { culprit: null, confidence: 'low', explanation: 'means the ERP link is misconfigured' }, source: 'ai' });
    render(<BlockedPanel />, root);
    expect(root.textContent).toContain('custom_weird_blocker');
    expect(root.textContent).toContain('means the ERP link is misconfigured');
  });
});
