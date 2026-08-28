// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h, render } from 'preact';
import FilterInput from '../src/ui/FilterInput.jsx';
import styles from '../src/ui/FilterInput.module.css';

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
  render(<FilterInput {...props} />, root);
  return root;
}
const inputOf = (el: any) => el.querySelector('input.' + styles.input) as HTMLInputElement;
const clearOf = (el: any) => el.querySelector('.' + styles.clear);
const wrapOf = (el: any) => el.querySelector('.' + styles.wrap)!;
const fireInput = (el: any, v: string) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('FilterInput', () => {
  it('reflects the value and reports typed text as a string', () => {
    const onInput = vi.fn();
    const el = mount({ value: 'ven', onInput, onClear: vi.fn() });
    expect(inputOf(el).value).toBe('ven');

    fireInput(inputOf(el), 'vendor');
    // The consumer receives the VALUE, never the event — that is what lets a call site
    // drop its own `(e: any) => setX(e.target.value)` reader.
    expect(onInput).toHaveBeenCalledWith('vendor');
  });

  it('renders no clear button while empty', () => {
    const el = mount({ value: '', onInput: vi.fn(), onClear: vi.fn() });
    expect(clearOf(el)).toBe(null);
    expect(wrapOf(el).className).not.toContain(styles.hasValue);
  });

  it('offers a clear button once engaged and calls onClear', () => {
    const onClear = vi.fn();
    const el = mount({ value: 'vendor', onInput: vi.fn(), onClear });
    const btn = clearOf(el);
    expect(btn).toBeTruthy();
    expect(wrapOf(el).className).toContain(styles.hasValue);

    btn.click();
    expect(onClear).toHaveBeenCalled();
  });

  it('lets the consumer decide what counts as engaged via `active`', () => {
    // The sidebar filter treats whitespace-only as NOT filtering (its matcher trims), while
    // the uploads filter genuinely matches on a space. So "engaged" cannot be derived from
    // the value here — the consumer owns that rule, and it drives both the accent state and
    // the clear button together.
    const el = mount({ value: '   ', active: false, onInput: vi.fn(), onClear: vi.fn() });
    expect(wrapOf(el).className).not.toContain(styles.hasValue);
    expect(clearOf(el)).toBe(null);
  });

  it('defaults `active` to a non-empty value', () => {
    const el = mount({ value: 'x', onInput: vi.fn(), onClear: vi.fn() });
    expect(wrapOf(el).className).toContain(styles.hasValue);
    expect(clearOf(el)).toBeTruthy();
  });

  it('forwards keydown without swallowing it', () => {
    // The sidebar clears on Escape, and its own test asserts Escape still reaches
    // document-level listeners. The primitive must not stopPropagation.
    const onKeyDown = vi.fn();
    const seenAtDocument = vi.fn();
    document.addEventListener('keydown', seenAtDocument);
    const el = mount({ value: 'v', onInput: vi.fn(), onClear: vi.fn(), onKeyDown });

    inputOf(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onKeyDown).toHaveBeenCalled();
    expect(seenAtDocument).toHaveBeenCalled();
    document.removeEventListener('keydown', seenAtDocument);
  });

  it('applies placeholder, aria-label and title, and hides the icon from assistive tech', () => {
    const el = mount({
      value: '',
      onInput: vi.fn(),
      onClear: vi.fn(),
      placeholder: 'Filter by name...',
      ariaLabel: 'Filter collections by name',
      title: 'tip',
    });
    const input = inputOf(el);
    expect(input.getAttribute('placeholder')).toBe('Filter by name...');
    expect(input.getAttribute('aria-label')).toBe('Filter collections by name');
    expect(input.getAttribute('title')).toBe('tip');
    expect(el.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('appends a consumer class to the wrap so width stays app-owned', () => {
    // Height and dressing belong to the primitive; how wide the box is depends on whether it
    // sits in a toolbar or fills a sidebar column, so that stays with the call site.
    const el = mount({
      value: '',
      onInput: vi.fn(),
      onClear: vi.fn(),
      className: 'uploads-ops-filter',
    });
    expect(wrapOf(el).className).toContain('uploads-ops-filter');
  });
});
