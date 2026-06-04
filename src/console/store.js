// src/console/store.js
import { signal } from '@preact/signals';

// Which app the console is currently showing.
export const activeApp = signal('mdh'); // 'mdh' | 'audit'
