import { h } from 'preact';

const PRIVACY_URL = 'https://github.com/rossumai/rossum-sa-extension/blob/master/PRIVACY.md';

// The consent surface for usage data. ONE name for the feature throughout the
// UI: "usage data" — never telemetry/measuring/tracking/counting. The word
// choice is deliberate: the 2021 Audacity case showed that opt-in and
// off-by-default did not stop a revolt against "telemetry" — the framing did the
// damage, and this audience is the same technical population. Engineering names
// keep the plain "usage" prefix (src/usage/, usageConsent, sa-usage).
//
// ONE SURFACE, ONE RENDERING (2026-08-19). This replaced a blocking modal
// overlay (`UsageCard`, `.usage-overlay`) that was both the first ask and the
// reopened review; the overlay, its scrim, its dialog semantics and
// `overlayMode` are all gone. A wall in front of the product is a poor way to
// earn a yes, and once the ask is non-blocking there is nothing left for a modal
// to do.
//
// `reviewing` decides WHETHER the strip is on screen and nothing else — the
// markup is byte-identical either way (pinned by a test). It briefly carried a
// "Currently on/off" line and a close button; both were removed, which left the
// two modes with nothing to distinguish them, so the distinction went too.
//
// With no close button of its own, the way back out of a review that changed
// nothing is the footer control that opened it: it TOGGLES `reviewing`.
//
// What being non-blocking costs is a persistence rule: a strip nobody is forced
// to look at must survive repeat opens, or it is simply missed. Hence
// stripVisible keys on whether the question has been ANSWERED, never on whether
// it has been SHOWN.
//
// Two independent stored facts, deliberately not conflated:
//   usageAsked  -> has the ask ever been SHOWN? Written the first time it
//                  renders. NOT what decides whether the strip shows; it is what
//                  makes the footer control reachable.
//   usageConsent-> has the user ANSWERED, and how? true / false / absent.
//
// The disclosure is a LINK, not an in-popup block (owner, 2026-08-19, to cut
// vertical space in a popup Chrome caps at 600px). A collapsed <details> ledger
// was built first and removed: the argument for keeping it in-popup was that
// "feature name, extension version, a random ID" is the most persuasive content
// on the surface and that sending people to a markdown file to find it may cost
// acceptances. That trade was raised and decided the other way; PRIVACY.md is
// now the ONLY place the ledger lives, verified complete in both directions by
// tests/usage-boundary.test.js. The link stays deliberately unnumbered so it
// cannot disagree with the vocabulary as events are added.
//
// "Currently on/off" went with it. It is not missed: the footer control the user
// clicked to reopen this reads "Usage data on"/"Usage data off" with a state
// dot, so the setting is adjacent rather than lost.

// Pure decision: is the consent surface on screen?
//   consent: undefined -> storage unresolved; render nothing rather than flash
//            null      -> never answered; ask, and keep asking until answered
//            true/false-> answered; only an explicit review reopens it
type UsageProps = { consent?: boolean | null; reviewing?: unknown };

export function stripVisible({ consent, reviewing }: UsageProps) {
  return consent === null || reviewing === true;
}

export default function UsageStrip({
  consent,
  reviewing,
  onAnswer,
}: UsageProps & { onAnswer: (yes: boolean) => void }) {
  if (!stripVisible({ consent, reviewing })) return null;

  return (
    <section class="usage-strip" aria-labelledby="usage-strip-lead">
      <p class="usage-strip-text">
        <b id="usage-strip-lead">Help decide what gets built.</b> Sharing usage data shows which
        features people actually use, so effort goes where it helps — never your documents or
        customer data.
      </p>

      <div class="usage-strip-actions">
        <button
          class="usage-strip-yes"
          data-testid="usage-strip-accept"
          onClick={() => onAnswer(true)}
        >
          Share usage data
        </button>
        <button
          class="usage-strip-no"
          data-testid="usage-strip-decline"
          onClick={() => onAnswer(false)}
        >
          No thanks
        </button>
        {/* Pushed to the far edge: available, never in the way. */}
        <a class="usage-strip-link" href={PRIVACY_URL} target="_blank" rel="noreferrer">
          What's sent ›
        </a>
      </div>
    </section>
  );
}

// Always-reachable entry point back into the strip. Lives in the footer because
// that is the only region rendered on every page, supported or not. It does NOT
// flip the setting: clicking TOGGLES the strip, so a change of mind happens next
// to the explanation rather than as a silent state flip — and, since the strip
// carries no close button, this is also how a reader who changed nothing gets
// back out.
export function UsageFooterButton({
  asked,
  consent,
  onToggle,
}: {
  asked?: boolean;
  consent?: boolean | null;
  onToggle: () => void;
}) {
  // Renders as soon as the ask has been shown once — including when it was never
  // answered, otherwise there would be no way back to it.
  if (asked !== true) return null;
  const on = consent === true;
  return (
    <button
      type="button"
      class={`footer-usage${on ? ' on' : ''}`}
      data-testid="usage-footer-button"
      title={
        on
          ? "Usage data is on. Click to see what's sent, or turn it off."
          : 'Usage data is off. Click to see what it does.'
      }
      onClick={onToggle}
    >
      <span class="footer-usage-dot" aria-hidden="true"></span>
      Usage data {on ? 'on' : 'off'}
    </button>
  );
}
