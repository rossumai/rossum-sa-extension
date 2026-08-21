import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { domain, selectedCollection } from '../store.js';
import * as cache from '../cache.js';

export default function ConnectionBar({ connected }: { connected: boolean | null }) {
  const [cacheText, setCacheText] = useState('cache: empty');

  useEffect(() => {
    if (!connected) return;
    let last = '';
    const compute = () => {
      const col = selectedCollection.value;
      const s = cache.stats(col as string);
      if (s.fieldCount === 0) return 'cache: empty';
      if (s.age !== null) {
        const secs = Math.round(s.age / 1000);
        return `cache: ${s.fieldCount} objects \u00b7 ${secs < 2 ? 'fresh' : secs + 's ago'}`;
      }
      return `cache: ${s.fieldCount} objects`;
    };
    const id = setInterval(() => {
      const next = compute();
      // Skip the setState entirely when the displayed text hasn't changed \u2014
      // otherwise this fires a re-render every second of every connected session.
      if (next !== last) { last = next; setCacheText(next); }
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
