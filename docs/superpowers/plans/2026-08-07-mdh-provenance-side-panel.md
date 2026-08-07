# MDH provenance side panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host the existing "MDH on this screen" provenance card in a Chrome side panel that stays open while the user works in the Rossum annotation screen, leaving the popup exactly as it is.

**Architecture:** A ninth esbuild entry point (`src/sidepanel/`) renders a Preact app that resolves the active tab of its own window, follows it across tab switches and SPA navigation, and mounts the **unmodified** `MdhProvenancePanel` from `src/popup/` keyed by annotation id. The page links `../popup/popup.css` first so the card's styling has one source of truth; `sidepanel.css` only undoes the popup's fixed width and 600px cap.

**Tech Stack:** Preact + preact/hooks (classic JSX, `h` pragma), esbuild, Vitest + jsdom, Chrome MV3 (`chrome.sidePanel`, `chrome.tabs`, `chrome.scripting`).

**Spec:** `docs/superpowers/specs/2026-08-07-mdh-provenance-side-panel-design.md`

## Global Constraints

- **Do not commit.** Owner approval is required for every commit; finish with work **staged** only. One commit per run when it is eventually approved.
- **The popup keeps every feature it has today.** The MDH provenance panel deliberately lives in two places. Nothing is moved out of `src/popup/`.
- **Never add a permission that triggers a warning** (`tabs`, `webNavigation`, `history`, …) — Chrome disables every existing install until each user re-approves. `sidePanel` is warning-free; `tab.url` is already readable through the existing Rossum `host_permissions`.
- **No new storage key.** Chrome remembers panel open/closed per window.
- JSX unicode escapes (`\uXXXX`) do not work in raw text children or attribute values — use `{'…'}`, the literal glyph, or an HTML entity.
- Tests are `.test.js` (never `.jsx`) and build elements with `h(Component, props)`; waits are condition-based via a local `waitFor`, never fixed timeouts.
- After any UI change run `npm run build` — the loaded extension runs `dist/`, and `tests/usage-boundary.test.js` inspects `dist/` and fails against a stale build.

---

### Task 1: Manifest, build wiring, and the page shell

**Files:**
- Modify: `manifest.json` (permissions + new `side_panel` key)
- Modify: `build.js:16` (dist dir), `build.js:27-38` (static copies), `build.js:41-54` (entry points)
- Create: `src/sidepanel/sidepanel.html`
- Create: `src/sidepanel/sidepanel.css`
- Create: `src/sidepanel/index.jsx`
- Create: `src/sidepanel/components/App.jsx` (placeholder body, filled in Task 4)
- Test: `tests/sidepanel-manifest.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a loadable `chrome-extension://<id>/sidepanel/sidepanel.html`; `src/sidepanel/components/App.jsx` default-exports `App()`.

- [ ] **Step 1: Write the failing test**

```js
// tests/sidepanel-manifest.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

describe('side panel manifest', () => {
  it('declares the sidePanel permission and a default path', () => {
    expect(manifest.permissions).toContain('sidePanel');
    expect(manifest.side_panel?.default_path).toBe('sidepanel/sidepanel.html');
  });

  // Adding a permission that triggers a warning DISABLES every existing
  // install until each user re-approves it. tab.url is readable through the
  // Rossum host_permissions we already hold, so "tabs" is never needed.
  it('adds no permission that triggers a Chrome permission warning', () => {
    const WARNS = ['tabs', 'webNavigation', 'history', 'bookmarks', 'downloads',
                   'management', 'debugger', 'proxy', 'clipboardRead', '<all_urls>'];
    expect(manifest.permissions.filter((p) => WARNS.includes(p))).toEqual([]);
  });

  it('leaves host_permissions untouched (the field that disables installs)', () => {
    expect(manifest.host_permissions).toEqual([
      'http://localhost:3000/*',
      'https://*.rossum.ai/*',
      'https://*.rossum.app/*',
      'https://*.r8.lol/*',
      'https://*.rossum.cloud/*',
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/sidepanel-manifest.test.js`
Expected: FAIL — `expect(permissions).toContain('sidePanel')`.

- [ ] **Step 3: Update the manifest**

In `manifest.json`, extend permissions and add the key after `"host_permissions"`:

```json
  "permissions": ["storage", "activeTab", "scripting", "sidePanel"],
  "side_panel": { "default_path": "sidepanel/sidepanel.html" },
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/sidepanel-manifest.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the page shell**

`src/sidepanel/sidepanel.html` — popup.css FIRST so the card is identical, then the overrides:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Rossum SA</title>
  <link href="../popup/popup.css" rel="stylesheet" />
  <link href="sidepanel.css" rel="stylesheet" />
</head>
<body class="sidepanel">
  <div id="app"></div>
  <script src="sidepanel.js"></script>
</body>
</html>
```

`src/sidepanel/sidepanel.css`:

```css
/* The side panel reuses popup.css verbatim so the MDH card has exactly ONE
   source of truth and cannot drift between the two surfaces. This file only
   undoes the popup-specific shell — a fixed 380px width and the 600px cap
   Chrome imposes on popups — and adds the document strip, which exists only
   here (a panel that outlives a click has to say which document it shows). */

body.sidepanel {
  width: auto;
  padding: 0;
}

body.sidepanel #app {
  max-height: none;
  height: 100vh;
  gap: 0;
}

body.sidepanel .mdh-card {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 8px 10px 10px;
}

/* ── document strip ─────────────────────────────── */

.sp-strip {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 10px 0;
  padding: 6px 9px;
  background: var(--bg-card);
  border-radius: 6px;
  box-shadow: var(--shadow-card);
  font-size: 10.5px;
  color: var(--text-secondary);
}

.sp-live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #16a34a;
  flex: none;
}

.sp-strip-title {
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sp-strip-id {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-hint);
  flex: none;
}

.sp-strip-hint {
  margin-left: auto;
  color: var(--text-hint);
  flex: none;
}

.sp-strip--idle .sp-strip-title {
  font-weight: 500;
  color: var(--text-secondary);
}

/* ── no Rossum tab in this window ───────────────── */

.sp-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px 22px;
}

.sp-empty-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.sp-empty-text {
  max-width: 32ch;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-hint);
}
```

`src/sidepanel/index.jsx`:

```jsx
import { h, render } from 'preact';
import App from './components/App.jsx';

render(<App />, document.getElementById('app'));
```

`src/sidepanel/components/App.jsx` — placeholder, replaced in Task 4:

```jsx
import { h } from 'preact';

export default function App() {
  return (
    <div class="sp-empty">
      <p class="sp-empty-title">No Rossum tab here</p>
      <p class="sp-empty-text">Open a Rossum tab in this window.</p>
    </div>
  );
}
```

- [ ] **Step 6: Wire the build**

`build.js` — add `'dist/sidepanel'` to the mkdir list on line 16, the two copies after the devtools copies, and the entry point after `'devtools/panel'`:

```js
for (const dir of ['dist/popup', 'dist/icons', 'dist/console', 'dist/devtools', 'dist/sidepanel']) {
```

```js
cpSync('src/sidepanel/sidepanel.html', 'dist/sidepanel/sidepanel.html');
cpSync('src/sidepanel/sidepanel.css', 'dist/sidepanel/sidepanel.css');
```

```js
    'sidepanel/sidepanel': 'src/sidepanel/index.jsx',
```

- [ ] **Step 7: Build and verify the artifacts exist**

Run: `npm run build && ls dist/sidepanel && node -e "const m=require('./dist/manifest.json'); if(!m.permissions.includes('sidePanel')||m.side_panel.default_path!=='sidepanel/sidepanel.html') throw new Error('manifest not wired'); console.log('ok')"`
Expected: `sidepanel.css sidepanel.html sidepanel.js` and `ok`.

- [ ] **Step 8: Stage (do not commit)**

```bash
git add manifest.json build.js src/sidepanel tests/sidepanel-manifest.test.js
```

---

### Task 2: `targetTab.js` — pure tab/annotation helpers

**Files:**
- Create: `src/sidepanel/targetTab.js`
- Test: `tests/sidepanel-target-tab.test.js`

**Interfaces:**
- Consumes: `detectSite(url)` from `src/popup/utils.js` (returns `'rossum' | 'netsuite' | 'coupa' | null`).
- Produces: `annotationIdFromUrl(url) → string | null`, `isRossumTab(tab) → boolean`, `viewState(tab) → 'no-tab' | 'unsupported' | 'ready'`, `sameTarget(a, b) → boolean`.

- [ ] **Step 1: Write the failing test**

```js
// tests/sidepanel-target-tab.test.js
import { describe, it, expect } from 'vitest';
import {
  annotationIdFromUrl,
  isRossumTab,
  sameTarget,
  viewState,
} from '../src/sidepanel/targetTab.js';

const R = 'https://org.rossum.app';

describe('annotationIdFromUrl', () => {
  it('reads the id from a /document/ URL (the id IS the annotation id)', () => {
    expect(annotationIdFromUrl(`${R}/document/1250417`)).toBe('1250417');
  });

  it('reads the id from /annotation/ and /annotations/', () => {
    expect(annotationIdFromUrl(`${R}/annotation/42`)).toBe('42');
    expect(annotationIdFromUrl(`${R}/annotations/42`)).toBe('42');
  });

  it('ignores the query string and hash', () => {
    expect(annotationIdFromUrl(`${R}/document/7?tab=x#y`)).toBe('7');
  });

  it('returns null when there is no annotation in the path', () => {
    expect(annotationIdFromUrl(`${R}/queues/5`)).toBeNull();
    expect(annotationIdFromUrl(`${R}/documents?level=all`)).toBeNull();
  });

  it('returns null for a missing or unparseable URL', () => {
    expect(annotationIdFromUrl(undefined)).toBeNull();
    expect(annotationIdFromUrl('')).toBeNull();
    expect(annotationIdFromUrl('not a url')).toBeNull();
  });

  it('does not match a digit run that is not an id segment', () => {
    expect(annotationIdFromUrl(`${R}/documentation/12`)).toBeNull();
  });
});

describe('isRossumTab / viewState', () => {
  it('accepts Rossum hosts and the localhost dev origin', () => {
    expect(isRossumTab({ url: `${R}/document/1` })).toBe(true);
    expect(isRossumTab({ url: 'https://elis.rossum.ai/queues/2' })).toBe(true);
    expect(isRossumTab({ url: 'http://localhost:3000/document/1' })).toBe(true);
  });

  it('rejects other sites and tabs whose URL is not readable', () => {
    expect(isRossumTab({ url: 'https://example.com/' })).toBe(false);
    expect(isRossumTab({})).toBe(false);
    expect(isRossumTab(null)).toBe(false);
  });

  it('maps a tab to a view state', () => {
    expect(viewState(null)).toBe('no-tab');
    expect(viewState({ url: 'https://example.com/' })).toBe('unsupported');
    expect(viewState({ url: `${R}/document/1` })).toBe('ready');
  });
});

describe('sameTarget', () => {
  it('is true only when both the tab id and the URL match', () => {
    expect(sameTarget({ id: 1, url: `${R}/document/1` }, { id: 1, url: `${R}/document/1` })).toBe(true);
    expect(sameTarget({ id: 1, url: `${R}/document/1` }, { id: 1, url: `${R}/document/2` })).toBe(false);
    expect(sameTarget({ id: 1, url: `${R}/document/1` }, { id: 2, url: `${R}/document/1` })).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(sameTarget(null, { id: 1, url: R })).toBe(false);
    expect(sameTarget({ id: 1, url: R }, null)).toBe(false);
    expect(sameTarget(null, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/sidepanel-target-tab.test.js`
Expected: FAIL — cannot resolve `../src/sidepanel/targetTab.js`.

- [ ] **Step 3: Implement**

```js
// src/sidepanel/targetTab.js
// Pure helpers for "which tab is the side panel following". The popup reads its
// context once, on open, because that is its whole life; a panel outlives every
// click, so it has to notice tab switches and SPA navigation itself.
//
// The annotation-id regexes mirror readCurrentContext in ../popup/tab-readers.js.
// That one runs INSIDE the page against window.location; this one parses the
// tab.url string the panel already holds, which lets us notice a document change
// without an executeScript round-trip.
import { detectSite } from '../popup/utils.js';

const DOC_RE = /\/document\/(\d+)/;
const ANN_RE = /\/annotations?\/(\d+)/;

export function annotationIdFromUrl(url) {
  if (!url) return null;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(DOC_RE) || pathname.match(ANN_RE);
  return match ? match[1] : null;
}

// A tab whose URL we cannot read (no host permission, redacted) is treated as
// unsupported rather than guessed at — same stance as findRossumTabs.
export function isRossumTab(tab) {
  return !!tab && detectSite(tab.url || '') === 'rossum';
}

export function viewState(tab) {
  if (!tab) return 'no-tab';
  return isRossumTab(tab) ? 'ready' : 'unsupported';
}

export function sameTarget(a, b) {
  return !!a && !!b && a.id === b.id && a.url === b.url;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/sidepanel-target-tab.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/sidepanel/targetTab.js tests/sidepanel-target-tab.test.js
```

---

### Task 3: `DocumentStrip` — which document the panel is showing

**Files:**
- Create: `src/sidepanel/components/DocumentStrip.jsx`
- Test: `tests/sidepanel-document-strip.test.js`

**Interfaces:**
- Consumes: `fetchJson(url, token)` from `src/popup/mdh-provenance.js` (throws on non-2xx; the message contains the status).
- Produces: `<DocumentStrip ctx={{domain, token}} annotationId={string|null} />`.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import DocumentStrip from '../src/sidepanel/components/DocumentStrip.jsx';

async function waitFor(cond, timeout = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const CTX = { domain: 'https://org.rossum.app', token: 'tok' };
let root;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('DocumentStrip', () => {
  it('says no document is open when there is no annotation', () => {
    render(h(DocumentStrip, { ctx: CTX, annotationId: null }), root);
    expect(root.textContent).toContain('No document open');
    expect(root.querySelector('.sp-live')).toBeNull();
  });

  it('paints the id immediately, before any request resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(h(DocumentStrip, { ctx: CTX, annotationId: '1250417' }), root);
    expect(root.textContent).toContain('#1250417');
    expect(root.querySelector('.sp-live')).not.toBeNull();
  });

  it('upgrades to the file name when the sideload resolves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{}], documents: [{ original_file_name: 'invoice-4471.pdf' }] }),
    })));
    render(h(DocumentStrip, { ctx: CTX, annotationId: '1250417' }), root);
    await waitFor(() => root.textContent.includes('invoice-4471.pdf'));
    expect(root.textContent).toContain('#1250417');
  });

  it('keeps the id when the name lookup fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    render(h(DocumentStrip, { ctx: CTX, annotationId: '99' }), root);
    await waitFor(() => fetchMock.mock.calls.length > 0);
    expect(root.textContent).toContain('#99');
    expect(root.textContent).toContain('Document');
  });

  it('does not fetch without a token', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(h(DocumentStrip, { ctx: { domain: CTX.domain, token: null }, annotationId: '5' }), root);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(root.textContent).toContain('#5');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/sidepanel-document-strip.test.js`
Expected: FAIL — cannot resolve `DocumentStrip.jsx`.

- [ ] **Step 3: Implement**

```jsx
// src/sidepanel/components/DocumentStrip.jsx
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../../popup/mdh-provenance.js';

// The one piece of UI the popup never needed: a panel that outlives a click has
// to say WHICH document it is showing. The id alone already identifies it, so the
// file name is strictly an upgrade — every failure path just keeps the id.
export default function DocumentStrip({ ctx, annotationId }) {
  const [name, setName] = useState(null);

  useEffect(() => {
    setName(null);
    if (!annotationId || !ctx?.token || !ctx?.domain) return undefined;
    let cancelled = false;
    (async () => {
      try {
        // List + sideload (not the detail route): the form verified live for the
        // Inspector landing.
        const res = await fetchJson(
          `${ctx.domain}/api/v1/annotations?id=${annotationId}&sideload=documents&fields=url,document`,
          ctx.token,
        );
        if (cancelled) return;
        const file = res?.documents?.[0]?.original_file_name;
        if (file) setName(file);
      } catch {
        // Keep the id — it identifies the document unambiguously on its own.
      }
    })();
    return () => { cancelled = true; };
  }, [annotationId, ctx?.domain, ctx?.token]);

  if (!annotationId) {
    return (
      <div class="sp-strip sp-strip--idle">
        <span class="sp-strip-title">No document open</span>
        <span class="sp-strip-hint">following this tab</span>
      </div>
    );
  }

  return (
    <div class="sp-strip">
      <i class="sp-live"></i>
      <span class="sp-strip-title" title={name || 'Document'}>{name || 'Document'}</span>
      <code class="sp-strip-id">#{annotationId}</code>
      <span class="sp-strip-hint">following this tab</span>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/sidepanel-document-strip.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Stage**

```bash
git add src/sidepanel/components/DocumentStrip.jsx tests/sidepanel-document-strip.test.js
```

---

### Task 4: `App` — resolve and follow the tab, mount the card

**Files:**
- Modify: `src/sidepanel/components/App.jsx` (replace the Task 1 placeholder)
- Test: `tests/sidepanel-app.test.js`

**Interfaces:**
- Consumes: `annotationIdFromUrl`, `sameTarget`, `viewState` (Task 2); `DocumentStrip` (Task 3); `MdhProvenancePanel` from `src/popup/components/MdhProvenancePanel.jsx` (props `{ tab, onPin }` — the panel passes no `onPin`); `runInTab`, `readCurrentContext` from `src/popup/`; `track` from `src/usage/track.js`.
- Produces: the rendered side panel.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import App from '../src/sidepanel/components/App.jsx';

async function waitFor(cond, timeout = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const R = 'https://org.rossum.app';
let root;
let listeners;
let activeTab;

function stubChrome() {
  listeners = { activated: [], updated: [] };
  return {
    windows: { getCurrent: vi.fn(async () => ({ id: 7 })) },
    tabs: {
      query: vi.fn(async () => (activeTab ? [activeTab] : [])),
      onActivated: {
        addListener: (fn) => listeners.activated.push(fn),
        removeListener: (fn) => { listeners.activated = listeners.activated.filter((f) => f !== fn); },
      },
      onUpdated: {
        addListener: (fn) => listeners.updated.push(fn),
        removeListener: (fn) => { listeners.updated = listeners.updated.filter((f) => f !== fn); },
      },
    },
    // A token-less context makes the card resolve to a message with no network.
    scripting: {
      executeScript: vi.fn(async () => [{ result: { token: null, domain: R, annotationId: null, queueId: null } }]),
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    runtime: { sendMessage: vi.fn(), getManifest: () => ({ version: '1.0', version_name: 'test' }) },
  };
}

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  activeTab = { id: 1, windowId: 7, url: `${R}/document/1250417` };
  vi.stubGlobal('chrome', stubChrome());
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('side panel App', () => {
  it('renders the MDH card and the strip for a Rossum document tab', async () => {
    render(h(App, {}), root);
    await waitFor(() => !!root.querySelector('.mdh-card'));
    expect(root.querySelector('.sp-strip')).not.toBeNull();
    expect(root.textContent).toContain('#1250417');
    expect(root.textContent).toContain('MDH on this screen');
  });

  it('offers no pin button in the panel (that button is popup-only)', async () => {
    render(h(App, {}), root);
    await waitFor(() => !!root.querySelector('.mdh-card'));
    expect(root.querySelector('.mdh-pin-btn')).toBeNull();
  });

  it('shows the empty state when the active tab is not Rossum', async () => {
    activeTab = { id: 1, windowId: 7, url: 'https://example.com/' };
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('No Rossum tab here'));
    expect(root.querySelector('.mdh-card')).toBeNull();
  });

  it('re-keys the card when the tab navigates to another document', async () => {
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('#1250417'));
    const before = chrome.scripting.executeScript.mock.calls.length;

    activeTab = { id: 1, windowId: 7, url: `${R}/document/999` };
    listeners.updated.forEach((fn) => fn(1, { url: activeTab.url }, activeTab));

    await waitFor(() => root.textContent.includes('#999'));
    // A remount means the card re-read the page context for the new document.
    await waitFor(() => chrome.scripting.executeScript.mock.calls.length > before);
  });

  it('follows a tab switch inside its own window', async () => {
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('#1250417'));

    activeTab = { id: 2, windowId: 7, url: `${R}/document/555` };
    listeners.activated.forEach((fn) => fn({ tabId: 2, windowId: 7 }));

    await waitFor(() => root.textContent.includes('#555'));
  });

  it('ignores tab activity in another window', async () => {
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('#1250417'));
    const queries = chrome.tabs.query.mock.calls.length;

    listeners.activated.forEach((fn) => fn({ tabId: 9, windowId: 99 }));
    await new Promise((r) => setTimeout(r, 20));

    expect(chrome.tabs.query.mock.calls.length).toBe(queries);
  });

  it('removes its listeners on unmount', async () => {
    render(h(App, {}), root);
    await waitFor(() => listeners.activated.length > 0 && listeners.updated.length > 0);
    render(null, root);
    await waitFor(() => listeners.activated.length === 0 && listeners.updated.length === 0);
  });

  it('reports the open exactly once', async () => {
    render(h(App, {}), root);
    await waitFor(() => !!root.querySelector('.mdh-card'));
    const opens = chrome.runtime.sendMessage.mock.calls
      .filter(([msg]) => msg?.name === 'sa_sidepanel_open');
    expect(opens.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/sidepanel-app.test.js`
Expected: FAIL — the placeholder App renders "No Rossum tab here" and no `.mdh-card`.

- [ ] **Step 3: Implement**

```jsx
// src/sidepanel/components/App.jsx
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import MdhProvenancePanel from '../../popup/components/MdhProvenancePanel.jsx';
import { readCurrentContext } from '../../popup/tab-readers.js';
import { runInTab } from '../../popup/utils.js';
import { track } from '../../usage/track.js';
import { annotationIdFromUrl, sameTarget, viewState } from '../targetTab.js';
import DocumentStrip from './DocumentStrip.jsx';

export default function App() {
  const [tab, setTab] = useState(null);
  const [ctx, setCtx] = useState(null);
  const tabRef = useRef(null);

  // Counted here rather than at the popup's pin button: the popup can be
  // destroyed before a sendMessage reaches the worker, and this also counts
  // opens that came from Chrome's own side-panel dropdown.
  useEffect(() => { track('sa_sidepanel_open'); }, []);

  useEffect(() => {
    let cancelled = false;
    let windowId = null;

    const apply = (next) => {
      if (cancelled) return;
      if (sameTarget(tabRef.current, next)) return;
      tabRef.current = next;
      setTab(next);
    };

    const resolveActive = async () => {
      if (windowId == null) return;
      try {
        const [found] = await chrome.tabs.query({ active: true, windowId });
        apply(found || null);
      } catch {
        apply(null);
      }
    };

    const onActivated = (info) => {
      if (info?.windowId === windowId) resolveActive();
    };

    // Rossum is an SPA, so document switches are history navigations rather than
    // loads. VERIFIED live 2026-08-07 (elis): onUpdated fires with
    // changeInfo.url for BOTH history.pushState and history.replaceState, so
    // this alone follows the annotation — an earlier 2.5s poll was removed once
    // measured rather than kept as a just-in-case timer. The `!tabRef.current`
    // arm is the recovery path: a panel that opened before any tab could be
    // resolved would otherwise ignore every later navigation.
    const onUpdated = (tabId, changeInfo) => {
      if (!changeInfo?.url) return;
      if (!tabRef.current || tabId === tabRef.current.id) resolveActive();
    };

    (async () => {
      try {
        const win = await chrome.windows.getCurrent();
        windowId = win?.id ?? null;
      } catch {
        windowId = null;
      }
      if (cancelled) return;
      await resolveActive();
      if (cancelled) return;
      chrome.tabs.onActivated.addListener(onActivated);
      chrome.tabs.onUpdated.addListener(onUpdated);
    })();

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  const state = viewState(tab);
  const annotationId = annotationIdFromUrl(tab?.url);

  // The strip needs the token; the card reads its own context independently, so
  // it stays byte-identical to the popup's copy.
  useEffect(() => {
    if (state !== 'ready' || !tab) {
      setCtx(null);
      return undefined;
    }
    let cancelled = false;
    runInTab(tab.id, readCurrentContext).then((next) => {
      if (!cancelled) setCtx(next);
    });
    return () => { cancelled = true; };
  }, [state, tab?.id, annotationId]);

  if (state !== 'ready') {
    return (
      <div class="sp-empty">
        <p class="sp-empty-title">No Rossum tab here</p>
        <p class="sp-empty-text">
          Open a Rossum tab in this window to see the Master Data Hub lookups behind the
          document you have open.
        </p>
      </div>
    );
  }

  return (
    <Fragment>
      <DocumentStrip ctx={ctx} annotationId={annotationId} />
      <MdhProvenancePanel tab={tab} key={annotationId || 'none'} />
    </Fragment>
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/sidepanel-app.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Stage**

```bash
git add src/sidepanel/components/App.jsx tests/sidepanel-app.test.js
```

---

### Task 5: The pin button — the popup's way into the panel

**Files:**
- Modify: `src/popup/components/MdhProvenancePanel.jsx` (optional `onPin` prop + button)
- Modify: `src/popup/components/App.jsx:304-308` (pass `onPin`)
- Modify: `src/popup/popup.css` (`.mdh-head-actions`, `.mdh-pin-btn`)
- Test: `tests/popup-mdh-pin.test.js`

**Interfaces:**
- Consumes: `MdhProvenancePanel({ tab, onPin })`.
- Produces: nothing downstream. `onPin` absent ⇒ no button (that is the side panel's case, asserted in Task 4).

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import MdhProvenancePanel from '../src/popup/components/MdhProvenancePanel.jsx';

async function waitFor(cond, timeout = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TAB = { id: 1, windowId: 7, index: 0, url: 'https://org.rossum.app/document/5' };
let root;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.stubGlobal('chrome', {
    // Token-less context: the card settles on a message without any network.
    scripting: { executeScript: vi.fn(async () => [{ result: { token: null, domain: 'https://org.rossum.app', annotationId: null, queueId: null } }]) },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    runtime: { sendMessage: vi.fn() },
  });
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('MDH card pin button', () => {
  it('renders no pin button when no onPin is given', async () => {
    render(h(MdhProvenancePanel, { tab: TAB }), root);
    await waitFor(() => !!root.querySelector('.mdh-card'));
    expect(root.querySelector('.mdh-pin-btn')).toBeNull();
    expect(root.querySelector('.mdh-refresh-btn')).not.toBeNull();
  });

  it('renders the pin button and calls onPin when clicked', async () => {
    const onPin = vi.fn();
    render(h(MdhProvenancePanel, { tab: TAB, onPin }), root);
    await waitFor(() => !!root.querySelector('.mdh-pin-btn'));
    root.querySelector('.mdh-pin-btn').click();
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('keeps Refresh working alongside the pin button', async () => {
    render(h(MdhProvenancePanel, { tab: TAB, onPin: vi.fn() }), root);
    await waitFor(() => !!root.querySelector('.mdh-refresh-btn'));
    const before = chrome.scripting.executeScript.mock.calls.length;
    root.querySelector('.mdh-refresh-btn').click();
    await waitFor(() => chrome.scripting.executeScript.mock.calls.length > before);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/popup-mdh-pin.test.js`
Expected: FAIL — no `.mdh-pin-btn` in the DOM.

- [ ] **Step 3: Add the icon and the button to the shared card**

In `src/popup/components/MdhProvenancePanel.jsx`, add the icon beside `RefreshIcon`:

```jsx
function PinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 4.5h18" />
      <path d="M6 4.5v9l-2 3v1.5h16V16.5l-2-3v-9" />
      <path d="M12 18v3" />
    </svg>
  );
}
```

Change the signature to `export default function MdhProvenancePanel({ tab, onPin }) {` and replace the header block:

```jsx
      <h3 class="section-title">
        <span>MDH on this screen <span class="beta-badge">beta</span></span>
        <span class="mdh-head-actions">
          {onPin ? (
            <button
              type="button"
              class="mdh-refresh-btn mdh-pin-btn"
              title="Open in the side panel — stays open while you work"
              onClick={onPin}
            >
              <PinIcon />
            </button>
          ) : null}
          <button
            type="button"
            class="mdh-refresh-btn"
            title="Refresh — bypass cache and re-fetch"
            onClick={onRefresh}
          >
            <RefreshIcon />
          </button>
        </span>
      </h3>
```

- [ ] **Step 4: Add the two CSS rules**

In `src/popup/popup.css`, right after the `.mdh-card .section-title` block (line ~622):

```css
.mdh-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
```

- [ ] **Step 5: Wire the popup**

In `src/popup/components/App.jsx`, add the handler next to `onRossumConsole` (~line 258):

```jsx
  // Chrome cannot keep a popup open on blur, so the pin hands the same card to a
  // side panel and closes the popup. Feature-detected: pre-114 Chrome simply
  // never sees the button. open() must run inside this click — it is the gesture.
  const canPin = !!chrome.sidePanel?.open;
  const onPinSidePanel = async () => {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    } catch {
      // Gesture refused or the API is unavailable — leave the popup open.
    }
  };
```

and pass it at the render site (~line 306):

```jsx
                <MdhProvenancePanel tab={tab} onPin={canPin ? onPinSidePanel : undefined} />
```

- [ ] **Step 6: Run the new test and the whole popup suite**

Run: `npx vitest run tests/popup-mdh-pin.test.js && npx vitest run tests/popup-`
Expected: PASS — the new file plus every existing popup test still green.

- [ ] **Step 7: Stage**

```bash
git add src/popup/components/MdhProvenancePanel.jsx src/popup/components/App.jsx src/popup/popup.css tests/popup-mdh-pin.test.js
```

---

### Task 6: Usage vocabulary and PRIVACY.md

**Files:**
- Modify: `src/usage/event.js:53` (add the event after the DevTools group)
- Modify: `PRIVACY.md` (new "In the side panel" table)
- Test: existing `tests/usage-boundary.test.js`, `tests/usage-console-events.test.js`

**Interfaces:**
- Consumes: `track('sa_sidepanel_open')`, already called in Task 4.
- Produces: `EVENT_NAMES` includes `sa_sidepanel_open`.

- [ ] **Step 1: Run the guard tests and watch them fail**

Run: `npx vitest run tests/usage-console-events.test.js tests/usage-boundary.test.js`
Expected: FAIL — `sa_sidepanel_open` appears in `src/` but is not in the vocabulary.

- [ ] **Step 2: Add the event name**

In `src/usage/event.js`, after the `// DevTools panel` group:

```js
  // Side panel
  'sa_sidepanel_open',
```

- [ ] **Step 3: Publish it in PRIVACY.md**

After the "In the extension popup" table:

```markdown
**In the side panel**

| Event | Meaning |
| --- | --- |
| `sa_sidepanel_open` | the side panel was opened (however you opened it) |
```

- [ ] **Step 4: Rebuild, then run the guards**

Run: `npm run build && npx vitest run tests/usage-console-events.test.js tests/usage-boundary.test.js tests/usage-event.test.js`
Expected: PASS. (`usage-boundary` inspects `dist/`, so the build must come first.)

- [ ] **Step 5: Stage**

```bash
git add src/usage/event.js PRIVACY.md
```

---

### Task 7: Documentation, full suite, and the live gates

**Files:**
- Modify: `CLAUDE.md` (entry-point count, a Side panel section, the storage-keys note)
- Modify: `README.md` (one Rossum feature bullet)

- [ ] **Step 1: Document the surface in CLAUDE.md**

Change "Eight esbuild entry points" to "Nine esbuild entry points" and add item 9:

```markdown
9. **`src/sidepanel/index.jsx`** → Chrome side panel (`sidepanel/sidepanel.html`, `"side_panel".default_path`)
```

Add a section after the Popup section:

```markdown
### Side panel (MDH provenance)

A Chrome side panel (`chrome.sidePanel`, permission is **warning-free** — adding it does not
disable existing installs, unlike a `host_permissions` change) that hosts the **same**
"MDH on this screen" card as the popup. The card deliberately lives in **two** places: the
popup keeps it unchanged, and the panel adds the persistence Chrome popups cannot have
(a popup closes on blur — no API prevents it).

- `src/sidepanel/index.jsx` → `components/App.jsx` resolves the **active tab of its own
  window** and follows it via `tabs.onActivated` (filtered to that window), `tabs.onUpdated`
  (URL changes on the tracked tab) and a 2.5s `visibilityState`-gated poll — Rossum is an SPA
  and `onUpdated` is not assumed to carry every `pushState`. The poll reads `tab.url` only:
  no injection, no request, and **no `tabs` permission** (that one warns; Rossum
  `host_permissions` already expose the URL).
- `targetTab.js` is pure (`annotationIdFromUrl` / `isRossumTab` / `viewState` / `sameTarget`);
  `components/DocumentStrip.jsx` is the only new UI — it names the document being shown
  (`#<id>` immediately, file name when `GET /annotations?id=…&sideload=documents` resolves,
  id retained on any failure).
- `MdhProvenancePanel` is reused **as-is** from `src/popup/`, remounted via
  `key={annotationId}` so its existing load-and-replay effect handles document switches with
  no changes. Its only new prop is the optional **`onPin`** — the popup passes a handler
  (`chrome.sidePanel.open({windowId})` + `window.close()`, feature-detected on
  `chrome.sidePanel?.open`), the panel passes none, so the pin button is popup-only.
- Styling: `sidepanel.html` links `../popup/popup.css` **first** (one source of truth for the
  card, dark mode included) and `sidepanel.css` only neutralises the popup's 380px width and
  600px cap plus the `.sp-*` strip/empty-state rules.
- Nothing new at rest: Chrome remembers the panel's open state per window; the card's own
  `chrome.storage.session` caches and `mdhProvenanceFilter` are shared with the popup.
```

In the Chrome Storage Keys section, append to the Console-state area:

```markdown
- Side panel state: none — Chrome remembers open/closed per window; the panel shares the popup's `mdhProvenanceFilter` and `mdhProv:*` session caches
```

- [ ] **Step 2: Add the README bullet**

Under `### Rossum`, after the Closable-tooltips bullet:

```markdown
- **MDH side panel** — opens the "MDH on this screen" lookup debugger in Chrome's side panel, where it stays put while you scroll and click through the annotation screen (the popup version closes as soon as you click away)
```

- [ ] **Step 3: Run the full suite**

Run: `npm run build && npm test`
Expected: every test green, including the pre-existing 2500+.

- [ ] **Step 4: Live gate G1 + G2 — open the panel and read the tab**

```bash
npm run build
agent-browser --session sp --profile "Profile 1" --extension "$PWD/dist" open "https://elis.rossum.ai/"
```
Get the extension id from `chrome://extensions` (shadow DOM), open
`chrome-extension://<id>/popup/popup.html` as a second tab, make the Rossum tab active from it
(the popup-dogfood trick), click the pin button, and confirm: the panel appears (**G1**), and
its body shows either the card or "Not signed in to Rossum." — either proves
`tabs.query` + `scripting.executeScript` resolved the **page** tab, not the panel (**G2**).
Internal orgs only; never echo the token.

- [ ] **Step 5: Live gate G3 — SPA navigation**

With the panel open, navigate between two documents in the Rossum tab. Confirm the strip's
`#<id>` follows. Then check which mechanism did it: install a recorder in the panel
(`window.__upd = []; chrome.tabs.onUpdated.addListener((id, ci) => window.__upd.push({id, url: ci.url}))`)
and drive both `history.pushState` and `history.replaceState` in the Rossum tab. Record the
answer in the spec's live-gates section.

**Outcome (2026-08-07):** both fire `onUpdated` with `changeInfo.url`, and the panel's
`visibilityState` is `'visible'` while the page tab has focus — so the poll was running and
redundant. It was **removed**, and its one real gap (nothing tracked yet) moved into the
`!tabRef.current` arm of `onUpdated`, covered by the "recovers when no tab was resolvable at
boot" test. The code blocks in Task 4 above reflect the final, poll-free implementation.

- [ ] **Step 6: Report and stop**

Summarise what shipped, what the gates showed, and leave everything **staged and uncommitted**.
Tell the owner to reload the extension at `chrome://extensions` (a manifest change requires a
reload, and content scripts are not re-injected into already-open tabs).

---

## Self-review

- **Spec coverage:** entry point + manifest (T1) · tab following incl. the poll (T4) · pure
  helpers and their tests (T2) · DocumentStrip incl. best-effort name (T3) · pin button,
  feature detection, `onPin`-only rendering (T5) · event fired from the panel, not the popup
  (T4 + T6) · CSS reuse strategy (T1) · states table (T4) · no new storage key (T7 docs) ·
  test matrix (T1–T5) · live gates G1–G3 (T7). G4 (Web Store draft flags the new permission)
  is a publishing-time check, noted in the spec, not a code task.
- **Placeholders:** none — every step carries the literal code or command.
- **Type consistency:** `viewState` returns `'no-tab' | 'unsupported' | 'ready'` and App only
  branches on `!== 'ready'`; `annotationIdFromUrl` returns `string | null` and is used as a
  key with an `|| 'none'` fallback; `sameTarget(a, b)` is called only with tab objects or
  null; `onPin` is optional everywhere it appears.
