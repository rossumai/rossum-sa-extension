import * as api from '../api.js';

export function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function showAsyncStatus(statusEl, message) {
  const operationId = message ? message.match(/[a-f0-9]{24}/i)?.[0] : null;
  if (!operationId) {
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.classList.remove('hidden');
  renderOpStatus(statusEl, operationId, 'RUNNING', null);
}

function renderOpStatus(statusEl, operationId, status, errorMessage) {
  const badgeClass = status === 'FINISHED' ? 'finished' : status === 'FAILED' ? 'failed' : 'running';
  statusEl.innerHTML = `
    <div class="op-status">
      <span class="op-status-badge ${badgeClass}">${status.toLowerCase()}</span>
      <span>Operation: ${operationId}</span>
      ${status !== 'FINISHED' && status !== 'FAILED' ? '<button class="btn btn-sm op-check-btn" style="margin-left:auto">Check Status</button>' : ''}
      ${errorMessage ? `<span style="color:var(--danger);margin-left:8px">${escapeHtml(errorMessage)}</span>` : ''}
    </div>
  `;
  const btn = statusEl.querySelector('.op-check-btn');
  if (btn) {
    btn.addEventListener('click', async () => {
      try {
        const res = await api.checkOperationStatus(operationId);
        const op = res.result || {};
        renderOpStatus(statusEl, operationId, op.status || 'UNKNOWN', op.error_message);
      } catch (err) {
        statusEl.innerHTML = `<div class="op-status"><span style="color:var(--danger)">${escapeHtml(err.message)}</span></div>`;
      }
    });
  }
}
