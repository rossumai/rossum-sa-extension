// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import DocView from '../src/docs/components/DocView.jsx';

// DocView's onClick routes one href through four possible branches, in a fixed order — a
// fragment, a resource link (left to initSourceViewer's own listener), an asset reference, or a
// sibling-document navigation. This file was named for exactly this and, until now, never tested
// it (review finding 3): the asset branch's position, its preventDefault and its onAssetOpen call
// had zero coverage.
const DOMAIN = 'https://example-org.rossum.app';

function mount(props: Record<string, any> = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => {
    render(h(DocView, { docId: 'solo', ...props }), root);
  });
  return root;
}

function clickHref(root: HTMLElement, hrefPredicate: (href: string) => boolean) {
  const link = [...root.querySelectorAll('a')].find((a) =>
    hrefPredicate(a.getAttribute('href') || ''),
  );
  if (!link) throw new Error('no matching link found');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  return event;
}

describe('DocView click routing', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('an in-document fragment scrolls the pane instead of falling through to sibling navigation', async () => {
    const onNavigate = vi.fn();
    const onAssetOpen = vi.fn();
    const root = mount({
      text: '# Modules\n\nSee [here](#modules) for details.\n',
      onNavigate,
      onAssetOpen,
    });
    await vi.waitFor(() => expect(root.querySelector('a[href="#modules"]')).toBeTruthy());

    const event = clickHref(root, (href) => href === '#modules');

    expect(event.defaultPrevented).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onAssetOpen).not.toHaveBeenCalled();
  });

  it('a resource href is left alone, so initSourceViewer opens its modal', async () => {
    const onNavigate = vi.fn();
    const root = mount({
      domain: DOMAIN,
      text: `[hook](${DOMAIN}/api/v1/hooks/42)\n`,
      onNavigate,
    });
    await vi.waitFor(() => expect(root.querySelector('a')).toBeTruthy());

    const event = clickHref(root, (href) => href.includes('/api/v1/'));

    // DocView's own onClick returns early for a resource href (isResourceHref), leaving
    // initSourceViewer's separate listener — bound to the same root — to intercept and open the
    // modal. onNavigate must NOT have been asked to treat this as a sibling document.
    expect(onNavigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    const overlay = document.getElementById('srcOverlay')!;
    expect(overlay.classList.contains('open')).toBe(true);
  });

  it('an asset reference is intercepted with preventDefault and calls onAssetOpen', async () => {
    const onNavigate = vi.fn();
    const onAssetOpen = vi.fn();
    const assets = {
      lookup: (href: string) => (href === 'assets/diagram.png' ? {} : null),
      peek: () => null,
      resolve: vi.fn(),
      pin: vi.fn(),
      version: () => 0,
    };
    const root = mount({
      text: '[the file](assets/diagram.png)\n',
      assets,
      onAssetOpen,
      onNavigate,
    });
    await vi.waitFor(() => expect(root.querySelector('a')).toBeTruthy());

    const event = clickHref(root, (href) => href === 'assets/diagram.png');

    expect(event.defaultPrevented).toBe(true);
    expect(onAssetOpen).toHaveBeenCalledWith('assets/diagram.png');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('an unresolvable relative link does nothing rather than navigating the Console away', async () => {
    // No onNavigate at all — the safest way to prove DocView never assumes it exists.
    const root = mount({ text: '[elsewhere](other.md)\n' });
    await vi.waitFor(() => expect(root.querySelector('a')).toBeTruthy());

    expect(() => clickHref(root, (href) => href === 'other.md')).not.toThrow();
  });

  it('an asset link takes priority over the sibling-document fallback for the same href shape', async () => {
    // Both branches would otherwise treat a bare relative path the same way; the asset check
    // must run FIRST, or a deliverable that happens to reuse a slug-shaped asset key would open
    // the wrong thing.
    const onNavigate = vi.fn();
    const onAssetOpen = vi.fn();
    const assets = {
      lookup: (href: string) => (href === 'assets/diagram.png' ? {} : null),
      peek: () => null,
      resolve: vi.fn(),
      pin: vi.fn(),
      version: () => 0,
    };
    const root = mount({
      text: '[the file](assets/diagram.png)\n\n[elsewhere](other.md)\n',
      assets,
      onAssetOpen,
      onNavigate,
    });
    await vi.waitFor(() => expect(root.querySelectorAll('a').length).toBe(2));

    clickHref(root, (href) => href === 'assets/diagram.png');
    expect(onAssetOpen).toHaveBeenCalledWith('assets/diagram.png');
    expect(onNavigate).not.toHaveBeenCalled();

    clickHref(root, (href) => href === 'other.md');
    expect(onNavigate).toHaveBeenCalledWith('other');
  });
});
