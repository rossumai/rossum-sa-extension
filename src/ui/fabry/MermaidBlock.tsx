import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { getMermaidRenderer, loadMermaidRenderer, themeFromTokens } from './mermaidLoader.js';
import styles from './FabryMarkdown.module.css';

// A mermaid fence rendered as an SVG diagram (beautiful-mermaid, themed from
// the live console tokens). The renderer is synchronous once the lazy bundle
// is in; it escapes label text itself (probe-verified) and we parse its output
// with DOMParser — no innerHTML sinks. States: bundle loading (dimmed source
// in the diagram box), rendered, or fallback code fence (invalid diagram /
// failed bundle load). Shares the markdown module (same code-fence chrome).
export default function MermaidBlock({ code }: { code?: string | null }) {
  const [ready, setReady] = useState(() => !!getMermaidRenderer());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (ready) return undefined;
    let stale = false;
    loadMermaidRenderer()
      .then(() => { if (!stale) setReady(true); })
      .catch(() => { if (!stale) setFailed(true); });
    return () => { stale = true; };
  }, [ready]);

  // Sync render + parse; ref callback attaches the node at commit time (no
  // effect needed, so this also behaves under the suite's no-op rAF polyfill).
  const svgEl = useMemo(() => {
    const fn = ready ? getMermaidRenderer() : null;
    if (!fn) return null; // still loading
    try {
      const svg = fn(code as string, themeFromTokens());
      const parsed = new DOMParser().parseFromString(svg, 'text/html');
      const el = parsed.querySelector('svg');
      return el ? document.importNode(el, true) : undefined;
    } catch {
      return undefined; // invalid/unsupported diagram
    }
  }, [ready, code]);

  if (failed || svgEl === undefined) {
    return (
      <div class={styles.codewrap}>
        <span class={styles.lang}>mermaid</span>
        <pre class={styles.code}><code>{code}</code></pre>
      </div>
    );
  }
  if (svgEl == null) {
    return (
      <div class={styles.mermaid + ' loading'}>
        <span class={styles.lang}>mermaid</span>
        <pre class={styles.mermaidSrc}>{code}</pre>
      </div>
    );
  }
  return (
    <div class={styles.mermaid}>
      <span class={styles.lang}>mermaid</span>
      <div class={styles.mermaidBox} ref={(el) => { if (el && el.firstChild !== svgEl) el.replaceChildren(svgEl); }} />
    </div>
  );
}
