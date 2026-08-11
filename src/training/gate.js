// The trainingUnlocked gate. Deliberately NOT experimentalUnlocked: that key
// gates Mr. Fabry, whose Architect implement loop defaults to write-enabled, and
// a trainee must not acquire an autonomous write capability against their org
// as a side effect of starting training.
import { UNLOCK_KEY } from './storage.js';

export async function isUnlocked() {
  const got = await chrome.storage.local.get([UNLOCK_KEY]);
  return got?.[UNLOCK_KEY] === true;
}

export function onUnlockChange(cb) {
  const listener = (changes, area) => {
    if (area !== 'local' || !changes[UNLOCK_KEY]) return;
    cb(changes[UNLOCK_KEY].newValue === true);
  };
  chrome.storage.onChanged?.addListener(listener);
  return () => chrome.storage.onChanged?.removeListener(listener);
}
