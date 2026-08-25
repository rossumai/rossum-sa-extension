// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import PlaceholderInputs from '../src/mdh/components/PlaceholderInputs.jsx';

function mount(props: any) {
  const root = document.createElement('div');
  render(h(PlaceholderInputs, props), root);
  return root;
}

describe('PlaceholderInputs UI', () => {
  const common = {
    names: ['code'], values: { code: '123' }, types: {},
    onSetValue: () => {}, onSetType: () => {}, onRunQuery: () => {},
    resolvedTypeFor: () => ({ type: 'string', autoType: 'string' }),
  };
  it('folds the resolved type into the Auto option and keeps no standalone badge', () => {
    const root = mount(common);
    const sel = root.querySelector('select.placeholder-type-select');
    expect(sel).toBeTruthy();
    expect(root.textContent).toContain('Auto (String)');
    expect(root.querySelector('.placeholder-badge')).toBeNull();
  });
  it('the select tooltip describes the control, not the resolved type', () => {
    const sel = mount(common).querySelector<HTMLSelectElement>('select.placeholder-type-select')!;
    expect(sel.title.toLowerCase()).toContain('data type for this variable');
    expect(sel.title).not.toContain('String'); // does not repeat the resolved type
  });
  it('the Auto option shows the true auto type even when overridden', () => {
    // field resolves to Number; the user overrode to String
    const root = mount({ ...common, types: { code: 'string' },
      resolvedTypeFor: () => ({ type: 'string', autoType: 'number' }) });
    const autoOpt = [...root.querySelectorAll('option')].find((o) => o.value === 'auto');
    expect(autoOpt!.textContent).toBe('Auto (Number)');
    // and the selected (closed) value reflects the override
    expect(root.querySelector<HTMLSelectElement>('select.placeholder-type-select')!.value).toBe('string');
  });
  it('offers Boolean only for true/false and Null only for empty/null', () => {
    const valueBased = () => ({ type: undefined, autoType: undefined });
    const optsFor = (value: any) => [...mount({ ...common, values: { code: value }, resolvedTypeFor: valueBased }).querySelectorAll('option')].map((o) => o.value);
    expect(optsFor('true')).toEqual(['auto', 'string', 'number', 'boolean']);
    expect(optsFor('acme')).toEqual(['auto', 'string', 'number']);
    expect(optsFor('')).toEqual(['auto', 'string', 'number', 'null']);
  });
  it('shows an incompatibility warning when the value cannot match the type', () => {
    const root = mount({ ...common, types: { code: 'number' }, values: { code: 'abc' },
      resolvedTypeFor: () => ({ type: 'number', autoType: 'number' }) });
    expect(root.querySelector('.placeholder-warn')).toBeTruthy();
  });
});
