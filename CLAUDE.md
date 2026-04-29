# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that enhances Rossum UI, NetSuite UI, and Coupa UI for solution architects during onboarding. Published to Chrome Web Store. Community-supported, not an official Rossum product.

## Build System

Uses **esbuild** to bundle ES modules from `src/` into `dist/`. No other build tools or transpilation.

- `npm run build` — clean build into `dist/`
- `npm run dev` — watch mode (JS only; re-run build for CSS/HTML changes)
- `dist/` is the loadable Chrome extension (gitignored)
- `build.js` orchestrates bundling + static asset copying (manifest.json, icons/, popup HTML/CSS, mdh HTML/CSS)

esbuild config: `format: 'iife'`, `minify: true`, `jsxFactory: 'h'`, `jsxFragment: 'Fragment'` (Preact JSX).

## Architecture

Five esbuild entry points:

1. **`src/rossum/index.js`** → content script for Rossum pages
2. **`src/netsuite/index.js`** → content script for NetSuite pages
3. **`src/coupa/index.js`** → content script for Coupa pages
4. **`src/popup/popup.js`** → extension popup UI
5. **`src/mdh/index.jsx`** → Dataset Management standalone page (opened via `chrome.tabs.create`)

No background/service worker — purely content scripts + popup.

### Rossum content script

Reads chrome.storage.local settings, builds a handler array from enabled features, creates a single MutationObserver that walks added subtrees. Feature modules in `src/rossum/features/` each export:
- `init()` (optional) — inject CSS, set up listeners (called once)
- `handleNode(node)` — called for every added DOM element; must be fast (no-op when irrelevant)

To add a new feature: create a module in `features/`, add its storage key to `SETTINGS_KEYS` in `index.js`, wire up `init()`/`handleNode()` in the conditional block, and add a toggle checkbox in `popup.html`/`popup.js`.

### Dataset Management (MDH)

A Preact SPA (`src/mdh/`) for managing Rossum Data Storage collections:

- **`store.js`** — Preact signals for global state: `domain`, `token`, `collections`, `selectedCollection`, `records`, `skip`, `limit`, `activePanel`, `loading`, `error`, `modalContent`
- **`api.js`** — REST client wrapping the Data Storage API (30+ methods: CRUD, aggregation, indexes, search indexes, bulk operations). 30-second timeout via AbortController. 401 → "Session expired".
- **`cache.js`** — LRU cache with 60-second TTL, max 200 entries. Field-level granularity (keyed by collection + field). Supports pinning to exempt active collection from TTL. `invalidateData()` clears query results but preserves index caches.
- **`prefetch.js`** — background preloading: prioritizes active collection/panel, then batches other collections (5 per batch, 200ms delay). Uses AbortController to cancel on selection change.
- **`hooks/`** — `usePipeline` (sort/filter state → MongoDB aggregation pipeline, placeholder substitution), `useQuery` (executes aggregations with stale-result cancellation via queryId counter), `usePagination` (skip/limit page tracking with cached total count)
- **`components/`** — 25 JSX components. Modal system: `openModal(title, renderFn)`, `confirmModal(title, msg, onConfirm)`, `promptModal(title, opts, onSubmit)`.

Auth flow: popup sends `'get-auth-info'` message to Rossum tab → content script returns `{token, domain}` from localStorage → popup stores in chrome.storage.local → opens mdh.html → MDH reads from storage on boot.

### Coupa content script

Two strategies: JSON metadata extraction from `#initial_full_react_data` script tag (React pages like invoices) and DOM attribute extraction with `IGNORE_S_CLASSES` filtering (Rails pages like POs).

### Popup

Detects current site (Rossum/NetSuite/Coupa) and dims irrelevant sections. Two toggle types: storage-backed (persist in chrome.storage.local, reload tab on change) and message-backed (devFeatures/devDebug, communicated via chrome.tabs.sendMessage without reload).

## Chrome Storage Keys

- Feature toggles: `schemaAnnotationsEnabled`, `expandFormulasEnabled`, `expandReasoningFieldsEnabled`, `scrollLockEnabled`, `resourceIdsEnabled`, `netsuiteFieldNamesEnabled`, `coupaFieldNamesEnabled`
- MDH auth: `mdhToken`, `mdhDomain`
- MDH state: `mdhPipelineWidth`

## CSS Architecture

- **MDH** (`mdh.css`): CSS custom properties for all colors, surfaces, typography. Dark mode via `@media (prefers-color-scheme: dark)` overriding `:root` variables. Semantic color variables: `--accent`, `--success`, `--warning`, `--danger` plus `-hover`, `-bg`, `-fg`, `-border` variants.
- **Popup** (`popup.css`): Separate variable system, also supports dark mode.
- **Content scripts**: Inject styles dynamically via `init()` functions (styles only in DOM when feature enabled). All classes prefixed `rossum-sa-extension-*`.
- **CodeMirror**: Custom highlight themes (light + dark) in `JsonEditor.jsx` matching the JSON tree renderer colors via `@lezer/highlight` tags.

## Dependencies

- **preact** + **@preact/signals** — UI rendering and reactive state for MDH
- **codemirror** + **@codemirror/lang-json** + **@codemirror/theme-one-dark** — JSON/pipeline editor with MongoDB operator autocompletion
- **json5** — lenient JSON parsing (allows trailing commas, unquoted keys in pipeline editor)
- **esbuild** (dev) — bundler

## Key Patterns

- All features gated behind chrome.storage.local toggles controlled via popup
- Rossum entry point builds handlers array from enabled settings — disabled features add zero overhead
- NetSuite and Coupa content scripts are self-contained single files (no MutationObserver pattern)

## JSX escape sequences

Unicode escapes (`\uXXXX`) DO NOT work in JSX raw text children or JSX attribute values — they render as the six literal characters `\u2013`, not as the intended glyph. This is because JSX text is parsed as HTML-like content, not as a JS string literal.

Three safe ways to render unicode glyphs in JSX:

1. **Wrap in a JS expression:** `{'\u2013'}` (the braces make it a JS string literal).
2. **Use the literal character directly:** `–` (paste the actual character into the source).
3. **Use an HTML entity** in text children: `&ndash;` (works in JSX text but not in attributes).

What DOES work: `\uXXXX` inside template literals and regular strings (`const label = 'foo \u2013 bar'`), inside `title=` attributes when the whole value is an expression (`title={\`foo \u2013 bar\`}`), and inside `style` strings.

Common offenders: en-dash `\u2013` / em-dash `\u2014`, ellipsis `\u2026`, arrows `\u2192`, chevrons `\u25BE` / `\u25B6`, checkmarks `\u2713`. When mixing with expressions (e.g., `{a}\u2013{b}`), the escape gets rendered literally — write `{a}{'\u2013'}{b}` instead.
## Versioning

Fully automated via `build.js` — no manual version bumping. At build time:

- `git rev-parse --short HEAD` → short commit hash (e.g., `2d935b1`)
- `git rev-list --count HEAD` → total commit count, split into Chrome-compatible `major.minor` (each segment 0–65535)
- `manifest.json` in `dist/` gets `"version"` (commit-count) and `"version_name"` (git hash) injected
- Popup reads `chrome.runtime.getManifest().version_name` at runtime to display the hash

Source `manifest.json` has a placeholder `"version": "0.0"` — never edit it manually.

## Release Process

1. `npm test` — must be fully green before packaging; fix any failures and re-run
2. `npm run build`
3. ZIP the `dist/` folder
4. Upload via https://chrome.google.com/webstore/devconsole
