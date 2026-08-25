import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import styles from './aiInput.module.css';

// Animated rainbow gerund loader — crossfades between rotating gerunds while a
// Fabry run is in flight. Owns its own tick; emits the shared aiInput module
// classes (loader / gerund / gerundIn / gerundOut). Sizing/left-inset come from
// the surrounding .row context (FabryInput), so this stays position-agnostic.
export default function GerundLoader({
  gerunds,
  intervalMs = 2400,
}: {
  gerunds: string[];
  intervalMs?: number;
}) {
  const [gi, setGi] = useState(0);
  useEffect(() => {
    setGi(0);
    const id = setInterval(() => setGi((i) => i + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  const list = gerunds && gerunds.length ? gerunds : ['Working'];
  return (
    <div class={styles.loader}>
      {gi > 0 && (
        <span key={'o' + gi} class={styles.gerund + ' ' + styles.gerundOut}>
          {list[(gi - 1) % list.length] + '…'}
        </span>
      )}
      <span key={'i' + gi} class={styles.gerund + ' ' + styles.gerundIn}>
        {list[gi % list.length] + '…'}
      </span>
    </div>
  );
}
