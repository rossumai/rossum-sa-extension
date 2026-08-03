// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import UsageCard, { UsageFooterButton, overlayMode } from '../src/popup/components/UsageCard.jsx';

let root;
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root');
});

const noop = () => {};

describe('UsageCard — first-run ask', () => {
  it('renders a modal overlay over the whole popup', () => {
    render(h(UsageCard, { mode: 'ask', consent: null, onAnswer: noop, onClose: noop }), root);
    const overlay = root.querySelector('.usage-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(root.textContent).toContain('Help decide what gets built');
  });

  it('states the objective reason, and both halves of the ledger', () => {
    render(h(UsageCard, { mode: 'ask', consent: null, onAnswer: noop, onClose: noop }), root);
    const text = root.textContent;
    expect(text).toMatch(/Help us understand how the extension is used/);
    expect(text).toMatch(/Sharing usage data shows which features people actually use/);
    expect(text).toMatch(/effort goes where it helps/);
    expect(text).toMatch(/never includes your documents or customer data/);
    // Ledger headings.
    expect(text).toContain("What's sent");
    expect(text).toContain("What's NEVER sent");
    // Sent
    expect(text).toContain('extension version');
    expect(text).toMatch(/random ID, not tied to you/);
    // Never
    expect(text).toMatch(/URLs or org domains/);
    expect(text).toMatch(/names, emails, tokens/);
    expect(text).toMatch(/document or dataset content/);
  });

  it('links out to the full event list, unnumbered so it cannot go stale', () => {
    render(h(UsageCard, { mode: 'ask', consent: null, onAnswer: noop, onClose: noop }), root);
    const link = root.querySelector('.usage-foot a');
    expect(link.textContent.trim()).toBe('See all events \u203a');
    expect(link.textContent).not.toMatch(/\d/);
    expect(link.getAttribute('href')).toMatch(/PRIVACY\.md$/);
    expect(root.textContent).toContain('Reversible any time.');
  });

  it('is NOT dismissible: no close button, and a scrim click does nothing', () => {
    let closed = 0;
    render(h(UsageCard, { mode: 'ask', consent: null, onAnswer: noop, onClose: () => { closed += 1; } }), root);
    expect(root.querySelector('.usage-close')).toBeNull();
    root.querySelector('.usage-overlay').click();
    expect(closed).toBe(0);
  });

  it('shows no "currently" line, since there is no current setting yet', () => {
    render(h(UsageCard, { mode: 'ask', consent: null, onAnswer: noop, onClose: noop }), root);
    expect(root.querySelector('[data-testid="usage-current-state"]')).toBeNull();
  });

  it('labels the primary action "Share usage data"', () => {
    render(h(UsageCard, { mode: 'ask', consent: null, onAnswer: noop, onClose: noop }), root);
    expect(root.querySelector('[data-testid="usage-accept"]').textContent.trim())
      .toBe('Share usage data');
    expect(root.querySelector('[data-testid="usage-decline"]').textContent.trim())
      .toBe('No thanks');
  });

  it('never says "plugin" — the product is an extension everywhere else', () => {
    render(h(UsageCard, { mode: 'ask', consent: null, onAnswer: noop, onClose: noop }), root);
    expect(root.textContent).not.toMatch(/plugin/i);
  });

  it('reports true on accept and false on decline', () => {
    const answers = [];
    const props = { mode: 'ask', consent: null, onAnswer: (v) => answers.push(v), onClose: noop };
    render(h(UsageCard, props), root);
    root.querySelector('[data-testid="usage-accept"]').click();
    render(h(UsageCard, props), root);
    root.querySelector('[data-testid="usage-decline"]').click();
    expect(answers).toEqual([true, false]);
  });
});

describe('UsageCard — reopened for review', () => {
  it('opens for an answered user only when reviewing is requested', () => {
    for (const consent of [true, false]) {
      render(h(UsageCard, { mode: null, consent, onAnswer: noop, onClose: noop }), root);
      expect(root.querySelector('.usage-overlay')).toBeNull();

      render(h(UsageCard, { mode: 'review', consent, onAnswer: noop, onClose: noop }), root);
      expect(root.querySelector('.usage-overlay')).not.toBeNull();
      expect(root.textContent).toContain('Help decide what gets built');
    }
  });

  it('says which way it is currently set', () => {
    render(h(UsageCard, { mode: 'review', consent: true, onAnswer: noop, onClose: noop }), root);
    expect(root.querySelector('[data-testid="usage-current-state"]').textContent)
      .toMatch(/Currently\s+on/);

    render(h(UsageCard, { mode: 'review', consent: false, onAnswer: noop, onClose: noop }), root);
    expect(root.querySelector('[data-testid="usage-current-state"]').textContent)
      .toMatch(/Currently\s+off/);
  });

  it('is dismissible by the close button and by the scrim, but not by the card', () => {
    let closed = 0;
    const props = { mode: 'review', consent: true, onAnswer: noop, onClose: () => { closed += 1; } };
    render(h(UsageCard, props), root);

    root.querySelector('.usage-close').click();
    expect(closed).toBe(1);

    root.querySelector('.usage-overlay').click();
    expect(closed).toBe(2);

    // A click inside the card must not close it.
    root.querySelector('.usage-card').click();
    expect(closed).toBe(2);
  });

  it('can turn counting off from the reopened overlay', () => {
    const answers = [];
    render(h(UsageCard, {
      mode: 'review', consent: true, onAnswer: (v) => answers.push(v), onClose: noop,
    }), root);
    root.querySelector('[data-testid="usage-decline"]').click();
    expect(answers).toEqual([false]);
  });

  it('renders nothing when mode is null', () => {
    render(h(UsageCard, { mode: null, consent: undefined, onAnswer: noop, onClose: noop }), root);
    expect(root.querySelector('.usage-overlay')).toBeNull();
    expect(root.textContent).toBe('');
  });
});

describe('UsageFooterButton', () => {
  it('shows the current state once answered', () => {
    render(h(UsageFooterButton, { asked: true, consent: true, onOpen: noop }), root);
    let btn = root.querySelector('[data-testid="usage-footer-button"]');
    expect(btn.textContent).toMatch(/Usage data on/);
    expect(btn.className).toMatch(/\bon\b/);

    render(h(UsageFooterButton, { asked: true, consent: false, onOpen: noop }), root);
    btn = root.querySelector('[data-testid="usage-footer-button"]');
    expect(btn.textContent).toMatch(/Usage data off/);
    expect(btn.className).not.toMatch(/\bon\b/);
  });

  it('opens the overlay instead of silently flipping the setting', () => {
    let opened = 0;
    render(h(UsageFooterButton, { asked: true, consent: true, onOpen: () => { opened += 1; } }), root);
    root.querySelector('[data-testid="usage-footer-button"]').click();
    expect(opened).toBe(1);
  });

  it('renders nothing before the overlay has ever been shown', () => {
    for (const asked of [false, undefined]) {
      render(h(UsageFooterButton, { asked, consent: null, onOpen: noop }), root);
      expect(root.querySelector('[data-testid="usage-footer-button"]')).toBeNull();
    }
  });

  it('still renders when the ask was closed unanswered — the only way back in', () => {
    render(h(UsageFooterButton, { asked: true, consent: null, onOpen: noop }), root);
    const btn = root.querySelector('[data-testid="usage-footer-button"]');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toMatch(/Usage data off/);
  });
});

describe('vocabulary is unified on "usage data"', () => {
  // Owner instruction 2026-08-03: one name for the feature in the UI. "telemetry",
  // "measure", "track" and "count" in any form are drift, in either overlay mode
  // — "telemetry" is excluded on purpose (see the note in UsageCard.jsx).
  for (const mode of ['ask', 'review']) {
    it(`uses no measuring/tracking/counting words in ${mode} mode`, () => {
      render(h(UsageCard, { mode, consent: true, onAnswer: noop, onClose: noop }), root);
      const text = root.querySelector('.usage-card').textContent;
      expect(text).not.toMatch(/\b(telemetr|measur|track|count)\w*\b/i);
      expect(text).toMatch(/usage data/i);
    });
  }

  it('names the feature the same way in the footer button', () => {
    render(h(UsageFooterButton, { asked: true, consent: true, onOpen: noop }), root);
    const btn = root.querySelector('[data-testid="usage-footer-button"]');
    expect(btn.textContent).not.toMatch(/\b(telemetr|measur|track|count)\w*\b/i);
    expect(btn.textContent).toMatch(/Usage data/);
    expect(btn.title).toMatch(/Usage data is on/);
  });
});

describe('overlayMode — the ask appears exactly once', () => {
  it('asks on the very first popup open', () => {
    expect(overlayMode({ asked: false, reviewing: false })).toBe('ask');
  });

  it('never asks again once it has been shown', () => {
    expect(overlayMode({ asked: true, reviewing: false })).toBe(null);
  });

  it('reopens only when the footer explicitly requests it', () => {
    expect(overlayMode({ asked: true, reviewing: true })).toBe('review');
  });

  it('shows nothing while storage is still resolving', () => {
    expect(overlayMode({ asked: undefined, reviewing: false })).toBe(null);
    expect(overlayMode({ asked: undefined, reviewing: true })).toBe(null);
  });
});
