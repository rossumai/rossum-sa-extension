import { ViewPlugin, Decoration, WidgetType, EditorView } from '@codemirror/view';
import { StateEffect, RangeSetBuilder } from '@codemirror/state';
import { rossumUrlRe } from './cmLinks.js';

const refreshNames = StateEffect.define();

class NameWidget extends WidgetType {
  declare name: string;

  constructor(name: string) { super(); this.name = name; }
  eq(other: any) { return other.name === this.name; }
  toDOM() { const s = document.createElement('span'); s.className = 'rawjson-name'; s.textContent = this.name; return s; }
  ignoreEvent() { return true; }
}

export function rossumNames(
  nameFor: (p: string) => { status: string; name: string | null } | null,
  ensure: (url: string, onDone: () => void) => void,
) {
  let scheduled = false;
  const scheduleRefresh = (view: any) => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; try { view.dispatch({ effects: refreshNames.of(null) }); } catch { /* view gone */ } }, 60);
  };
  const plugin = ViewPlugin.fromClass(class {
    declare decorations: any;

    constructor(view: any) { this.decorations = this.build(view); }
    update(u: any) {
      const refreshed = u.transactions.some((t: any) => t.effects.some((e: any) => e.is(refreshNames)));
      if (u.docChanged || u.viewportChanged || refreshed) this.decorations = this.build(u.view);
    }
    build(view: any) {
      const byLine = new Map<number, string[]>(); // line.to -> [names]
      const re = rossumUrlRe();
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          const url = m[0];
          const info = nameFor(url);
          if (!info) continue;                                   // not nameable
          if (info.status === 'done') {
            if (!info.name) continue;                            // resolved, no display name
            const lineTo = view.state.doc.lineAt(from + m.index).to;
            const arr = byLine.get(lineTo) || [];
            if (!arr.includes(info.name)) arr.push(info.name);
            byLine.set(lineTo, arr);
          } else if (info.status !== 'error') {
            ensure(url, () => scheduleRefresh(view));            // 'none' | 'loading'
          }
        }
      }
      const builder = new RangeSetBuilder();
      for (const pos of [...byLine.keys()].sort((a, b) => a - b)) {
        builder.add(pos, pos, Decoration.widget({ widget: new NameWidget(byLine.get(pos)!.join(' · ')), side: 1 }));
      }
      return builder.finish();
    }
  }, { decorations: (v) => v.decorations });
  return [plugin, EditorView.theme({ '.rawjson-name': { opacity: '0.55', fontStyle: 'italic', marginLeft: '1.5em', userSelect: 'none' } })];
}
