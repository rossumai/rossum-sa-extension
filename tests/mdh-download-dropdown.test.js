// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import DownloadSplitButton, { chooseSubmenuSide } from '../src/mdh/components/DownloadSplitButton.jsx';

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(DownloadSplitButton, props), root);
  return root;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// Poll for a condition instead of guessing a fixed delay. preact schedules
// useEffect callbacks after paint (rAF + a follow-up macrotask), so a fixed
// sleep races effect registration under load — the source of this file's flake.
async function waitFor(condition, description = 'condition', timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = condition(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('chooseSubmenuSide', () => {
  it('prefers right when the measured flyout fits', () => {
    expect(chooseSubmenuSide(200, 120, 1024)).toBe('right');
    expect(chooseSubmenuSide(1290, 120, 1440)).toBe('right'); // 1290+120+8=1418 <= 1440
  });
  it('flips left when the flyout would overflow the right edge', () => {
    expect(chooseSubmenuSide(950, 120, 1024)).toBe('left');   // 1078 > 1024
    expect(chooseSubmenuSide(1290, 160, 1440)).toBe('left');  // a 160px flyout would NOT fit here
  });
  it('treats the margin boundary as fitting (<=)', () => {
    expect(chooseSubmenuSide(896, 120, 1024)).toBe('right'); // 896+120+8 = 1024
    expect(chooseSubmenuSide(897, 120, 1024)).toBe('left');  // 1025 > 1024
  });
});

describe('DownloadSplitButton', () => {
  const handlers = () => ({ onAllJson: vi.fn(), onFilteredJson: vi.fn(), onAllCsv: vi.fn(), onFilteredCsv: vi.fn(), onAllXml: vi.fn(), onFilteredXml: vi.fn(), onAllJsonl: vi.fn(), onFilteredJsonl: vi.fn(), onAllXlsx: vi.fn(), onFilteredXlsx: vi.fn() });

  it('renders a single "Download" toggle button when closed; no menu', () => {
    const root = mount(handlers());
    const buttons = root.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toContain('Download');
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('click toggle → two action items visible, no flyout open yet', async () => {
    const root = mount(handlers());
    root.querySelector('button').click();
    await flush();
    const menu = root.querySelector('.toolbar-more-menu');
    expect(menu).not.toBeNull();
    expect(menu.querySelector('[data-testid="download-all"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="download-filtered"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="download-all-submenu"]')).toBeNull();
    expect(root.querySelector('[data-testid="download-filtered-submenu"]')).toBeNull();
  });

  it('hover "Download all" wrap → its flyout appears with JSON and CSV buttons', async () => {
    const root = mount(handlers());
    root.querySelector('button').click();
    await flush();
    const allParent = root.querySelector('[data-testid="download-all"]');
    const wrap = allParent.parentElement; // .toolbar-submenu-wrap
    wrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await waitFor(
      () => root.querySelector('[data-testid="download-all-submenu"]') !== null,
      'download-all flyout to open',
    );
    const flyout = root.querySelector('[data-testid="download-all-submenu"]');
    expect(flyout.querySelector('[data-testid="download-all-json"]')).not.toBeNull();
    expect(flyout.querySelector('[data-testid="download-all-csv"]')).not.toBeNull();
  });

  it('click download-all-json → onAllJson called once AND menu closes', async () => {
    const h4 = handlers();
    const root = mount(h4);
    root.querySelector('button').click();
    await flush();
    const wrap = root.querySelector('[data-testid="download-all"]').parentElement;
    wrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await waitFor(
      () => root.querySelector('[data-testid="download-all-submenu"]') !== null,
      'download-all flyout',
    );
    root.querySelector('[data-testid="download-all-json"]').click();
    await flush();
    expect(h4.onAllJson).toHaveBeenCalledOnce();
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('click download-filtered-csv → onFilteredCsv called once', async () => {
    const h4 = handlers();
    const root = mount(h4);
    root.querySelector('button').click();
    await flush();
    const wrap = root.querySelector('[data-testid="download-filtered"]').parentElement;
    wrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await waitFor(
      () => root.querySelector('[data-testid="download-filtered-submenu"]') !== null,
      'download-filtered flyout',
    );
    root.querySelector('[data-testid="download-filtered-csv"]').click();
    await flush();
    expect(h4.onFilteredCsv).toHaveBeenCalledOnce();
  });

  it('offers a JSON Lines option that fires onAllJsonl', async () => {
    const h2 = handlers();
    const root = mount(h2);
    root.querySelector('button').click();                                  // open menu
    await flush();
    root.querySelector('[data-testid="download-all"]').click();            // open flyout
    await waitFor(
      () => root.querySelector('[data-testid="download-all-jsonl"]') !== null,
      'download-all-jsonl button',
    );
    const jsonl = root.querySelector('[data-testid="download-all-jsonl"]');
    expect(jsonl.querySelector('.toolbar-menu-beta')).toBeTruthy();        // beta badge
    jsonl.click();
    expect(h2.onAllJsonl).toHaveBeenCalledTimes(1);
  });

  it('offers an Excel option that fires onAllXlsx (beta) and onFilteredXlsx', async () => {
    const h2 = handlers();
    const root = mount(h2);
    root.querySelector('button').click();
    await flush();
    root.querySelector('[data-testid="download-all"]').click();
    await waitFor(
      () => root.querySelector('[data-testid="download-all-xlsx"]') !== null,
      'download-all-xlsx button',
    );
    const xlsx = root.querySelector('[data-testid="download-all-xlsx"]');
    expect(xlsx.textContent).toContain('Excel');
    expect(xlsx.querySelector('.toolbar-menu-beta')).toBeTruthy();
    xlsx.click();
    expect(h2.onAllXlsx).toHaveBeenCalledTimes(1);

    const root2 = mount(h2);
    root2.querySelector('button').click();
    await flush();
    root2.querySelector('[data-testid="download-filtered"]').click();
    await waitFor(
      () => root2.querySelector('[data-testid="download-filtered-xlsx"]') !== null,
      'download-filtered-xlsx button',
    );
    root2.querySelector('[data-testid="download-filtered-xlsx"]').click();
    expect(h2.onFilteredXlsx).toHaveBeenCalledTimes(1);
  });

  it('hovering the other parent switches the open flyout', async () => {
    const root = mount(handlers());
    root.querySelector('button').click();
    await flush();

    // Open "all" flyout first
    const allWrap = root.querySelector('[data-testid="download-all"]').parentElement;
    allWrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await waitFor(
      () => root.querySelector('[data-testid="download-all-submenu"]') !== null,
      'download-all flyout to open',
    );

    // Now hover "filtered" — this should switch the open flyout
    const filteredWrap = root.querySelector('[data-testid="download-filtered"]').parentElement;
    filteredWrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await waitFor(
      () => root.querySelector('[data-testid="download-filtered-submenu"]') !== null,
      'download-filtered flyout to open',
    );
    expect(root.querySelector('[data-testid="download-all-submenu"]')).toBeNull();
  });

  it('mouseleave the wrap → flyout closes after ~180ms delay (condition-based, no fixed sleep)', async () => {
    const root = mount(handlers());
    root.querySelector('button').click();
    await flush();
    const allWrap = root.querySelector('[data-testid="download-all"]').parentElement;
    allWrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await waitFor(
      () => root.querySelector('[data-testid="download-all-submenu"]') !== null,
      'flyout to open',
    );
    allWrap.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    await waitFor(
      () => root.querySelector('[data-testid="download-all-submenu"]') === null,
      'flyout to close after mouseleave',
      500,
    );
    expect(root.querySelector('[data-testid="download-all-submenu"]')).toBeNull();
  });

  it('click the toggle again → menu toggles shut', async () => {
    const root = mount(handlers());
    const btn = root.querySelector('button');
    btn.click(); await flush();
    expect(root.querySelector('.toolbar-more-menu')).not.toBeNull();
    btn.click(); await flush();
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('mousedown outside the dropdown closes the menu', async () => {
    const root = mount(handlers());
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    root.querySelector('button').click();
    await waitFor(() => root.querySelector('.toolbar-more-menu') !== null, 'menu to open');
    await waitFor(() => {
      if (root.querySelector('.toolbar-more-menu') === null) return true;
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return false;
    }, 'menu to close on outside mousedown');
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('clicking a parent action also opens its flyout (touch/keyboard fallback)', async () => {
    const root = mount(handlers());
    root.querySelector('button').click();
    await flush();
    root.querySelector('[data-testid="download-all"]').click();
    await flush();
    expect(root.querySelector('[data-testid="download-all-submenu"]')).toBeTruthy();
  });

  it('re-entering the wrap before the 180ms close delay keeps the flyout open', async () => {
    const root = mount(handlers());
    root.querySelector('button').click();
    await flush();
    const wrap = root.querySelector('[data-testid="download-all"]').parentElement;
    wrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await flush();
    expect(root.querySelector('[data-testid="download-all-submenu"]')).toBeTruthy();
    wrap.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));  // arms the 180ms close timer
    wrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));  // openSub clearTimeout cancels it
    await new Promise((r) => setTimeout(r, 260));                          // wait PAST 180ms; assert it did NOT close
    expect(root.querySelector('[data-testid="download-all-submenu"]')).toBeTruthy();
  });

  it('opens the flyout on the right when it fits', async () => {
    // jsdom returns offsetWidth=0 and getBoundingClientRect().right=0, so
    // stub offsetWidth=120 to simulate a real flyout. menuRight=0, so:
    // 0 + 120 + 8 = 128 <= 1024 → right.
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 120; } });
    const prevW = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    try {
      const root = mount(handlers());
      root.querySelector('button').click();
      await flush();
      root.querySelector('[data-testid="download-all"]').parentElement.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await waitFor(
        () => root.querySelector('[data-testid="download-all-submenu"]') !== null,
        'download-all flyout to open',
      );
      expect(root.querySelector('[data-testid="download-all-submenu"]').classList.contains('is-right')).toBe(true);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalDescriptor);
      } else {
        delete HTMLElement.prototype.offsetWidth;
      }
      Object.defineProperty(window, 'innerWidth', { value: prevW, configurable: true });
    }
  });

  it('flips the flyout to the left when it would overflow', async () => {
    // With offsetWidth=120 and innerWidth=100: 0 + 120 + 8 = 128 > 100 → left.
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 120; } });
    const prevW = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 100, configurable: true });
    try {
      const root = mount(handlers());
      root.querySelector('button').click();
      await flush();
      root.querySelector('[data-testid="download-all"]').parentElement.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await waitFor(
        () => root.querySelector('[data-testid="download-all-submenu"]') !== null,
        'download-all flyout to open',
      );
      expect(root.querySelector('[data-testid="download-all-submenu"]').classList.contains('is-left')).toBe(true);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalDescriptor);
      } else {
        delete HTMLElement.prototype.offsetWidth;
      }
      Object.defineProperty(window, 'innerWidth', { value: prevW, configurable: true });
    }
  });
});
