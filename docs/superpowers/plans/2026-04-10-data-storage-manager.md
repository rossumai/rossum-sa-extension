# Data Storage Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-page Chrome extension tab for browsing and managing Rossum Data Storage collections — CRUD, aggregation, bulk write, index management — with light/dark theming.

**Architecture:** Modular vanilla JS under `src/mdh/`, bundled by esbuild alongside existing entry points. State management via a central event emitter. API client wraps all 19 Data Storage REST endpoints. Authentication passed from popup via `chrome.storage.local`.

**Tech Stack:** Vanilla JS (ES modules), esbuild, Chrome Extension Manifest V3 APIs

**Spec:** `docs/superpowers/specs/2026-04-10-data-storage-manager-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `manifest.json` | Modify | Add `host_permissions` |
| `build.js` | Modify | Add MDH entry point + static file copies |
| `src/mdh/mdh.html` | Create | Page shell — DOM skeleton for sidebar + main panel |
| `src/mdh/mdh.css` | Create | All styles with light/dark theme via CSS custom properties |
| `src/mdh/state.js` | Create | Central state + event emitter |
| `src/mdh/api.js` | Create | Data Storage API client (all 19 endpoints + healthz + operation status) |
| `src/mdh/index.js` | Create | Entry point — auth init, app shell render, panel routing |
| `src/mdh/ui/modal.js` | Create | Generic modal + confirmation modal |
| `src/mdh/ui/sidebar.js` | Create | Collection list, create, context menu, rename, drop |
| `src/mdh/ui/records.js` | Create | Record table — find, paginate, expand, delete one |
| `src/mdh/ui/record-editor.js` | Create | Insert one/many, edit (update one), replace one |
| `src/mdh/ui/update-many.js` | Create | Update many with filter + update + preview |
| `src/mdh/ui/delete-many.js` | Create | Delete many with filter + preview |
| `src/mdh/ui/aggregate.js` | Create | Aggregation pipeline editor + results |
| `src/mdh/ui/bulk-write.js` | Create | Bulk write operations editor + async status |
| `src/mdh/ui/indexes.js` | Create | Index list, create, drop |
| `src/mdh/ui/search-indexes.js` | Create | Search index list, create, drop |
| `src/rossum/features/dev-flags.js` | Modify | Add `get-auth-info` message handler |
| `src/popup/popup.html` | Modify | Add "Data Storage" button |
| `src/popup/popup.js` | Modify | Add Data Storage button click handler |
| `src/popup/popup.css` | Modify | Style for secondary action button |

---

### Task 1: Manifest and Build Scaffold

**Files:**
- Modify: `manifest.json`
- Modify: `build.js`

- [ ] **Step 1: Add host_permissions to manifest.json**

Add after the `"permissions"` line in `manifest.json`:

```json
"host_permissions": [
  "http://localhost:3000/*",
  "https://*.rossum.ai/*",
  "https://*.rossum.app/*",
  "https://*.r8.lol/*"
],
```

The full `manifest.json` becomes:

```json
{
  "manifest_version": 3,
  "name": "Rossum SA extension",
  "version": "0.19.0",
  "description": "Adds additional functionality to Rossum, NetSuite, and Coupa UI for easier onboarding.",
  "icons": {
    "16": "icons/16-blue-crunch.png",
    "48": "icons/48-blue-crunch.png",
    "128": "icons/128-blue-crunch.png"
  },
  "permissions": ["storage", "tabs"],
  "host_permissions": [
    "http://localhost:3000/*",
    "https://*.rossum.ai/*",
    "https://*.rossum.app/*",
    "https://*.r8.lol/*"
  ],
  "content_scripts": [
    {
      "js": ["scripts/rossum.js"],
      "matches": [
        "http://localhost:3000/*",
        "https://*.rossum.ai/*",
        "https://*.rossum.app/*",
        "https://*.r8.lol/*"
      ]
    },
    {
      "js": ["scripts/netsuite.js"],
      "matches": ["https://*.netsuite.com/app/*"]
    },
    {
      "js": ["scripts/coupa.js"],
      "matches": ["https://*.coupacloud.com/*"]
    }
  ],
  "action": {
    "default_popup": "popup/popup.html"
  }
}
```

- [ ] **Step 2: Update build.js to include MDH entry point and static files**

Add `dist/mdh` to the directory creation loop, add static file copies, and add the entry point:

```js
const esbuild = require('esbuild');
const { cpSync, rmSync, mkdirSync } = require('fs');

const isWatch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });

for (const dir of ['dist/popup', 'dist/icons', 'dist/mdh']) {
  mkdirSync(dir, { recursive: true });
}

cpSync('manifest.json', 'dist/manifest.json');
cpSync('icons', 'dist/icons', { recursive: true });
cpSync('src/popup/popup.html', 'dist/popup/popup.html');
cpSync('src/popup/popup.css', 'dist/popup/popup.css');
cpSync('src/mdh/mdh.html', 'dist/mdh/mdh.html');
cpSync('src/mdh/mdh.css', 'dist/mdh/mdh.css');

const options = {
  entryPoints: {
    'scripts/rossum': 'src/rossum/index.js',
    'scripts/netsuite': 'src/netsuite/index.js',
    'scripts/coupa': 'src/coupa/index.js',
    'popup/popup': 'src/popup/popup.js',
    'mdh/mdh': 'src/mdh/index.js',
  },
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  logLevel: 'info',
};

if (isWatch) {
  esbuild.context(options).then((ctx) => ctx.watch());
} else {
  esbuild.buildSync(options);
}
```

- [ ] **Step 3: Commit**

```bash
git add manifest.json build.js
git commit -m "add host_permissions and MDH build entry point"
```

---

### Task 2: State Module

**Files:**
- Create: `src/mdh/state.js`

- [ ] **Step 1: Create state.js with event emitter and initial state**

```js
// src/mdh/state.js

const listeners = {};

const state = {
  domain: '',
  token: '',
  collections: [],
  selectedCollection: null,
  records: [],
  filter: '{}',
  sort: '{}',
  projection: '',
  skip: 0,
  limit: 30,
  activePanel: 'records',
  loading: false,
  error: null,
};

export function get(key) {
  return state[key];
}

export function set(updates) {
  const changed = [];
  for (const [key, value] of Object.entries(updates)) {
    if (state[key] !== value) {
      state[key] = value;
      changed.push(key);
    }
  }
  for (const key of changed) {
    const eventName = key + 'Changed';
    if (listeners[eventName]) {
      for (const fn of listeners[eventName]) {
        fn(state[key]);
      }
    }
  }
}

export function on(eventName, fn) {
  if (!listeners[eventName]) listeners[eventName] = [];
  listeners[eventName].push(fn);
}

export function off(eventName, fn) {
  if (!listeners[eventName]) return;
  listeners[eventName] = listeners[eventName].filter((f) => f !== fn);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/state.js
git commit -m "add state module with event emitter"
```

---

### Task 3: API Client

**Files:**
- Create: `src/mdh/api.js`

- [ ] **Step 1: Create api.js with all Data Storage endpoints**

```js
// src/mdh/api.js

let serviceBase = ''; // e.g. https://acme.rossum.app/svc/data-storage
let authHeader = '';

export function init(domain, token) {
  serviceBase = `${domain}/svc/data-storage`;
  authHeader = `Bearer ${token}`;
}

async function post(path, body) {
  const res = await fetch(`${serviceBase}/api/v1${path}`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    throw new Error('Session expired. Open a Rossum page and click Data Storage again to reconnect.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.message || `API error ${res.status}`);
  }
  return data;
}

async function get(path) {
  const res = await fetch(`${serviceBase}${path}`, {
    headers: { Authorization: authHeader },
  });
  if (res.status === 401) {
    throw new Error('Session expired. Open a Rossum page and click Data Storage again to reconnect.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.message || `API error ${res.status}`);
  }
  return data;
}

// --- Collections ---

export function listCollections(filter = null, nameOnly = true) {
  return post('/collections/list', { filter, nameOnly });
}

export function createCollection(collectionName, options = {}) {
  return post('/collections/create', { collectionName, options });
}

export function renameCollection(collectionName, target, dropTarget = false) {
  return post('/collections/rename', { collectionName, target, dropTarget });
}

export function dropCollection(collectionName) {
  return post('/collections/drop', { collectionName });
}

// --- Data CRUD ---

export function find(collectionName, { query = {}, projection = null, skip = 0, limit = 30, sort = null } = {}) {
  return post('/data/find', { collectionName, query, projection, skip, limit, sort });
}

export function insertOne(collectionName, document) {
  return post('/data/insert_one', { collectionName, document });
}

export function insertMany(collectionName, documents, ordered = false) {
  return post('/data/insert_many', { collectionName, documents, ordered });
}

export function updateOne(collectionName, filter, update) {
  return post('/data/update_one', { collectionName, filter, update });
}

export function updateMany(collectionName, filter, update) {
  return post('/data/update_many', { collectionName, filter, update });
}

export function deleteOne(collectionName, filter) {
  return post('/data/delete_one', { collectionName, filter });
}

export function deleteMany(collectionName, filter) {
  return post('/data/delete_many', { collectionName, filter });
}

export function replaceOne(collectionName, filter, replacement) {
  return post('/data/replace_one', { collectionName, filter, replacement });
}

// --- Aggregation ---

export function aggregate(collectionName, pipeline) {
  return post('/data/aggregate', { collectionName, pipeline });
}

// --- Bulk Write ---

export function bulkWrite(collectionName, operations) {
  return post('/data/bulk_write', { collectionName, operations });
}

// --- Indexes ---

export function listIndexes(collectionName, nameOnly = false) {
  return post('/indexes/list', { collectionName, nameOnly });
}

export function createIndex(collectionName, indexName, keys, options = {}) {
  return post('/indexes/create', { collectionName, indexName, keys, options });
}

export function dropIndex(collectionName, indexName) {
  return post('/indexes/drop', { collectionName, indexName });
}

// --- Search Indexes ---

export function listSearchIndexes(collectionName, nameOnly = false) {
  return post('/search_indexes/list', { collectionName, nameOnly });
}

export function createSearchIndex(collectionName, { indexName, mappings, analyzer, analyzers, searchAnalyzer, synonyms } = {}) {
  const body = { collectionName, indexName, mappings };
  if (analyzer) body.analyzer = analyzer;
  if (analyzers) body.analyzers = analyzers;
  if (searchAnalyzer) body.searchAnalyzer = searchAnalyzer;
  if (synonyms) body.synonyms = synonyms;
  return post('/search_indexes/create', body);
}

export function dropSearchIndex(collectionName, indexName) {
  return post('/search_indexes/drop', { collectionName, indexName });
}

// --- Operation Status ---

export function checkOperationStatus(operationId) {
  return get(`/api/v1/operation_status/${operationId}`);
}

// --- Health ---

export function healthz() {
  return get('/api/healthz');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/api.js
git commit -m "add Data Storage API client"
```

---

### Task 4: Modal Infrastructure

**Files:**
- Create: `src/mdh/ui/modal.js`

- [ ] **Step 1: Create modal.js with openModal, closeModal, confirmModal**

```js
// src/mdh/ui/modal.js

let overlayEl = null;
let onCloseCallback = null;

function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.className = 'modal-overlay';
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeModal();
  });
  document.body.appendChild(overlayEl);
  return overlayEl;
}

export function openModal(title, contentEl, onClose) {
  const overlay = ensureOverlay();
  onCloseCallback = onClose || null;

  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'modal-card';

  const header = document.createElement('div');
  header.className = 'modal-header';
  const titleEl = document.createElement('span');
  titleEl.className = 'modal-title';
  titleEl.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', closeModal);
  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  card.appendChild(header);
  card.appendChild(contentEl);
  overlay.appendChild(card);
  overlay.classList.add('visible');

  document.addEventListener('keydown', handleEscape);
}

export function closeModal() {
  if (overlayEl) {
    overlayEl.classList.remove('visible');
    overlayEl.innerHTML = '';
  }
  document.removeEventListener('keydown', handleEscape);
  if (onCloseCallback) {
    onCloseCallback();
    onCloseCallback = null;
  }
}

function handleEscape(e) {
  if (e.key === 'Escape') closeModal();
}

export function confirmModal(title, message, onConfirm) {
  const content = document.createElement('div');
  content.className = 'modal-body';

  const msg = document.createElement('p');
  msg.className = 'modal-message';
  msg.textContent = message;
  content.appendChild(msg);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-danger';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.addEventListener('click', () => {
    closeModal();
    onConfirm();
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  content.appendChild(actions);

  openModal(title, content);
}
```

- [ ] **Step 2: Commit**

```bash
mkdir -p src/mdh/ui
git add src/mdh/ui/modal.js
git commit -m "add modal infrastructure"
```

---

### Task 5: HTML Shell and CSS

**Files:**
- Create: `src/mdh/mdh.html`
- Create: `src/mdh/mdh.css`

- [ ] **Step 1: Create mdh.html page shell**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Data Storage — Rossum SA</title>
  <link href="mdh.css" rel="stylesheet" />
</head>
<body>
  <div id="app">
    <aside id="sidebar" class="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-title">Collections</span>
        <button id="refreshCollections" class="icon-btn" title="Refresh">&#x21bb;</button>
      </div>
      <div class="sidebar-create">
        <input id="newCollectionName" type="text" class="input" placeholder="New collection..." />
        <button id="createCollectionBtn" class="btn btn-sm">Create</button>
      </div>
      <div id="collectionList" class="collection-list"></div>
      <div id="sidebarFooter" class="sidebar-footer"></div>
    </aside>

    <main id="main" class="main">
      <div id="connectionBar" class="connection-bar"></div>
      <div id="errorBanner" class="error-banner hidden"></div>
      <div id="loadingOverlay" class="loading-overlay hidden">
        <div class="spinner"></div>
      </div>

      <div id="emptyState" class="empty-state">
        <p>Select a collection to get started</p>
      </div>

      <div id="mainContent" class="main-content hidden">
        <div class="tab-bar">
          <button class="tab active" data-panel="records">Records</button>
          <button class="tab" data-panel="aggregate">Aggregate</button>
          <button class="tab" data-panel="indexes">Indexes</button>
          <button class="tab" data-panel="search-indexes">Search Indexes</button>
          <button class="tab" data-panel="bulk-write">Bulk Write</button>
        </div>

        <div id="panel-records" class="panel"></div>
        <div id="panel-aggregate" class="panel hidden"></div>
        <div id="panel-indexes" class="panel hidden"></div>
        <div id="panel-search-indexes" class="panel hidden"></div>
        <div id="panel-bulk-write" class="panel hidden"></div>
      </div>
    </main>
  </div>

  <div id="contextMenu" class="context-menu hidden"></div>

  <script src="mdh.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create mdh.css with full light/dark theme**

```css
/* src/mdh/mdh.css */

:root {
  --bg-base: #f1f1f5;
  --bg-card: #ffffff;
  --bg-input: #ffffff;
  --bg-hover: #e8e8ee;
  --bg-sidebar: #f8f8fb;
  --bg-code: #f5f5f8;
  --text-primary: #1a1a24;
  --text-secondary: #7a7a8c;
  --text-code: #333;
  --border: #dcdce4;
  --accent: #4270db;
  --accent-hover: #3560c5;
  --danger: #cc3333;
  --danger-hover: #aa2222;
  --success: #22883e;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  --radius: 6px;
  --shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-base: #12121e;
    --bg-card: #1a1a2e;
    --bg-input: #0d0d18;
    --bg-hover: #2a2a3e;
    --bg-sidebar: #1a1a2e;
    --bg-code: #0d0d18;
    --text-primary: #ccccdd;
    --text-secondary: #666680;
    --text-code: #aaaabb;
    --border: #2a2a3e;
    --accent: #4270db;
    --accent-hover: #5580ee;
    --danger: #cc3333;
    --danger-hover: #ee4444;
    --success: #22883e;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
}

/* ── Reset ────────────────────────────────────── */

*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  height: 100vh;
  overflow: hidden;
}

/* ── App Layout ───────────────────────────────── */

#app {
  display: flex;
  height: 100vh;
}

/* ── Sidebar ──────────────────────────────────── */

.sidebar {
  width: 240px;
  min-width: 240px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 12px 8px;
}

.sidebar-title {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--accent);
}

.sidebar-create {
  display: flex;
  gap: 6px;
  padding: 0 12px 10px;
}

.sidebar-create .input {
  flex: 1;
  min-width: 0;
}

.collection-list {
  flex: 1;
  overflow-y: auto;
}

.collection-item {
  padding: 7px 12px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 13px;
  transition: background 0.1s, color 0.1s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.collection-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.collection-item.active {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-left: 3px solid var(--accent);
  padding-left: 9px;
}

.collection-item-rename {
  display: flex;
  gap: 4px;
  padding: 4px 12px;
}

.collection-item-rename .input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 3px 6px;
}

.sidebar-footer {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
}

/* ── Main ─────────────────────────────────────── */

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Connection Bar ───────────────────────────── */

.connection-bar {
  padding: 6px 16px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
  display: flex;
  align-items: center;
  gap: 8px;
}

.connection-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
}

.connection-dot.error {
  background: var(--danger);
}

/* ── Error Banner ─────────────────────────────── */

.error-banner {
  padding: 8px 16px;
  background: #fef2f2;
  border-bottom: 1px solid #fecaca;
  color: #991b1b;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

@media (prefers-color-scheme: dark) {
  .error-banner {
    background: #2a1515;
    border-color: #4a2020;
    color: #fca5a5;
  }
}

.error-banner .dismiss {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
  opacity: 0.6;
}

.error-banner .dismiss:hover {
  opacity: 1;
}

/* ── Loading ──────────────────────────────────── */

.loading-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

@media (prefers-color-scheme: dark) {
  .loading-overlay {
    background: rgba(0, 0, 0, 0.3);
  }
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Empty State ──────────────────────────────── */

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 14px;
}

/* ── Tab Bar ──────────────────────────────────── */

.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
  flex-shrink: 0;
}

.tab {
  padding: 9px 18px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.tab:hover {
  color: var(--text-primary);
}

.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* ── Panels ───────────────────────────────────── */

.panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Toolbar ──────────────────────────────────── */

.toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
  flex-shrink: 0;
}

.toolbar-label {
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
  width: 60px;
}

/* ── Record List ──────────────────────────────── */

.record-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px;
}

.record-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 11px;
  transition: background 0.1s;
}

.record-row:nth-child(odd) {
  background: var(--bg-card);
}

.record-row:nth-child(even) {
  background: var(--bg-base);
}

.record-row:hover {
  background: var(--bg-hover);
}

.record-id {
  color: var(--accent);
  flex-shrink: 0;
  width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-preview {
  flex: 1;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.record-actions button {
  background: none;
  border: none;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  transition: background 0.1s, color 0.1s;
}

.record-actions .action-expand {
  color: var(--accent);
}

.record-actions .action-edit,
.record-actions .action-replace {
  color: var(--text-secondary);
}

.record-actions .action-delete {
  color: var(--danger);
}

.record-actions button:hover {
  background: var(--bg-hover);
}

.record-expanded {
  margin: 0 10px 6px;
  padding: 10px;
  background: var(--bg-code);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.record-expanded-header {
  font-size: 10px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.record-expanded pre {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-code);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

/* ── Pagination ───────────────────────────────── */

.pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-card);
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.pagination-controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

.pagination-controls button {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 6px;
}

.pagination-controls button:disabled {
  color: var(--text-secondary);
  opacity: 0.4;
  cursor: default;
}

/* ── Split View (Aggregate) ───────────────────── */

.split-view {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.split-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
  overflow: hidden;
}

.split-pane:first-child {
  border-right: 1px solid var(--border);
}

.split-pane-label {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.split-pane-footer {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 8px;
}

/* ── Index List ───────────────────────────────── */

.index-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px;
}

.index-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 12px;
}

.index-row:nth-child(odd) {
  background: var(--bg-card);
}

.index-row:nth-child(even) {
  background: var(--bg-base);
}

.index-name {
  color: var(--text-primary);
  font-weight: 500;
}

.index-keys {
  color: var(--text-secondary);
  margin-left: 10px;
  font-size: 11px;
}

.index-default {
  font-size: 10px;
  color: var(--text-secondary);
  font-style: italic;
}

.index-create-form {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-code);
  flex-shrink: 0;
}

.index-create-form .input {
  font-size: 12px;
}

/* ── Buttons ──────────────────────────────────── */

.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  background: var(--bg-card);
  color: var(--text-primary);
  flex-shrink: 0;
}

.btn:hover {
  background: var(--bg-hover);
}

.btn-sm {
  padding: 4px 10px;
  font-size: 11px;
}

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn-primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.btn-success {
  background: var(--success);
  border-color: var(--success);
  color: #fff;
}

.btn-success:hover {
  background: #1a6e32;
  border-color: #1a6e32;
}

.btn-danger {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}

.btn-danger:hover {
  background: var(--danger-hover);
  border-color: var(--danger-hover);
}

.btn-secondary {
  background: var(--bg-card);
  border-color: var(--border);
  color: var(--text-primary);
}

.icon-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background 0.1s, color 0.1s;
}

.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* ── Inputs ───────────────────────────────────── */

.input {
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s;
}

.input:focus {
  border-color: var(--accent);
}

.input-error {
  border-color: var(--danger) !important;
}

textarea.input {
  resize: vertical;
  min-height: 80px;
  line-height: 1.5;
}

.textarea-fill {
  flex: 1;
  resize: none;
}

.input-hint {
  font-size: 11px;
  color: var(--danger);
  margin-top: 4px;
}

/* ── Context Menu ─────────────────────────────── */

.context-menu {
  position: fixed;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow), 0 4px 12px rgba(0, 0, 0, 0.1);
  min-width: 140px;
  z-index: 100;
  padding: 4px 0;
}

.context-menu-item {
  display: block;
  width: 100%;
  padding: 6px 14px;
  background: none;
  border: none;
  text-align: left;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.1s;
}

.context-menu-item:hover {
  background: var(--bg-hover);
}

.context-menu-item.danger {
  color: var(--danger);
}

/* ── Modal ────────────────────────────────────── */

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal-overlay.visible {
  display: flex;
}

.modal-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
  min-width: 460px;
  max-width: 700px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
}

.modal-close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.modal-close:hover {
  color: var(--text-primary);
}

.modal-body {
  padding: 16px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-message {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.modal-field-label {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

/* ── Operation Status ─────────────────────────── */

.op-status {
  padding: 10px 16px;
  background: var(--bg-code);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.op-status-badge {
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}

.op-status-badge.running {
  background: #fef3c7;
  color: #92400e;
}

.op-status-badge.finished {
  background: #d1fae5;
  color: #065f46;
}

.op-status-badge.failed {
  background: #fee2e2;
  color: #991b1b;
}

@media (prefers-color-scheme: dark) {
  .op-status-badge.running {
    background: #3a2f10;
    color: #fbbf24;
  }
  .op-status-badge.finished {
    background: #0a3020;
    color: #6ee7b7;
  }
  .op-status-badge.failed {
    background: #3a1515;
    color: #fca5a5;
  }
}

/* ── Result info ──────────────────────────────── */

.result-info {
  padding: 8px 16px;
  font-size: 11px;
  color: var(--text-secondary);
  border-top: 1px solid var(--border);
  background: var(--bg-card);
  flex-shrink: 0;
}

/* ── Preview box (delete many / update many) ──── */

.preview-box {
  background: var(--bg-code);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px;
  max-height: 160px;
  overflow-y: auto;
}

.preview-box pre {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-code);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

/* ── Mode Toggle ──────────────────────────────── */

.mode-toggle {
  display: flex;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  flex-shrink: 0;
}

.mode-toggle button {
  padding: 4px 12px;
  background: var(--bg-card);
  border: none;
  border-right: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}

.mode-toggle button:last-child {
  border-right: none;
}

.mode-toggle button.active {
  background: var(--accent);
  color: #fff;
}

/* ── Hidden utility ───────────────────────────── */

.hidden {
  display: none !important;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/mdh/mdh.html src/mdh/mdh.css
git commit -m "add MDH page shell and CSS with light/dark themes"
```

---

### Task 6: Entry Point

**Files:**
- Create: `src/mdh/index.js`

- [ ] **Step 1: Create index.js with auth initialization and panel routing**

```js
// src/mdh/index.js

import * as api from './api.js';
import * as state from './state.js';
import { initSidebar } from './ui/sidebar.js';
import { initRecords } from './ui/records.js';
import { initAggregate } from './ui/aggregate.js';
import { initIndexes } from './ui/indexes.js';
import { initSearchIndexes } from './ui/search-indexes.js';
import { initBulkWrite } from './ui/bulk-write.js';

async function boot() {
  const { mdhToken, mdhDomain } = await chrome.storage.local.get(['mdhToken', 'mdhDomain']);

  const connectionBar = document.getElementById('connectionBar');
  if (!mdhToken || !mdhDomain) {
    connectionBar.innerHTML = '<span class="connection-dot error"></span> Not connected — open a Rossum page and click Data Storage in the extension popup';
    return;
  }

  state.set({ domain: mdhDomain, token: mdhToken });
  api.init(mdhDomain, mdhToken);

  // Health check
  try {
    await api.healthz();
    connectionBar.innerHTML = `<span class="connection-dot"></span> Connected to ${mdhDomain}`;
  } catch {
    connectionBar.innerHTML = `<span class="connection-dot error"></span> Cannot reach ${mdhDomain}`;
  }

  // Error banner
  state.on('errorChanged', (error) => {
    const banner = document.getElementById('errorBanner');
    if (error) {
      banner.innerHTML = `<span>${error.message}</span><button class="dismiss" onclick="this.parentElement.classList.add('hidden')">\u00d7</button>`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  });

  // Loading overlay
  state.on('loadingChanged', (loading) => {
    document.getElementById('loadingOverlay').classList.toggle('hidden', !loading);
  });

  // Panel tab switching
  const tabs = document.querySelectorAll('.tab-bar .tab');
  const panels = ['records', 'aggregate', 'indexes', 'search-indexes', 'bulk-write'];

  function showPanel(name) {
    for (const p of panels) {
      document.getElementById(`panel-${p}`).classList.toggle('hidden', p !== name);
    }
    for (const t of tabs) {
      t.classList.toggle('active', t.dataset.panel === name);
    }
    state.set({ activePanel: name });
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => showPanel(tab.dataset.panel));
  }

  // Show/hide main content vs empty state
  state.on('selectedCollectionChanged', (collection) => {
    document.getElementById('emptyState').classList.toggle('hidden', collection !== null);
    document.getElementById('mainContent').classList.toggle('hidden', collection === null);
  });

  // Init UI modules
  initSidebar();
  initRecords();
  initAggregate();
  initIndexes();
  initSearchIndexes();
  initBulkWrite();
}

boot();
```

- [ ] **Step 2: Verify build works**

Run: `npm run build`
Expected: Build succeeds (esbuild finds all imports — they don't exist yet, so create stub files first). Actually, we need to create the UI module stubs first, so skip verification here — it will be verified after Task 7.

- [ ] **Step 3: Commit**

```bash
git add src/mdh/index.js
git commit -m "add MDH entry point with auth and panel routing"
```

---

### Task 7: Sidebar

**Files:**
- Create: `src/mdh/ui/sidebar.js`

- [ ] **Step 1: Create sidebar.js with collection list, create, context menu, rename, drop**

```js
// src/mdh/ui/sidebar.js

import * as api from '../api.js';
import * as state from '../state.js';
import { confirmModal } from './modal.js';

const contextMenuEl = document.getElementById('contextMenu');

export function initSidebar() {
  loadCollections();

  document.getElementById('refreshCollections').addEventListener('click', loadCollections);

  document.getElementById('createCollectionBtn').addEventListener('click', async () => {
    const input = document.getElementById('newCollectionName');
    const name = input.value.trim();
    if (!name) return;
    try {
      state.set({ loading: true, error: null });
      await api.createCollection(name);
      input.value = '';
      await loadCollections();
    } catch (err) {
      state.set({ error: { message: err.message } });
    } finally {
      state.set({ loading: false });
    }
  });

  document.getElementById('newCollectionName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('createCollectionBtn').click();
  });

  // Close context menu on any click
  document.addEventListener('click', () => hideContextMenu());
}

async function loadCollections() {
  try {
    state.set({ loading: true, error: null });
    const res = await api.listCollections(null, true);
    const collections = res.result || [];
    state.set({ collections, loading: false });
    renderCollections(collections);
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

function renderCollections(collections) {
  const listEl = document.getElementById('collectionList');
  const selected = state.get('selectedCollection');
  listEl.innerHTML = '';

  for (const name of collections) {
    const item = document.createElement('div');
    item.className = 'collection-item' + (name === selected ? ' active' : '');
    item.textContent = name;
    item.addEventListener('click', () => selectCollection(name));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, name);
    });
    listEl.appendChild(item);
  }

  const footer = document.getElementById('sidebarFooter');
  footer.textContent = `${collections.length} collection${collections.length !== 1 ? 's' : ''}`;
}

function selectCollection(name) {
  state.set({ selectedCollection: name, records: [], skip: 0, error: null });
}

// --- Context menu ---

function showContextMenu(x, y, collectionName) {
  contextMenuEl.innerHTML = '';
  contextMenuEl.style.left = x + 'px';
  contextMenuEl.style.top = y + 'px';
  contextMenuEl.classList.remove('hidden');

  const renameBtn = document.createElement('button');
  renameBtn.className = 'context-menu-item';
  renameBtn.textContent = 'Rename';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideContextMenu();
    startRename(collectionName);
  });

  const dropBtn = document.createElement('button');
  dropBtn.className = 'context-menu-item danger';
  dropBtn.textContent = 'Drop';
  dropBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideContextMenu();
    confirmDrop(collectionName);
  });

  contextMenuEl.appendChild(renameBtn);
  contextMenuEl.appendChild(dropBtn);
}

function hideContextMenu() {
  contextMenuEl.classList.add('hidden');
}

function startRename(oldName) {
  const listEl = document.getElementById('collectionList');
  const items = listEl.querySelectorAll('.collection-item');
  for (const item of items) {
    if (item.textContent !== oldName) continue;

    const row = document.createElement('div');
    row.className = 'collection-item-rename';
    const input = document.createElement('input');
    input.className = 'input';
    input.value = oldName;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-primary';
    saveBtn.textContent = 'Save';

    async function doRename() {
      const newName = input.value.trim();
      if (!newName || newName === oldName) {
        row.replaceWith(item);
        return;
      }
      try {
        state.set({ loading: true, error: null });
        await api.renameCollection(oldName, newName);
        if (state.get('selectedCollection') === oldName) {
          state.set({ selectedCollection: newName });
        }
        await loadCollections();
      } catch (err) {
        state.set({ error: { message: err.message } });
      } finally {
        state.set({ loading: false });
      }
    }

    saveBtn.addEventListener('click', doRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doRename();
      if (e.key === 'Escape') row.replaceWith(item);
    });

    row.appendChild(input);
    row.appendChild(saveBtn);
    item.replaceWith(row);
    input.focus();
    input.select();
    break;
  }
}

function confirmDrop(name) {
  confirmModal(
    'Drop collection?',
    `This will permanently delete "${name}" and all its data. This action cannot be undone.`,
    async () => {
      try {
        state.set({ loading: true, error: null });
        await api.dropCollection(name);
        if (state.get('selectedCollection') === name) {
          state.set({ selectedCollection: null });
        }
        await loadCollections();
      } catch (err) {
        state.set({ error: { message: err.message } });
      } finally {
        state.set({ loading: false });
      }
    },
  );
}

// Re-render when collections change from external source
state.on('collectionsChanged', renderCollections);
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/ui/sidebar.js
git commit -m "add sidebar with collection list, create, rename, drop"
```

---

### Task 8: Records Panel

**Files:**
- Create: `src/mdh/ui/records.js`

- [ ] **Step 1: Create records.js with find, pagination, expand, delete one**

```js
// src/mdh/ui/records.js

import * as api from '../api.js';
import * as state from '../state.js';
import { confirmModal } from './modal.js';
import { openRecordEditor } from './record-editor.js';
import { openUpdateMany } from './update-many.js';
import { openDeleteMany } from './delete-many.js';

const panelEl = () => document.getElementById('panel-records');

export function initRecords() {
  renderToolbar();
  state.on('selectedCollectionChanged', onCollectionChange);
  state.on('recordsChanged', renderRecords);
}

function onCollectionChange(collection) {
  if (collection) {
    state.set({ filter: '{}', sort: '{}', projection: '', skip: 0 });
    doFind();
  }
}

function renderToolbar() {
  const el = panelEl();
  el.innerHTML = `
    <div class="toolbar">
      <span class="toolbar-label">Filter:</span>
      <input id="recordFilter" class="input" style="flex:1" value="{}" />
      <button id="recordFindBtn" class="btn btn-primary btn-sm">Find</button>
      <button id="recordInsertBtn" class="btn btn-success btn-sm">+ Insert</button>
      <button id="recordUpdateManyBtn" class="btn btn-sm">Update Many</button>
      <button id="recordDeleteManyBtn" class="btn btn-danger btn-sm">Delete Many</button>
    </div>
    <div class="toolbar">
      <span class="toolbar-label">Sort:</span>
      <input id="recordSort" class="input" style="flex:1" value="{}" />
      <span class="toolbar-label" style="width:70px">Projection:</span>
      <input id="recordProjection" class="input" style="flex:1" placeholder="(all fields)" />
    </div>
    <div id="recordList" class="record-list"></div>
    <div id="recordPagination" class="pagination">
      <span id="recordCount"></span>
      <div class="pagination-controls">
        <button id="recordPrev" disabled>&larr; Prev</button>
        <span id="recordPage">Page 1</span>
        <button id="recordNext">Next &rarr;</button>
      </div>
    </div>
  `;

  el.querySelector('#recordFindBtn').addEventListener('click', () => {
    state.set({ skip: 0 });
    doFind();
  });

  el.querySelector('#recordFilter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      state.set({ skip: 0 });
      doFind();
    }
  });

  el.querySelector('#recordInsertBtn').addEventListener('click', () => {
    openRecordEditor('insert', null, () => doFind());
  });

  el.querySelector('#recordUpdateManyBtn').addEventListener('click', () => {
    openUpdateMany(() => doFind());
  });

  el.querySelector('#recordDeleteManyBtn').addEventListener('click', () => {
    openDeleteMany(() => doFind());
  });

  el.querySelector('#recordPrev').addEventListener('click', () => {
    const skip = Math.max(0, state.get('skip') - state.get('limit'));
    state.set({ skip });
    doFind();
  });

  el.querySelector('#recordNext').addEventListener('click', () => {
    state.set({ skip: state.get('skip') + state.get('limit') });
    doFind();
  });
}

async function doFind() {
  const collection = state.get('selectedCollection');
  if (!collection) return;

  const filterInput = document.getElementById('recordFilter');
  const sortInput = document.getElementById('recordSort');
  const projInput = document.getElementById('recordProjection');

  let query, sort, projection;
  try {
    query = JSON.parse(filterInput.value || '{}');
    filterInput.classList.remove('input-error');
  } catch {
    filterInput.classList.add('input-error');
    return;
  }
  try {
    sort = JSON.parse(sortInput.value || '{}');
    sortInput.classList.remove('input-error');
  } catch {
    sortInput.classList.add('input-error');
    return;
  }
  try {
    projection = projInput.value.trim() ? JSON.parse(projInput.value) : null;
    projInput.classList.remove('input-error');
  } catch {
    projInput.classList.add('input-error');
    return;
  }

  const skip = state.get('skip');
  const limit = state.get('limit');

  try {
    state.set({ loading: true, error: null });
    const res = await api.find(collection, { query, projection, skip, limit, sort });
    state.set({ records: res.result || [], loading: false });
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

function renderRecords(records) {
  const listEl = document.getElementById('recordList');
  if (!listEl) return;
  listEl.innerHTML = '';

  for (const record of records) {
    const idStr = record._id?.$oid || record._id || '?';
    const preview = JSON.stringify(record);

    const row = document.createElement('div');
    row.className = 'record-row';
    row.innerHTML = `
      <span class="record-id" title="${idStr}">${idStr}</span>
      <span class="record-preview">${escapeHtml(preview)}</span>
      <span class="record-actions">
        <button class="action-expand">Expand</button>
        <button class="action-edit">Edit</button>
        <button class="action-replace">Replace</button>
        <button class="action-delete">Del</button>
      </span>
    `;

    row.querySelector('.action-expand').addEventListener('click', () => toggleExpand(row, record));
    row.querySelector('.action-edit').addEventListener('click', () => {
      openRecordEditor('edit', record, () => doFind());
    });
    row.querySelector('.action-replace').addEventListener('click', () => {
      openRecordEditor('replace', record, () => doFind());
    });
    row.querySelector('.action-delete').addEventListener('click', () => {
      confirmModal(
        'Delete record?',
        `Delete record with _id "${idStr}"? This cannot be undone.`,
        async () => {
          try {
            state.set({ loading: true, error: null });
            await api.deleteOne(state.get('selectedCollection'), { _id: record._id });
            await doFind();
          } catch (err) {
            state.set({ error: { message: err.message }, loading: false });
          }
        },
      );
    });

    listEl.appendChild(row);
  }

  // Update pagination
  const skip = state.get('skip');
  const limit = state.get('limit');
  const count = records.length;
  document.getElementById('recordCount').textContent = count > 0
    ? `Showing ${skip + 1}\u2013${skip + count}`
    : 'No records';
  document.getElementById('recordPage').textContent = `Page ${Math.floor(skip / limit) + 1}`;
  document.getElementById('recordPrev').disabled = skip === 0;
  document.getElementById('recordNext').disabled = count < limit;
}

function toggleExpand(row, record) {
  const existing = row.nextElementSibling;
  if (existing?.classList.contains('record-expanded')) {
    existing.remove();
    return;
  }
  const expanded = document.createElement('div');
  expanded.className = 'record-expanded';
  const idStr = record._id?.$oid || record._id || '?';
  expanded.innerHTML = `<div class="record-expanded-header">_id: ${escapeHtml(idStr)}</div><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>`;
  row.after(expanded);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/ui/records.js
git commit -m "add records panel with find, pagination, expand, delete"
```

---

### Task 9: Record Editor Modal

**Files:**
- Create: `src/mdh/ui/record-editor.js`

- [ ] **Step 1: Create record-editor.js with insert one/many, edit, replace**

```js
// src/mdh/ui/record-editor.js

import * as api from '../api.js';
import * as state from '../state.js';
import { openModal, closeModal } from './modal.js';

export function openRecordEditor(mode, record, onSuccess) {
  // mode: 'insert' | 'edit' | 'replace'
  let currentMode = mode === 'insert' ? 'insertOne' : mode;

  const body = document.createElement('div');
  body.className = 'modal-body';

  // Mode toggle for insert
  if (mode === 'insert') {
    const toggle = document.createElement('div');
    toggle.className = 'mode-toggle';
    toggle.style.marginBottom = '8px';

    const oneBtn = document.createElement('button');
    oneBtn.textContent = 'Insert One';
    oneBtn.className = 'active';

    const manyBtn = document.createElement('button');
    manyBtn.textContent = 'Insert Many';

    oneBtn.addEventListener('click', () => {
      currentMode = 'insertOne';
      oneBtn.className = 'active';
      manyBtn.className = '';
      label.textContent = 'Document (JSON):';
      textarea.value = '{\n  \n}';
      hint.textContent = '';
    });

    manyBtn.addEventListener('click', () => {
      currentMode = 'insertMany';
      manyBtn.className = 'active';
      oneBtn.className = '';
      label.textContent = 'Documents (JSON array):';
      textarea.value = '[\n  {\n    \n  }\n]';
      hint.textContent = '';
    });

    toggle.appendChild(oneBtn);
    toggle.appendChild(manyBtn);
    body.appendChild(toggle);
  }

  const label = document.createElement('div');
  label.className = 'modal-field-label';
  body.appendChild(label);

  const textarea = document.createElement('textarea');
  textarea.className = 'input textarea-fill';
  textarea.style.minHeight = '200px';
  body.appendChild(textarea);

  const hint = document.createElement('div');
  hint.className = 'input-hint';
  body.appendChild(hint);

  // Set initial content based on mode
  if (mode === 'insert') {
    label.textContent = 'Document (JSON):';
    textarea.value = '{\n  \n}';
  } else if (mode === 'edit') {
    label.textContent = 'Update expression (MongoDB update syntax):';
    const fields = { ...record };
    delete fields._id;
    textarea.value = JSON.stringify({ $set: fields }, null, 2);
  } else if (mode === 'replace') {
    label.textContent = 'Replacement document (full document, excluding _id):';
    const fields = { ...record };
    delete fields._id;
    textarea.value = JSON.stringify(fields, null, 2);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = mode === 'insert' ? 'Insert' : mode === 'edit' ? 'Update' : 'Replace';

  submitBtn.addEventListener('click', async () => {
    let parsed;
    try {
      parsed = JSON.parse(textarea.value);
      hint.textContent = '';
      textarea.classList.remove('input-error');
    } catch (e) {
      hint.textContent = 'Invalid JSON: ' + e.message;
      textarea.classList.add('input-error');
      return;
    }

    const collection = state.get('selectedCollection');
    try {
      state.set({ loading: true, error: null });
      if (currentMode === 'insertOne') {
        await api.insertOne(collection, parsed);
      } else if (currentMode === 'insertMany') {
        if (!Array.isArray(parsed)) {
          hint.textContent = 'Expected a JSON array of documents';
          textarea.classList.add('input-error');
          state.set({ loading: false });
          return;
        }
        await api.insertMany(collection, parsed);
      } else if (mode === 'edit') {
        await api.updateOne(collection, { _id: record._id }, parsed);
      } else if (mode === 'replace') {
        await api.replaceOne(collection, { _id: record._id }, parsed);
      }
      state.set({ loading: false });
      closeModal();
      if (onSuccess) onSuccess();
    } catch (err) {
      state.set({ loading: false });
      hint.textContent = err.message;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  body.appendChild(actions);

  const title = mode === 'insert' ? 'Insert Record' : mode === 'edit' ? `Edit Record` : `Replace Record`;
  openModal(title, body);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/ui/record-editor.js
git commit -m "add record editor modal for insert, edit, replace"
```

---

### Task 10: Update Many Modal

**Files:**
- Create: `src/mdh/ui/update-many.js`

- [ ] **Step 1: Create update-many.js with filter, update expression, preview**

```js
// src/mdh/ui/update-many.js

import * as api from '../api.js';
import * as state from '../state.js';
import { openModal, closeModal } from './modal.js';

export function openUpdateMany(onSuccess) {
  const body = document.createElement('div');
  body.className = 'modal-body';

  // Filter
  const filterLabel = document.createElement('div');
  filterLabel.className = 'modal-field-label';
  filterLabel.textContent = 'Filter (which documents to update):';
  body.appendChild(filterLabel);

  const filterInput = document.createElement('textarea');
  filterInput.className = 'input';
  filterInput.style.minHeight = '60px';
  filterInput.value = '{}';
  body.appendChild(filterInput);

  // Update expression
  const updateLabel = document.createElement('div');
  updateLabel.className = 'modal-field-label';
  updateLabel.textContent = 'Update expression:';
  body.appendChild(updateLabel);

  const updateInput = document.createElement('textarea');
  updateInput.className = 'input';
  updateInput.style.minHeight = '80px';
  updateInput.value = '{\n  "$set": {\n    \n  }\n}';
  body.appendChild(updateInput);

  const hint = document.createElement('div');
  hint.className = 'input-hint';
  body.appendChild(hint);

  // Preview
  const previewBox = document.createElement('div');
  previewBox.className = 'preview-box hidden';
  const previewPre = document.createElement('pre');
  previewBox.appendChild(previewPre);
  body.appendChild(previewBox);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const previewBtn = document.createElement('button');
  previewBtn.className = 'btn btn-secondary';
  previewBtn.textContent = 'Preview (5 docs)';

  previewBtn.addEventListener('click', async () => {
    let filter;
    try {
      filter = JSON.parse(filterInput.value);
      filterInput.classList.remove('input-error');
    } catch {
      filterInput.classList.add('input-error');
      hint.textContent = 'Invalid filter JSON';
      return;
    }
    try {
      const res = await api.find(state.get('selectedCollection'), { query: filter, limit: 5 });
      previewPre.textContent = JSON.stringify(res.result, null, 2);
      previewBox.classList.remove('hidden');
      hint.textContent = '';
    } catch (err) {
      hint.textContent = err.message;
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = 'Update Many';

  submitBtn.addEventListener('click', async () => {
    let filter, update;
    try {
      filter = JSON.parse(filterInput.value);
      filterInput.classList.remove('input-error');
    } catch {
      filterInput.classList.add('input-error');
      hint.textContent = 'Invalid filter JSON';
      return;
    }
    try {
      update = JSON.parse(updateInput.value);
      updateInput.classList.remove('input-error');
    } catch {
      updateInput.classList.add('input-error');
      hint.textContent = 'Invalid update JSON';
      return;
    }

    try {
      state.set({ loading: true, error: null });
      const res = await api.updateMany(state.get('selectedCollection'), filter, update);
      state.set({ loading: false });
      const matched = res.result?.matched_count ?? 0;
      const modified = res.result?.modified_count ?? 0;
      hint.textContent = '';
      hint.style.color = 'var(--success)';
      hint.textContent = `Done: ${matched} matched, ${modified} modified`;
      setTimeout(() => {
        closeModal();
        if (onSuccess) onSuccess();
      }, 1200);
    } catch (err) {
      state.set({ loading: false });
      hint.style.color = '';
      hint.textContent = err.message;
    }
  });

  actions.appendChild(previewBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  body.appendChild(actions);

  openModal('Update Many', body);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/ui/update-many.js
git commit -m "add update many modal with preview"
```

---

### Task 11: Delete Many Modal

**Files:**
- Create: `src/mdh/ui/delete-many.js`

- [ ] **Step 1: Create delete-many.js with filter, preview, confirmation**

```js
// src/mdh/ui/delete-many.js

import * as api from '../api.js';
import * as state from '../state.js';
import { openModal, closeModal } from './modal.js';

export function openDeleteMany(onSuccess) {
  const body = document.createElement('div');
  body.className = 'modal-body';

  const warning = document.createElement('p');
  warning.className = 'modal-message';
  warning.style.color = 'var(--danger)';
  warning.textContent = 'This will delete ALL documents matching the filter. This action cannot be undone.';
  body.appendChild(warning);

  const filterLabel = document.createElement('div');
  filterLabel.className = 'modal-field-label';
  filterLabel.textContent = 'Filter:';
  body.appendChild(filterLabel);

  const filterInput = document.createElement('textarea');
  filterInput.className = 'input';
  filterInput.style.minHeight = '80px';
  filterInput.value = '{}';
  body.appendChild(filterInput);

  const hint = document.createElement('div');
  hint.className = 'input-hint';
  body.appendChild(hint);

  // Preview
  const previewBox = document.createElement('div');
  previewBox.className = 'preview-box hidden';
  const previewPre = document.createElement('pre');
  previewBox.appendChild(previewPre);
  body.appendChild(previewBox);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const previewBtn = document.createElement('button');
  previewBtn.className = 'btn btn-secondary';
  previewBtn.textContent = 'Preview (5 docs)';

  previewBtn.addEventListener('click', async () => {
    let filter;
    try {
      filter = JSON.parse(filterInput.value);
      filterInput.classList.remove('input-error');
    } catch {
      filterInput.classList.add('input-error');
      hint.textContent = 'Invalid JSON';
      return;
    }
    try {
      const res = await api.find(state.get('selectedCollection'), { query: filter, limit: 5 });
      previewPre.textContent = JSON.stringify(res.result, null, 2);
      previewBox.classList.remove('hidden');
      hint.textContent = '';
    } catch (err) {
      hint.textContent = err.message;
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete Many';

  deleteBtn.addEventListener('click', async () => {
    let filter;
    try {
      filter = JSON.parse(filterInput.value);
      filterInput.classList.remove('input-error');
    } catch {
      filterInput.classList.add('input-error');
      hint.textContent = 'Invalid JSON';
      return;
    }

    try {
      state.set({ loading: true, error: null });
      const res = await api.deleteMany(state.get('selectedCollection'), filter);
      state.set({ loading: false });
      const count = res.result?.deleted_count ?? 0;
      hint.style.color = 'var(--success)';
      hint.textContent = `Deleted ${count} document${count !== 1 ? 's' : ''}`;
      setTimeout(() => {
        closeModal();
        if (onSuccess) onSuccess();
      }, 1200);
    } catch (err) {
      state.set({ loading: false });
      hint.style.color = '';
      hint.textContent = err.message;
    }
  });

  actions.appendChild(previewBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(deleteBtn);
  body.appendChild(actions);

  openModal('Delete Many', body);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/ui/delete-many.js
git commit -m "add delete many modal with preview"
```

---

### Task 12: Aggregate Panel

**Files:**
- Create: `src/mdh/ui/aggregate.js`

- [ ] **Step 1: Create aggregate.js with split-view pipeline editor and results**

```js
// src/mdh/ui/aggregate.js

import * as api from '../api.js';
import * as state from '../state.js';

export function initAggregate() {
  const panelEl = document.getElementById('panel-aggregate');

  panelEl.innerHTML = `
    <div class="split-view">
      <div class="split-pane">
        <div class="split-pane-label">Pipeline (JSON array of stages):</div>
        <textarea id="aggPipeline" class="input textarea-fill">[\n  \n]</textarea>
        <div id="aggHint" class="input-hint"></div>
        <div style="margin-top:8px">
          <button id="aggRunBtn" class="btn btn-primary">Run Pipeline</button>
        </div>
      </div>
      <div class="split-pane">
        <div class="split-pane-label">Results:</div>
        <div id="aggResults" class="preview-box" style="flex:1;overflow:auto"><pre>Run a pipeline to see results</pre></div>
        <div id="aggFooter" class="split-pane-footer"></div>
      </div>
    </div>
  `;

  panelEl.querySelector('#aggRunBtn').addEventListener('click', runPipeline);
}

async function runPipeline() {
  const pipelineInput = document.getElementById('aggPipeline');
  const hint = document.getElementById('aggHint');
  const resultsEl = document.getElementById('aggResults');
  const footer = document.getElementById('aggFooter');

  let pipeline;
  try {
    pipeline = JSON.parse(pipelineInput.value);
    if (!Array.isArray(pipeline)) throw new Error('Pipeline must be a JSON array');
    pipelineInput.classList.remove('input-error');
    hint.textContent = '';
  } catch (e) {
    pipelineInput.classList.add('input-error');
    hint.textContent = e.message;
    return;
  }

  const collection = state.get('selectedCollection');
  try {
    state.set({ loading: true, error: null });
    const start = performance.now();
    const res = await api.aggregate(collection, pipeline);
    const elapsed = Math.round(performance.now() - start);
    state.set({ loading: false });

    const results = res.result || [];
    resultsEl.innerHTML = `<pre>${escapeHtml(JSON.stringify(results, null, 2))}</pre>`;
    footer.textContent = `${results.length} result${results.length !== 1 ? 's' : ''} \u00b7 ${elapsed}ms`;
  } catch (err) {
    state.set({ loading: false });
    hint.textContent = err.message;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/ui/aggregate.js
git commit -m "add aggregate panel with pipeline editor"
```

---

### Task 13: Bulk Write Panel

**Files:**
- Create: `src/mdh/ui/bulk-write.js`

- [ ] **Step 1: Create bulk-write.js with operations editor and async status**

```js
// src/mdh/ui/bulk-write.js

import * as api from '../api.js';
import * as state from '../state.js';

const TEMPLATE = `[
  {"insertOne": {"document": {"key": "value"}}},
  {"updateOne": {"filter": {"_id": "..."}, "update": {"$set": {"key": "value"}}}},
  {"deleteOne": {"filter": {"_id": "..."}}}
]`;

export function initBulkWrite() {
  const panelEl = document.getElementById('panel-bulk-write');

  panelEl.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;padding:12px 16px;overflow:hidden">
      <div class="split-pane-label">Operations (JSON array):</div>
      <textarea id="bulkOps" class="input textarea-fill">${escapeHtml(TEMPLATE)}</textarea>
      <div id="bulkHint" class="input-hint"></div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button id="bulkRunBtn" class="btn btn-primary">Run Bulk Write</button>
      </div>
      <div id="bulkStatus" class="hidden" style="margin-top:12px"></div>
    </div>
  `;

  panelEl.querySelector('#bulkRunBtn').addEventListener('click', runBulkWrite);
}

async function runBulkWrite() {
  const opsInput = document.getElementById('bulkOps');
  const hint = document.getElementById('bulkHint');
  const statusEl = document.getElementById('bulkStatus');

  let operations;
  try {
    operations = JSON.parse(opsInput.value);
    if (!Array.isArray(operations)) throw new Error('Operations must be a JSON array');
    opsInput.classList.remove('input-error');
    hint.textContent = '';
  } catch (e) {
    opsInput.classList.add('input-error');
    hint.textContent = e.message;
    return;
  }

  const collection = state.get('selectedCollection');
  try {
    state.set({ loading: true, error: null });
    const res = await api.bulkWrite(collection, operations);
    state.set({ loading: false });

    // Extract operation ID from message
    const operationId = extractOperationId(res.message);
    if (operationId) {
      showOperationStatus(statusEl, operationId);
    } else {
      statusEl.innerHTML = '<div class="op-status"><span class="op-status-badge finished">accepted</span> Operation submitted</div>';
      statusEl.classList.remove('hidden');
    }
  } catch (err) {
    state.set({ loading: false });
    hint.textContent = err.message;
  }
}

function extractOperationId(message) {
  if (!message) return null;
  // Message format varies — try to find an ObjectId-like string
  const match = message.match(/[a-f0-9]{24}/i);
  return match ? match[0] : null;
}

async function showOperationStatus(statusEl, operationId) {
  statusEl.classList.remove('hidden');

  function render(status, errorMessage) {
    const badgeClass = status === 'FINISHED' ? 'finished' : status === 'FAILED' ? 'failed' : 'running';
    statusEl.innerHTML = `
      <div class="op-status">
        <span class="op-status-badge ${badgeClass}">${status.toLowerCase()}</span>
        <span>Operation: ${operationId}</span>
        ${status !== 'FINISHED' && status !== 'FAILED' ? '<button id="checkStatusBtn" class="btn btn-sm" style="margin-left:auto">Check Status</button>' : ''}
        ${errorMessage ? `<span style="color:var(--danger);margin-left:8px">${escapeHtml(errorMessage)}</span>` : ''}
      </div>
    `;
    const checkBtn = statusEl.querySelector('#checkStatusBtn');
    if (checkBtn) {
      checkBtn.addEventListener('click', () => pollStatus(statusEl, operationId));
    }
  }

  render('RUNNING', null);
}

async function pollStatus(statusEl, operationId) {
  try {
    const res = await api.checkOperationStatus(operationId);
    const op = res.result || {};
    const status = op.status || 'UNKNOWN';
    const badgeClass = status === 'FINISHED' ? 'finished' : status === 'FAILED' ? 'failed' : 'running';
    statusEl.innerHTML = `
      <div class="op-status">
        <span class="op-status-badge ${badgeClass}">${status.toLowerCase()}</span>
        <span>Operation: ${operationId}</span>
        ${status !== 'FINISHED' && status !== 'FAILED' ? '<button id="checkStatusBtn" class="btn btn-sm" style="margin-left:auto">Check Status</button>' : ''}
        ${op.error_message ? `<span style="color:var(--danger);margin-left:8px">${escapeHtml(op.error_message)}</span>` : ''}
      </div>
    `;
    const checkBtn = statusEl.querySelector('#checkStatusBtn');
    if (checkBtn) {
      checkBtn.addEventListener('click', () => pollStatus(statusEl, operationId));
    }
  } catch (err) {
    state.set({ error: { message: err.message } });
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/ui/bulk-write.js
git commit -m "add bulk write panel with async status"
```

---

### Task 14: Indexes Panel

**Files:**
- Create: `src/mdh/ui/indexes.js`

- [ ] **Step 1: Create indexes.js with list, create, drop**

```js
// src/mdh/ui/indexes.js

import * as api from '../api.js';
import * as state from '../state.js';
import { confirmModal } from './modal.js';

export function initIndexes() {
  const panelEl = document.getElementById('panel-indexes');

  panelEl.innerHTML = `
    <div class="toolbar">
      <span style="flex:1;font-weight:500">Indexes</span>
      <button id="refreshIndexes" class="icon-btn" title="Refresh">&#x21bb;</button>
    </div>
    <div id="indexList" class="index-list"></div>
    <div id="indexOpStatus" class="hidden" style="padding:8px 16px"></div>
    <div class="index-create-form">
      <span class="toolbar-label">Name:</span>
      <input id="indexName" class="input" style="width:140px" placeholder="my_index" />
      <span class="toolbar-label">Keys:</span>
      <input id="indexKeys" class="input" style="flex:1" value='{"field": 1}' />
      <button id="createIndexBtn" class="btn btn-primary btn-sm">Create</button>
    </div>
  `;

  panelEl.querySelector('#refreshIndexes').addEventListener('click', loadIndexes);
  panelEl.querySelector('#createIndexBtn').addEventListener('click', doCreateIndex);

  state.on('activePanelChanged', (panel) => {
    if (panel === 'indexes') loadIndexes();
  });

  state.on('selectedCollectionChanged', () => {
    if (state.get('activePanel') === 'indexes') loadIndexes();
  });
}

async function loadIndexes() {
  const collection = state.get('selectedCollection');
  if (!collection) return;

  try {
    state.set({ loading: true, error: null });
    const res = await api.listIndexes(collection, false);
    state.set({ loading: false });
    renderIndexes(res.result || []);
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

function renderIndexes(indexes) {
  const listEl = document.getElementById('indexList');
  listEl.innerHTML = '';

  for (const idx of indexes) {
    const name = typeof idx === 'string' ? idx : (idx.name || idx.key ? JSON.stringify(idx.key) : String(idx));
    const keys = typeof idx === 'object' && idx.key ? JSON.stringify(idx.key) : '';
    const isDefault = name === '_id_';

    const row = document.createElement('div');
    row.className = 'index-row';
    row.innerHTML = `
      <div>
        <span class="index-name">${escapeHtml(name)}</span>
        ${keys ? `<span class="index-keys">${escapeHtml(keys)}</span>` : ''}
      </div>
      ${isDefault ? '<span class="index-default">default</span>' : `<button class="btn btn-sm btn-danger drop-index-btn">Drop</button>`}
    `;

    if (!isDefault) {
      row.querySelector('.drop-index-btn').addEventListener('click', () => {
        confirmModal(
          'Drop index?',
          `Drop index "${name}"? This may affect query performance.`,
          () => doDropIndex(name),
        );
      });
    }

    listEl.appendChild(row);
  }
}

async function doCreateIndex() {
  const nameInput = document.getElementById('indexName');
  const keysInput = document.getElementById('indexKeys');
  const statusEl = document.getElementById('indexOpStatus');
  const indexName = nameInput.value.trim();

  if (!indexName) {
    nameInput.classList.add('input-error');
    return;
  }
  nameInput.classList.remove('input-error');

  let keys;
  try {
    keys = JSON.parse(keysInput.value);
    keysInput.classList.remove('input-error');
  } catch {
    keysInput.classList.add('input-error');
    return;
  }

  try {
    state.set({ loading: true, error: null });
    const res = await api.createIndex(state.get('selectedCollection'), indexName, keys);
    state.set({ loading: false });
    nameInput.value = '';
    showAsyncStatus(statusEl, res.message);
    await loadIndexes();
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

async function doDropIndex(indexName) {
  const statusEl = document.getElementById('indexOpStatus');
  try {
    state.set({ loading: true, error: null });
    const res = await api.dropIndex(state.get('selectedCollection'), indexName);
    state.set({ loading: false });
    showAsyncStatus(statusEl, res.message);
    await loadIndexes();
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

function showAsyncStatus(statusEl, message) {
  const operationId = message ? message.match(/[a-f0-9]{24}/i)?.[0] : null;
  if (!operationId) {
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.classList.remove('hidden');
  statusEl.innerHTML = `
    <div class="op-status">
      <span class="op-status-badge running">pending</span>
      <span>Operation: ${operationId}</span>
      <button class="btn btn-sm check-status-btn" style="margin-left:auto">Check Status</button>
    </div>
  `;
  statusEl.querySelector('.check-status-btn').addEventListener('click', async () => {
    try {
      const res = await api.checkOperationStatus(operationId);
      const op = res.result || {};
      const badgeClass = op.status === 'FINISHED' ? 'finished' : op.status === 'FAILED' ? 'failed' : 'running';
      statusEl.innerHTML = `
        <div class="op-status">
          <span class="op-status-badge ${badgeClass}">${(op.status || 'unknown').toLowerCase()}</span>
          <span>Operation: ${operationId}</span>
          ${op.status !== 'FINISHED' && op.status !== 'FAILED' ? '<button class="btn btn-sm check-status-btn" style="margin-left:auto">Check Status</button>' : ''}
          ${op.error_message ? `<span style="color:var(--danger)">${escapeHtml(op.error_message)}</span>` : ''}
        </div>
      `;
      const btn = statusEl.querySelector('.check-status-btn');
      if (btn) btn.addEventListener('click', () => showAsyncStatus(statusEl, message));
    } catch (err) {
      state.set({ error: { message: err.message } });
    }
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/ui/indexes.js
git commit -m "add indexes panel with list, create, drop"
```

---

### Task 15: Search Indexes Panel

**Files:**
- Create: `src/mdh/ui/search-indexes.js`

- [ ] **Step 1: Create search-indexes.js with list, create, drop**

```js
// src/mdh/ui/search-indexes.js

import * as api from '../api.js';
import * as state from '../state.js';
import { confirmModal } from './modal.js';

export function initSearchIndexes() {
  const panelEl = document.getElementById('panel-search-indexes');

  panelEl.innerHTML = `
    <div class="toolbar">
      <span style="flex:1;font-weight:500">Search Indexes (Atlas Search)</span>
      <button id="refreshSearchIndexes" class="icon-btn" title="Refresh">&#x21bb;</button>
    </div>
    <div id="searchIndexList" class="index-list"></div>
    <div id="searchIndexOpStatus" class="hidden" style="padding:8px 16px"></div>
    <div class="index-create-form" style="flex-direction:column;align-items:stretch;gap:8px">
      <div style="display:flex;gap:6px;align-items:center">
        <span class="toolbar-label">Name:</span>
        <input id="searchIndexName" class="input" style="flex:1" placeholder="my_search_index" />
      </div>
      <div>
        <span class="toolbar-label" style="display:block;margin-bottom:4px">Mappings (JSON):</span>
        <textarea id="searchIndexMappings" class="input" style="width:100%;min-height:80px">{\n  "dynamic": true\n}</textarea>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <span class="toolbar-label">Analyzer:</span>
        <input id="searchIndexAnalyzer" class="input" style="flex:1" placeholder="(optional)" />
        <span class="toolbar-label" style="width:auto">Search Analyzer:</span>
        <input id="searchIndexSearchAnalyzer" class="input" style="flex:1" placeholder="(optional)" />
      </div>
      <div>
        <button id="createSearchIndexBtn" class="btn btn-primary btn-sm">Create Search Index</button>
      </div>
    </div>
  `;

  panelEl.querySelector('#refreshSearchIndexes').addEventListener('click', loadSearchIndexes);
  panelEl.querySelector('#createSearchIndexBtn').addEventListener('click', doCreateSearchIndex);

  state.on('activePanelChanged', (panel) => {
    if (panel === 'search-indexes') loadSearchIndexes();
  });

  state.on('selectedCollectionChanged', () => {
    if (state.get('activePanel') === 'search-indexes') loadSearchIndexes();
  });
}

async function loadSearchIndexes() {
  const collection = state.get('selectedCollection');
  if (!collection) return;

  try {
    state.set({ loading: true, error: null });
    const res = await api.listSearchIndexes(collection, false);
    state.set({ loading: false });
    renderSearchIndexes(res.result || []);
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

function renderSearchIndexes(indexes) {
  const listEl = document.getElementById('searchIndexList');
  listEl.innerHTML = '';

  if (indexes.length === 0) {
    listEl.innerHTML = '<div style="padding:16px;color:var(--text-secondary);font-size:12px">No search indexes</div>';
    return;
  }

  for (const idx of indexes) {
    const name = typeof idx === 'string' ? idx : (idx.name || JSON.stringify(idx));
    const row = document.createElement('div');
    row.className = 'index-row';
    row.innerHTML = `
      <div><span class="index-name">${escapeHtml(name)}</span></div>
      <button class="btn btn-sm btn-danger drop-btn">Drop</button>
    `;
    row.querySelector('.drop-btn').addEventListener('click', () => {
      confirmModal(
        'Drop search index?',
        `Drop search index "${name}"?`,
        () => doDropSearchIndex(name),
      );
    });
    listEl.appendChild(row);
  }
}

async function doCreateSearchIndex() {
  const nameInput = document.getElementById('searchIndexName');
  const mappingsInput = document.getElementById('searchIndexMappings');
  const analyzerInput = document.getElementById('searchIndexAnalyzer');
  const searchAnalyzerInput = document.getElementById('searchIndexSearchAnalyzer');
  const statusEl = document.getElementById('searchIndexOpStatus');

  const indexName = nameInput.value.trim();
  if (!indexName) {
    nameInput.classList.add('input-error');
    return;
  }
  nameInput.classList.remove('input-error');

  let mappings;
  try {
    mappings = JSON.parse(mappingsInput.value);
    mappingsInput.classList.remove('input-error');
  } catch {
    mappingsInput.classList.add('input-error');
    return;
  }

  const opts = { indexName, mappings };
  const analyzer = analyzerInput.value.trim();
  const searchAnalyzer = searchAnalyzerInput.value.trim();
  if (analyzer) opts.analyzer = analyzer;
  if (searchAnalyzer) opts.searchAnalyzer = searchAnalyzer;

  try {
    state.set({ loading: true, error: null });
    const res = await api.createSearchIndex(state.get('selectedCollection'), opts);
    state.set({ loading: false });
    nameInput.value = '';
    showAsyncStatus(statusEl, res.message);
    await loadSearchIndexes();
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

async function doDropSearchIndex(indexName) {
  const statusEl = document.getElementById('searchIndexOpStatus');
  try {
    state.set({ loading: true, error: null });
    const res = await api.dropSearchIndex(state.get('selectedCollection'), indexName);
    state.set({ loading: false });
    showAsyncStatus(statusEl, res.message);
    await loadSearchIndexes();
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

function showAsyncStatus(statusEl, message) {
  const operationId = message ? message.match(/[a-f0-9]{24}/i)?.[0] : null;
  if (!operationId) {
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.classList.remove('hidden');
  statusEl.innerHTML = `
    <div class="op-status">
      <span class="op-status-badge running">pending</span>
      <span>Operation: ${operationId}</span>
      <button class="btn btn-sm check-btn" style="margin-left:auto">Check Status</button>
    </div>
  `;
  statusEl.querySelector('.check-btn').addEventListener('click', async () => {
    try {
      const res = await api.checkOperationStatus(operationId);
      const op = res.result || {};
      const badgeClass = op.status === 'FINISHED' ? 'finished' : op.status === 'FAILED' ? 'failed' : 'running';
      statusEl.innerHTML = `
        <div class="op-status">
          <span class="op-status-badge ${badgeClass}">${(op.status || 'unknown').toLowerCase()}</span>
          <span>Operation: ${operationId}</span>
          ${op.status !== 'FINISHED' && op.status !== 'FAILED' ? '<button class="btn btn-sm check-btn" style="margin-left:auto">Check Status</button>' : ''}
          ${op.error_message ? `<span style="color:var(--danger)">${escapeHtml(op.error_message)}</span>` : ''}
        </div>
      `;
      const btn = statusEl.querySelector('.check-btn');
      if (btn) btn.addEventListener('click', () => showAsyncStatus(statusEl, message));
    } catch (err) {
      state.set({ error: { message: err.message } });
    }
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mdh/ui/search-indexes.js
git commit -m "add search indexes panel"
```

---

### Task 16: Content Script Auth Handler

**Files:**
- Modify: `src/rossum/features/dev-flags.js`

- [ ] **Step 1: Add get-auth-info message handler to dev-flags.js**

Add a new entry to the `handlers` object:

```js
const handlers = {
  'get-auth-info': (sendResponse) => {
    sendResponse({
      token: window.localStorage.getItem('secureToken'),
      domain: window.location.origin,
    });
  },
  'get-dev-features-enabled-value': (sendResponse) => {
    sendResponse(window.localStorage.getItem('devFeaturesEnabled') === 'true');
  },
  // ... rest of existing handlers unchanged
```

The full file becomes:

```js
const handlers = {
  'get-auth-info': (sendResponse) => {
    sendResponse({
      token: window.localStorage.getItem('secureToken'),
      domain: window.location.origin,
    });
  },
  'get-dev-features-enabled-value': (sendResponse) => {
    sendResponse(window.localStorage.getItem('devFeaturesEnabled') === 'true');
  },
  'toggle-dev-features-enabled': (sendResponse) => {
    const key = 'devFeaturesEnabled';
    if (window.localStorage.getItem(key) === 'true') {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, 'true');
    }
    sendResponse(true);
  },
  'get-dev-debug-enabled-value': (sendResponse) => {
    sendResponse(window.localStorage.getItem('devDebugEnabled') === 'true');
  },
  'toggle-dev-debug-enabled': (sendResponse) => {
    const key = 'devDebugEnabled';
    if (window.localStorage.getItem(key) === 'true') {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, 'true');
    }
    sendResponse(true);
  },
};

export function initDevFlags() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = handlers[message];
    if (handler) handler(sendResponse);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/rossum/features/dev-flags.js
git commit -m "add get-auth-info message handler for MDH auth"
```

---

### Task 17: Popup Integration

**Files:**
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.js`
- Modify: `src/popup/popup.css`

- [ ] **Step 1: Add Data Storage button to popup.html**

Add a second button after the existing Master Data Hub button in the header:

```html
<header class="header">
  <div class="brand-badge">SA</div>
  <span class="brand-name">Rossum SA</span>
  <button id="masterDataHub" class="action-btn">
    <span>Master Data Hub</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M17 7H7M17 7v10"/></svg>
  </button>
  <button id="dataStorage" class="action-btn action-btn-secondary">
    <span>Data Storage</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M17 7H7M17 7v10"/></svg>
  </button>
</header>
```

- [ ] **Step 2: Add Data Storage button handler to popup.js**

Add after the existing Master Data Hub button handler (after line 48):

```js
// Data Storage button
document.getElementById('dataStorage')?.addEventListener('click', () => {
  chrome.tabs.sendMessage(tab.id, 'get-auth-info', (response) => {
    if (response?.token && response?.domain) {
      chrome.storage.local.set({ mdhToken: response.token, mdhDomain: response.domain }, () => {
        chrome.tabs.create({
          url: chrome.runtime.getURL('mdh/mdh.html'),
          index: tab.index + 1,
        });
      });
    }
  });
});
```

The full popup.js becomes:

```js
function combineUrlWithCustomPath(originalUrl, customPath) {
  const match = originalUrl.match(/^https?:\/\/[^/?#]+/);
  if (!match) return originalUrl;
  const normalizedPath = customPath.startsWith('/') ? customPath : `/${customPath}`;
  return match[0] + normalizedPath;
}

const STORAGE_TOGGLES = [
  'schemaAnnotationsEnabled',
  'resourceIdsEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'netsuiteFieldNamesEnabled',
  'coupaFieldNamesEnabled',
];

const MESSAGE_TOGGLES = [
  { id: 'devFeaturesEnabled', getMessage: 'get-dev-features-enabled-value', toggleMessage: 'toggle-dev-features-enabled' },
  { id: 'devDebugEnabled', getMessage: 'get-dev-debug-enabled-value', toggleMessage: 'toggle-dev-debug-enabled' },
];

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  // Dim sections not relevant to the current page
  const url = tab.url || '';
  const isRossum = /localhost:3000|\.rossum\.(ai|app)|\.r8\.lol/.test(url);
  const isNetsuite = /\.netsuite\.com\/app/.test(url);
  const isCoupa = /\.coupacloud\.com/.test(url);
  if (isRossum) {
    document.querySelector('[data-context="netsuite"]')?.classList.add('dimmed');
    document.querySelector('[data-context="coupa"]')?.classList.add('dimmed');
  } else if (isNetsuite) {
    document.querySelector('[data-context="rossum"]')?.classList.add('dimmed');
    document.querySelector('[data-context="coupa"]')?.classList.add('dimmed');
  } else if (isCoupa) {
    document.querySelector('[data-context="rossum"]')?.classList.add('dimmed');
    document.querySelector('[data-context="netsuite"]')?.classList.add('dimmed');
  }

  // Master Data Hub button
  document.getElementById('masterDataHub')?.addEventListener('click', () => {
    chrome.tabs.create({
      url: combineUrlWithCustomPath(tab.url, '/svc/data-matching/web/management'),
      index: tab.index + 1,
    });
  });

  // Data Storage button
  document.getElementById('dataStorage')?.addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, 'get-auth-info', (response) => {
      if (response?.token && response?.domain) {
        chrome.storage.local.set({ mdhToken: response.token, mdhDomain: response.domain }, () => {
          chrome.tabs.create({
            url: chrome.runtime.getURL('mdh/mdh.html'),
            index: tab.index + 1,
          });
        });
      }
    });
  });

  // Storage-backed toggles (reload on change)
  const storageValues = await chrome.storage.local.get(STORAGE_TOGGLES);
  for (const key of STORAGE_TOGGLES) {
    const checkbox = document.getElementById(key);
    if (!(checkbox instanceof HTMLInputElement)) continue;
    checkbox.checked = storageValues[key] ?? false;
    checkbox.addEventListener('change', async () => {
      await chrome.storage.local.set({ [key]: checkbox.checked });
      chrome.tabs.reload(tab.id);
    });
  }

  // Message-backed toggles (devFeaturesEnabled, devDebugEnabled)
  for (const { id, getMessage, toggleMessage } of MESSAGE_TOGGLES) {
    chrome.tabs.sendMessage(tab.id, getMessage, (response) => {
      const checkbox = document.getElementById(id);
      if (!(checkbox instanceof HTMLInputElement)) return;
      checkbox.checked = response ?? false;
      checkbox.addEventListener('change', () => {
        chrome.tabs.sendMessage(tab.id, toggleMessage, (resp) => {
          if (resp === true) chrome.tabs.reload(tab.id);
        });
      });
    });
  }
});
```

- [ ] **Step 3: Add secondary action button style to popup.css**

Add after the `.action-btn:active` rule block (after line 107):

```css
.action-btn-secondary {
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  color: var(--accent);
  box-shadow: var(--shadow-card);
}

.action-btn-secondary:hover {
  background: var(--bg-hover);
  border-color: var(--accent);
  box-shadow: 0 2px 6px rgba(66, 112, 219, 0.15);
}

.action-btn-secondary:active {
  background: var(--bg-base);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/popup/popup.html src/popup/popup.js src/popup/popup.css
git commit -m "add Data Storage button to popup"
```

---

### Task 18: Build and Manual Verification

- [ ] **Step 1: Run the build**

Run: `npm run build`
Expected: Build succeeds with no errors. All entry points compile. Output in `dist/`.

- [ ] **Step 2: Verify dist output**

Check that these files exist:
- `dist/mdh/mdh.html`
- `dist/mdh/mdh.css`
- `dist/mdh/mdh.js`
- `dist/manifest.json` (contains `host_permissions`)
- `dist/popup/popup.html` (contains Data Storage button)

- [ ] **Step 3: Load extension in Chrome and test**

1. Go to `chrome://extensions/`, enable Developer Mode
2. Click "Load unpacked" and select the `dist/` folder
3. Navigate to a Rossum page (e.g., `https://your-org.rossum.app/`)
4. Click the extension popup — verify both "Master Data Hub" and "Data Storage" buttons appear
5. Click "Data Storage" — verify a new tab opens with the Data Storage Manager page
6. Verify the connection bar shows "Connected to ..." (green dot)
7. Verify the sidebar loads and lists collections
8. Click a collection, verify records load
9. Test light/dark theme by toggling system preference
10. Test insert, edit, replace, delete operations
11. Test aggregate panel
12. Test indexes panel
13. Test search indexes panel
14. Test bulk write panel
15. Test context menu (right-click collection) for rename/drop
16. Test error handling (invalid JSON, expired token)

- [ ] **Step 4: Final commit**

If any build fixes were needed, commit them:

```bash
git add -A
git commit -m "fix build issues from integration"
```
