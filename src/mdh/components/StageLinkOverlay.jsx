import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { hoveredStage } from '../store.js';
import { computeStageLink } from '../stageLink.js';

// SVG connector drawn over the data panel: from the hovered Stages-view section to
// that stage's code line in the pipeline editor. Reads the `hoveredStage` signal so
// only this small overlay re-renders on hover (not the whole DataPanel). The editor
// stage is revealed once on hover (auto-scroll); the line then re-measures on any
// scroll/resize so it stays attached.
export default function StageLinkOverlay({ editorRef, panelRef }) {
  const [pts, setPts] = useState(null);
  const hv = hoveredStage.value; // subscribe to hover changes

  useEffect(() => {
    if (!hv) { setPts(null); return; }
    editorRef.current?.revealStage?.(hv.entryIndex); // scroll the stage into view once

    let raf = 0;
    const recompute = () => {
      raf = 0;
      const cur = hoveredStage.value;
      if (!cur) { setPts(null); return; }
      const editorRect = editorRef.current?.stageScreenRect?.(cur.entryIndex);
      const sectionRect = cur.el?.getBoundingClientRect?.();
      const panelRect = panelRef.current?.getBoundingClientRect?.();
      setPts(computeStageLink(editorRect, sectionRect, panelRect));
    };
    const schedule = () => {
      if (raf) return;
      raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(recompute)
        : (recompute(), 0);
    };

    recompute();
    // Capture so scrolls on inner scrollers (CodeMirror, the stages pane) are caught.
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [hv]);

  if (!pts) return null;
  return (
    <svg class="stage-link-overlay" aria-hidden="true">
      <path class="stage-link-line" d={pts.d} />
      <circle class="stage-link-dot" cx={pts.x1} cy={pts.y1} r="3" />
      <circle class="stage-link-dot" cx={pts.x2} cy={pts.y2} r="3" />
    </svg>
  );
}
