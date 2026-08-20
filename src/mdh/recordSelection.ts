import { selectedIds } from './store.js';

export function recordIdKey(record: any): string {
  return record._id?.$oid || String(record._id);
}

export function isRecordSelected(record: any): boolean {
  return selectedIds.value.has(recordIdKey(record));
}

export function toggleRecordSelection(record: any): void {
  const key = recordIdKey(record);
  const next = new Map(selectedIds.value);
  if (next.has(key)) next.delete(key);
  else next.set(key, record._id);
  selectedIds.value = next;
}
