# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest v3) that enhances Rossum UI and NetSuite UI for solution architects during onboarding. Published to Chrome Web Store. Community-supported, not an official Rossum product.

## Architecture

- **Content scripts** injected into target pages:
  - `scripts/rossum.js` — Rossum platform enhancements (schema ID display, resource ID display with click-to-copy, formula/reasoning field auto-expand, scroll lock, dev flag toggles)
  - `scripts/netsuite.js` — NetSuite field name display
- **Popup UI** (`popup/popup.html`, `popup/popup.js`, `popup/popup.css`) — feature toggle interface using `chrome.storage.local`
- **No build system** — plain JS files loaded directly by Chrome, no bundler or transpilation
- **Flow type annotations** (`// @flow` headers, `/*:: */` comment syntax) — used for type safety without requiring a build step

## Key Patterns

- All features are gated behind chrome.storage.local toggles controlled via the popup
- DOM observation uses `MutationObserver` extensively to detect page changes
- Resource IDs are extracted via URL parsing, DOM data attributes, and Rossum API calls
- Scroll lock works by patching `scrollTop` property descriptors and tracking user scroll intent

## Release Process

1. Bump version in three places: `manifest.json`, `package.json`, `popup/popup.html`
2. ZIP the `rossum-sa-extension` folder
3. Upload via https://chrome.google.com/webstore/devconsole
