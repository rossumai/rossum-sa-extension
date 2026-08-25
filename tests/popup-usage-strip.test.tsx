// @vitest-environment jsdom
//
// One consent surface, two modes. This replaced a blocking modal overlay
// (`UsageCard` / `.usage-overlay`) which was both the first ask and the reopened
// review; the modal, its scrim and `overlayMode` are gone. The strip blocks
// nothing, which is what forces it to persist until ANSWERED rather than be
// spent on a single showing.
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import UsageStrip, { UsageFooterButton, stripVisible } from '../src/popup/components/UsageStrip.jsx';

let root: any;
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root');
});

const noop = () => {};
const show: any = (props = {}) => render(
  <UsageStrip consent={null} reviewing={false} onAnswer={noop} {...props} />, root,
);

describe('UsageStrip — the first ask', () => {
  it('blocks nothing: no overlay, no scrim, no dialog semantics', () => {
    show();
    expect(root.querySelector('.usage-strip')).not.toBeNull();
    expect(root.querySelector('.usage-overlay')).toBeNull();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector('[aria-modal]')).toBeNull();
  });

  it('states the reason in one sentence, and what it never includes', () => {
    show();
    const text: any = root.textContent;
    expect(text).toContain('Help decide what gets built');
    expect(text).toMatch(/Sharing usage data shows which features people actually use/);
    expect(text).toMatch(/effort goes where it helps/);
    expect(text).toMatch(/never your documents or customer data/);
  });

  it('has no dismiss control at all — both buttons are real answers', () => {
    show();
    expect(root.querySelector('.usage-strip-close')).toBeNull();
    expect(root.querySelector('[aria-label="Close"]')).toBeNull();
  });

  it('offers both answers and reports them', () => {
    const answers: any = [];
    show({ onAnswer: (v: any) => answers.push(v) });
    expect(root.querySelector('[data-testid="usage-strip-accept"]').textContent.trim())
      .toBe('Share usage data');
    expect(root.querySelector('[data-testid="usage-strip-decline"]').textContent.trim())
      .toBe('No thanks');

    root.querySelector('[data-testid="usage-strip-accept"]').click();
    show({ onAnswer: (v: any) => answers.push(v) });
    root.querySelector('[data-testid="usage-strip-decline"]').click();
    expect(answers).toEqual([true, false]);
  });

  it('never says "plugin" — the product is an extension everywhere else', () => {
    show();
    expect(root.textContent).not.toMatch(/plugin/i);
  });

  it('renders nothing once answered, either way', () => {
    for (const consent of [true, false]) {
      show({ consent });
      expect(root.textContent).toBe('');
    }
  });

  it('renders nothing while storage is unresolved, so it cannot flash', () => {
    show({ consent: undefined });
    expect(root.querySelector('.usage-strip')).toBeNull();
  });
});

describe('the disclosure is a link, not an in-popup block', () => {
  it('links out to the full event list, unnumbered so it cannot go stale', () => {
    show();
    const link: any = root.querySelector('.usage-strip-link');
    expect(link.textContent.trim()).toBe("What's sent ›");
    expect(link.textContent).not.toMatch(/\d/);
    expect(link.getAttribute('href')).toMatch(/PRIVACY\.md$/);
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('carries no ledger of its own — PRIVACY.md is the only place it lives', () => {
    show();
    expect(root.querySelector('details')).toBeNull();
    expect(root.textContent).not.toContain("What's NEVER sent");
    expect(root.textContent).not.toContain('extension version');
  });

  it('stays three short elements, so it costs almost no vertical space', () => {
    show();
    const strip: any = root.querySelector('.usage-strip');
    expect([...strip.children].map((el) => el.tagName)).toEqual(['P', 'DIV']);
    expect(strip.querySelectorAll('button')).toHaveLength(2);
  });
});

describe('UsageStrip — reopened for review', () => {
  it('reopens for an answered user only when review is requested', () => {
    for (const consent of [true, false]) {
      show({ consent, reviewing: false });
      expect(root.querySelector('.usage-strip')).toBeNull();

      show({ consent, reviewing: true });
      expect(root.querySelector('.usage-strip')).not.toBeNull();
      expect(root.textContent).toContain('Help decide what gets built');
    }
  });

  it('does not restate the current setting — the footer button already shows it', () => {
    // The user reached this by clicking a control labelled "Usage data on"/"off"
    // with a state dot, so repeating it here only costs vertical space in a
    // popup Chrome caps at 600px.
    show({ consent: true, reviewing: true });
    expect(root.querySelector('[data-testid="usage-current-state"]')).toBeNull();
    expect(root.textContent).not.toMatch(/Currently/);
  });

  it('has no close button either — the footer control that opened it closes it', () => {
    show({ consent: true, reviewing: true });
    expect(root.querySelector('.usage-strip-close')).toBeNull();
    expect(root.querySelector('[aria-label="Close"]')).toBeNull();
  });

  it('renders markup IDENTICAL to the ask, so there is only one thing to style', () => {
    // Nothing about the surface depends on `reviewing` any more: it decides
    // whether the strip is on screen and nothing else. Any future per-mode
    // difference has to be added deliberately, and this fails when it is.
    show({ consent: null, reviewing: false });
    const askHtml: any = root.querySelector('.usage-strip').outerHTML;
    show({ consent: true, reviewing: true });
    expect(root.querySelector('.usage-strip').outerHTML).toBe(askHtml);
  });

  it('can turn usage data off from the reopened strip', () => {
    const answers: any = [];
    show({ consent: true, reviewing: true, onAnswer: (v: any) => answers.push(v) });
    root.querySelector('[data-testid="usage-strip-decline"]').click();
    expect(answers).toEqual([false]);
  });
});

describe('stripVisible — answered, not merely shown', () => {
  it('asks while the question is unanswered', () => {
    expect(stripVisible({ consent: null })).toBe(true);
  });

  it('stops once either answer is given', () => {
    expect(stripVisible({ consent: true })).toBe(false);
    expect(stripVisible({ consent: false })).toBe(false);
  });

  it('stays hidden while storage is unresolved', () => {
    expect(stripVisible({ consent: undefined })).toBe(false);
    expect(stripVisible({})).toBe(false);
  });

  it('does NOT depend on whether the ask has been shown before', () => {
    // The whole point: a strip nobody is forced to look at has to survive repeat
    // opens until answered, or it is missed and the answer never comes.
    expect(// `asked` is deliberately along for the ride: the assertion is that it does not matter.
    stripVisible({ consent: null, asked: true } as any)).toBe(true);
  });

  it('an explicit review reopens it whatever the answer was', () => {
    for (const consent of [true, false, null]) {
      expect(stripVisible({ consent, reviewing: true })).toBe(true);
    }
  });
});

describe('UsageFooterButton', () => {
  it('shows the current state once answered', () => {
    render(<UsageFooterButton asked consent onToggle={noop} />, root);
    let btn: any = root.querySelector('[data-testid="usage-footer-button"]');
    expect(btn.textContent).toMatch(/Usage data on/);
    expect(btn.className).toMatch(/\bon\b/);

    render(<UsageFooterButton asked consent={false} onToggle={noop} />, root);
    btn = root.querySelector('[data-testid="usage-footer-button"]');
    expect(btn.textContent).toMatch(/Usage data off/);
    expect(btn.className).not.toMatch(/\bon\b/);
  });

  it('toggles the strip instead of silently flipping the setting', () => {
    // It reports the intent; App turns that into `setReviewingUsage(v => !v)`,
    // which is how a reader who changed nothing gets back out now that the strip
    // carries no close button of its own.
    let toggled = 0;
    render(<UsageFooterButton asked consent onToggle={() => { toggled += 1; }} />, root);
    root.querySelector('[data-testid="usage-footer-button"]').click();
    root.querySelector('[data-testid="usage-footer-button"]').click();
    expect(toggled).toBe(2);
  });

  it('renders nothing before the ask has ever been shown', () => {
    for (const asked of [false, undefined]) {
      render(<UsageFooterButton asked={asked} consent={null} onToggle={noop} />, root);
      expect(root.querySelector('[data-testid="usage-footer-button"]')).toBeNull();
    }
  });

  it('still renders when the ask was never answered — the only way back in', () => {
    render(<UsageFooterButton asked consent={null} onToggle={noop} />, root);
    const btn: any = root.querySelector('[data-testid="usage-footer-button"]');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toMatch(/Usage data off/);
  });
});

describe('vocabulary is unified on "usage data"', () => {
  // Owner instruction 2026-08-03: one name for the feature in the UI.
  // "telemetry", "measure", "track" and "count" in any form are drift —
  // "telemetry" is excluded on purpose (see the note in UsageStrip.jsx).
  for (const [label, props] of [['ask', {}], ['review', { consent: true, reviewing: true }]]) {
    it(`uses no measuring/tracking/counting words in ${label} mode`, () => {
      show(props);
      const text: any = root.querySelector('.usage-strip').textContent;
      expect(text).not.toMatch(/\b(telemetr|measur|track|count)\w*\b/i);
      expect(text).toMatch(/usage data/i);
    });
  }

  it('names the feature the same way in the footer button', () => {
    render(<UsageFooterButton asked consent onToggle={noop} />, root);
    const btn: any = root.querySelector('[data-testid="usage-footer-button"]');
    expect(btn.textContent).not.toMatch(/\b(telemetr|measur|track|count)\w*\b/i);
    expect(btn.textContent).toMatch(/Usage data/);
    expect(btn.title).toMatch(/Usage data is on/);
  });
});
