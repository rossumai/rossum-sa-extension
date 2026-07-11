// On-demand loader for the beautiful-mermaid SVG renderer bundle
// (dist/console/mermaid.js, see src/fabry/mermaidEntry.js). A same-package
// <script> satisfies the extension page's CSP (script-src 'self'). The cached
// promise lets concurrent MermaidBlocks share one load; a failed load rejects
// them all (they fall back to a plain code fence) but permits a later retry.
let pending = null;

export function getMermaidRenderer() {
  return (typeof window !== 'undefined' && window.__fabryMermaidSvg) || null;
}

export function loadMermaidRenderer({ src = 'mermaid.js', doc = document } = {}) {
  const ready = getMermaidRenderer();
  if (ready) return Promise.resolve(ready);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = src;
    script.onload = () => {
      const fn = getMermaidRenderer();
      if (fn) resolve(fn);
      else reject(new Error('mermaid bundle loaded but did not register'));
    };
    script.onerror = () => reject(new Error('failed to load mermaid bundle'));
    doc.head.appendChild(script);
  });
  pending.catch(() => { pending = null; }); // allow retry after a failed load
  return pending;
}

// Console theme → beautiful-mermaid theme options, read live from the CSS
// custom properties so diagrams match the active (light/dark) theme. Blue
// accent per the console-wide scheme.
export function themeFromTokens(doc = document) {
  const cs = getComputedStyle(doc.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  // bg = the PAGE color (the svg has no background rect — probe-verified — so
  // bg only drives contrast math); surface = card color so nodes read as
  // elevated cards sitting directly on the page.
  return {
    bg: v('--bg-base', '#f1f1f5'),
    fg: v('--text-primary', '#1a1a24'),
    line: v('--text-secondary', '#7a7a8c'),
    accent: v('--accent', '#4270db'),
    muted: v('--text-secondary', '#7a7a8c'),
    surface: v('--bg-card', '#ffffff'),
    border: v('--border', '#dcdce4'),
  };
}
