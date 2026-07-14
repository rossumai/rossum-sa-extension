// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import FabryNotice from '../src/ui/fabry/FabryNotice.jsx';
import styles from '../src/ui/fabry/FabryNotice.module.css';

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(FabryNotice, props), root);
  return root;
}

// Query by the module's scoped class (via `styles`), not literal names.
const sel = (cls) => '.' + cls.trim().split(/\s+/).join('.');

describe('FabryNotice', () => {
  it('null notice renders nothing', () => {
    expect(mount({ notice: null }).querySelector(sel(styles.notice))).toBeNull();
  });
  it('error shows the message', () => {
    expect(mount({ notice: { kind: 'error', text: 'boom' } }).querySelector(sel(styles.error)).textContent).toContain('boom');
  });
  it('unsupported names the type and shows the raw payload in details', () => {
    const root = mount({ notice: { kind: 'unsupported', types: ['data-agent-confirmation'], payloads: [{ type: 'data-agent-confirmation', data: { prompt: 'ok?' } }] } });
    const el = root.querySelector(sel(styles.warn));
    expect(el.textContent).toContain('data-agent-confirmation');
    expect(el.querySelector('details pre').textContent).toContain('ok?');
  });
  it('empty shows a quiet no-response note', () => {
    expect(mount({ notice: { kind: 'empty' } }).querySelector(sel(styles.muted)).textContent).toContain('no response');
  });
});
