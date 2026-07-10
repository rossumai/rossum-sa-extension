// tests/ui-fabry-transcript.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h, render } from 'preact';
import FabryTranscript from '../src/ui/fabry/FabryTranscript.jsx';

let root;
afterEach(() => { if (root) { render(null, root); root.remove(); } });
function mount(props) { root = document.createElement('div'); document.body.appendChild(root); render(h(FabryTranscript, props), root); return root; }

describe('FabryTranscript', () => {
  it('shows reasoning and the tools line; closes on backdrop but not inner click', () => {
    const onClose = vi.fn();
    const el = mount({ reasoning: 'because logs', tools: ['search', 'get'], onClose });
    expect(el.querySelector('.inspector-code-block').textContent).toContain('because logs');
    expect(el.querySelector('.inspector-note').textContent).toContain('search, get');
    el.querySelector('.inspector-modal').click();
    expect(onClose).not.toHaveBeenCalled();
    el.querySelector('.inspector-modal-backdrop').click();
    expect(onClose).toHaveBeenCalled();
  });
  it('renders a placeholder when there is no reasoning and no tools line when empty', () => {
    const el = mount({ reasoning: '', tools: [], onClose: () => {} });
    expect(el.querySelector('.inspector-code-block').textContent).toContain('no reasoning');
    expect(el.querySelector('.inspector-note')).toBeFalsy();
  });
});
