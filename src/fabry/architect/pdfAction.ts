// "Download PDF" for the specification.
//
// Re-homed here on 2026-08-19: it used to live inside the deliverable pane, and was lost when the
// unified view replaced that pane — the button vanished with its host (owner report). A module, not a
// component, so the only thing the bar has to own is a button.
//
// Mechanism unchanged and worth restating: an extension cannot WRITE a .pdf under this manifest
// (chrome.printing is ChromeOS-only, chrome.debugger's Page.printToPDF needs a permission that would
// disable every existing install until each user re-approves), so this opens a print-ready page and
// the browser's own print dialog, where "Save as PDF" is the default destination.
import * as store from './store.js';
import type { Deliverable } from './collectionPlan.js';
import { displayTitle } from './format.js';
import { buildPrintDocument } from '../../docs/printDoc.js';
import { createMarkdownRenderer, MERMAID_LIGHT } from '../../docs/render.js';
import { loadMermaidRenderer, getMermaidRenderer } from '../../ui/fabry/mermaidLoader.js';
import { openPrintTab } from './printAction.js';
import { openPdfDialog } from './components/PdfDialog.jsx';

// `current` is the deliverable the reader is on, which is what "this deliverable" means in the scope
// dialog. `onNote` reports outcome text for the document bar; `onWarnings` the document warnings.
type PdfFlowOpts = { onNote?: (note: string) => void; onWarnings?: (w: string[]) => void };

export function openPdfFlow(current: Deliverable | null, { onNote = () => {}, onWarnings = () => {} }: PdfFlowOpts = {}) {
  const all = store.deliverables.value;
  openPdfDialog(
    { deliverableTitle: current ? displayTitle(current) : 'this deliverable', count: all.length },
    ({ scope, options }: { scope: string; options: any }) => runPdf({ current, scope, options, onNote, onWarnings }),
  );
}

export async function runPdf(
  { current, scope, options, onNote = () => {}, onWarnings = () => {} }:
  { current: Deliverable | null; scope: string; options?: any } & PdfFlowOpts,
) {
  onNote('busy');
  try {
    await loadMermaidRenderer().catch(() => null);
    // Paper is white, so diagrams are baked light regardless of the Console's theme.
    const md = createMarkdownRenderer({ mermaid: getMermaidRenderer(), mermaidTheme: MERMAID_LIGHT });
    const all = store.deliverables.value;
    const chosen = scope === 'all' || !current ? all : all.filter((d) => d.id === current.id);
    const { html, title, warnings } = buildPrintDocument({
      deliverables: chosen,
      displayTitle,
      results: store.results.value,
      md,
      options,
      heading: scope === 'all' || !current ? 'Specification' : displayTitle(current),
    });
    await openPrintTab({ html, title });
    onNote(`print view opened${chosen.length > 1 ? ` \u00b7 ${chosen.length} documents` : ''}`);
    if (warnings.length) onWarnings(warnings);
  } catch (err) {
    onNote(`could not open the print view: ${err && (err as any).message ? (err as any).message : err}`);
  }
}
