// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import SpecialText from '../src/mdh/components/SpecialText.jsx';

function mount(props: any) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<SpecialText {...props} />, root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SpecialText', () => {
  it('renders a clean string as plain text with no marker spans', () => {
    const root = mount({ value: 'Acme Corp' }); // ordinary spaces only
    expect(root.querySelectorAll('.mdh-special').length).toBe(0);
    expect(root.textContent).toBe('Acme Corp');
  });

  it('wraps in quotes when quote is set', () => {
    const root = mount({ value: 'Acme Corp', quote: true });
    expect(root.textContent).toBe('"Acme Corp"');
  });

  it('truncates a long clean string exactly like displayValue', () => {
    const root = mount({ value: 'x'.repeat(25), quote: true, limit: 20 });
    expect(root.textContent).toBe('"' + 'x'.repeat(20) + '..."');
    expect(root.querySelectorAll('.mdh-special').length).toBe(0);
  });

  it('renders a special character as a category-classed span with a U+ tooltip', () => {
    const root = mount({ value: 'a\u00a0b' });
    const span = root.querySelector('.mdh-special')!;
    expect(span).not.toBeNull();
    expect(span.classList.contains('mdh-special-space')).toBe(true);
    expect(span.getAttribute('title')).toBe('U+00A0 NO-BREAK SPACE');
    expect(span.textContent).toBe('NBSP');
    // surrounding text preserved
    expect(root.textContent).toBe('aNBSPb');
  });

  it('classifies multiple categories in one value', () => {
    const root = mount({ value: 'a\u00a0b\u200bc\td' });
    expect(root.querySelector('.mdh-special-space')).not.toBeNull();
    expect(root.querySelector('.mdh-special-zero-width')).not.toBeNull();
    expect(root.querySelector('.mdh-special-control')).not.toBeNull();
  });

  it('appends ... when a special-containing value is truncated', () => {
    const root = mount({ value: 'a\u00a0' + 'b'.repeat(30), quote: true, limit: 20 });
    expect(root.textContent.endsWith('..."')).toBe(true);
  });

  it('returns non-string values unchanged', () => {
    const root = mount({ value: 42 });
    expect(root.textContent).toBe('42');
    expect(root.querySelectorAll('.mdh-special').length).toBe(0);
  });
});

describe('SpecialText markEdgeSpaces', () => {
  it('marks leading and trailing ordinary spaces', () => {
    const el = mount({ value: ' name  ', markEdgeSpaces: true });
    const marks = el.querySelectorAll('.mdh-special-space');
    expect(marks.length).toBe(3); // 1 leading + 2 trailing
    expect(marks[0].getAttribute('title')).toBe('U+0020 SPACE');
    expect(el.textContent).toBe('·name··');
  });

  it('leaves interior spaces plain', () => {
    const el = mount({ value: 'full name', markEdgeSpaces: true });
    expect(el.querySelectorAll('.mdh-special-space').length).toBe(0);
    expect(el.textContent).toBe('full name');
  });

  it('still marks interior special characters in the core', () => {
    const el = mount({ value: ' a\u00A0b', markEdgeSpaces: true }); // leading space + interior NBSP
    expect(el.textContent).toContain('NBSP');
    // Only the leading U+0020 gets an edge marker; the interior NBSP marker
    // shares .mdh-special-space (category "space"), so filter by title.
    const edgeMarks = [...el.querySelectorAll('.mdh-special-space')].filter(
      (m) => m.getAttribute('title') === 'U+0020 SPACE',
    );
    expect(edgeMarks.length).toBe(1);
  });

  it('quotes around the marked value', () => {
    const el = mount({ value: 'name ', quote: true, markEdgeSpaces: true });
    expect(el.textContent).toBe('"name·"');
  });

  it('renders a clean string byte-identical', () => {
    const el = mount({ value: 'name', markEdgeSpaces: true });
    expect(el.textContent).toBe('name');
    expect(el.querySelector('.mdh-special')).toBe(null);
  });

  it('handles an all-spaces value without double-marking', () => {
    const el = mount({ value: '  ', markEdgeSpaces: true });
    expect(el.querySelectorAll('.mdh-special-space').length).toBe(2);
  });
});
