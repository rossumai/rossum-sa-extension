import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

// Animated rainbow gerund loader — crossfades between rotating gerunds while a
// Fabry run is in flight. Owns its own tick; emits the shared console.css
// classes (.nl-search-loading / .nl-gerund / -in / -out).
export default function GerundLoader({ gerunds, intervalMs = 2400 }) {
  const [gi, setGi] = useState(0);
  useEffect(() => {
    setGi(0);
    const id = setInterval(() => setGi((i) => i + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  const list = gerunds && gerunds.length ? gerunds : ['Working'];
  return (
    <div class="nl-search-loading">
      {gi > 0 && <span key={'o' + gi} class="nl-gerund nl-gerund-out">{list[(gi - 1) % list.length] + '…'}</span>}
      <span key={'i' + gi} class="nl-gerund nl-gerund-in">{list[gi % list.length] + '…'}</span>
    </div>
  );
}
