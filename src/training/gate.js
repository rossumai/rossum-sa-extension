// The hidden-features gate: `experimentalUnlocked`, the key the popup's 5-click
// version-hash gesture flips and the Console rail reads. It was a separate
// `trainingUnlocked` key until 2026-08-11, kept apart so that unlocking training
// could not also hand a trainee Mr. Fabry's write-enabled Architect implement
// loop. That separation stopped protecting anything the moment Fabry went
// public — implement loop included — because a trainee now has it whether or
// not they ever unlock a thing. One gate, named for what it does.
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
