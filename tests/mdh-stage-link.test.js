import { describe, it, expect } from 'vitest';
import { computeStageLink, operatorColonOffset } from '../src/mdh/stageLink.js';

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
