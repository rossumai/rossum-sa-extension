import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { hoveredStage, editorHoverStage, caretStage, stagesAutoscroll } from '../store.js';
import { computeStageLink, sectionInPane } from '../stageLink.js';
import { animateScrollTop, nearestScrollTop } from '../smoothScroll.js';

// SVG connector drawn over the data panel: from the hovered Stages-view section to
// that stage's code line in the pipeline editor. Reads the `hoveredStage` signal so
// only this small overlay re-renders on hover (not the whole DataPanel). The editor
// stage is revealed once on hover (auto-scroll); the line then re-measures on any
// scroll/resize so it stays attached.
//
// The link is driven from BOTH ends: hovering a section, and the pipeline-editor
// CARET sitting in a stage (`caretStage`). Either way the same connector is drawn
// and the same stage is TINTED in the editor (`.cm-linked-stage`), so both ends
// of the dashed line are marked. That band is deliberately NOT gated on the
// Auto-scroll option: that option governs scrolling, and the connector it
// accompanies has never been gated either. It therefore still marks the stage when
// Auto-scroll is off and the stage sits off-screen — the line hides in that case
// (stageScreenRect returns null), but the band is waiting when the user scrolls to it.
export default function StageLinkOverlay({ editorRef, panelRef }) {
  const [pts, setPts] = useState(null);
  const hv = hoveredStage.value;      // a Stages-view section is hovered
  const eh = editorHoverStage.value;  // ...or a stage in the editor is
  const cs = caretStage.value;        // ...or the caret is resting in one

  // Either POINTER source beats a resting caret — an active gesture wins — and
  // only ONE connector is ever drawn. The two hovers are mutually exclusive in
  // practice, since there is one pointer.
  const src = hv || eh || cs;

  // The caret knows no DOM, so resolve its section from the entry index. Doing
  // this on every recompute (rather than caching an element) also survives a
  // StagesView re-render replacing the node. Returns null when the Stages view
  // isn't open — which is exactly when there is nothing to link to.
  const sectionFor = (s) => (
    s?.el || (s ? panelRef.current?.querySelector(`[data-entry="${s.entryIndex}"]`) : null)
  );

  useEffect(() => {
    const sectionEl = sectionFor(src);
    if (!src || !sectionEl) { setPts(null); editorRef.current?.highlightStage?.(null); return; }
    // Mirror of hovering a section (which reveals the stage in the editor):
    // hovering a stage in the EDITOR reveals its section in the pane. Same gate.
    // 'nearest' so an already-visible section doesn't jolt. Never for the caret
    // — a caret is not a gesture asking to be taken somewhere.
    if (eh && !hv && stagesAutoscroll.value) {
      // Animated, so the pane visibly travels to the section rather than
      // teleporting — the same reason the editor side animates. Scrolls the
      // Stages scroller directly (not Element.scrollIntoView, which cannot be
      // given a duration and would also scroll outer ancestors).
      const pane = sectionEl.closest?.('.pipeline-inspect-scroll');
      if (pane) {
        const s = sectionEl.getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        animateScrollTop(pane, nearestScrollTop(s.top, s.bottom, p.top, p.bottom, pane.scrollTop));
      }
    }
    // Auto-scroll the editor to the stage — only on HOVER, and only when the
    // option is on. Never for the caret: the caret is on screen by definition,
    // so scrolling to it would yank the view out from under the user's own
    // cursor. With the option off the connector still draws whenever the stage
    // is already visible (stageScreenRect returns null when off-screen, so the
    // line simply hides).
    if (hv && stagesAutoscroll.value) editorRef.current?.revealStage?.(hv.entryIndex);
    editorRef.current?.highlightStage?.(src.entryIndex);

    let raf = 0;
    const recompute = () => {
      raf = 0;
      const cur = hoveredStage.value || editorHoverStage.value || caretStage.value;
      const el = sectionFor(cur);
      if (!cur || !el) { setPts(null); return; }
      const sectionRect = el.getBoundingClientRect?.();
      // Don't draw toward a section scrolled out of the pane — the line would
      // run off over the toolbar. With the reveal above this is transient; with
      // Auto-scroll off, or for the caret, the band alone carries the link.
      const pane = el.closest?.('.pipeline-inspect-scroll');
      if (pane && !sectionInPane(sectionRect, pane.getBoundingClientRect())) { setPts(null); return; }
      const editorRect = editorRef.current?.stageScreenRect?.(cur.entryIndex);
      const panelRect = panelRef.current?.getBoundingClientRect?.();
      setPts(computeStageLink(editorRect, sectionRect, panelRect));
    };
    const schedule = () => {
      if (raf) return;
      raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(recompute)
        : (recompute(), 0);
    };

    // The section's own :hover marks the target when the pointer is over it; it
    // cannot fire when the pointer is in the EDITOR, so mark it here instead.
    // An attribute, not a class: Preact rewrites className wholesale when
    // sectionCls() changes for the inspectTarget flash.
    if (!hv) sectionEl.setAttribute('data-linked', '');

    recompute();
    // Capture so scrolls on inner scrollers (CodeMirror, the stages pane) are caught.
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      // Clear the band here rather than in the `!hv` branch above: this cleanup
      // runs before the next effect body AND on unmount, so it covers un-hover,
      // hovering a different stage, and the panel going away.
      editorRef.current?.highlightStage?.(null);
      sectionEl.removeAttribute('data-linked');
    };
  }, [hv, eh, cs]);

  if (!pts) return null;
  return (
    <svg class="stage-link-overlay" aria-hidden="true">
      <path class="stage-link-line" d={pts.d} />
      <circle class="stage-link-dot" cx={pts.x1} cy={pts.y1} r="3" />
      <circle class="stage-link-dot" cx={pts.x2} cy={pts.y2} r="3" />
    </svg>
  );
}
