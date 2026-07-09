// Vanilla-DOM, Trusted-Types-safe result panel (no innerHTML). Dry-run: shows
// proposed changes only — no Apply button yet (Plan 2). Injects its own style once.
export const PANEL_ID = 'rossum-sa-extension-annotate-panel';
const STYLE_ID = 'rossum-sa-extension-annotate-style';

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
#${PANEL_ID}{position:fixed;bottom:64px;right:16px;z-index:2147483646;width:min(440px,calc(100vw - 32px));
  max-height:72vh;overflow:auto;background:#fff;color:#1a1a1a;border-radius:10px;
  box-shadow:0 8px 28px rgba(0,0,0,.28);font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:12px;}
#${PANEL_ID} .rossum-sa-extension-annotate-status{font-weight:600;margin-bottom:8px;}
#${PANEL_ID} .rossum-sa-extension-annotate-status:empty{display:none;margin:0;}
#${PANEL_ID} .rossum-sa-extension-annotate-row{border-top:1px solid #eee;padding:8px 0;}
#${PANEL_ID} .rossum-sa-extension-annotate-badge{display:inline-block;font-size:10px;font-weight:700;
  border-radius:4px;padding:1px 5px;background:#eef2ff;color:#2b4eb8;margin-left:6px;}
#${PANEL_ID} .rossum-sa-extension-annotate-err{color:#b00020;font-weight:600;}
#${PANEL_ID} .rossum-sa-extension-annotate-note{color:#8a6d00;font-size:11px;margin-bottom:6px;}
#${PANEL_ID} .rossum-sa-extension-annotate-pulse{display:flex;gap:4px;padding:4px 0;}
#${PANEL_ID} .rossum-sa-extension-annotate-pulse span{width:6px;height:6px;border-radius:50%;background:#7b5cff;
  opacity:.3;animation:rossum-sa-annotate-pulse 1.2s infinite ease-in-out;}
#${PANEL_ID} .rossum-sa-extension-annotate-pulse span:nth-child(2){animation-delay:.2s;}
#${PANEL_ID} .rossum-sa-extension-annotate-pulse span:nth-child(3){animation-delay:.4s;}
@keyframes rossum-sa-annotate-pulse{0%,80%,100%{opacity:.25;transform:scale(.85);}40%{opacity:.9;transform:scale(1);}}
#${PANEL_ID} .rossum-sa-extension-annotate-btn2{font:inherit;font-weight:600;border:1px solid #ccc;
  border-radius:6px;background:#fff;color:#1a1a1a;padding:5px 10px;margin-right:8px;cursor:pointer;}
#${PANEL_ID} .rossum-sa-extension-annotate-btn2:hover{background:#f2f2f2;}
#${PANEL_ID} .rossum-sa-extension-annotate-transcript{display:none;max-height:180px;overflow-y:auto;margin:0 0 8px;
  padding:6px 8px;background:#f7f7fa;border:1px solid #e5e5ee;border-radius:6px;color:#555;
  font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;}
#${PANEL_ID} .rossum-sa-extension-annotate-transcript-label{color:#7b5cff;font-weight:700;}`;
  (doc.head || doc.documentElement).appendChild(s);
}

export function createPanel(doc = document) {
  ensureStyle(doc);
  const el = doc.createElement('div');
  el.id = PANEL_ID;
  const status = doc.createElement('div');
  status.className = 'rossum-sa-extension-annotate-status';
  // Textless working indicator (three pulsing dots) — shown from open until the
  // first real content (transcript, results, or an error) replaces it. No phase
  // narration by design: the panel is just the transcript + the final results.
  const pulse = doc.createElement('div');
  pulse.className = 'rossum-sa-extension-annotate-pulse';
  for (let i = 0; i < 3; i++) pulse.appendChild(doc.createElement('span'));
  const transcript = doc.createElement('div');
  transcript.className = 'rossum-sa-extension-annotate-transcript';
  const list = doc.createElement('div');
  el.appendChild(status);
  el.appendChild(pulse);
  el.appendChild(transcript);
  el.appendChild(list);

  let undoCb = null;
  let reloadCb = null;

  const clearList = () => { while (list.firstChild) list.removeChild(list.firstChild); };
  const line = (parent, text, cls) => { const d = doc.createElement('div'); if (cls) d.className = cls; d.textContent = text; parent.appendChild(d); return d; };
  const settle = () => { pulse.remove(); };

  return {
    el,
    setStatus(text) { status.textContent = text; },
    // Live Mr. Fabry transcript (reasoning + replies), streamed as it happens.
    // Labeled appends (turn header, reply marker) normalize their own spacing:
    // exactly one blank line before them — none when the transcript is empty —
    // so callers never juggle leading newlines against streamed deltas that may
    // or may not end with one.
    appendTranscript(text, label) {
      settle();
      transcript.style.display = 'block';
      if (label) {
        const cur = transcript.textContent;
        const pad = !cur ? '' : cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
        if (pad) transcript.appendChild(doc.createTextNode(pad));
      }
      const span = doc.createElement('span');
      if (label) span.className = 'rossum-sa-extension-annotate-transcript-label';
      span.textContent = text;
      transcript.appendChild(span);
      transcript.scrollTop = transcript.scrollHeight;
    },
    onUndo(cb) { undoCb = cb; },
    onReload(cb) { reloadCb = cb; },
    showResult({ applied, remaining, unboxed, note }) {
      settle();
      clearList();
      status.textContent = `Applied ${applied.length} · ${remaining.length} unresolved`;
      if (note) line(list, note, 'rossum-sa-extension-annotate-note');
      if (unboxed && unboxed.length) {
        const u = line(list, `Without a box (value not printed, or its text belongs to another field): ${unboxed.map((x) => x.schemaId + (x.rowIndex ? ` r${x.rowIndex}` : '')).join(', ')}`);
        u.style.color = '#8a6d00';
        u.style.fontSize = '11px';
      }
      for (const c of applied) {
        const row = doc.createElement('div');
        row.className = 'rossum-sa-extension-annotate-row';
        const h = line(row, `✓ ${c.schemaId}${c.rowIndex ? ` (row ${c.rowIndex})` : ''}`);
        h.style.fontWeight = '700';
        if (c.valueChanged) line(row, `value: ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`);
        if (c.boxChanged) {
          const b = line(row, 'box: redrawn');
          const badge = doc.createElement('span');
          badge.className = 'rossum-sa-extension-annotate-badge';
          badge.textContent = c.boxSource;
          b.appendChild(badge);
        }
        if (c.reason) line(row, c.reason).style.color = '#555';
        list.appendChild(row);
      }
      for (const e of remaining) line(list, `unresolved: ${e.content}`, 'rossum-sa-extension-annotate-err');
      const actions = doc.createElement('div');
      actions.style.marginTop = '10px';
      const mk = (label, cb) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'rossum-sa-extension-annotate-btn2';
        b.textContent = label;
        b.addEventListener('click', () => cb && cb());
        actions.appendChild(b);
        return b;
      };
      mk('Undo all', () => undoCb && undoCb());
      mk('Reload to view', () => reloadCb && reloadCb());
      list.appendChild(actions);
    },
    showError(text) { settle(); clearList(); line(list, text, 'rossum-sa-extension-annotate-err'); },
    remove() { el.remove(); },
  };
}
