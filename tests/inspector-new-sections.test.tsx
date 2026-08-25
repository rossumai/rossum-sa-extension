// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/inspector/store.js';
import IntakeSection from '../src/inspector/components/IntakeSection.jsx';
import WorkflowSection from '../src/inspector/components/WorkflowSection.jsx';
import DriftSection from '../src/inspector/components/DriftSection.jsx';

function mount(vnode: any) {
  const el = document.createElement('div');
  render(vnode, el);
  return el;
}

describe('IntakeSection', () => {
  it('renders intake items with data-evidence-id anchors', () => {
    store.data.value = {
      annotation: { id: 1 },
      blocker: null,
      content: null,
      resolved: { _intakeLoaded: true },
    };
    store.evidence.value = {
      verdict: {},
      items: [
        {
          id: 'intake:arrival',
          section: 'intake',
          fact: 'document arrived as an email attachment',
          reliability: 'verified',
          culprit: null,
          data: {},
        },
      ],
    };
    const el = mount(<IntakeSection />);
    expect(el.querySelector('[data-evidence-id="intake:arrival"]')).toBeTruthy();
    expect(el.textContent).toContain('email attachment');
  });
  it('no intake items but loaded → n/a status, no body', () => {
    store.data.value = {
      annotation: { id: 1 },
      blocker: null,
      content: null,
      resolved: { _intakeLoaded: true },
    };
    store.evidence.value = { verdict: {}, items: [] };
    const el = mount(<IntakeSection />);
    expect(el.querySelector('.inspector-sst-na')).toBeTruthy();
  });
  it('_intakeLoaded not yet set → pending status, even with evidence present', () => {
    store.data.value = { annotation: { id: 1 }, blocker: null, content: null, resolved: {} };
    store.evidence.value = {
      verdict: {},
      items: [
        {
          id: 'intake:arrival',
          section: 'intake',
          fact: 'document arrived as an email attachment',
          reliability: 'verified',
          culprit: null,
          data: {},
        },
      ],
    };
    const el = mount(<IntakeSection />);
    expect(el.querySelector('.inspector-sst-pending')).toBeTruthy();
  });
});

describe('WorkflowSection', () => {
  it('renders run + steps, current step highlighted', () => {
    store.data.value = {
      annotation: { id: 1 },
      blocker: null,
      content: null,
      resolved: { _workflowLoaded: true },
    };
    store.evidence.value = {
      verdict: {},
      items: [
        {
          id: 'workflow:run',
          section: 'workflow',
          fact: 'approval workflow status "in_review"',
          reliability: 'verified',
          culprit: null,
          data: { status: 'in_review' },
        },
        {
          id: 'workflow:step:3',
          section: 'workflow',
          fact: 'step 2 "Finance"',
          reliability: 'verified',
          culprit: null,
          data: { current: true },
        },
      ],
    };
    const el = mount(<WorkflowSection />);
    expect(el.textContent).toContain('in_review');
    expect(el.querySelector('.inspector-wf-current')).toBeTruthy();
  });
  it('_workflowLoaded not yet set → pending status, even with evidence present', () => {
    store.data.value = { annotation: { id: 1 }, blocker: null, content: null, resolved: {} };
    store.evidence.value = {
      verdict: {},
      items: [
        {
          id: 'workflow:run',
          section: 'workflow',
          fact: 'approval workflow status "in_review"',
          reliability: 'verified',
          culprit: null,
          data: { status: 'in_review' },
        },
      ],
    };
    const el = mount(<WorkflowSection />);
    expect(el.querySelector('.inspector-sst-pending')).toBeTruthy();
  });
});

describe('DriftSection', () => {
  beforeEach(() => {
    store.live.value = null;
    store.data.value = {
      annotation: { id: 1, messages: [{ type: 'error', content: 'A' }] },
      blocker: null,
      content: null,
      resolved: {},
    };
  });
  it('idle → opt-in button and lock note', () => {
    const el = mount(<DriftSection />);
    expect(el.textContent).toMatch(/Re-evaluate/);
    expect(el.textContent).toMatch(/reviewing lock/i);
  });
  it('after a live run → renders the diff', () => {
    store.live.value = { messages: [{ type: 'error', content: 'B' }], matchedTriggerRules: [] };
    const el = mount(<DriftSection />);
    expect(el.textContent).toContain('B'); // added
    expect(el.textContent).toContain('A'); // removed
    expect(el.textContent).toMatch(/added|removed/i);
  });
  it('two added messages get distinct, unique data-evidence-id anchors', () => {
    store.data.value = {
      annotation: { id: 1, messages: [] },
      blocker: null,
      content: null,
      resolved: {},
    };
    store.live.value = {
      messages: [
        { type: 'error', content: 'B1' },
        { type: 'error', content: 'B2' },
      ],
      matchedTriggerRules: [],
    };
    const el = mount(<DriftSection />);
    const anchors = [...el.querySelectorAll('[data-evidence-id^="drift:added:"]')].map((n) =>
      n.getAttribute('data-evidence-id'),
    );
    expect(anchors).toEqual(['drift:added:0', 'drift:added:1']);
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});
