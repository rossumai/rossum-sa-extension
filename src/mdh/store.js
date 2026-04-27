// src/mdh/store.js
import { signal } from '@preact/signals';

export const domain = signal('');
export const token = signal('');
export const collections = signal([]);
export const selectedCollection = signal(null);
export const records = signal([]);
export const skip = signal(0);
export const limit = signal(50);
export const activePanel = signal('data');
export const activeView = signal('collection');
export const loading = signal(false);
export const error = signal(null);
export const modalContent = signal(null);
export const aiEnabled = signal(false);
export const aiStatus = signal('idle'); // idle | downloading | ready | unavailable
export const aiDownloadProgress = signal(0);
export const statsSummary = signal(null); // { collection, health, label } | null
export const operations = signal([]);
export const operationsLoaded = signal(false);
export const pendingOperations = signal(null); // { ops, changedOps } | null
export const opsSearch = signal('');
export const undoToast = signal(null); // { id, message, action, ts, ttlMs, status, error } | null
