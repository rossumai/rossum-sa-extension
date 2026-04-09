import { fetchRossumApi } from '../api.js';

function displayResourceId(node, id, variant) {
  if (node.querySelector('.rossum-sa-extension-resource-id') != null) return;
  const span = document.createElement('span');
  span.className = 'rossum-sa-extension-resource-id' + (variant != null ? ` rossum-sa-extension-resource-id--${variant}` : '');
  span.textContent = id;
  span.title = 'Click to copy';
  span.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(id).then(() => {
      const original = span.textContent;
      span.textContent = '\u2713 copied';
      setTimeout(() => { span.textContent = original; }, 1000);
    });
  });
  node.appendChild(span);
}

export function handleNode(node) {
  // Sidebar workspace IDs: name-matched via API
  if (node.matches('[data-cy="workspace"]')) {
    const name = node.querySelector('[data-cy="sidebar-heading"] span')?.textContent.trim();
    if (name) {
      fetchRossumApi('/api/v1/workspaces?page_size=100').then((data) => {
        const ws = data.results?.find((w) => w.name === name);
        if (ws) displayResourceId(node, String(ws.id));
      }).catch(() => {});
    }
  }

  // Sidebar queue IDs: data-id attribute directly on the element
  if (node.matches('[data-cy="sidebar-queue"]') && node.dataset.id) {
    displayResourceId(node, node.dataset.id);
  }

  // Document list annotation IDs: row has data-id, label goes in the filename cell
  if (node.matches('[data-field="original_file_name"]')) {
    const row = node.closest('[data-cy="document-row"]');
    if (row instanceof HTMLElement && row.dataset.id) {
      displayResourceId(node, row.dataset.id);
    }
  }

  // Automation screen queue IDs: extract from href="/queues/{id}/..."
  if (node.matches('[data-cy="queue"]')) {
    const href = node.getAttribute('href') ?? '';
    const match = href.match(/\/queues\/(\d+)/);
    if (match) {
      displayResourceId(node, match[1]);
    }
  }

  // Extensions screen hook IDs: label on the name element, ID from parent anchor href
  if (node.matches('[data-cy="extensions-list-name"]')) {
    const anchor = node.closest('a[href*="/extensions/my-extensions/"]');
    if (anchor) {
      const match = (anchor.getAttribute('href') ?? '').match(/\/extensions\/my-extensions\/(\d+)/);
      if (match) {
        displayResourceId(node, match[1], 'left-offset');
      }
    }
  }

  // Settings > Labels screen: name-matched via API
  if (node.matches('[data-sentry-component="LabelChip"]')) {
    const nameEl = node.querySelector('.MuiChip-label');
    const name = nameEl?.textContent.trim();
    if (name) {
      fetchRossumApi('/api/v1/labels?page_size=100').then((data) => {
        const label = data.results?.find((l) => l.name === name);
        if (label) displayResourceId(node, String(label.id));
      }).catch(() => {});
    }
  }

  // Rule manager tiles: data-id directly on the tile
  if (node.matches('[data-cy="rule-tile"]') && node.dataset.id) {
    displayResourceId(node, node.dataset.id);
  }

  // Settings > Users screen: label on the name cell, ID from parent anchor href
  if (node.matches('[data-field="name"]')) {
    const anchor = node.closest('a[href*="/settings/users/"]');
    if (anchor) {
      const match = (anchor.getAttribute('href') ?? '').match(/\/settings\/users\/(\d+)/);
      if (match) {
        displayResourceId(node, match[1]);
      }
    }
  }
}
