// src/ui/fabry/FabryTranscript.tsx
import { h } from 'preact';
import styles from './FabryTranscript.module.css';

// Read-only "investigation" modal for a finished Fabry answer: the streamed
// reasoning + the tool names it used. Self-contained styling (own module).
export default function FabryTranscript(
  { reasoning, tools, onClose }:
  { reasoning?: string | null; tools?: any[]; onClose?: () => void },
) {
  return (
    <div class={styles.backdrop} onClick={onClose}>
      <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div class={styles.hd}>Investigation transcript <button type="button" class={styles.x} onClick={onClose}>{'×'}</button></div>
        {tools && tools.length ? <div class={styles.note}>Tools used: {tools.join(', ')}</div> : null}
        <pre class={styles.codeBlock}>{reasoning || '(no reasoning recorded)'}</pre>
      </div>
    </div>
  );
}
