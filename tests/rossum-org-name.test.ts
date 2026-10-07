import { describe, it, expect } from 'vitest';
import { rect } from './support/dom.js';
import { currentOrgName, pillSlot } from '../src/rossum/orgName.js';

describe('currentOrgName', () => {
  it('names the one organization the session can see', () => {
    expect(currentOrgName({ results: [{ id: 7, name: 'Acme HQ - TEST' }] })).toBe('Acme HQ - TEST');
  });

  it('trims the name', () => {
    expect(currentOrgName({ results: [{ id: 7, name: '  Acme HQ ' }] })).toBe('Acme HQ');
  });

  it('names nothing when the session sees several organizations', () => {
    // Which one is current cannot be told from the list, and a wrong name is worse than none.
    const list = {
      results: [
        { id: 3, name: 'Acme Home' },
        { id: 7, name: 'Acme HQ' },
      ],
    };
    expect(currentOrgName(list)).toBeNull();
  });

  it('names nothing for an empty or malformed list', () => {
    expect(currentOrgName({ results: [] })).toBeNull();
    expect(currentOrgName({ results: [{ id: 7 }] })).toBeNull();
    expect(currentOrgName({ results: [{ id: 7, name: '   ' }] })).toBeNull();
    expect(currentOrgName({})).toBeNull();
    expect(currentOrgName(null)).toBeNull();
  });
});

// Rects are [left, top, width, height] measured on a live Rossum page, 2026-09-23.
const box = ([left, top, width, height]: number[]) =>
  rect({ left, top, right: left + width, bottom: top + height });

describe('pillSlot', () => {
  it('fits the gap between the last nav tab and the right-hand buttons (documents list)', () => {
    const slot = pillSlot({
      header: box([0, 0, 1705, 48]),
      clusterLeft: 1517, // chat-open-button
      obstacles: [
        box([295, 0, 104, 48]),
        box([399, 0, 105, 48]),
        box([503, 0, 101, 48]),
        box([605, 0, 90, 48]),
        box([695, 0, 90, 48]), // settings-navtab, right edge 785
      ],
    });
    // right = 1705 - 1517 + 12; maxWidth = (1517 - 12) - (785 + 12)
    expect(slot).toEqual({ right: 200, maxWidth: 708 });
  });

  it('fits the gap after the paging controls (document review screen)', () => {
    const slot = pillSlot({
      header: box([0, 0, 1516, 48]),
      clusterLeft: 1336,
      obstacles: [
        box([8, 5, 36, 36]), // exit-route-button
        box([44, 11, 178, 24]), // file-name
        box([634, 15, 6, 17]), // number-of-pages
        box([749, 5, 36, 36]), // a paging button, right edge 785
      ],
    });
    // right = 1516 - 1336 + 12; maxWidth = (1336 - 12) - (785 + 12)
    expect(slot).toEqual({ right: 192, maxWidth: 527 });
  });

  it('uses the header edge when nothing sits left of the buttons', () => {
    const slot = pillSlot({ header: box([0, 0, 1000, 48]), clusterLeft: 900, obstacles: [] });
    // maxWidth = (900 - 12) - (0 + 12)
    expect(slot).toEqual({ right: 112, maxWidth: 876 });
  });

  it('ignores anything that reaches into or past the right-hand buttons', () => {
    const slot = pillSlot({
      header: box([0, 0, 1000, 48]),
      clusterLeft: 900,
      obstacles: [
        box([100, 0, 100, 48]), // right edge 200
        box([850, 0, 100, 48]), // straddles the buttons: a wrapper, not a neighbour
        box([920, 0, 20, 20]), // one of the buttons themselves
      ],
    });
    expect(slot).toEqual({ right: 112, maxWidth: 676 });
  });

  it('ignores zero-size elements', () => {
    const slot = pillSlot({
      header: box([0, 0, 1000, 48]),
      clusterLeft: 900,
      obstacles: [box([700, 0, 0, 0])],
    });
    expect(slot).toEqual({ right: 112, maxWidth: 876 });
  });

  it('skips past branding that sits right beside the buttons', () => {
    // A white-labelled header: "Powered by Rossum" ends 16px short of the chat button,
    // and the real free space is between it and the last nav tab.
    const slot = pillSlot({
      header: box([0, 0, 1516, 48]),
      clusterLeft: 1328,
      obstacles: [
        box([295, 0, 104, 48]),
        box([695, 0, 90, 48]), // settings-navtab, right edge 785
        box([1154, 13, 22, 22]), // the branding logo
        box([1184, 14, 127, 19]), // "Powered by Rossum"
        box([1261, 15, 51, 16]), // "Rossum", inside it, right edge 1312
      ],
    });
    // right = 1516 - 1154 + 12; maxWidth = (1154 - 12) - (785 + 12)
    expect(slot).toEqual({ right: 374, maxWidth: 345 });
  });

  it('moves to the next gap left when the one beside the buttons is too narrow', () => {
    const slot = pillSlot({
      header: box([0, 0, 1000, 48]),
      clusterLeft: 900,
      obstacles: [box([700, 0, 130, 48])], // leaves (900 - 12) - (830 + 12) = 46px beside the buttons
    });
    // right = 1000 - 700 + 12; maxWidth = (700 - 12) - (0 + 12)
    expect(slot).toEqual({ right: 312, maxWidth: 676 });
  });

  it('treats overlapping elements as one block', () => {
    const slot = pillSlot({
      header: box([0, 0, 1000, 48]),
      clusterLeft: 900,
      obstacles: [
        box([200, 0, 300, 48]), // 200–500
        box([450, 0, 150, 48]), // 450–600, overlaps the first
        box([300, 0, 50, 48]), // nested inside the first
      ],
    });
    // The free gap is 600–900: right = 1000 - 900 + 12; maxWidth = (900 - 12) - (600 + 12)
    expect(slot).toEqual({ right: 112, maxWidth: 276 });
  });

  it('never moves into the left half of the header, where the logo and tabs live', () => {
    const slot = pillSlot({
      header: box([0, 0, 1400, 48]),
      clusterLeft: 865,
      obstacles: [
        box([16, 10, 96, 28]), // logo
        box([259, 12, 113, 24]), // a chip
        box([404, 0, 460, 48]), // the nav tabs, right up to the buttons
      ],
    });
    // The only readable gap, 112–259, lies left of the header's middle (700).
    expect(slot).toBeNull();
  });

  it('may still use a gap that ends right of the middle', () => {
    const slot = pillSlot({
      header: box([0, 0, 1000, 48]),
      clusterLeft: 900,
      obstacles: [box([300, 0, 250, 48]), box([820, 0, 60, 48])],
    });
    // Gaps: 0–300 (left half, skipped), 550–820 (ends right of 500, used), 880–900 (too narrow).
    // right = 1000 - 820 + 12; maxWidth = (820 - 12) - (550 + 12)
    expect(slot).toEqual({ right: 192, maxWidth: 246 });
  });

  it('moves left to a gap that holds the whole name rather than truncate it', () => {
    const slot = pillSlot({
      header: box([0, 0, 1000, 48]),
      clusterLeft: 900,
      obstacles: [box([0, 0, 300, 48]), box([620, 0, 160, 48])],
      nameWidth: 200,
    });
    // By the buttons, 780–900 leaves 96px: readable, but the name would be cut. The gap
    // 300–620 ends right of the middle and holds all 200px of it.
    // right = 1000 - 620 + 12; maxWidth = (620 - 12) - (300 + 12)
    expect(slot).toEqual({ right: 392, maxWidth: 296 });
  });

  it('truncates by the buttons when no gap holds the whole name', () => {
    const slot = pillSlot({
      header: box([0, 0, 1000, 48]),
      clusterLeft: 900,
      obstacles: [box([0, 0, 300, 48]), box([620, 0, 160, 48])],
      nameWidth: 400,
    });
    // Neither 96px nor 296px holds it, so it is cut in the gap nearest the buttons.
    expect(slot).toEqual({ right: 112, maxWidth: 96 });
  });

  it('never moves into a gap in the left half to fit the whole name', () => {
    const slot = pillSlot({
      header: box([0, 0, 1000, 48]),
      clusterLeft: 900,
      obstacles: [box([450, 0, 330, 48])],
      nameWidth: 200,
    });
    // 0–450 would hold it but lies left of the middle (500); 780–900 cuts it to 96px.
    expect(slot).toEqual({ right: 112, maxWidth: 96 });
  });

  it('keeps a name that fits by the buttons by the buttons', () => {
    const slot = pillSlot({
      header: box([0, 0, 1000, 48]),
      clusterLeft: 900,
      obstacles: [box([0, 0, 300, 48]), box([620, 0, 160, 48])],
      nameWidth: 90,
    });
    expect(slot).toEqual({ right: 112, maxWidth: 96 });
  });

  it('gives up when no gap is wide enough to read a name', () => {
    const slot = pillSlot({
      header: box([0, 0, 1000, 48]),
      clusterLeft: 900,
      obstacles: [
        box([0, 0, 400, 48]),
        box([450, 0, 380, 48]), // gaps left: 400–450 and 830–900, both under 60px once padded
      ],
    });
    expect(slot).toBeNull();
  });
});
