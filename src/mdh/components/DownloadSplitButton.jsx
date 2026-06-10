import { h } from 'preact';
import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';

// Choose which side the format flyout opens on. Prefer the right; flip to the
// left only when the (actually-measured) flyout would overflow the viewport.
export function chooseSubmenuSide(menuRight, flyoutWidth, viewportWidth, margin = 8) {
  return menuRight + flyoutWidth + margin <= viewportWidth ? 'right' : 'left';
}

export default function DownloadSplitButton({ onAllJson, onFilteredJson, onAllCsv, onFilteredCsv, onAllXml, onFilteredXml, onAllJsonl, onFilteredJsonl }) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState(null); // 'all' | 'filtered' | null
  const [submenuSide, setSubmenuSide] = useState('right'); // 'right' | 'left'
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const flyoutRef = useRef(null);
  const closeTimer = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e) {
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
      setSubmenu(null);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // When a flyout opens, measure the menu's right edge and the flyout's REAL
  // rendered width, then pick the side (in a layout effect → before paint, no
  // flicker). offsetWidth is side-independent, so measuring while it's on the
  // default 'right' is fine.
  useLayoutEffect(() => {
    if (!submenu || !menuRef.current || !flyoutRef.current) return;
    const menuRight = menuRef.current.getBoundingClientRect().right;
    const flyoutWidth = flyoutRef.current.offsetWidth;
    setSubmenuSide(chooseSubmenuSide(menuRight, flyoutWidth, window.innerWidth));
  }, [submenu]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  function openSub(which) { clearTimeout(closeTimer.current); setSubmenu(which); }
  function scheduleCloseSub() {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setSubmenu(null), 180);
  }
  function choose(fn) { setOpen(false); setSubmenu(null); fn(); }

  const ITEMS = [
    { key: 'all', label: 'Download all', json: onAllJson, csv: onAllCsv, xml: onAllXml, jsonl: onAllJsonl },
    { key: 'filtered', label: 'Download filtered', json: onFilteredJson, csv: onFilteredCsv, xml: onFilteredXml, jsonl: onFilteredJsonl },
  ];

  return (
    <div ref={rootRef} class="dropdown-btn">
      <button class="btn btn-sm" title="Download collection"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); setSubmenu(null); }}>
        Download {'▾'}
      </button>
      {open && (
        <div ref={menuRef} class="toolbar-more-menu">
          {ITEMS.map((it) => (
            <div key={it.key} class="toolbar-submenu-wrap"
              onMouseEnter={() => openSub(it.key)} onMouseLeave={scheduleCloseSub}>
              <button class="toolbar-menu-item toolbar-submenu-parent"
                data-testid={`download-${it.key}`}
                aria-haspopup="menu" aria-expanded={submenu === it.key}
                onClick={() => openSub(it.key)}>
                <span>{it.label}</span>
                <span class="toolbar-submenu-caret">{submenuSide === 'right' ? '›' : '‹'}</span>
              </button>
              {submenu === it.key && (
                <div ref={flyoutRef} class={`toolbar-submenu is-${submenuSide}`} data-testid={`download-${it.key}-submenu`}>
                  <button class="toolbar-menu-item" data-testid={`download-${it.key}-json`}
                    onClick={() => choose(it.json)}>JSON</button>
                  <button class="toolbar-menu-item" data-testid={`download-${it.key}-jsonl`}
                    onClick={() => choose(it.jsonl)}>JSON Lines <span class="toolbar-menu-beta">beta</span></button>
                  <button class="toolbar-menu-item" data-testid={`download-${it.key}-csv`}
                    onClick={() => choose(it.csv)}>CSV <span class="toolbar-menu-beta">beta</span></button>
                  <button class="toolbar-menu-item" data-testid={`download-${it.key}-xml`}
                    onClick={() => choose(it.xml)}>XML <span class="toolbar-menu-beta">beta</span></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
