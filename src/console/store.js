// src/console/store.js
import { signal } from '@preact/signals';

// Which app the console is currently showing.
export const activeApp = signal('mdh'); // 'mdh' | 'audit'

// Experimental features gate (popup-owned; 5 quick clicks on the version hash).
// Mirrored from chrome.storage.local at boot and live via onChanged.
export const experimentalUnlocked = signal(false);
