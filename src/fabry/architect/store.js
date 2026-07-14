import { signal } from '@preact/signals';

// Deliverables (Markdown docs) + their last check results live server-side in
// Data Storage. Only content-free navigation is persisted in the browser:
// fabryMode + activeId (the open deliverable id, per-tab via fabryArchitectActive
// so it survives a page refresh — see src/fabry/index.jsx).
export const deliverables = signal([]); // {id, text, order}[]
export const activeId = signal(null);   // open deliverable id, or null
export const loaded = signal(false);
export const loadError = signal(null);
export const running = signal(false);
export const results = signal({}); // { [id]: Result }
// Shared expand/collapse preference for the verdict evidence banner: once the
// user expands one deliverable's verdict, every other deliverable opens expanded
// by default (and vice-versa). Session-only, content-free.
export const verdictExpanded = signal(false);

export function setResult(id, result) { results.value = { ...results.value, [id]: result }; }
export function clearResults() { results.value = {}; }
export function setActive(id) { activeId.value = id; }
