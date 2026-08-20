import { ViewPlugin, Decoration, EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

const URL_RE = /https?:\/\/[^\s"']+\/api\/v1\/[a-z_]+\/\d+(?:[/?#][^\s"']*)?/g;

// Fresh global matcher for Rossum API URLs (own lastIndex per caller).
export function rossumUrlRe() { return /https?:\/\/[^\s"']+\/api\/v1\/[a-z_]+\/\d+(?:[/?#][^\s"']*)?/g; }

// PURE: the Rossum API URL covering `offset` in `text`, or null.
export function urlAt(text: string, offset: number): string | null {
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text))) {
    const start = m.index, end = start + m[0].length;
    if (offset >= start && offset <= end) return m[0];
  }
  return null;
}

const linkMark = Decoration.mark({ class: 'rawjson-link' });

function buildDeco(view: any): any {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text))) builder.add(from + m.index, from + m.index + m[0].length, linkMark);
  }
  return builder.finish();
}

export function rossumLinks(
  onFollowLink: (url: string) => void,
  onContextLink?: (url: string, x: number, y: number) => void,
) {
  const plugin = ViewPlugin.fromClass(class {
    declare decorations: any;

    constructor(view: any) { this.decorations = buildDeco(view); }
    update(u: any) { if (u.docChanged || u.viewportChanged) this.decorations = buildDeco(u.view); }
  }, {
    decorations: (v: any) => v.decorations,
    eventHandlers: {
      mousedown(e, view) {
        if (!(e.metaKey || e.ctrlKey)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const url = urlAt(view.state.doc.toString(), pos);
        if (url) { e.preventDefault(); onFollowLink(url); return true; }
        return false;
      },
      contextmenu(e, view) {
        if (typeof onContextLink !== 'function') return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const url = urlAt(view.state.doc.toString(), pos);
        if (url) { e.preventDefault(); onContextLink!(url, e.clientX, e.clientY); return true; }
        return false;
      },
    },
  });
  return [plugin, EditorView.theme({ '.rawjson-link': { textDecoration: 'underline', cursor: 'pointer' } })];
}
