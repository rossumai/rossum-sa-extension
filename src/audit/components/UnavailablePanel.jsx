import { h } from 'preact';
import { availabilityMessage, availabilityStatus, activeSource } from '../store.js';
import { SOURCES } from '../sources/index.js';

export default function UnavailablePanel() {
  const status = availabilityStatus.value;
  const message = availabilityMessage.value;
  const label = SOURCES[activeSource.value]?.label || 'This source';

  return (
    <div class="unavailable-panel">
      <h2 class="unavailable-title">{label} aren't available for your role/plan</h2>
      <p class="unavailable-lead">
        The audit log endpoint refused the request{status ? ` (HTTP ${status})` : ''}. This usually means one of:
      </p>
      <ul class="unavailable-causes">
        <li><strong>Subscription / feature flag.</strong> Audit logs are not part of every Rossum plan and may need to be enabled by Rossum for this organization.</li>
        <li><strong>Missing role.</strong> Only organization admins (or organization-group admins) can read audit logs. Confirm your user has the right role.</li>
      </ul>
      {message && (
        <div class="unavailable-raw">
          <span class="unavailable-raw-label">API response</span>
          <code>{message}</code>
        </div>
      )}
      <p class="unavailable-foot">
        If both look fine, contact Rossum support — they can confirm whether the feature is provisioned for your organization.
      </p>
    </div>
  );
}
