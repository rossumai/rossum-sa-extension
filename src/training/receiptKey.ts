// The receipt signing key. Isolated in its own module so exactly one file names
// it — tests/training-key-boundary.test.js enforces that, and also enforces
// that it only ever reaches dist/console/console.js (the Academy mints and
// validates; no other surface needs it).
//
// Extractable from the bundle BY DESIGN, exactly like src/usage/ga4Config.js.
// It deters copying a code between trainees; it is not proof against a
// determined forger. Rotating it invalidates every previously issued receipt
// and costs a full Chrome review, so rotate only on a real leak.
export const RECEIPT_KEY = 'TNtMAEHTTD0Z3C4IquCh7xpDneFjvpH4nci2KDkZGsI=';
