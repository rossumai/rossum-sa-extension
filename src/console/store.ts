// src/console/store.ts
import { signal } from '@preact/signals';
import type { AppId } from './boot.js';

// Which app the console is currently showing.
export const activeApp = signal<AppId>('mdh');

// The extension's one hidden-features gate (popup-owned; 5 quick clicks on the
// version hash). Mirrored from chrome.storage.local at boot and live via
// onChanged. It hides exactly one app today — the Academy — and Mr. Fabry is
// public. The separate `trainingUnlocked` signal was folded into this one on
// 2026-08-11; see src/training/gate.js for why the split stopped buying safety.
export const experimentalUnlocked = signal(false);

// The connected organization's name, for the connection lines of Dataset Management
// and the Audit Log Viewer. Null until src/console/orgName.ts resolves it, and null for
// good when that fails — a connection line then reads exactly as it did before.
export const orgName = signal<string | null>(null);
