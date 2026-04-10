import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { domain, selectedCollection } from '../store.js';
import * as cache from '../cache.js';

export default function ConnectionBar({ connected }) {
  const [cacheText, setCacheText] = useState('cache: empty');

  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => {
      const col = selectedCollection.value;
      const s = cache.stats(col);
      if (s.fieldCount === 0) {
        setCacheText('cache: empty');
      } else if (s.age !== null) {
        const secs = Math.round(s.age / 1000);
        setCacheText(`cache: ${s.fieldCount} objects \u00b7 ${secs < 2 ? 'fresh' : secs + 's ago'}`);
      } else {
        setCacheText(`cache: ${s.fieldCount} objects`);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [connected]);

  if (!connected) {
    return (
      <div class="connection-bar">
        <span class="connection-dot error"></span> Not connected — open a Rossum page and click Data Storage in the extension popup
      </div>
    );
  }

  return (
    <div class="connection-bar">
      <span class="connection-dot"></span> Connected to {domain.value}
      <span class="cache-indicator">{cacheText}</span>
    </div>
  );
}
