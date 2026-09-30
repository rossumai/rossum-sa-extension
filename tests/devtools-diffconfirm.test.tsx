// tests/devtools-diffconfirm.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import DiffConfirm from '../src/devtools/DiffConfirm.jsx';

function mount(props: any) {
  const root = document.createElement('div');
  render(<DiffConfirm {...props} />, root);
  return root;
}

describe('DiffConfirm', () => {
  it('lists changed leaves and fires onConfirm', () => {
    const onConfirm = vi.fn();
    const root = mount({
      original: { name: 'A' },
      edited: { name: 'B' },
      saving: false,
      onConfirm,
      onCancel: () => {},
    });
    expect(root.textContent).toContain('name');
    root.querySelector<HTMLElement>('.rawjson-confirm')!.click();
    expect(onConfirm).toHaveBeenCalled();
  });
  it('warns about removed top-level keys', () => {
    const root = mount({
      original: { name: 'A', gone: 1 },
      edited: { name: 'A' },
      saving: false,
      onConfirm: () => {},
      onCancel: () => {},
    });
    expect(root.textContent.toLowerCase()).toContain('remov');
    expect(root.textContent).toContain('gone');
  });
});

describe('DiffConfirm notes', () => {
  it('shows each note above the actions', () => {
    const root = document.createElement('div');
    render(
      <DiffConfirm
        original={{ a: 1 }}
        edited={{ a: 2 }}
        notes={['Table rows are matched by position.']}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      root,
    );
    expect(root.textContent).toContain('Table rows are matched by position.');
  });
});
