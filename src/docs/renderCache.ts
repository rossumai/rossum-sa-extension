// Rendered documents, cached and pre-warmable, so switching deliverable is instant
// (owner, 2026-08-18: "preload all deliverables so the page switching is instant").
//
// What actually costs time on a switch is NOT loading the text — every deliverable's text
// arrives in the single Data Storage `find` at boot — it is rendering it: markdown-it, then the
// sanitizer, then (for a document with a diagram) a SECOND paint once the 1.5MB mermaid bundle
// has loaded. Caching the rendered tree turns a switch into an importNode of an existing DOM.
//
// The key includes everything that changes the output, so a stale entry is impossible: the
// deliverable's id, its exact text, the theme (diagram palettes differ), whether sync anchors
// were requested, and whether a diagram renderer was available at render time — that last one
// matters because a document rendered before the bundle arrived has code fences where it should
// have diagrams, and must not be served afterwards.
import {
  createMarkdownRenderer,
  wrapStandaloneImages,
  MERMAID_LIGHT,
  MERMAID_DARK,
} from './render.js';
import { reportDocWarnings } from './docWarnings.js';
import { sanitizeBody, markLinksForPane } from './sanitize.js';

// Rendered documents hold a full DOM tree plus any diagram SVGs, so the cap is a memory
// decision rather than a hit-rate one: a large SOW is tens of documents, and holding ~24 of
// them is cheap next to holding all of them.
export const CACHE_CAP = 24;
type Entry = { body: HTMLElement | null; warnings: string[] };
const cache = new Map<string, Entry>();
let hits = 0;
let misses = 0;

export function cacheKey({
  id,
  text,
  dark,
  syncLines,
  withMermaid,
}: {
  id?: string;
  text?: string | null;
  dark?: boolean;
  syncLines?: boolean;
  withMermaid?: boolean;
}) {
  return [
    id || '',
    dark ? 'd' : 'l',
    syncLines ? 's' : '-',
    withMermaid ? 'm' : '-',
    String(text ?? ''),
  ].join('\u0000');
}

export function cacheStats() {
  return { size: cache.size, hits, misses };
}

export function clearRenderCache() {
  cache.clear();
  hits = 0;
  misses = 0;
}

// Returns { body, warnings } — `body` is a DETACHED element whose children callers import
// (never adopt directly, or the cached tree would be emptied by its first consumer).
export function renderDocument({
  id,
  text,
  mermaid = null,
  dark = false,
  syncLines = false,
}: {
  id?: string;
  text?: string | null;
  mermaid?: any;
  dark?: boolean;
  syncLines?: boolean;
}): Entry {
  const key = cacheKey({ id, text, dark, syncLines, withMermaid: !!mermaid });
  const hit = cache.get(key);
  if (hit) {
    hits += 1;
    // Refresh recency: re-inserting moves the key to the end of the Map's iteration order,
    // which is what makes the eviction below least-recently-USED rather than oldest-inserted.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  misses += 1;

  const md = createMarkdownRenderer({ mermaid, mermaidTheme: dark ? MERMAID_DARK : MERMAID_LIGHT });
  const env: { syncLines: boolean; mermaidErrors: string[] } = { syncLines, mermaidErrors: [] };
  let entry: Entry;
  try {
    const html = wrapStandaloneImages(md.render(String(text ?? ''), env));
    const warnings: string[] = [];
    reportDocWarnings(env, 'this deliverable', (m) => warnings.push(m));
    for (const e of env.mermaidErrors) warnings.push(`mermaid: ${e}`);
    // markLinksForPane mutates, so it runs BEFORE caching: a cached tree is never touched again.
    entry = { body: markLinksForPane(sanitizeBody(html)), warnings };
  } catch (err) {
    // A render failure is returned, not cached — a transient throw must not become permanent.
    return {
      body: null,
      warnings: [`render failed: ${err && (err as any).message ? (err as any).message : err}`],
    };
  }

  if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
  return entry;
}

export function isRendered(args: {
  id?: string;
  text?: string | null;
  mermaid?: any;
  dark?: boolean;
  syncLines?: boolean;
}) {
  return cache.has(cacheKey({ ...args, withMermaid: !!args.mermaid }));
}
