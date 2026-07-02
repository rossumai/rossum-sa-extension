import { h } from 'preact';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';

const PAD = 8, GAP = 4, MIN_DROP = 180, MAX_DROP = 260;

// Controlled match-key combobox. The suggestion list is a position:fixed popup
// anchored to the input's on-screen rect, so it escapes the modal's overflow
// clipping (no modal ancestor establishes a fixed containing block). It flips
// above the input when there isn't room below, caps its height to the viewport,
// and re-anchors on scroll/resize while open.
export default function MatchKeyPicker({ paths, keys, setKeys }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [box, setBox] = useState(null);
  const inputRef = useRef(null);

  const q = query.trim().toLowerCase();
  const available = paths.filter((p) => !keys.includes(p));
  const suggestions = (q ? available.filter((p) => p.toLowerCase().includes(q)) : available).slice(0, 50);
  const open = focused && suggestions.length > 0;
  const active = Math.min(activeIndex, suggestions.length - 1);

  useLayoutEffect(() => {
    if (!open) { setBox(null); return undefined; }
    const measure = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - PAD;
      const above = r.top - PAD;
      const flip = below < MIN_DROP && above > below;
      const maxHeight = Math.max(80, Math.min(MAX_DROP, (flip ? above : below) - GAP));
      setBox({
        left: r.left,
        width: r.width,
        maxHeight,
        ...(flip ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
      });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  function add(p) {
    if (!keys.includes(p)) setKeys([...keys, p]);
    setQuery('');
    setActiveIndex(0);
  }
  function remove(p) { setKeys(keys.filter((k) => k !== p)); }
  function onInput(e) { setQuery(e.target.value); setActiveIndex(0); setFocused(true); }
  function onKeyDown(e) {
    if (open && e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(Math.min(active + 1, suggestions.length - 1)); }
    else if (open && e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(Math.max(active - 1, 0)); }
    else if (open && e.key === 'Enter') { e.preventDefault(); add(suggestions[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setFocused(false); }
    else if (e.key === 'Backspace' && query === '' && keys.length > 0) { remove(keys[keys.length - 1]); }
  }

  const boxStyle = box
    ? `left:${box.left}px;width:${box.width}px;max-height:${box.maxHeight}px;${box.top != null ? `top:${box.top}px` : `bottom:${box.bottom}px`}`
    : '';

  return (
    <div class="match-key-picker" data-testid="match-keys">
      <div class="match-key-chips">
        {keys.map((k) => (
          <span class="match-key-chip" key={k}>
            {k}
            <button type="button" class="match-key-chip-x" aria-label={`Remove ${k}`} onClick={() => remove(k)}>{'✕'}</button>
          </span>
        ))}
        <input
          ref={inputRef}
          class="match-key-input"
          type="text"
          value={query}
          placeholder={keys.length ? 'Add another field…' : 'Type or pick a field…'}
          data-testid="match-key-input"
          onInput={onInput}
          onKeyDown={onKeyDown}
          onFocus={() => { setFocused(true); setActiveIndex(0); }}
          onBlur={() => setFocused(false)}
        />
      </div>
      {open && box && (
        <div class="match-key-suggest" data-testid="match-key-suggest" style={boxStyle}>
          {suggestions.map((p, i) => (
            <button
              type="button"
              class={`match-key-suggest-item${i === active ? ' active' : ''}`}
              key={p}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(p)}
            >{p}</button>
          ))}
        </div>
      )}
    </div>
  );
}
