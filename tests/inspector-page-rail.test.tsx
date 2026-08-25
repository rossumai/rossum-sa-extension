// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/inspector/store.js';
import PageRail from '../src/inspector/components/PageRail.jsx';

function mount() {
  const el = document.createElement('div');
  render(<PageRail />, el);
  return el;
}

describe('PageRail', () => {
  beforeEach(() => {
    store.pagePreviews.value = null;
    store.domain.value = 'https://org.example';
    store.annotationId.value = '42';
  });

  it('renders nothing when previews are absent or errored', () => {
    expect(mount().textContent).toBe('');
    store.pagePreviews.value = { status: 'error', total: 0, pages: [], rest: [] };
    expect(mount().textContent).toBe('');
    store.pagePreviews.value = { status: 'done', total: 0, pages: [], rest: [] };
    expect(mount().textContent).toBe('');
  });

  it('renders thumbnails with page numbers and a Rossum deep link', () => {
    store.pagePreviews.value = {
      status: 'done',
      total: 2,
      pages: [
        { number: 1, width: 800, height: 1100, objectUrl: 'blob:one' },
        { number: 2, width: 800, height: 1100, objectUrl: 'blob:two' },
      ],
      rest: [],
    };
    const el = mount();
    const imgs = el.querySelectorAll('.inspector-page img');
    expect(imgs.length).toBe(2);
    expect(imgs[0].getAttribute('src')).toBe('blob:one');
    expect(el.querySelector('.inspector-page')!.getAttribute('href')).toBe(
      'https://org.example/document/42',
    );
    expect(el.textContent).toContain('2 pages');
  });

  it('shows a load-more button with the remaining count', () => {
    store.pagePreviews.value = {
      status: 'done',
      total: 6,
      pages: [{ number: 1, width: 800, height: 1100, objectUrl: 'blob:one' }],
      rest: [{ number: 2 }, { number: 3 }, { number: 4 }, { number: 5 }, { number: 6 }],
    };
    const el = mount();
    const btn = el.querySelector('.inspector-pagerail-more');
    expect(btn!.textContent).toContain('5 more');
  });

  it('loading with no pages yet shows a skeleton, not nothing', () => {
    store.pagePreviews.value = { status: 'loading', total: 0, pages: [], rest: [] };
    expect(mount().querySelector('.inspector-page-skel')).toBeTruthy();
  });
});

describe('store.clearPagePreviews', () => {
  it('revokes object URLs and nulls the signal', () => {
    const revoke = vi.fn();
    const orig = URL.revokeObjectURL;
    URL.revokeObjectURL = revoke;
    store.pagePreviews.value = {
      status: 'done',
      total: 1,
      pages: [{ number: 1, objectUrl: 'blob:x' }],
      rest: [],
    };
    store.clearPagePreviews();
    expect(revoke).toHaveBeenCalledWith('blob:x');
    expect(store.pagePreviews.value).toBe(null);
    URL.revokeObjectURL = orig;
  });
});
