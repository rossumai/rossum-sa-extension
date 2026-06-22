import { h } from 'preact';

function parseId(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\/document\/(\d+)/) || s.match(/\/annotations?\/(\d+)/) || s.match(/^(\d+)$/);
  return m ? m[1] : null;
}

export default function IdInput({ onSubmit }) {
  return (
    <form
      class="inspector-idform"
      onSubmit={(e) => {
        e.preventDefault();
        const raw = e.currentTarget.querySelector('input')?.value;
        const id = parseId(raw);
        if (id) onSubmit(id);
      }}
    >
      <input class="inspector-idinput" placeholder="Annotation id or Rossum URL" spellcheck={false} />
      <button class="btn btn-primary" type="submit">Inspect</button>
    </form>
  );
}
