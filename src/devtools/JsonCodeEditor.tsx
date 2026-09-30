import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
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
import { lightHL, darkHL, surfaceTheme } from './cmTheme.js';

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
  // Line wrapping is toggled live, without rebuilding the editor (cursor and scroll stay).
  const wrapRef = useRef(new Compartment());
  const wrap = store.lineWrap.value;
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
      wrapRef.current.of(wrap ? EditorView.lineWrapping : []),
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

  useEffect(() => {
    const view = viewRef.current;
    if (view)
      view.dispatch({ effects: wrapRef.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

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
