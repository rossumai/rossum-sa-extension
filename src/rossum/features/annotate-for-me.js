// Double-gated: "annotateForMeEnabled" AND "experimentalUnlocked" (popup
// easter-egg — see isAnnotateEnabled), both off by default. On the validation screen
// (/document/<id>) it shows a docked button; clicking runs the auto-apply
// propose→apply→validate→refine loop (writes content) and shows the outcome in a
// panel, with Undo (revert to the pre-run snapshot) and Reload actions. Vanilla
// DOM only. Button placement: viewport-docked (top-right) — a selector-independent
// default; refine to a toolbar anchor once the live DOM is confirmed (do NOT guess
// a Rossum internal selector — see resource-ids precedent).
import { postRossumApi, getJson, getBase64 } from '../api.js';
import { streamFabry } from '../annotate/fabryBridge.js';
import { runAnnotate } from '../annotate/loop.js';
import { runUndo, loadSnapshot } from '../annotate/undo.js';
import { createPanel, PANEL_ID } from '../annotate/panel.js';

// Double-gate: the toggle AND the popup easter-egg unlock (5 clicks on the
// version hash → `experimentalUnlocked`) must both be set. Re-locking the
// Experimental section disables the feature on next tab load, not just its UI.
export function isAnnotateEnabled(settings) {
  return !!(settings && settings.annotateForMeEnabled && settings.experimentalUnlocked);
}

export const BUTTON_ID = 'rossum-sa-extension-annotate-btn';
const STYLE_ID = 'rossum-sa-extension-annotate-btn-style';

export function annotationIdFromPath(pathname) {
  const m = String(pathname || '').match(/\/(?:document|annotation)\/(\d+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}

export function injectButton(doc, onClick) {
  if (doc.getElementById(BUTTON_ID)) return;
  if (!doc.getElementById(STYLE_ID)) {
    const s = doc.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `#${BUTTON_ID}{position:fixed;bottom:16px;right:16px;z-index:2147483646;
      background:linear-gradient(90deg,#7b5cff,#4270db);color:#fff;border:none;border-radius:8px;
      padding:8px 12px;font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);}
      #${BUTTON_ID}[disabled]{opacity:.6;cursor:default;}`;
    (doc.head || doc.documentElement).appendChild(s);
  }
  const btn = doc.createElement('button');
  btn.id = BUTTON_ID;
  btn.type = 'button';
  btn.textContent = '✨ Annotate for me';
  btn.addEventListener('click', () => onClick(btn));
  doc.body.appendChild(btn);
}

let running = false;
async function run(btn) {
  if (running) return;
  const annotationId = annotationIdFromPath(window.location.pathname);
  if (!annotationId) return;
  running = true;
  btn.disabled = true;
  document.getElementById(PANEL_ID)?.remove();
  const panel = createPanel(document);
  document.body.appendChild(panel.el);
  panel.onReload(() => window.location.reload());
  panel.onUndo(async () => {
    panel.setStatus('Reverting…');
    try {
      const { restored } = await runUndo({ annotationId, deps: { post: postRossumApi } });
      panel.setStatus(restored ? 'Reverted — reload to view' : 'Nothing to undo');
    } catch {
      panel.setStatus('Undo failed — the annotation may be locked; reload and retry.');
    }
  });
  const token = window.localStorage.getItem('secureToken');
  // Stream Mr. Fabry's whole conversation (reasoning + replies) into the panel
  // transcript, live. The wrapper must CHAIN the caller's onEvent — the loop's
  // accumulator depends on receiving every event.
  const streamFabryWithTranscript = (o) => {
    panel.appendTranscript('\u2500\u2500 Mr. Fabry \u2500\u2500\n', true);
    return streamFabry({
      ...o,
      onEvent: (ev) => {
        if (typeof o.onEvent === 'function') o.onEvent(ev);
        if (ev.type === 'reasoning-delta' || ev.type === 'text-delta') panel.appendTranscript(ev.delta || '');
        if (ev.type === 'text-start') panel.appendTranscript('\u21B3 reply:\n', true);
      },
    });
  };
  try {
    const out = await runAnnotate({
      annotationId, token, domain: window.location.origin,
      deps: { getJson, getBase64, streamFabry: streamFabryWithTranscript, post: postRossumApi },
      // Geometry results appear immediately; the AI stage keeps streaming above.
      // No phase narration: the panel shows only the transcript and the results.
      onPartial: (partial) => {
        const applied = [...new Map(partial.applied.map((c) => [c.datapointId, c])).values()];
        panel.showResult({ applied, remaining: [] });
      },
    });
    if (!out.applied.length && !out.addedRows && !out.remaining.length) {
      panel.showResult({ applied: [], remaining: [], note: out.note });
      panel.setStatus('No changes needed — annotation looks correct.');
    } else {
      // Dedupe by datapointId (keep last): a field corrected twice across refine
      // turns should be reported once, with its final value — not double-counted.
      const applied = [...new Map(out.applied.map((c) => [c.datapointId, c])).values()];
      panel.showResult({ applied, remaining: out.remaining, unboxed: out.unboxed, note: out.note });
    }
  } catch (e) {
    const msg = e && e.status === 401 ? 'Session expired — reload the Rossum page.' : 'Could not annotate this document.';
    const snap = loadSnapshot(annotationId);
    if (snap && Object.keys(snap).length) {
      // A snapshot exists → some writes may have landed before the failure. Surface
      // the error through the result view (not showError) so Undo/Reload stay reachable.
      panel.setStatus(msg);
      panel.showResult({ applied: [], remaining: [{ type: 'error', content: msg + ' Some changes may have been applied — use Undo to revert.' }] });
    } else {
      panel.showError(msg);
    }
  } finally {
    running = false;
    btn.disabled = false;
  }
}

export function init() {
  if (annotationIdFromPath(window.location.pathname)) injectButton(document, run);
}

export function handleNode() {
  // Re-assert the button after SPA re-renders/route changes.
  if (annotationIdFromPath(window.location.pathname)) injectButton(document, run);
  else {
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
  }
}
