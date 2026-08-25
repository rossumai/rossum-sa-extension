// tests/ui-connector-path.test.js
import { describe, it, expect } from 'vitest';
import { bevelPath, arrowHeadPath } from '../src/ui/connectorPath.js';
import { edgeArrowPath } from '../src/mdh/stageLink.js';

describe('arrowHeadPath', () => {
  // The vertical cases are the ones MDH already ships. They are pinned to their
  // literal output — vertex order included — because this module was extracted
  // from stageLink.js on the promise that it could not move a Stages-view pixel.
  it('emits the exact triangle the MDH connector has always drawn', () => {
    expect(arrowHeadPath(100, 200, 'up')).toBe('M 100.0 194.0 L 105.0 201.0 L 95.0 201.0 Z');
    expect(arrowHeadPath(100, 200, 'down')).toBe('M 100.0 206.0 L 105.0 199.0 L 95.0 199.0 Z');
  });

  it('stays identical when reached through stageLink.edgeArrowPath', () => {
    for (const dir of ['up', 'down']) {
      expect(edgeArrowPath(100, 200, dir)).toBe(arrowHeadPath(100, 200, dir));
    }
  });

  it('transposes the same formula for the horizontal heads the tether uses', () => {
    expect(arrowHeadPath(100, 200, 'left')).toBe('M 94.0 200.0 L 101.0 205.0 L 101.0 195.0 Z');
    expect(arrowHeadPath(100, 200, 'right')).toBe('M 106.0 200.0 L 99.0 205.0 L 99.0 195.0 Z');
  });

  it('returns null for a direction it does not know', () => {
    expect(arrowHeadPath(1, 2, null)).toBe(null);
    expect(arrowHeadPath(1, 2, 'sideways')).toBe(null);
  });

  // edgeArrowPath must keep rejecting non-vertical input even though the shape
  // it delegates to now understands left/right: null is that caller's signal for
  // "unclamped endpoint — draw the dot instead", not a drawing failure.
  it('does not let horizontal directions leak through the MDH wrapper', () => {
    expect(edgeArrowPath(100, 200, 'left')).toBe(null);
    expect(edgeArrowPath(100, 200, 'right')).toBe(null);
  });
});

describe('bevelPath', () => {
  it('emits legs joined by rounded bends, never a cubic', () => {
    const d = bevelPath({ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 160, y: 90 }, { x: 200, y: 90 });
    expect(d.startsWith('M 0.0 0.0')).toBe(true);
    expect(d.endsWith('L 200.0 90.0')).toBe(true);
    expect((d.match(/ Q /g) || []).length).toBe(2); // one round per bend
    expect(d).not.toContain(' C ');
  });

  it('degrades to a straight run when the legs collapse', () => {
    const d = bevelPath({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 });
    expect(d).toContain('M 0.0 0.0');
    expect(d.endsWith('L 100.0 0.0')).toBe(true);
    expect(d).not.toContain('NaN');
  });
});
