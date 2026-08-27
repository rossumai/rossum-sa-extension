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
import { collectAssetRefs, inlinePrintAssets } from '../../docs/printAssets.js';
import type { PrintAssets } from '../../docs/printAssets.js';
import { prefetchAssets, printAssetBudget, type PrintAssetStore } from './assetPrefetch.js';
import { createMarkdownRenderer, MERMAID_LIGHT } from '../../docs/render.js';
import { loadMermaidRenderer, getMermaidRenderer } from '../../ui/fabry/mermaidLoader.js';
import { openPrintTab } from './printAction.js';
import { openPdfDialog } from './components/PdfDialog.jsx';

// `current` is the deliverable the reader is on, which is what "this deliverable" means in the scope
// dialog. `onNote` reports outcome text for the document bar; `onWarnings` the document warnings.
// `assets` is the store the prefetch reads; it defaults to the one instance and is a parameter so
// this flow can be driven without a live organization.
type PdfFlowOpts = {
  onNote?: (note: string) => void;
  onWarnings?: (w: string[]) => void;
  assets?: PrintAssetStore | null;
};

export function openPdfFlow(
  current: Deliverable | null,
  { onNote = () => {}, onWarnings = () => {}, assets }: PdfFlowOpts = {},
) {
  const all = store.deliverables.value;
  openPdfDialog(
    { deliverableTitle: current ? displayTitle(current) : 'this deliverable', count: all.length },
    // `assets` is forwarded and NOT defaulted here: `runPdf` defaults it to the one instance, and a
    // second default in this hop would be a second thing to keep in step. Declaring the option and
    // then dropping it — which is what this did — is this feature's own defect shape in miniature.
    ({ scope, options }: { scope: string; options: any }) =>
      runPdf({ current, scope, options, onNote, onWarnings, assets }),
  );
}

export async function runPdf({
  current,
  scope,
  options,
  onNote = () => {},
  onWarnings = () => {},
  assets = store.assets,
}: { current: Deliverable | null; scope: string; options?: any } & PdfFlowOpts) {
  onNote('busy');
  try {
    await loadMermaidRenderer().catch(() => null);
    // Paper is white, so diagrams are baked light regardless of the Console's theme.
    const md = createMarkdownRenderer({
      mermaid: getMermaidRenderer(),
      mermaidTheme: MERMAID_LIGHT,
    });
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
    // Assets are baked in AFTER assembly, not during it. `buildPrintDocument` is synchronous and
    // pure and stays that way — it never learns that assets exist — while the reference list comes
    // from the ASSEMBLED HTML, where an `<img>` and an `<a>` are unambiguous. Re-scanning the
    // markdown instead would have to re-derive that distinction, and get fenced examples right a
    // second time.
    const refs = collectAssetRefs(html);
    let prepared: PrintAssets = new Map();
    const assetWarnings: string[] = [];
    if (refs.length) {
      try {
        // The budget is computed HERE because this is where the assembled markup exists: the
        // quota is shared between the two, and only this scope knows how much of it the document
        // has already spent.
        const out = await prefetchAssets(assets, refs, { budget: printAssetBudget(html) });
        prepared = out.assets;
        assetWarnings.push(...out.warnings);
      } catch (err) {
        // `prefetchAssets` degrades per asset and cannot reject — every call it makes is already
        // wrapped — so this is defence in depth. With an empty map nothing can be marked (there is
        // no way to know from here WHICH references were assets), so the references stage as
        // authored and the failure is named in the document bar instead. Still the right trade:
        // losing the whole specification over one picture is what this path exists to prevent.
        assetWarnings.push(
          `assets could not be prepared: ${err && (err as any).message ? (err as any).message : err}`,
        );
      }
    }
    await openPrintTab({ html: inlinePrintAssets(html, prepared), title });
    onNote(`print view opened${chosen.length > 1 ? ` \u00b7 ${chosen.length} documents` : ''}`);
    const allWarnings = [...warnings, ...assetWarnings];
    if (allWarnings.length) onWarnings(allWarnings);
  } catch (err) {
    onNote(
      `could not open the print view: ${err && (err as any).message ? (err as any).message : err}`,
    );
  }
}
