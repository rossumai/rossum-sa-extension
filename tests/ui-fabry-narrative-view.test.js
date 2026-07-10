// tests/ui-fabry-narrative-view.test.js
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import FabryNarrative from '../src/ui/fabry/FabryNarrative.jsx';

let root;
afterEach(() => { if (root) { render(null, root); root.remove(); } });
function mount(props) { root = document.createElement('div'); document.body.appendChild(root); render(h(FabryNarrative, props), root); return root; }

describe('FabryNarrative', () => {
  it('renders takeaway + bullets + next step, with a streaming caret only when streaming', () => {
    const el = mount({ text: 'Takeaway.\n- one\n- two\nNext step: go.', streaming: true });
    expect(el.querySelectorAll('.inspector-diag-list li').length).toBe(2);
    expect(el.querySelectorAll('.inspector-diag-body > p').length).toBe(2);
    expect(el.querySelector('.inspector-caret')).toBeTruthy();
    const el2 = mount({ text: 'Done.', streaming: false });
    expect(el2.querySelector('.inspector-caret')).toBeFalsy();
  });
  it('citation-free (no resolveCite): [e:…] renders as plain text, no chip', () => {
    const el = mount({ text: 'Blocked [e:audit:1].', streaming: false });
    expect(el.querySelector('.inspector-cite')).toBeFalsy();
    expect(el.textContent).toContain('audit:1');
  });
  it('with a resolver: resolvable → chip, null → struck chip', () => {
    const resolveCite = (id) => (id === 'ok:1' ? { title: 't', onClick: () => {} } : null);
    const el = mount({ text: 'a [e:ok:1] b [e:no:9]', streaming: false, resolveCite });
    const chips = el.querySelectorAll('.inspector-cite');
    expect(chips.length).toBe(2);
    expect(chips[0].classList.contains('unresolved')).toBe(false);
    expect(chips[1].classList.contains('unresolved')).toBe(true);
    expect(chips[1].getAttribute('title')).toBe('cited evidence not found');
  });
});
