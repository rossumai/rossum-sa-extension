import { h } from 'preact';

const PRIVACY_URL = 'https://github.com/rossumai/rossum-sa-extension/blob/master/PRIVACY.md';

// The consent surface for usage data, in two parts. ONE name for the feature
// throughout the UI: "usage data" — never telemetry/measuring/tracking/counting.
// The word choice is deliberate: the 2021 Audacity case showed that opt-in and
// off-by-default did not stop a revolt against "telemetry" — the framing did the
// damage, and this audience is the same technical population. Engineering names
// keep the plain "usage" prefix (src/usage/, usageConsent, sa-usage).
//
// Two independent stored facts, deliberately not conflated:
//   usageAsked  -> has the overlay ever been SHOWN? Written the first time it
//                  renders, so the ask appears exactly once, never on every
//                  popup open. Closing it without answering leaves usage data off
//                  (the safe default) and does not nag.
//   usageConsent-> has the user ANSWERED, and how? true / false / absent.
//
// After the first showing, the footer button is the only way back in — which is
// why it renders as soon as `asked` is true, answered or not.
//
// The full event list with descriptions lives ONLY in PRIVACY.md — one place,
// verified complete in both directions by tests/usage-boundary.test.js. The
// link is deliberately unnumbered ("See all events"), so it can never disagree
// with the vocabulary as events are added.

// Pure decision: when is the overlay on screen, and in which mode?
//   'ask'    — first and only automatic showing
//   'review' — explicitly reopened from the footer
//   null     — not shown (including while storage is still resolving)
export function overlayMode({ asked, reviewing }) {
  if (asked === undefined) return null;   // storage not resolved yet
  if (!asked) return 'ask';
  return reviewing ? 'review' : null;
}

export default function UsageCard({ mode, consent, onAnswer, onClose }) {
  const ask = mode === 'ask';
  const review = mode === 'review';
  if (!ask && !review) return null;

  // Only the reopened overlay is dismissible; the one-time ask is not.
  const onScrim = review
    ? (e) => { if (e.target === e.currentTarget) onClose(); }
    : undefined;

  return (
    <div
      class="usage-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="usage-title"
      onClick={onScrim}
    >
      <section class="usage-card">
        {review ? (
          <button class="usage-close" aria-label="Close" title="Close" onClick={onClose}>×</button>
        ) : null}

        <h3 class="section-title" id="usage-title">Help decide what gets built</h3>

        <p class="usage-lede">
          Help us understand how the extension is used. Sharing usage data shows which features
          people actually use, so effort goes where it helps. It never includes your documents or
          customer data.
        </p>

        <dl class="usage-ledger">
          <div>
            <dt>What's sent</dt>
            <ul class="yes">
              <li>feature name</li>
              <li>extension version</li>
              <li>a random ID, not tied to you</li>
            </ul>
          </div>
          <div>
            <dt>What's NEVER sent</dt>
            <ul class="no">
              <li>URLs or org domains</li>
              <li>names, emails, tokens</li>
              <li>document or dataset content</li>
            </ul>
          </div>
        </dl>

        {review ? (
          <p class="usage-state" data-testid="usage-current-state">
            Currently <strong>{consent === true ? 'on' : 'off'}</strong>.
          </p>
        ) : null}

        <div class="usage-actions">
          <button class="usage-btn-primary" data-testid="usage-accept" onClick={() => onAnswer(true)}>
            Share usage data
          </button>
          <button class="usage-btn-ghost" data-testid="usage-decline" onClick={() => onAnswer(false)}>
            No thanks
          </button>
        </div>

        <p class="usage-foot">
          Reversible any time.{' '}
          <a class="footer-link" href={PRIVACY_URL} target="_blank" rel="noreferrer">
            See all events ›
          </a>
        </p>
      </section>
    </div>
  );
}

// Always-reachable entry point back into the overlay. Lives in the footer
// because that is the only region rendered on every page, supported or not.
// It does NOT flip the setting: clicking REOPENS the overlay, so a change of
// mind happens next to the explanation rather than as a silent state flip.
export function UsageFooterButton({ asked, consent, onOpen }) {
  // Renders as soon as the overlay has been shown once — including when it was
  // closed unanswered, otherwise there would be no way back to it.
  if (asked !== true) return null;
  const on = consent === true;
  return (
    <button
      type="button"
      class={`footer-usage${on ? ' on' : ''}`}
      data-testid="usage-footer-button"
      title={on
        ? "Usage data is on. Click to see what's sent, or turn it off."
        : 'Usage data is off. Click to see what it does.'}
      onClick={onOpen}
    >
      <span class="footer-usage-dot" aria-hidden="true"></span>
      Usage data {on ? 'on' : 'off'}
    </button>
  );
}
