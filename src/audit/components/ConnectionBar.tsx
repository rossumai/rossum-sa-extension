import { h } from 'preact';
import { domain, loading, pageInfo } from '../store.js';
import { orgName, orgIsProduction } from '../../console/orgName.js';

export default function ConnectionBar({ connected }: { connected: boolean | null }) {
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
      {orgName.value ? ` \u00b7 ${orgName.value}` : ''}
      {orgIsProduction.value ? <span class="connection-prod">PRODUCTION</span> : null}
      {pageInfo.value.total != null && (
        <span class="connection-meta">{pageInfo.value.total.toLocaleString()} records</span>
      )}
    </div>
  );
}

function prettyDomain(d: string) {
  try {
    return new URL(d).host;
  } catch {
    return d;
  }
}
