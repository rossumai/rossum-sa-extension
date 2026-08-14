import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { hoveredStage, editorHoverStage, caretStage, stagesAutoscroll } from '../store.js';
import { computeStageLink, edgeArrowPath } from '../stageLink.js';

// SVG connector drawn over the data panel: from the hovered Stages-view section to
// that stage's code line in the pipeline editor. Reads the `hoveredStage` signal so
// only this small overlay re-renders on hover (not the whole DataPanel). The editor
// stage is revealed once on hover (auto-scroll) — and only when it is off screen,
// see below; the line then re-measures on any scroll/resize so it stays attached.
//
// The link is driven from BOTH ends: hovering a section, hovering a stage in the
// editor (`editorHoverStage`), and the pipeline-editor CARET sitting in one
// (`caretStage`). Any of them draws the same connector and TINTS the same stage
// in the editor (`.cm-linked-stage`), so both ends of the dashed line are marked
// — but only the section hover ever SCROLLS anything (see below). That band is
// deliberately NOT gated on the
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
    // The link is symmetric; the SCROLLING is deliberately not. Pointing at a
    // stage in the editor — by hovering it or by leaving the caret in it — marks
    // its section here (band, connector, [data-linked]) but never scrolls the
    // pane to it. It used to, mirroring the hover-reveal below and sharing the
    // same Auto-scroll gate; reversed by the owner 2026-08-14 because reading or
    // typing in the editor is not a request to send the other half of the screen
    // travelling, and the movement in the corner of the eye was distracting. The
    // pane now moves only when the user acts on the pane's own side (hovering a
    // section) or asks for a stage explicitly (a debug-panel row click).
    //
    // Auto-scroll the editor to the stage — only on section HOVER, only when the
    // option is on, and only when the stage's opening line is OFF SCREEN, in which
    // case it lands at the top of the editor box (revealStage decides; it used to
    // centre the stage on every hover, moving an editor the user could already
    // read). Never for the caret: the caret is on screen by definition, so
    // scrolling to it would yank the view out from under the user's own cursor.
    // With the option off nothing scrolls and the connector simply stays attached
    // to wherever the stage currently sits — clamped to the editor's clip box when
    // that is out of view, since CodeMirror keeps reporting coordinates for a
    // scrolled-out line (measured; see the stage-link spec's revision note).
    if (hv && stagesAutoscroll.value) editorRef.current?.revealStage?.(hv.entryIndex);
    editorRef.current?.highlightStage?.(src.entryIndex);

    let raf = 0;
    const recompute = () => {
      raf = 0;
      const cur = hoveredStage.value || editorHoverStage.value || caretStage.value;
      const el = sectionFor(cur);
      if (!cur || !el) { setPts(null); return; }
      const sectionRect = el.getBoundingClientRect?.();
      // The pane rect keeps the far endpoint INSIDE the Stages scroller: a
      // section scrolled out of it would otherwise put the line over the options
      // toolbar or past the pane's bottom. It used to be suppressed entirely
      // there, which was a brief flicker while the pane still auto-scrolled the
      // section into view — but the editor stopped doing that, so the link would
      // simply be missing. Now it ends at the pane's edge under an arrow saying
      // which way the stage lies (owner request 2026-08-14).
      const pane = el.closest?.('.pipeline-inspect-scroll');
      const editorRect = editorRef.current?.stageScreenRect?.(cur.entryIndex);
      const panelRect = panelRef.current?.getBoundingClientRect?.();
      // Same treatment for the editor end, and for the same reason: CodeMirror
      // reports coordinates for a stage scrolled out of its box, so without the
      // clip rect the line started outside the editor and crossed the pipeline
      // header's buttons.
      setPts(computeStageLink(
        editorRect,
        sectionRect,
        panelRect,
        pane?.getBoundingClientRect?.(),
        editorRef.current?.clipRect?.(),
      ));
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
  // The far end is a DOT when it lands on the section itself and an ARROW when
  // the section is off screen and the line had to stop at the pane's edge — a
  // dot there would claim the stage is at the boundary, which is the one thing
  // it isn't.
  const arrow = edgeArrowPath(pts.x2, pts.y2, pts.edge);
  const startArrow = edgeArrowPath(pts.x1, pts.y1, pts.startEdge);
  return (
    <svg class="stage-link-overlay" aria-hidden="true">
      <path class="stage-link-line" d={pts.d} />
      {startArrow
        ? <path class="stage-link-arrow" d={startArrow} />
        : <circle class="stage-link-dot" cx={pts.x1} cy={pts.y1} r="3" />}
      {arrow
        ? <path class="stage-link-arrow" d={arrow} />
        : <circle class="stage-link-dot" cx={pts.x2} cy={pts.y2} r="3" />}
    </svg>
  );
}
