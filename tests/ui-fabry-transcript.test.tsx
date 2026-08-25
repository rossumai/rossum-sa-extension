// tests/ui-fabry-transcript.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h, render } from 'preact';
import FabryTranscript from '../src/ui/fabry/FabryTranscript.jsx';
import styles from '../src/ui/fabry/FabryTranscript.module.css';

let root: any;
afterEach(() => {
  if (root) {
    render(null, root);
    root.remove();
  }
});
function mount(props: any) {
  root = document.createElement('div');
  document.body.appendChild(root);
  render(<FabryTranscript {...props} />, root);
  return root;
}
const q = (el: any, cls: any) => el.querySelector('.' + cls);

describe('FabryTranscript', () => {
  it('shows reasoning and the tools line; closes on backdrop but not inner click', () => {
    const onClose = vi.fn();
    const el = mount({ reasoning: 'because logs', tools: ['search', 'get'], onClose });
    expect(q(el, styles.codeBlock).textContent).toContain('because logs');
    expect(q(el, styles.note).textContent).toContain('search, get');
    q(el, styles.modal).click();
    expect(onClose).not.toHaveBeenCalled();
    q(el, styles.backdrop).click();
    expect(onClose).toHaveBeenCalled();
  });
  it('renders a placeholder when there is no reasoning and no tools line when empty', () => {
    const el = mount({ reasoning: '', tools: [], onClose: () => {} });
    expect(q(el, styles.codeBlock).textContent).toContain('no reasoning');
    expect(q(el, styles.note)).toBeFalsy();
  });
});
