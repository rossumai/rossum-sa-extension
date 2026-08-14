import { describe, it, expect } from 'vitest';
import { computeStageLink, operatorColonOffset, edgeArrowPath, sectionInPane } from '../src/mdh/stageLink.js';

const rect = (top, left, bottom, right) => ({ top, left, bottom, right });

describe('computeStageLink', () => {
  it('returns null when the editor line rect is missing (stage off-screen)', () => {
    expect(computeStageLink(null, rect(0, 0, 10, 10), rect(0, 0, 100, 100))).toBeNull();
  });

  it('returns null when the section or panel rect is missing', () => {
    expect(computeStageLink(rect(0, 0, 10, 10), null, rect(0, 0, 100, 100))).toBeNull();
    expect(computeStageLink(rect(0, 0, 10, 10), rect(0, 0, 10, 10), null)).toBeNull();
  });

  it('maps both endpoints into panel-relative coords', () => {
    // Panel origin at (50, 20). Editor "{" at viewport left x 100, y 120..140.
    const panel = rect(20, 50, 800, 700);
    const editorLine = rect(120, 100, 140, 300); // top, left, bottom, right
    // Section starts at viewport x 420, top 200.
    const section = rect(200, 420, 560, 690);
    const pts = computeStageLink(editorLine, section, panel);
    // x1 starts a bit to the right of the "{" (small start gap).
    expect(pts.x1).toBeGreaterThan(100 - 50);
    expect(pts.x1).toBeLessThan(100 - 50 + 16);
    expect(pts.y1).toBe((120 + 140) / 2 - 20); // "{" line vertical middle
    expect(pts.x2).toBe(420 - 50);             // section left edge
    expect(pts.y2).toBe((200 + 16) - 20);      // near section header
  });

  it('builds a beveled connector: first horizontal runs past the operator, then a diagonal', () => {
    const panel = rect(0, 0, 1000, 1000);
    // After-"{" at x≈60, y≈108; operator ends (hEnd) at x≈140.
    const editorLine = { top: 100, left: 60, bottom: 116, right: 64, hEnd: 140 };
    const section = rect(300, 600, 460, 980); // stage right x≈600, y≈316
    const pts = computeStageLink(editorLine, section, panel);

    expect(pts.x1).toBeGreaterThan(60);  // starts a bit to the right of the "{"
    expect(pts.x1).toBeLessThan(60 + 16);
    expect(pts.y1).toBe(108);
    expect(typeof pts.d).toBe('string');
    expect(pts.d.startsWith('M ')).toBe(true);
    expect(pts.d).toContain('L'); // straight segments
    expect(pts.d).toContain('Q'); // small rounded bends at the corners

    const nums = pts.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    // The path starts exactly at (x1, y1) and ends exactly at the stage.
    expect(nums[0]).toBeCloseTo(pts.x1, 1);
    expect(nums[1]).toBeCloseTo(108, 1);
    expect(nums[nums.length - 2]).toBeCloseTo(600, 1);
    expect(nums[nums.length - 1]).toBeCloseTo(316, 1);
    // First horizontal stays at y1 and reaches near hEnd=140 (past the operator).
    expect(nums[3]).toBeCloseTo(108, 0);
    expect(nums[2]).toBeGreaterThan(130);
  });

  it('operatorColonOffset finds the operator colon even when it is on the line below the {', () => {
    // Pretty-printed (multi-line) stage — the format the editor actually uses.
    const text = '[\n  {\n    "$match": { "active": true }\n  }\n]';
    const brace = text.indexOf('{');
    const c = operatorColonOffset(text, brace, text.length);
    expect(text[c]).toBe(':');
    expect(c).toBe(text.indexOf(':')); // the ':' after "$match"
    expect(c).toBeGreaterThan(brace);  // after the '{', on a later line
  });

  it('operatorColonOffset finds the operator colon on an inline stage', () => {
    const text = '[ { "$limit": 50 } ]';
    const brace = text.indexOf('{');
    expect(operatorColonOffset(text, brace, text.length)).toBe(text.indexOf(':'));
  });

  it('operatorColonOffset returns -1 when no colon precedes the stage end', () => {
    expect(operatorColonOffset('no colon', 0, 8)).toBe(-1);
    expect(operatorColonOffset('a : b', 0, 1)).toBe(-1); // colon at 2 is past the bound
  });

  // The pane rect is optional; without it nothing clamps (every existing caller
  // that passes three arguments keeps its exact geometry).
  it('leaves the endpoint alone when the section sits inside the pane', () => {
    const panel = rect(0, 0, 1000, 1000);
    const editorLine = { top: 100, left: 60, bottom: 116, right: 64, hEnd: 140 };
    const section = rect(300, 600, 460, 980);
    const pane = rect(200, 560, 800, 1000);
    const pts = computeStageLink(editorLine, section, panel, pane);
    expect(pts.y2).toBe(316); // section top + 16, unclamped
    expect(pts.edge).toBeNull();
  });

  it('pins the endpoint to the pane top and reports edge:up for a section scrolled above', () => {
    const panel = rect(0, 0, 1000, 1000);
    const editorLine = { top: 400, left: 60, bottom: 416, right: 64, hEnd: 140 };
    const section = rect(-500, 600, -340, 980); // entirely above the pane
    const pane = rect(200, 560, 800, 1000);
    const pts = computeStageLink(editorLine, section, panel, pane);
    expect(pts.edge).toBe('up');
    expect(pts.y2).toBe(208); // pane top + 8 inset
    expect(pts.x2).toBe(600); // still the section's left edge
    const nums = pts.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    expect(nums[nums.length - 1]).toBeCloseTo(208, 1); // the path ends there too
  });

  it('pins the endpoint to the pane bottom and reports edge:down for a section below', () => {
    const panel = rect(0, 0, 1000, 1000);
    const editorLine = { top: 300, left: 60, bottom: 316, right: 64, hEnd: 140 };
    const section = rect(1400, 600, 1560, 980); // far below the pane
    const pane = rect(200, 560, 800, 1000);
    const pts = computeStageLink(editorLine, section, panel, pane);
    expect(pts.edge).toBe('down');
    expect(pts.y2).toBe(792); // pane bottom - 8 inset
  });

  // The case sectionInPane() lets through today: the section overlaps the pane,
  // so it counts as visible, but its ANCHOR (top + 16) is still above the pane —
  // the line used to be drawn over the toolbar.
  it('clamps a partially visible section whose header anchor is above the pane', () => {
    const panel = rect(0, 0, 1000, 1000);
    const editorLine = { top: 400, left: 60, bottom: 416, right: 64, hEnd: 140 };
    const section = rect(120, 600, 400, 980);
    const pane = rect(200, 560, 800, 1000);
    expect(sectionInPane(section, pane)).toBe(true); // genuinely on screen
    const pts = computeStageLink(editorLine, section, panel, pane);
    expect(pts.y2).toBe(208);
    expect(pts.edge).toBe('up');
  });

  it('never clamps into an inverted band when the pane is shorter than the insets', () => {
    const panel = rect(0, 0, 1000, 1000);
    const editorLine = { top: 100, left: 60, bottom: 116, right: 64, hEnd: 140 };
    const section = rect(900, 600, 1000, 980);
    const pane = rect(300, 560, 306, 1000); // 6px tall — thinner than 2 * inset
    const pts = computeStageLink(editorLine, section, panel, pane);
    expect(pts.y2).toBeGreaterThanOrEqual(300);
    expect(pts.y2).toBeLessThanOrEqual(306);
  });
});

// The clamped end is an ARROW, so the line has to arrive along the arrow's own
// axis: a vertical shaft into the head, not the horizontal stub that suits a dot
// entering a section from the left (owner, 2026-08-14: "the tether leaving the
// arrow is too abrupt and immediately going to the left").
describe('computeStageLink — the approach to a clamped endpoint', () => {
  const panel = rect(0, 0, 1000, 1000);
  const pane = rect(200, 560, 800, 1000);
  // Path points as [x, y] pairs, control points included — enough to inspect the
  // final leg without re-parsing SVG grammar.
  const points = (d) => {
    const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    return Array.from({ length: n.length / 2 }, (_, i) => [n[i * 2], n[i * 2 + 1]]);
  };

  it('ends with a vertical run into an up arrow, travelling upward', () => {
    const editorLine = { top: 600, left: 60, bottom: 616, right: 64, hEnd: 140 };
    const section = rect(-500, 600, -340, 980);
    const pts = computeStageLink(editorLine, section, panel, pane);
    expect(pts.edge).toBe('up');
    const p = points(pts.d);
    const [lastX, lastY] = p[p.length - 1];
    const [prevX, prevY] = p[p.length - 2];
    expect(lastX).toBeCloseTo(pts.x2, 1);
    expect(prevX).toBeCloseTo(pts.x2, 1); // the final leg is vertical
    expect(lastY).toBeLessThan(prevY);    // and it travels UP, the way the head points
    expect(lastY).toBeCloseTo(pts.y2, 1);
  });

  it('ends with a vertical run into a down arrow, travelling downward', () => {
    const editorLine = { top: 300, left: 60, bottom: 316, right: 64, hEnd: 140 };
    const section = rect(1400, 600, 1560, 980);
    const pts = computeStageLink(editorLine, section, panel, pane);
    expect(pts.edge).toBe('down');
    const p = points(pts.d);
    const [lastX, lastY] = p[p.length - 1];
    const [prevX, prevY] = p[p.length - 2];
    expect(lastX).toBeCloseTo(pts.x2, 1);
    expect(prevX).toBeCloseTo(pts.x2, 1);
    expect(lastY).toBeGreaterThan(prevY);
  });

  it('never doubles back: y is monotonic along the whole path', () => {
    // Editor stage BELOW the clamped endpoint, section scrolled above it.
    const editorLine = { top: 600, left: 60, bottom: 616, right: 64, hEnd: 140 };
    const section = rect(-500, 600, -340, 980);
    const ys = points(computeStageLink(editorLine, section, panel, pane).d).map(([, y]) => y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 0.05);
  });

  // The shaft is unconditional: an arrow without its vertical run is the "goes
  // immediately sideways" look this whole design exists to avoid (owner,
  // 2026-08-14). When the line arrives from the far side it dips past the head by
  // the shaft's length and turns back into it — bounded, and shallow in practice
  // because the two panes are hundreds of pixels apart horizontally.
  it('keeps the vertical shaft when the line arrives from the far side, overshooting by no more than the shaft', () => {
    const editorLine = { top: 100, left: 60, bottom: 116, right: 64, hEnd: 140 };
    const section = rect(-900, 600, -800, 980);
    const pts = computeStageLink(editorLine, section, panel, pane);
    expect(pts.edge).toBe('up');
    const p = points(pts.d);
    expect(p[p.length - 2][0]).toBeCloseTo(pts.x2, 1);              // still a vertical last leg
    expect(p[p.length - 1][1]).toBeLessThan(p[p.length - 2][1]);    // still travelling up into the head
    const ys = p.map(([, y]) => y);
    expect(Math.max(...ys) - pts.y2).toBeLessThanOrEqual(14.05);    // the dip is at most one shaft
  });

  // The path is always M · L · Q(ctrl,pt) · L · Q(ctrl,pt) · L — eight points, with
  // the two ELBOWS at the quadratic control points (indices 2 and 5). Every other
  // point is pulled back along its leg by the corner radius, so the elbows are what
  // to assert on.
  const ELBOW_START = 2, ELBOW_END = 5;

  // The case the owner reported: BOTH ends clamped upward. The pane's band starts
  // below the editor's (its options strip pushes it down), so the end leg's
  // approach comes from above — which the old guard read as "no room" and dropped
  // the shaft, leaving the line to turn left at the arrowhead.
  it('gives BOTH ends a vertical shaft when both arrows point the same way', () => {
    const clip = rect(100, 20, 700, 300);
    const editorLine = { top: -20, left: 60, bottom: -4, right: 64, hEnd: 140 };
    const section = rect(-500, 600, -340, 980);
    const pts = computeStageLink(editorLine, section, panel, pane, clip);
    expect([pts.startEdge, pts.edge]).toEqual(['up', 'up']);
    expect(pts.y1).toBe(108); // editor band top
    expect(pts.y2).toBe(208); // pane band top, 100px lower
    const p = points(pts.d);
    // Leaves the first head vertically, one shaft down...
    expect(p[ELBOW_START]).toEqual([pts.x1, 122]);
    // ...and enters the second one vertically from one shaft below it, rather than
    // turning left at the head.
    expect(p[ELBOW_END]).toEqual([pts.x2, 222]);
    expect(p[p.length - 1]).toEqual([pts.x2, 208]);
  });

  it('leaves the in-view (dot) geometry alone — it still enters horizontally', () => {
    const editorLine = { top: 100, left: 60, bottom: 116, right: 64, hEnd: 140 };
    const section = rect(300, 600, 460, 980);
    const pts = computeStageLink(editorLine, section, panel, pane);
    expect(pts.edge).toBeNull();
    const p = points(pts.d);
    expect(p[p.length - 1][1]).toBeCloseTo(p[p.length - 2][1], 1); // last leg horizontal
  });
});

// The editor end has the same failure the pane end had: CodeMirror keeps
// reporting coordinates for a stage scrolled out of the editor's box (MEASURED:
// box at y 10..330, scrolled 40px → the stage's `{` reports y -7; scrolled 320px
// → y -287), so the line started outside the editor and crossed the pipeline
// header's buttons. Owner, 2026-08-14.
describe('computeStageLink — clamping the editor end', () => {
  const panel = rect(0, 0, 1000, 1000);
  const pane = rect(200, 560, 800, 1000);
  const clip = rect(100, 20, 700, 300); // the editor's visible box
  const points = (d) => {
    const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    return Array.from({ length: n.length / 2 }, (_, i) => [n[i * 2], n[i * 2 + 1]]);
  };

  it('leaves the start alone while the stage is inside the editor box', () => {
    const editorLine = { top: 300, left: 60, bottom: 316, right: 64, hEnd: 140 };
    const section = rect(300, 600, 460, 980);
    const pts = computeStageLink(editorLine, section, panel, pane, clip);
    expect(pts.startEdge).toBeNull();
    expect(pts.y1).toBe(308);
  });

  it('pins the start into the box and points the arrow up for a stage scrolled above', () => {
    const editorLine = { top: -20, left: 60, bottom: -4, right: 64, hEnd: 140 }; // above the box
    const section = rect(300, 600, 460, 980);
    const pts = computeStageLink(editorLine, section, panel, pane, clip);
    expect(pts.startEdge).toBe('up');
    expect(pts.y1).toBe(108); // clip top + 8
    const p = points(pts.d);
    expect(p[0][1]).toBeCloseTo(108, 1);
    expect(p[1][0]).toBeCloseTo(pts.x1, 1); // the first leg is vertical, leaving the head
    expect(p[1][1]).toBeGreaterThan(p[0][1]); // ...travelling away from the arrow
  });

  it('pins the start to the box bottom for a stage scrolled below', () => {
    const editorLine = { top: 900, left: 60, bottom: 916, right: 64, hEnd: 140 };
    const section = rect(210, 600, 370, 980);
    const pts = computeStageLink(editorLine, section, panel, pane, clip);
    expect(pts.startEdge).toBe('down');
    expect(pts.y1).toBe(692); // clip bottom - 8
  });

  it('handles both ends clamped at once: shaft, diagonal, shaft', () => {
    const editorLine = { top: -200, left: 60, bottom: -184, right: 64, hEnd: 140 };
    const section = rect(1400, 600, 1560, 980);
    const pts = computeStageLink(editorLine, section, panel, pane, clip);
    expect(pts.startEdge).toBe('up');
    expect(pts.edge).toBe('down');
    const p = points(pts.d);
    expect(p[1][0]).toBeCloseTo(pts.x1, 1);                   // vertical leaving the start
    expect(p[p.length - 2][0]).toBeCloseTo(pts.x2, 1);        // vertical entering the end
    const ys = p.map(([, y]) => y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 0.05);
  });

  it('is inert without a clip rect, so callers that omit it keep today geometry', () => {
    const editorLine = { top: -20, left: 60, bottom: -4, right: 64, hEnd: 140 };
    const section = rect(300, 600, 460, 980);
    const pts = computeStageLink(editorLine, section, panel, pane);
    expect(pts.startEdge).toBeNull();
    expect(pts.y1).toBe(-12);
  });
});

describe('edgeArrowPath', () => {
  it('points up for edge:up and down for edge:down, centred on the endpoint', () => {
    const up = edgeArrowPath(100, 50, 'up').match(/-?\d+(?:\.\d+)?/g).map(Number);
    const down = edgeArrowPath(100, 50, 'down').match(/-?\d+(?:\.\d+)?/g).map(Number);
    // Apex first in both, above the base for up and below it for down.
    expect(up[0]).toBe(100);
    expect(up[1]).toBeLessThan(50);
    expect(down[1]).toBeGreaterThan(50);
    // Symmetric about x, and the two base corners share a y.
    expect(up[2] + up[4]).toBeCloseTo(200, 5);
    expect(up[3]).toBeCloseTo(up[5], 5);
  });

  it('returns null without a direction, so a normal endpoint keeps its dot', () => {
    expect(edgeArrowPath(10, 10, null)).toBeNull();
  });
});

describe('computeStageLink (path shape)', () => {
  it('clamps the first horizontal so it never eats the diagonal/end stub', () => {
    const panel = rect(0, 0, 1000, 1000);
    // hEnd absurdly far right (past the stage) — must be clamped.
    const editorLine = { top: 100, left: 60, bottom: 116, right: 64, hEnd: 5000 };
    const section = rect(300, 600, 460, 980);
    const pts = computeStageLink(editorLine, section, panel);
    const nums = pts.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    // The first horizontal's end (nums[2]) stays left of the stage x (600).
    expect(nums[2]).toBeLessThan(600);
  });
});
