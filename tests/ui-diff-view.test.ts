// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import DiffView from '../src/ui/DiffView.jsx';
import styles from '../src/ui/DiffView.module.css';

function mount(props: any) { const r = document.createElement('div'); document.body.appendChild(r); render(h(DiffView, props), r); return r; }

describe('DiffView', () => {
  it('renders added words as <ins> and removed words as <del>', () => {
    const root = mount({ before: 'the invoices queue', after: 'the Invoices queue' });
    expect(root.querySelector('ins.' + styles.add)!.textContent).toContain('Invoices');
    expect(root.querySelector('del.' + styles.del)!.textContent).toContain('invoices');
  });
  it('identical inputs render no ins/del and show the text', () => {
    const root = mount({ before: 'same text', after: 'same text' });
    expect(root.querySelector('ins')).toBeNull();
    expect(root.querySelector('del')).toBeNull();
    expect(root.textContent).toBe('same text');
  });
});
