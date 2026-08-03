// GA4 destination for usage counting.
//
// Both values are PUBLIC by construction: they ship inside the bundle, so anyone
// can extract them. Google's Measurement Protocol reference calls the api_secret
// "Private to your organization. Should be regularly updated to avoid excessive
// SPAM" — shipping it client-side is therefore against Google's guidance, and we
// do it knowingly. What the exposure permits is bounded: the protocol is
// send-only, so a holder can inject junk events but can NOT read, modify or
// delete any data, and cannot reach any other property or account.
//
// Three things make that tolerable (spec §10):
//   1. This property is DEDICATED to the extension — there is no other data in
//      it to corrupt.
//   2. Injected events are detectable: PRIVACY.md publishes the closed event
//      vocabulary, so any name outside EVENT_NAMES, or an ext_ver that is not a
//      real git short hash, is provably forged.
//   3. Secrets are revocable in the GA4 UI, and a stream may hold several.
//
// COST OF ROTATION: because the secret is baked into the bundle, revoking it
// requires a new release through Chrome review, and installs that have not
// updated keep posting to a dead secret until they do. Budget days, not minutes.
// The only structural fix is a proxy that holds the secret server-side.
export const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
// For a pre-release smoke test, temporarily point GA4_ENDPOINT at
// https://www.google-analytics.com/debug/mp/collect — it validates the payload
// and records nothing. Deliberately not a second export: an unused constant
// reads like a live code path.

export const MEASUREMENT_ID = 'G-WRE4Z4K38W';
export const API_SECRET = 'x6ZLQ2OARMW8KO1ds-_D4A';
