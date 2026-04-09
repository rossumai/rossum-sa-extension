# Refactor & Modularize Chrome Extension

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the monolithic Chrome extension into ES modules with an esbuild build step, fix all identified bugs, remove Flow annotations, and DRY up the popup.

**Architecture:** Source lives in `src/` with one file per feature. `build.js` uses esbuild to bundle three entry points (rossum, netsuite, popup) into `dist/`, which IS the loadable extension. CSS moves from inline JS strings to standalone files loaded via manifest.json's `css` array.

**Tech Stack:** esbuild (bundler), Chrome Manifest V3, plain JS (ES modules in source, IIFE in output)

---

## File Structure

```
src/
  rossum/
    index.js              # Entry: reads settings, wires features into MutationObserver
    api.js                # fetchRossumApi with error-cache invalidation
    rossum.css            # All Rossum overlay CSS (was inline in JS)
    features/
      schema-ids.js       # Schema ID overlays
      resource-ids.js     # Resource ID overlays + click-to-copy
      expand-formulas.js  # Auto-expand formula source code
      expand-reasoning.js # Auto-expand reasoning options
      scroll-lock.js      # Scroll lock + focus patch
      dev-flags.js        # devFeaturesEnabled/devDebugEnabled message handlers
  netsuite/
    index.js              # NetSuite field name display
    netsuite.css          # NetSuite overlay CSS (was inline in JS)
  popup/
    popup.js              # DRY popup logic
    popup.html            # Copied from old popup/
    popup.css             # Copied from old popup/
build.js                  # esbuild build script
dist/                     # Generated, gitignored — this is the Chrome extension
```

## Bugs to Fix

1. **innerHTML XSS** — `displaySchemaID` and `displayFieldName` use `innerHTML`; change to `textContent`
2. **API cache traps errors** — rejected promises cached forever; delete cache entry on failure
3. **Dead `userScrollTimer`** — cleared but never assigned; remove
4. **Expand features scan entire DOM** — `document.querySelector` on every mutation; scope to added subtree
5. **Misleading `styleSchemaID`** in netsuite.js — rename (moot: extracted to CSS file)
6. **Boolean passed to `setItem`** — `localStorage.setItem('devFeaturesEnabled', true)` → `'true'`
7. **Dev flag handler checks all branches** — use lookup map with early return

---

### Task 1: Build system setup

**Files:**
- Create: `build.js`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install esbuild**

```bash
npm install --save-dev esbuild
```

- [ ] **Step 2: Create build.js**

```javascript
const esbuild = require('esbuild');
const { cpSync, rmSync, mkdirSync } = require('fs');

const isWatch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });

for (const dir of ['dist/styles', 'dist/popup', 'dist/icons']) {
  mkdirSync(dir, { recursive: true });
}

cpSync('manifest.json', 'dist/manifest.json');
cpSync('icons', 'dist/icons', { recursive: true });
cpSync('src/rossum/rossum.css', 'dist/styles/rossum.css');
cpSync('src/netsuite/netsuite.css', 'dist/styles/netsuite.css');
cpSync('src/popup/popup.html', 'dist/popup/popup.html');
cpSync('src/popup/popup.css', 'dist/popup/popup.css');

const options = {
  entryPoints: {
    'scripts/rossum': 'src/rossum/index.js',
    'scripts/netsuite': 'src/netsuite/index.js',
    'popup/popup': 'src/popup/popup.js',
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

- [ ] **Step 3: Add npm scripts to package.json**

```json
"scripts": {
  "build": "node build.js",
  "dev": "node build.js --watch"
}
```

Remove `"type": "commonjs"` and `"sideEffects": false` (no longer relevant).

- [ ] **Step 4: Update .gitignore**

Add `dist/` and `node_modules/` lines.

- [ ] **Step 5: Commit**

```bash
git add build.js package.json package-lock.json .gitignore
git commit -m "feat: add esbuild build system"
```

---

### Task 2: Extract CSS to standalone files

**Files:**
- Create: `src/rossum/rossum.css`
- Create: `src/netsuite/netsuite.css`

- [ ] **Step 1: Create src/rossum/rossum.css**

Extract the two CSS blocks from `scripts/rossum.js` lines 10-32 and 37-89 into this file.

- [ ] **Step 2: Create src/netsuite/netsuite.css**

Extract the CSS block from `scripts/netsuite.js` lines 10-16 into this file.

- [ ] **Step 3: Commit**

```bash
git add src/rossum/rossum.css src/netsuite/netsuite.css
git commit -m "refactor: extract inline CSS to standalone files"
```

---

### Task 3: Create Rossum modules

**Files:**
- Create: `src/rossum/api.js`
- Create: `src/rossum/features/schema-ids.js`
- Create: `src/rossum/features/resource-ids.js`
- Create: `src/rossum/features/expand-formulas.js`
- Create: `src/rossum/features/expand-reasoning.js`
- Create: `src/rossum/features/scroll-lock.js`
- Create: `src/rossum/features/dev-flags.js`

- [ ] **Step 1: Create src/rossum/api.js**

Export `fetchRossumApi(path)`. Key fix: delete cache entry on fetch error so retries work.

```javascript
const apiCache = {};

export function fetchRossumApi(path) {
  if (!apiCache[path]) {
    const token = window.localStorage.getItem('secureToken');
    const headers = token ? { Authorization: `Token ${token}` } : {};
    apiCache[path] = fetch(path, { headers })
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        delete apiCache[path];
        throw err;
      });
  }
  return apiCache[path];
}
```

- [ ] **Step 2: Create src/rossum/features/schema-ids.js**

Export `handleNode(node)`. Fix: use `textContent` instead of `innerHTML`.

```javascript
export function handleNode(node) {
  if (node.hasAttribute('data-sa-extension-schema-id')) {
    const span = document.createElement('span');
    span.className = 'rossum-sa-extension-schema-id';
    span.textContent = node.getAttribute('data-sa-extension-schema-id');
    node.appendChild(span);
  }
}
```

- [ ] **Step 3: Create src/rossum/features/resource-ids.js**

Export `handleNode(node)`. Contains `displayResourceId` (private) and all resource type matchers from lines 177-247 of the original. Uses `fetchRossumApi` from `../api.js`. Silently catches API errors with `.catch(() => {})`.

- [ ] **Step 4: Create src/rossum/features/expand-formulas.js**

Export `handleNode(node)`. Fix: scope button search to added subtree instead of `document.querySelector`.

```javascript
export function handleNode(node) {
  const buttons = node.matches?.('button[aria-label="Show source code"]')
    ? [node]
    : Array.from(node.querySelectorAll('button[aria-label="Show source code"]'));
  for (const button of buttons) {
    button.click();
  }
}
```

- [ ] **Step 5: Create src/rossum/features/expand-reasoning.js**

Export `handleNode(node)`. Same subtree-scoping fix as expand-formulas.

```javascript
export function handleNode(node) {
  const selector = 'button[data-sentry-source-file="ReasoningTiles.tsx"]';
  const buttons = node.matches?.(selector)
    ? [node]
    : Array.from(node.querySelectorAll(selector));
  for (const button of buttons) {
    if (button.textContent.trim() === 'Show options') {
      button.click();
    }
  }
}
```

- [ ] **Step 6: Create src/rossum/features/scroll-lock.js**

Export `initScrollLock(element)` and `initFocusPatch()`. Fixes: remove dead `userScrollTimer` variable, remove unused `observerDisconnected` flag, simplify focus patch args handling.

- [ ] **Step 7: Create src/rossum/features/dev-flags.js**

Export `initDevFlags()`. Fixes: use handler lookup map (early return), pass string `'true'` to `setItem`.

```javascript
const handlers = {
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

- [ ] **Step 8: Commit**

```bash
git add src/rossum/
git commit -m "refactor: create modular Rossum feature files with bug fixes"
```

---

### Task 4: Create Rossum entry point

**Files:**
- Create: `src/rossum/index.js`

- [ ] **Step 1: Create src/rossum/index.js**

Imports all features, reads settings from chrome.storage.local, builds a handler array from enabled features, creates a single MutationObserver that walks added subtrees and dispatches to handlers.

Key pattern:
```javascript
import { handleNode as handleSchemaId } from './features/schema-ids.js';
// ... other imports

const SETTINGS_KEYS = [
  'schemaAnnotationsEnabled', 'expandFormulasEnabled',
  'expandReasoningFieldsEnabled', 'scrollLockEnabled', 'resourceIdsEnabled',
];

initDevFlags();

chrome.storage.local.get(SETTINGS_KEYS).then((settings) => {
  if (settings.scrollLockEnabled) initFocusPatch();

  const handlers = [];
  if (settings.schemaAnnotationsEnabled) handlers.push(handleSchemaId);
  if (settings.resourceIdsEnabled) handlers.push(handleResourceId);
  // ... etc

  if (handlers.length === 0) return;

  const body = document.querySelector('body');
  if (!body) return;

  function processNode(node, fns) {
    for (const fn of fns) fn(node);
    for (const child of node.children) processNode(child, fns);
  }

  new MutationObserver((mutations) => {
    for (const { addedNodes } of mutations) {
      for (const node of addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) processNode(node, handlers);
      }
    }
  }).observe(body, { subtree: true, childList: true });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/rossum/index.js
git commit -m "refactor: create Rossum entry point orchestrator"
```

---

### Task 5: Create NetSuite module

**Files:**
- Create: `src/netsuite/index.js`

- [ ] **Step 1: Create src/netsuite/index.js**

Port from `scripts/netsuite.js`. Fixes: use `textContent` instead of `innerHTML`, remove misleading variable name (no more inline style element), use `for...of` instead of `forEach`.

- [ ] **Step 2: Commit**

```bash
git add src/netsuite/index.js
git commit -m "refactor: create NetSuite module, fix innerHTML usage"
```

---

### Task 6: Refactor popup

**Files:**
- Create: `src/popup/popup.js`
- Create: `src/popup/popup.html` (copy from `popup/popup.html`)
- Create: `src/popup/popup.css` (copy from `popup/popup.css`)

- [ ] **Step 1: Create src/popup/popup.js**

DRY refactor: replace 6 identical `chrome.storage.local.get` + `observeCheckbox` blocks with a data-driven loop. Replace 2 message-toggle blocks with a loop. Single `chrome.storage.local.get` call for all keys.

- [ ] **Step 2: Copy popup.html and popup.css to src/popup/**

Files are unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/popup/
git commit -m "refactor: DRY up popup toggle logic"
```

---

### Task 7: Integration — manifest, build, delete old files

**Files:**
- Modify: `manifest.json` (add `css` arrays to content_scripts)
- Delete: `scripts/rossum.js`, `scripts/netsuite.js`
- Delete: `popup/popup.js`, `popup/popup.html`, `popup/popup.css`

- [ ] **Step 1: Update manifest.json**

Add `"css": ["styles/rossum.css"]` to Rossum content_scripts entry and `"css": ["styles/netsuite.css"]` to NetSuite entry.

- [ ] **Step 2: Run build and verify**

```bash
npm run build
ls -R dist/
```

Verify dist/ contains: manifest.json, icons/, scripts/rossum.js, scripts/netsuite.js, styles/rossum.css, styles/netsuite.css, popup/popup.html, popup/popup.js, popup/popup.css.

- [ ] **Step 3: Delete old source files**

```bash
rm scripts/rossum.js scripts/netsuite.js
rm popup/popup.js popup/popup.html popup/popup.css
rmdir scripts popup
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: switch to esbuild build, remove old source files"
```

---

### Task 8: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update README.md**

Update Build and release section to cover `npm install`, `npm run build`, loading `dist/` in Chrome for development, and zipping `dist/` for Chrome Web Store release.

- [ ] **Step 2: Update CLAUDE.md**

Reflect new architecture: esbuild build system, `src/` directory structure, no Flow annotations. Update file paths and key patterns.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: update README and CLAUDE.md for new project structure"
```
