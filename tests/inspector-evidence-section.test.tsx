// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';
import { act } from 'preact/test-utils';
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((cb) => { cb(0); return 0; });

import EvidenceSection from '../src/inspector/components/EvidenceSection.jsx';

function mount(vnode: any) {
  const el = document.createElement('div');
  render(vnode, el);
  return el;
}

describe('EvidenceSection', () => {
  it('renders title, count, status chip and children', () => {
    const el = mount(<EvidenceSection
      id="intake"
      title={'Intake & origin'}
      count="email attachment"
      status="loaded"
    >
      <div class="kid">body</div>
    </EvidenceSection>);
    expect(el.textContent).toContain('Intake & origin');
    expect(el.querySelector('.inspector-sst-loaded')).toBeTruthy();
    expect(el.querySelector('.kid')).toBeTruthy();
    expect(el.querySelector('[data-evidence-section="intake"]')).toBeTruthy();
  });
  it('toggles collapse on header click', () => {
    const el = mount(<EvidenceSection id="x" title="T" status="na"><div class="kid" /></EvidenceSection>);
    el.querySelector<HTMLElement>('.inspector-esec-hd')!.click();
    expect(el.querySelector('.kid')).toBeFalsy();
  });
  it('n/a and pending render no children even when open', () => {
    const el = mount(<EvidenceSection id="x" title="T" status="pending"><div class="kid" /></EvidenceSection>);
    expect(el.querySelector('.inspector-esec-skel')).toBeTruthy();
    expect(el.querySelector('.kid')).toBeFalsy();
  });
  it('header is keyboard-operable (role/tabindex/aria-expanded, toggles on Enter and Space)', () => {
    let el: any;
    act(() => { el = mount(<EvidenceSection id="x" title="T" status="loaded"><div class="kid" /></EvidenceSection>); });
    const hd = el.querySelector('.inspector-esec-hd');
    expect(hd.getAttribute('role')).toBe('button');
    expect(hd.getAttribute('tabindex')).toBe('0');
    expect(hd.getAttribute('aria-expanded')).toBe('true');
    act(() => hd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(el.querySelector('.kid')).toBeFalsy();            // collapsed
    expect(el.querySelector('.inspector-esec-hd').getAttribute('aria-expanded')).toBe('false');
    act(() => el.querySelector('.inspector-esec-hd').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    expect(el.querySelector('.kid')).toBeTruthy();            // re-expanded
  });
});
