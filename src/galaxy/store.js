import { signal } from '@preact/signals';

// Shared connection (set by the console shell before initGalaxy runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal(null); // null = not yet probed; true/false after whoami

// The org graph, built once by initGalaxy from the REST resources.
export const graph = signal({ nodes: [], links: [] });

// UI state.
export const loading = signal(false);
export const loadedCount = signal(0); // objects fetched from the API so far (for the loading screen)
export const error = signal(null);
export const selectedNodeId = signal(null); // node.id of the focused node, or null
export const hoveredNodeId = signal(null);   // node.id under the cursor, or null

// Which node types are shown in the scene; clicking a Legend entry toggles one.
export const visibleTypes = signal({ organization: true, workspace: true, queue: true, hook: true, engine: true });
export function toggleType(type) {
  const cur = visibleTypes.value;
  visibleTypes.value = { ...cur, [type]: cur[type] === false ? true : false };
}
