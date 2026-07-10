// src/ui/fabry/FabryTranscript.jsx
import { h } from 'preact';

// Read-only "investigation" modal for a finished Fabry answer: the streamed
// reasoning + the tool names it used. Reuses the Inspector modal chrome.
export default function FabryTranscript({ reasoning, tools, onClose }) {
  return (
    <div class="inspector-modal-backdrop" onClick={onClose}>
      <div class="inspector-modal" onClick={(e) => e.stopPropagation()}>
        <div class="inspector-modal-hd">Investigation transcript <button type="button" class="inspector-modal-x" onClick={onClose}>{'×'}</button></div>
        {tools && tools.length ? <div class="inspector-note">Tools used: {tools.join(', ')}</div> : null}
        <pre class="inspector-code-block">{reasoning || '(no reasoning recorded)'}</pre>
      </div>
    </div>
  );
}
