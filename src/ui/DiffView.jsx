import { h } from 'preact';
import { diffWords } from './textDiff.js';
import styles from './DiffView.module.css';

// Shared inline word-diff renderer (design system). Shows a clear before→after diff:
// added words as <ins> (highlighted), removed as <del> (struck), unchanged plain.
export default function DiffView({ before, after }) {
  const segs = diffWords(before ?? '', after ?? '');
  return (
    <div class={styles.diff}>
      {segs.map((s, i) => {
        if (s.type === 'add') return <ins key={i} class={styles.add}>{s.text}</ins>;
        if (s.type === 'del') return <del key={i} class={styles.del}>{s.text}</del>;
        return <span key={i}>{s.text}</span>;
      })}
    </div>
  );
}
