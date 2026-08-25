// tests/academy-hero-bleed.test.js
// @vitest-environment jsdom
//
// Regression test for a measured layout bug: the atmospheric hero background
// (`.heroBg`) used to be inset from the app area by `.entry`'s own padding
// (24px top/bottom, 20px sides), because `.heroBg` — an absolutely-positioned
// `inset: 0` child of `.hero` — sat one level BELOW that padding (`.entry` >
// `.hero` > `.heroBg`), so it never reached the true edges.
//
// jsdom does not run layout, so there is no computed geometry to assert on
// here (that was measured by hand in the running extension — see the report
// for this change). What IS structurally checkable, and is the actual fix:
//   1. `.entry` (the shared wrapper for both the not-connected and
//      no-progress branches) carries no padding at all any more.
//   2. `.hero` carries the padding instead — an absolutely-positioned
//      `inset: 0` child resolves against the PADDING box of its containing
//      block, so moving the padding one level down (onto `.hero`) makes
//      `.heroBg` reach `.hero`'s true outer edge while `.heroInner` (an
//      in-flow, non-absolute child) still gets pushed in by that padding
//      exactly as before.
//   3. The two children that used to get their horizontal inset for free
//      from `.entry`'s padding — the error strip and `.trainerWrap` — now
//      carry their own, so they don't end up flush against the window edge.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { h, render } from 'preact';
import AcademyApp from '../src/academy/components/App.jsx';
import * as store from '../src/academy/store.js';
import { TRACK } from '../src/training/track.js';
import { emptyProgress } from '../src/training/progress.js';
import academyCss from '../src/academy/Academy.module.css';

const CSS_SRC = readFileSync('src/academy/Academy.module.css', 'utf8');

// Same pattern as tests/mdh-stage-link-highlight.test.js's `blockFor`: pull a
// single selector's declaration block out of the raw stylesheet text (with
// comments stripped) so the test expresses the actual shipped CSS, not a
// hand-copied duplicate of it.
function blockFor(selector: any) {
  const body = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(body);
  return m ? m[2] : null;
}

async function waitFor(cond: any, timeout = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Academy.module.css — hero background bleeds to the app edges', () => {
  it('.entry carries no padding (the wrapper no longer insets its children)', () => {
    const block = blockFor('.entry');
    expect(block).not.toBeNull();
    expect(block).not.toMatch(/padding/);
  });

  it('.hero carries the padding instead, so its padding-box-relative .heroBg fills the app area', () => {
    const block = blockFor('.hero');
    expect(block).not.toBeNull();
    expect(block).toMatch(/padding:\s*24px 20px/);
    // Still the positioning context .heroBg's `inset: 0` resolves against.
    expect(block).toMatch(/position:\s*relative/);
  });

  it('.heroBg is still a full-bleed absolutely-positioned overlay', () => {
    const block = blockFor('.heroBg');
    expect(block).not.toBeNull();
    expect(block).toMatch(/position:\s*absolute/);
    expect(block).toMatch(/inset:\s*0/);
  });

  it('.trainerWrap carries its own horizontal padding (border-box, so it cannot overflow a narrow window)', () => {
    const block = blockFor('.trainerWrap');
    expect(block).not.toBeNull();
    expect(block).toMatch(/padding:\s*0 20px/);
    expect(block).toMatch(/box-sizing:\s*border-box/);
  });

  it("reproduces .entry's old inset (.entryError) for children that used to borrow it", () => {
    const block = blockFor('.entryError');
    expect(block).not.toBeNull();
    expect(block).toMatch(/margin-top:\s*24px/);
    expect(block).toMatch(/margin-left:\s*20px/);
    expect(block).toMatch(/margin-right:\s*20px/);
  });
});

describe('AcademyApp — error strip inset applied only where .entry no longer provides one', () => {
  beforeEach(() => {
    render(null, document.body);
    document.body.innerHTML = '';
    store.error.value = null;
    store.progress.value = null;
    store.activeMissionId.value = null;
  });

  it('applies the .entryError inset on the not-connected branch (a direct .entry child)', async () => {
    store.error.value = "Open the Rossum Console from this extension's popup on a Rossum tab to access the Academy.";
    render(<AcademyApp connected={false} />, document.body);
    await waitFor(() => document.querySelector('[role="alert"]'));
    const strip = document.querySelector('[role="alert"]');
    expect(strip!.classList.contains(academyCss.entryError)).toBe(true);
  });

  it('applies the .entryError inset on the no-progress hero branch (a direct .entry child)', async () => {
    store.error.value = 'Something went wrong';
    render(<AcademyApp connected />, document.body);
    await waitFor(() => document.querySelector('[role="alert"]'));
    const strip = document.querySelector('[role="alert"]');
    expect(strip!.classList.contains(academyCss.entryError)).toBe(true);
  });

  it("does NOT apply the inset on the with-progress branch, which still uses .main's own padding", async () => {
    store.progress.value = emptyProgress(TRACK, 1);
    store.error.value = 'boom';
    render(<AcademyApp connected />, document.body);
    await waitFor(() => document.querySelector('[role="alert"]'));
    const strip = document.querySelector('[role="alert"]');
    expect(strip!.classList.contains(academyCss.entryError)).toBe(false);
  });
});
