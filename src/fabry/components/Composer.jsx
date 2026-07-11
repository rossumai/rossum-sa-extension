import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { sendMessage, stopStreaming } from '../chat.js';
import GerundLoader from '../../ui/GerundLoader.jsx';
import CommandMenu from './CommandMenu.jsx';
import { PERSONAS } from '../personas.js';

const MAX_IMAGES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const GERUNDS = ['Thinking', 'Investigating', 'Reading', 'Cross-checking', 'Answering'];

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
  const streaming = store.streaming.value;
  const isNewChat = !store.activeChatId.value;
  const showMenu = draft.startsWith('/') && !draft.includes('\n') && store.commands.value.length > 0;

  async function addFiles(files) {
    const picked = [...files].filter((f) => IMG_TYPES.includes(f.type) && f.size <= MAX_BYTES);
    const converted = await Promise.all(picked.map(fileToImage));
    // Cap is computed from `cur.length` inside the functional updater (not
    // the `images` closure) so concurrent addFiles calls (e.g. a paste and a
    // drop in quick succession) can't both read a stale count and together
    // push the total past MAX_IMAGES.
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
    // Restore on failure — but never clobber a NEWER draft the user typed
    // while the send was streaming (draft-while-streaming + Stop).
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
      {(isNewChat || store.deepVerifyAllowed.value || streaming) && <div class="fabry-persona">
        {streaming && <span class="fabry-working"><GerundLoader gerunds={GERUNDS} /></span>}
        {isNewChat && !streaming && <span class="fabry-persona-label">Persona</span>}
        {isNewChat && !streaming && (
          <span class="fabry-persona-seg">
            {PERSONAS.map((p) => (
              <button type="button" key={p.value} title={p.hint} class={store.personaChoice.value === p.value ? 'on' : ''} onClick={() => { store.personaChoice.value = p.value; }}>{p.label}</button>
            ))}
          </span>
        )}
        {isNewChat && !streaming && <span class="fabry-persona-hint">{PERSONAS.find((p) => p.value === store.personaChoice.value)?.hint}</span>}
        {store.deepVerifyAllowed.value && (
          <button
            type="button"
            class={'fabry-deep-toggle' + (store.deepMode.value ? ' on' : '')}
            title="Verifies each answer in a fresh chat and auto-fixes issues. Roughly 2–3× tokens and latency per message."
            onClick={() => { store.deepMode.value = !store.deepMode.value; }}
          >
            {'✦'} Deep verify
          </button>
        )}
      </div>}
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
        <div class="fabry-field">
          <textarea
            class="fabry-input"
            rows={1}
            placeholder={streaming ? 'Prepare your next message…' : 'Message Mr. Fabry… (Enter to send, Shift+Enter for a new line)'}
            value={draft}
            onInput={(e) => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'; }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div class="fabry-input-actions">
            <label class="fabry-attach-btn" title="Attach image">
              {'\u{1F4CE}'}
              <input type="file" accept={IMG_TYPES.join(',')} multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
            {streaming
              ? <button type="button" class="fabry-stop" onClick={stopStreaming}>Stop</button>
              : <button type="button" class="fabry-send" disabled={!draft.trim()} onClick={() => submit()}>Send</button>}
          </div>
        </div>
      </div>
      <div class="fabry-notice">
        Mr. Fabry can read this organization and, as Autonomous, act on it {'—'} including modifications. Cautious asks before every write.
      </div>
    </div>
  );
}
