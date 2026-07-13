import { h } from 'preact';

// Fallback renderer for a turn with nothing normally renderable (spec §6).
// Never blank: a stream error, an unsupported (future) interactive element
// named with its raw payload, or a quiet no-response note.
export default function FabryNotice({ notice }) {
  if (!notice) return null;
  if (notice.kind === 'error') {
    return <div class="fabry-turn-notice fabry-turn-notice-error">{notice.text || 'The agent reported an error.'}</div>;
  }
  if (notice.kind === 'unsupported') {
    return (
      <div class="fabry-turn-notice fabry-turn-notice-warn">
        <div>Mr. Fabry used an interactive element this version of the extension doesn{`'`}t support yet (<code>{notice.types.join(', ')}</code>). Update the extension, or continue this chat in the Rossum agent UI.</div>
        <details class="fabry-turn-notice-details"><summary>Details</summary><pre>{JSON.stringify(notice.payloads, null, 2)}</pre></details>
      </div>
    );
  }
  return <div class="fabry-turn-notice fabry-turn-notice-muted">(no response)</div>;
}
