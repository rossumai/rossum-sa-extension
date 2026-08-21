// src/devtools/RequestBar.tsx
import { h } from 'preact';
import { useState, useRef } from 'preact/hooks';
import { suggest, shortPath } from './catalog.js';

export default function RequestBar({ onSubmit }: { onSubmit: (path: string) => void }) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const items = suggest(value);

  const fire = (raw?: string) => { const v = (raw ?? value).trim(); if (!v) return; onSubmit(v); setOpen(false); };

  const pick = (e: any) => {
    // Insert the short (prefix-free) form — the /api/v1/ prefix is assumed.
    const short = shortPath(e.pathTemplate);
    setValue(short);
    setOpen(false);
    const el = inputRef.current;
    if (el) {
      const at = short.indexOf('{');
      requestAnimationFrame(() => { el.focus(); if (at >= 0) el.setSelectionRange(at, short.indexOf('}') + 1); });
    }
  };

  const onKeyDown = (ev: any) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setOpen(true); setHi((i) => (items.length ? (i >= items.length - 1 ? 0 : i + 1) : -1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setOpen(true); setHi((i) => (items.length ? (i <= 0 ? items.length - 1 : i - 1) : -1)); }
    else if (ev.key === 'Escape') { setOpen(false); setHi(-1); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (open && hi >= 0 && items[hi]) pick(items[hi]);
      // Read the live DOM value (not the closured `value` state) — Preact
      // batches state updates via microtask, so a keydown dispatched right
      // after an input event (no await in between) can still run this closure
      // from before the state update landed.
      else fire(ev.target.value);
    }
  };

  return (
    <div class="rawjson-reqbar">
      <span class="rawjson-reqbar-method">GET</span>
      <span class="rawjson-reqbar-prefix" aria-hidden="true">/api/v1/</span>
      <input
        ref={inputRef}
        class="rawjson-reqbar-input"
        type="text"
        spellcheck={false}
        placeholder={'queues?page_size=100  —  type to search endpoints'}
        value={value}
        onInput={(ev: any) => { setValue(ev.target.value); setOpen(true); setHi(-1); }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      <button class="rawjson-reqbar-go" title="Go" onClick={() => fire()}>{'→'}</button>
      {open && items.length ? (
        <ul class="rawjson-reqbar-suggest">
          {items.map((e, i) => (
            <li key={e.pathTemplate + e.kind} class={`rawjson-reqbar-item${i === hi ? ' active' : ''}`} onMouseDown={(ev) => { ev.preventDefault(); pick(e); }}>
              <span class="rawjson-reqbar-item-path">{shortPath(e.pathTemplate)}</span>
              <span class="rawjson-reqbar-item-desc">{e.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
