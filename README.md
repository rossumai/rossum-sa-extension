> [!IMPORTANT]
> This is a community project supported by enthusiasts and volunteers. For official support, please get in touch with [Rossum Sales](https://rossum.ai/form/contact/).

Chrome extension adds small enhancements to **Rossum UI** as well as **NetSuite UI** for easier onboarding (created by the SA team).

## Install

Head over to https://chrome.google.com/webstore/detail/bljkbinljmhdbipklfcljongikhmnneh and click **Add to Chrome**

## Rossum UI improvements

All of these options are configurable and can be turned on/off on demand:

- overlays `schema_id` on annotation fields (headers and line items)
- overlays resource IDs on queues, hooks, extensions, labels, rules, and users (click to copy)
- auto-expands formula field source code
- auto-expands reasoning field options
- prevents annotation sidebar from auto-scrolling to top (scroll lock)
- toggles `devFeaturesEnabled` flag
- toggles `devDebugEnabled` flag

![header fields](./assets/header_fields.png)

![line items](./assets/line_items.png)

## NetSuite UI improvements

- shows internal field names on form labels

![NetSuite field names](./assets/netsuite_field_names.png)

## Development

```bash
npm install          # install dependencies (esbuild)
npm run build        # bundle src/ → dist/
npm run dev          # rebuild on file changes (JS only)
```

Load `dist/` as an unpacked extension in `chrome://extensions` (enable Developer mode).

After changing HTML files, re-run `npm run build` — the watch mode only picks up JS changes.

## Release

1. Bump version in `manifest.json`, `package.json`, and `src/popup/popup.html`
2. `npm run build`
3. ZIP the `dist/` folder
4. Upload via https://chrome.google.com/webstore/devconsole
