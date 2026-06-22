import { fetchRossumApi } from '../api.js';

export function init() {
  const style = document.createElement('style');
  style.textContent = `
[data-cy="sidebar-queue"],
[data-cy="workspace"],
[data-cy="queue"],
[data-cy="extensions-list-name"],
[data-cy="rule-tile"],
[data-field="original_file_name"],
[data-sentry-component="LabelChip"] {
  position: relative !important;
  overflow: visible !important;
}

/* Graph bubble cell + Users name cell: need position:relative for badge
   anchoring, but NOT overflow:visible — Rossum relies on overflow:hidden +
   text-overflow:ellipsis here to truncate long names. Forcing visible lets
   the name overflow into adjacent space (graph: pushes the gear/squares
   buttons past the bubble border; users: name spills into the email column).
   The badge sits inside the cell at bottom-right or cell-overlay, so clipping
   is fine. Engine tiles likewise only need the anchor — the badge sits inside
   the tile at top-right. */
[data-cy^="extension-cell-"],
[data-cy="engine-tile"],
[data-field="name"] {
  position: relative !important;
}

.rossum-sa-extension-resource-id {
  position: absolute;
  top: 2px;
  right: 2px;
  font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', 'Roboto Mono', Menlo, Consolas, monospace;
  font-size: 9px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  letter-spacing: 0.01em;
  color: rgba(190, 40, 70, 0.6);
  background-color: rgba(255, 255, 255, 0.75);
  padding: 1px 4px;
  border-radius: 4px;
  opacity: 0.85;
  z-index: 100;
  pointer-events: auto;
  cursor: pointer;
  transition: opacity 0.15s ease, color 0.15s ease, background-color 0.15s ease, font-size 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}

.rossum-sa-extension-resource-id:hover {
  opacity: 1;
  font-size: 11px;
  color: rgba(190, 40, 70, 1);
  background-color: rgba(255, 255, 255, 0.98);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.12);
  z-index: 9999;
}

.rossum-sa-extension-resource-id--bottom-left {
  top: auto;
  right: auto;
  bottom: 2px;
  left: 2px;
}

.rossum-sa-extension-resource-id--bottom-right {
  top: auto;
  bottom: 2px;
}

.rossum-sa-extension-resource-id--below {
  top: 100%;
  right: auto;
  left: 2px;
}

.rossum-sa-extension-resource-id--left-offset {
  right: auto;
  left: 100%;
  margin-left: 4px;
}

.rossum-sa-extension-resource-id--cell-overlay {
  top: 50%;
  right: auto;
  left: 2px;
  transform: translateY(-50%);
}`;
  document.head?.appendChild(style);
}

// Position of a label tile among the same-named tiles in the labels management
// list (DOM order). Label names are not unique, so this is what lets us map each
// tile to its own label: the Nth same-named tile gets the Nth same-named label.
// Only tiles inside the management list (LabelChip wrapped in a TileContent tile)
// are counted, so chips elsewhere on the page can't skew the position.
function labelTileIndex(node, name) {
  let index = 0;
  for (const chip of document.querySelectorAll('[data-sentry-component="LabelChip"]')) {
    if (chip === node) continue;
    if (chip.closest('[data-sentry-component="TileContent"]') == null) continue;
    if (chip.querySelector('.MuiChip-label')?.textContent.trim() !== name) continue;
    if (node.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_PRECEDING) index++;
  }
  return index;
}

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

  // Extensions dependency graph: each bubble has [data-cy="extension-cell-<slug>"]
  // wrapping the leaf icon and name. The ID lives in the sibling gear link's href.
  if (node.matches('[data-cy^="extension-cell-"]')) {
    const link = node.parentElement?.querySelector('a[data-cy="go-to-extension-settings"]');
    const match = (link?.getAttribute('href') ?? '').match(/\/extensions\/my-extensions\/(\d+)/);
    if (match) {
      displayResourceId(node, match[1], 'cell-overlay');
    }
  }

  // Settings > Labels screen: name-matched via API. Label names are not unique,
  // so when several labels share a name a plain name lookup would hand every tile
  // the same (first) ID. /api/v1/labels and the rendered list are both ordered by
  // name, so a same-named group appears in the same order in both — we disambiguate
  // by position: the Nth same-named tile maps to the Nth same-named label. This is
  // only meaningful inside the labels management list (LabelChip in a TileContent
  // tile), where every label is present; elsewhere (document rows, annotation
  // sidebar) only a subset of chips shows, so we keep the simple first match.
  if (node.matches('[data-sentry-component="LabelChip"]')) {
    const nameEl = node.querySelector('.MuiChip-label');
    const name = nameEl?.textContent.trim();
    if (name) {
      fetchRossumApi('/api/v1/labels?page_size=100').then((data) => {
        const matches = (data.results ?? []).filter((l) => l.name === name);
        if (matches.length === 0) return;
        const inLabelList = node.closest('[data-sentry-component="TileContent"]') != null;
        if (matches.length === 1 || !inLabelList) {
          displayResourceId(node, String(matches[0].id));
          return;
        }
        const i = labelTileIndex(node, name);
        displayResourceId(node, String(matches[Math.min(i, matches.length - 1)].id));
      }).catch(() => {});
    }
  }

  // Rule manager tiles: data-id directly on the tile
  if (node.matches('[data-cy="rule-tile"]') && node.dataset.id) {
    displayResourceId(node, node.dataset.id);
  }

  // Automation > AI engines: extraction and splitting/sorting engine tiles carry
  // data-id directly. Dedicated/generic engine tiles render without
  // data-cy/data-id (not clickable in the UI), so they get no badge.
  if (node.matches('[data-cy="engine-tile"]') && node.dataset.id) {
    displayResourceId(node, node.dataset.id);
  }

  // Settings > Users screen: label on the name cell, ID from parent anchor href.
  // Use bottom-right placement so the badge sits in the cell's lower whitespace
  // below the vertically-centered name text, avoiding overlap with long names.
  if (node.matches('[data-field="name"]')) {
    const anchor = node.closest('a[href*="/settings/users/"]');
    if (anchor) {
      const match = (anchor.getAttribute('href') ?? '').match(/\/settings\/users\/(\d+)/);
      if (match) {
        displayResourceId(node, match[1], 'bottom-right');
      }
    }
  }
}
