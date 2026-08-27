// What a rejection is allowed to say, in one place — and it may never be the empty string.
//
// Ruling 27 fixed that at the root once and a later round found a fifth site that had missed it, so
// the rule stopped being a rule and became four copies of one literal: the store's `indexError`
// doubles as the flag for "the read failed", the panel's log row is the only place an upload failure
// is ever reported, the editor's note is the only record a pasted file's failure leaves, and the
// print prefetch's refusal is what a marker on the page says. A rejection carrying no message —
// `Promise.reject('')`, a gateway with an empty body — turns every one of those into a failure the
// user is told about without being told anything, and in the store's case into no failure at all.
//
// `err.message` first, whatever the value's type, because that is where every `Error` this repo
// builds carries its text; `String(err)` for a transport that rejected with a bare string.
export function message(err: unknown): string {
  const m = err && (err as any).message ? String((err as any).message) : String(err);
  return m || 'the request failed with no reason given';
}
