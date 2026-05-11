// Platform detection for keyboard-shortcut labels.
// On macOS the Alt key is labeled "Option" (or shown as ⌥); on Windows/Linux
// it's "Alt". The `altKey` event property is true for both, so only the label
// changes. We detect once at module load — the OS doesn't change at runtime.

function detectMac() {
  if (typeof navigator === 'undefined') return false;
  // userAgentData is the modern API; fall back to navigator.platform (deprecated
  // but still supported in Chrome) and finally userAgent.
  const platform = navigator.userAgentData?.platform
    || navigator.platform
    || navigator.userAgent
    || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export const IS_MAC = detectMac();
export const ALT_KEY = IS_MAC ? 'Option' : 'Alt';
