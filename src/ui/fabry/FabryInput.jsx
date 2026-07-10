import { h } from 'preact';
import GerundLoader from '../GerundLoader.jsx';

// Controlled Fabry ask input (MDH visual design): ✦ spark + rounded input +
// gerund loader while busy. Store-agnostic — the parent owns value/submit.
export default function FabryInput({ value, onInput, onSubmit, busy, placeholder, gerunds, className }) {
  return (
    <div class={'agent-input-row' + (className ? ' ' + className : '')}>
      <div class="nl-search-wrapper">
        <span class={'agent-spark' + (busy ? ' loading' : '')}>{'✦'}</span>
        <input
          class={'nl-search-input' + (busy ? ' loading' : '')}
          type="text"
          placeholder={placeholder}
          value={busy ? '' : value}
          disabled={busy}
          onInput={(e) => onInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(e.target.value); if (e.key === 'Escape') onInput(''); }}
        />
        {busy && <GerundLoader gerunds={gerunds} />}
      </div>
    </div>
  );
}
