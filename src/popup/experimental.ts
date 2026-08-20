// Easter-egg unlock for experimental features: N clicks in quick succession on
// the popup's version hash flip the `experimentalUnlocked` chrome.storage key.
// Pure counter — the caller owns storage and UI.

export function createUnlockCounter({ threshold = 5, windowMs = 2000, now = () => Date.now() } = {}) {
  let count = 0;
  let last = 0;
  return {
    // Returns true when this click reaches the threshold (and resets the count).
    click() {
      const t = now();
      if (t - last > windowMs) count = 0; // stale streak — start over
      last = t;
      count++;
      if (count >= threshold) {
        count = 0;
        return true;
      }
      return false;
    },
  };
}
