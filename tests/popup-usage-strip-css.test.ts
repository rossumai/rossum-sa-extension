import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// jsdom has no layout, so the component tests cannot see a missing layout rule.
// This one was deleted by accident on 2026-08-19 while removing a neighbouring
// block, and all 3388 tests stayed green while the strip's link sat flush
// against "No thanks" instead of at the far right. Reading the stylesheet as
// text is crude, but it is the only thing in this suite that can catch it.
const css = readFileSync(join(process.cwd(), 'src/popup/popup.css'), 'utf8');

function block(selector: any) {
  const i = css.indexOf(`\n${selector} {`);
  if (i === -1) throw new Error(`missing CSS block: ${selector}`);
  return css.slice(i, css.indexOf('\n}', i));
}

describe('usage strip layout rules survive edits', () => {
  it('the action row is a flex row', () => {
    const b = block('.usage-strip-actions');
    expect(b).toMatch(/display:\s*flex/);
    expect(b).toMatch(/align-items:\s*center/);
    expect(b).toMatch(/gap:/);
  });

  it('the disclosure link is pushed to the right edge', () => {
    // Inert unless the row above is a flex container, which is why both are
    // asserted together rather than in isolation.
    expect(block('.usage-strip-link')).toMatch(/margin-left:\s*auto/);
  });

  it('the strip itself is still a card-like block in flow, not an overlay', () => {
    const b = block('.usage-strip');
    expect(b).not.toMatch(/position:\s*(fixed|absolute)/);
    expect(b).toMatch(/border-left:/);
  });
});
