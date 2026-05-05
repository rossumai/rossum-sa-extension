import { h } from 'preact';
import { domain, loading, total } from '../store.js';

export default function ConnectionBar({ connected }) {
  if (!connected) {
    return (
      <div class="connection-bar">
        <span class="connection-dot error"></span>
        Not connected — open a Rossum page and click Audit Logs in the extension popup
      </div>
    );
  }
  return (
    <div class="connection-bar">
      <span class={'connection-dot' + (loading.value ? ' busy' : '')}></span>
      Audit Logs · Connected to {prettyDomain(domain.value)}
      {total.value != null && (
        <span class="connection-meta">{total.value.toLocaleString()} records</span>
      )}
    </div>
  );
}

function prettyDomain(d) {
  try {
    return new URL(d).host;
  } catch {
    return d;
  }
}
