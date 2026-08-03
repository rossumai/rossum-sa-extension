> [!IMPORTANT]
> This is a community project supported by enthusiasts and volunteers. For official support, please get in touch with [Rossum Sales](https://rossum.ai/form/contact/).

# Rossum SA Extension

A Chrome extension that adds developer tools and productivity enhancements to **Rossum**, **NetSuite**, and **Coupa** web interfaces. Designed for solution architects who configure and integrate these platforms.

## Install

Install from the [Chrome Web Store](https://chrome.google.com/webstore/detail/bljkbinljmhdbipklfcljongikhmnneh).

## Features

All features are configurable via the extension popup and can be toggled on or off individually.

### Rossum

- **Schema ID overlays** — displays `schema_id` on annotation fields (headers and line items)
- **Resource ID overlays** — displays internal IDs on queues, hooks, extensions, labels, rules, users, and AI engines (click to copy)
- **Expand formulas** — automatically opens formula field source code
- **Expand reasoning** — automatically opens reasoning field options
- **Sidebar scroll lock** — prevents the annotation sidebar from auto-scrolling to the top
- **Closable validation tooltips** — adds a small × to interactive validation message tooltips on the annotation screen so they can be dismissed; the next time the tooltip is triggered it reopens normally (always on, no toggle)
- **Dev features toggle** — enables `devFeaturesEnabled` flag
- **Dev debug toggle** — enables `devDebugEnabled` flag
- **Dataset Management** — browse, query, edit, and delete records in Data Storage collections; manage indexes and Atlas Search indexes

![Schema ID overlays on header fields](./assets/header_fields.png)

![Schema ID overlays on line items](./assets/line_items.png)

### NetSuite

- **Internal field names** — shows internal field IDs on form labels

![NetSuite internal field names](./assets/netsuite_field_names.png)

### Coupa

- **API field names** — shows API field names on form labels (invoices, purchase orders, and other pages)
- On invoice pages, extracts exact API names from page metadata (e.g., `currency_id`, `payment_term_id`)
- On PO and other pages, extracts field identifiers from DOM attributes

## Usage data

Optional usage data reports which of the extension's own features you use, so
unused features get removed instead of maintained. It is **off by default** —
enable it in the popup. It sends the feature's name and the extension version,
and never a URL, an organisation domain, a credential, or any document, dataset
or field data. [PRIVACY.md](PRIVACY.md) lists the exact payload and every event
name the extension can send.

## Development

```bash
npm install          # install dependencies
npm run build        # bundle src/ → dist/
npm run dev          # rebuild on file changes (JS only)
```

Load `dist/` as an unpacked extension in `chrome://extensions` (enable Developer mode).

After changing HTML or CSS files, re-run `npm run build` — watch mode only picks up JS changes.

## Release

1. Bump version in `manifest.json`, `package.json`, and `src/popup/popup.html`
2. `npm run build`
3. ZIP the `dist/` folder
4. Upload via https://chrome.google.com/webstore/devconsole
