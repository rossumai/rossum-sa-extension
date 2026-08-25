import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import * as store from './store.js';
import { buildPatchBody } from './diff.js';
import { isDark } from './theme.js';

// Dirty = the edited text actually differs from the fetched original (key-order-
// insensitive, matching what Save would PATCH). Invalid JSON counts as dirty
// (there are unsaved edits). Reverting to the original therefore clears it.
function computeDirty(original: unknown, text: string) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return true;
  }
  const { body, removed } = buildPatchBody(original, parsed);
  return Object.keys(body).length + removed.length > 0;
}
import { rossumLinks } from './cmLinks.js';
import { rossumNames } from './cmNames.js';
import { resolver } from './nameResolve.js';

// Approximate DevTools' JSON/source palette (exact tokens aren't exposed to
// extension panels — only the theme name). Tune in dogfood.
const lightHL = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: '#881391' },
    { tag: tags.string, color: '#c41a16' },
    { tag: tags.number, color: '#1c00cf' },
    { tag: tags.bool, color: '#0842a0' },
    { tag: tags.null, color: '#808080' },
    { tag: tags.keyword, color: '#881391' },
  ]),
);
const darkHL = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: '#5db0d7' },
    { tag: tags.string, color: '#f29766' },
    { tag: tags.number, color: '#9980ff' },
    { tag: tags.bool, color: '#569cd6' },
    { tag: tags.null, color: '#808080' },
    { tag: tags.keyword, color: '#c586c0' },
  ]),
);
// Editor surface inherits the panel's theme-aware background (no oneDark dark surface).
const surfaceTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#888', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(128,128,128,0.08)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
});

export default function JsonCodeEditor({
  tabId,
  onFollowLink,
  onContextLink,
}: {
  tabId?: number | string;
  onFollowLink?: (url: string) => void;
  /** The context-menu handler also receives the click position. */
  onContextLink?: (url: string, x?: number, y?: number) => unknown;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // True while WE programmatically push an external buffer change into the view,
  // so the updateListener can distinguish that from a real user edit and NOT
  // re-mark the store dirty (the sync fires synchronously inside view.dispatch).
  const syncingRef = useRef(false);
  const tab = store.tabs.value.find((t) => t.id === tabId) || null;
  const buffer = tab ? tab.buffer : '';
  const readOnly = tab ? tab.readOnly : false;

  useEffect(() => {
    const listener = EditorView.updateListener.of((u) => {
      if (u.docChanged && !syncingRef.current) {
        const text = u.state.doc.toString();
        const t = store.tabs.value.find((x) => x.id === tabId);
        store.patchTab(tabId as string, {
          buffer: text,
          dirty: computeDirty(t ? t.original : null, text),
        });
      }
    });
    const extensions = [
      basicSetup,
      json(),
      ...(onFollowLink ? [rossumLinks(onFollowLink, onContextLink)] : []),
      rossumNames(resolver.nameFor, resolver.ensure),
      listener,
      EditorView.editable.of(!readOnly),
    ];
    extensions.push(isDark() ? darkHL : lightHL, surfaceTheme);
    const view = new EditorView({
      state: EditorState.create({ doc: buffer, extensions }),
      parent: parentRef.current!,
    });
    viewRef.current = view;
    store.views.active = view;
    return () => {
      view.destroy();
      store.views.active = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect EXTERNAL buffer writes (load/save) back into the editor, without
  // tripping the dirty flag (guarded by syncingRef).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (buffer !== cur) {
      syncingRef.current = true;
      try {
        view.dispatch({ changes: { from: 0, to: cur.length, insert: buffer } });
      } finally {
        syncingRef.current = false;
      }
    }
  }, [buffer]);

  let parseError: string | null = null;
  try {
    JSON.parse(buffer);
  } catch (e: any) {
    parseError = (e as Error).message;
  }

  return (
    <div class="rawjson-raw">
      <div class="rawjson-cm" ref={parentRef}></div>
      {parseError ? <div class="rawjson-parse-error">Invalid JSON: {parseError}</div> : null}
    </div>
  );
}
