import { h } from 'preact';
import { annotationIdFromInput } from '../../rossum/annotationUrl.js';

export default function IdInput({ onSubmit }) {
  return (
    <form
      class="inspector-idform"
      onSubmit={(e) => {
        e.preventDefault();
        const raw = e.currentTarget.querySelector('input')?.value;
        const id = annotationIdFromInput(raw);
        if (id) onSubmit(id);
      }}
    >
      <input class="inspector-idinput" placeholder="Annotation id or Rossum URL" spellcheck={false} />
      <button class="btn btn-primary" type="submit">Inspect</button>
    </form>
  );
}
