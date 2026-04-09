# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that enhances Rossum UI and NetSuite UI for solution architects during onboarding. Published to Chrome Web Store. Community-supported, not an official Rossum product.

## Build System

Uses **esbuild** to bundle ES modules from `src/` into `dist/`. No other build tools or transpilation.

- `npm run build` — clean build into `dist/`
- `npm run dev` — watch mode (JS only; re-run build for CSS/HTML changes)
- `dist/` is the loadable Chrome extension (gitignored)
- `build.js` at project root orchestrates bundling + static asset copying

## Architecture

Source code lives in `src/` with one file per feature:

- **`src/rossum/index.js`** — entry point: reads chrome.storage.local settings, builds a handler array from enabled features, creates a single MutationObserver that walks added subtrees
- **`src/rossum/api.js`** — `fetchRossumApi()` with token auth and error-aware caching
- **`src/rossum/features/`** — one module per feature, each exports a `handleNode(node)` or `init*()` function:
  - `schema-ids.js` — schema ID overlays on annotation fields
  - `resource-ids.js` — resource ID overlays with click-to-copy (workspaces, queues, annotations, extensions, labels, rules, users)
  - `expand-formulas.js` — auto-click "Show source code" buttons
  - `expand-reasoning.js` — auto-click "Show options" on reasoning fields
  - `scroll-lock.js` — prevents sidebar auto-scroll; exports `initScrollLock()` and `initFocusPatch()`
  - `dev-flags.js` — message handlers for devFeaturesEnabled/devDebugEnabled toggles
- **`src/netsuite/index.js`** — NetSuite field name display
- **`src/popup/`** — popup UI (`popup.js`, `popup.html`, `popup.css`); feature toggle interface using chrome.storage.local
- **`src/rossum/rossum.css`**, **`src/netsuite/netsuite.css`** — injected via manifest.json `css` arrays

## Key Patterns

- All features are gated behind chrome.storage.local toggles controlled via the popup
- Each feature module exports a `handleNode(node)` function called by the central MutationObserver for every added DOM element
- The entry point builds a handlers array from enabled settings — disabled features add zero overhead
- Resource IDs are extracted via URL parsing, DOM data attributes, and Rossum API calls
- Scroll lock works by patching `scrollTop` property descriptors and tracking user scroll intent

## Release Process

1. Bump version in three places: `manifest.json`, `package.json`, `src/popup/popup.html`
2. `npm run build`
3. ZIP the `dist/` folder
4. Upload via https://chrome.google.com/webstore/devconsole
