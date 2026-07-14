import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import * as store from '../store.js';
import { sendMessage, stopStreaming } from '../chat.js';
import GerundLoader from '../../ui/GerundLoader.jsx';
import CommandMenu from './CommandMenu.jsx';
import { PERSONAS, personaLabel } from '../personas.js';
import FabryMark from '../../ui/FabryMark.jsx';
import Tip from '../../ui/Tip.jsx';

const MAX_IMAGES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const GERUNDS = ['Thinking', 'Investigating', 'Reading', 'Cross-checking', 'Answering'];

// Bottom-bar icons (stroke, currentColor). Kept inline so the composer owns no
// extra deps; sized by the button, not hard-coded here beyond the 24-box viewBox.
const IconPlus = () => <svg class="fabry-bar-ico" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>;
const IconSend = () => <svg class="fabry-bar-ico" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
// Persona chip caret — deliberately mid-sized (see .fabry-persona-caret): big
// enough to read as a menu affordance, not so big it dominates the chip.
const IconCaret = () => <svg class="fabry-persona-caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>;

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ media_type: file.type, data: String(r.result).split(',')[1] });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function Composer() {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState([]);
  const [personaOpen, setPersonaOpen] = useState(false);
  const personaRef = useRef(null);
  const streaming = store.streaming.value;
  const isNewChat = !store.activeChatId.value;
  const showMenu = draft.startsWith('/') && !draft.includes('\n') && store.commands.value.length > 0;
  const showPersona = isNewChat && !streaming; // persona is locked once a chat exists

  // Close the persona dropdown on outside-click / Escape.
  useEffect(() => {
    if (!personaOpen) return undefined;
    const onDoc = (e) => { if (personaRef.current && !personaRef.current.contains(e.target)) setPersonaOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setPersonaOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [personaOpen]);

  async function addFiles(files) {
    const picked = [...files].filter((f) => IMG_TYPES.includes(f.type) && f.size <= MAX_BYTES);
    const converted = await Promise.all(picked.map(fileToImage));
    // Cap is computed from `cur.length` inside the functional updater (not the
    // `images` closure) so concurrent addFiles calls (paste + drop) can't both
    // read a stale count and together push the total past MAX_IMAGES.
    setImages((cur) => {
      const room = Math.max(0, MAX_IMAGES - cur.length);
      return room > 0 ? [...cur, ...converted.slice(0, room)] : cur;
    });
  }

  async function submit(overrideText) {
    const text = (overrideText ?? draft).trim();
    if (!text || streaming) return;
    setDraft('');
    const sent = [...images];
    setImages([]);
    const ok = await sendMessage(text, sent);
    // Restore on failure — but never clobber a NEWER draft the user typed while
    // the send was streaming (draft-while-streaming + Stop).
    if (!ok) {
      setDraft((cur) => cur || text);
      setImages((cur) => (cur.length ? cur : sent));
    }
  }

  function onKeyDown(e) {
    // Read the live DOM value directly (not the `draft` state closure): the
    // `input` event just before this keydown may not have propagated to a
    // re-render yet, and the raw element value is always current.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e.target.value); }
  }

  function onPaste(e) {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  }

  return (
    <div class="fabry-composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer?.files || []); }}>
      {store.sendError.value && <div class="fabry-senderr">{store.sendError.value}</div>}
      <div class="fabry-composer-box">
        {images.length > 0 && (
          <div class="fabry-attach-row">
            {images.map((img, i) => (
              <span class="fabry-attach">
                <img src={`data:${img.media_type};base64,${img.data}`} alt="attachment" />
                <button type="button" title="Remove" onClick={() => setImages(images.filter((_, j) => j !== i))}>{'×'}</button>
              </span>
            ))}
          </div>
        )}
        <div class="fabry-input-wrap">
          {showMenu && <CommandMenu query={draft} commands={store.commands.value} onPick={(v) => setDraft(v)} />}
          <textarea
            class="fabry-input"
            rows={1}
            placeholder={streaming ? 'Prepare your next message…' : 'What would you like to know about this organization?'}
            value={draft}
            onInput={(e) => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'; }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        <div class="fabry-bar">
          <label class="fabry-attach-btn" title="Attach image">
            <IconPlus />
            <input type="file" accept={IMG_TYPES.join(',')} multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </label>
          {streaming && <span class="fabry-working"><GerundLoader gerunds={GERUNDS} /></span>}
          <span class="fabry-bar-spacer" />
          {showPersona && (
            <span class="fabry-persona-wrap" ref={personaRef}>
              <button type="button" class="fabry-persona-chip" title="Persona for the next chat" aria-haspopup="menu" aria-expanded={personaOpen} onClick={() => setPersonaOpen((o) => !o)}>
                {personaLabel(store.personaChoice.value)}<IconCaret />
              </button>
              {personaOpen && (
                <div class="fabry-persona-menu" role="menu">
                  {PERSONAS.map((p) => (
                    <button
                      type="button"
                      key={p.value}
                      role="menuitemradio"
                      aria-checked={store.personaChoice.value === p.value}
                      class={'fabry-persona-menu-item' + (store.personaChoice.value === p.value ? ' on' : '')}
                      onClick={() => { store.personaChoice.value = p.value; setPersonaOpen(false); }}
                    >
                      <span class="fabry-persona-menu-label">{p.label}<span class="fabry-persona-check">{store.personaChoice.value === p.value ? '✓' : ''}</span></span>
                      <span class="fabry-persona-menu-hint">{p.hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          {store.deepVerifyAllowed.value && (
            <Tip text={<span><b>Deep verify</b> {'—'} checks each answer in a fresh chat and auto-fixes issues. Roughly 2{'–'}3{'×'} the tokens and latency per message.</span>}>
              <button
                type="button"
                class={'fabry-deep-toggle' + (store.deepMode.value ? ' on' : '')}
                aria-label="Deep verify"
                aria-pressed={store.deepMode.value}
                onClick={() => { store.deepMode.value = !store.deepMode.value; }}
              >
                <FabryMark animated={false} size={17} />
              </button>
            </Tip>
          )}
          {streaming
            ? <button type="button" class="fabry-stop" title="Stop" onClick={stopStreaming}><span class="fabry-stop-sq" /></button>
            : <button type="button" class="fabry-send" title="Send" disabled={!draft.trim()} onClick={() => submit()}><IconSend /></button>}
        </div>
      </div>
      <div class="fabry-notice">
        Mr. Fabry can read this organization and, as Autonomous, act on it {'—'} including modifications. Cautious asks before every write.
      </div>
    </div>
  );
}
