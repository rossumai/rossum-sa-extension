> [!IMPORTANT]
> This is a community project supported by enthusiasts and volunteers. For official support, please get in touch with [Rossum Sales](https://rossum.ai/form/contact/).

Chrome extension adds small enhancements to **Rossum UI** as well as **NetSuite UI** for easier onboarding (created by the SA team).

## Install

Head over to https://chrome.google.com/webstore/detail/bljkbinljmhdbipklfcljongikhmnneh and click **Add to Chrome**

## Rossum UI improvements

All of these options are configurable and can be turned on/off on demand:

- shows datapoint `schema_id` on the annotation screen (headers and line items)
- expands formula field definitions by default
- expands reasoning field options by default
- prevents sidebar from auto-scrolling to top after async loads (scroll lock)
- adds `devFeatureEnabled` toggle
- adds `devDebugEnabled` toggle

![header fields](./assets/header_fields.png)

![line items](./assets/line_items.png)

## NetSuite UI improvements

- shows field internal names where available

![NetSuite field names](./assets/netsuite_field_names.png)

## Development

```bash
npm install          # install dependencies (esbuild)
npm run build        # bundle src/ → dist/
npm run dev          # rebuild on file changes (JS only)
```

Load `dist/` as an unpacked extension in `chrome://extensions` (enable Developer mode).

After changing CSS or HTML files, re-run `npm run build` — the watch mode only picks up JS changes.

## Release

1. Bump version in `manifest.json`, `package.json`, and `src/popup/popup.html`
2. `npm run build`
3. ZIP the `dist/` folder
4. Upload via https://chrome.google.com/webstore/devconsole
