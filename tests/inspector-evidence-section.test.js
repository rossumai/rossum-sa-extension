// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';

import EvidenceSection from '../src/inspector/components/EvidenceSection.jsx';

function mount(vnode) {
  const el = document.createElement('div');
  render(vnode, el);
  return el;
}

describe('EvidenceSection', () => {
  it('renders title, count, status chip and children', () => {
    const el = mount(h(EvidenceSection, { id: 'intake', title: 'Intake & origin', count: 'email attachment', status: 'loaded' }, h('div', { class: 'kid' }, 'body')));
    expect(el.textContent).toContain('Intake & origin');
    expect(el.querySelector('.inspector-sst-loaded')).toBeTruthy();
    expect(el.querySelector('.kid')).toBeTruthy();
    expect(el.querySelector('[data-evidence-section="intake"]')).toBeTruthy();
  });
  it('toggles collapse on header click', () => {
    const el = mount(h(EvidenceSection, { id: 'x', title: 'T', status: 'na' }, h('div', { class: 'kid' })));
    el.querySelector('.inspector-esec-hd').click();
    expect(el.querySelector('.kid')).toBeFalsy();
  });
  it('n/a and pending render no children even when open', () => {
    const el = mount(h(EvidenceSection, { id: 'x', title: 'T', status: 'pending' }, h('div', { class: 'kid' })));
    expect(el.querySelector('.inspector-esec-skel')).toBeTruthy();
    expect(el.querySelector('.kid')).toBeFalsy();
  });
});
