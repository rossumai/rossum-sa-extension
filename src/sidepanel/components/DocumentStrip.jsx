import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../../popup/mdh-provenance.js';

// The one piece of UI the popup never needed: a panel that outlives a click has
// to say WHICH document it is showing. The id alone already identifies it, so the
// file name is strictly an upgrade — every failure path just keeps the id.
export default function DocumentStrip({ ctx, annotationId }) {
  const [name, setName] = useState(null);

  useEffect(() => {
    setName(null);
    if (!annotationId || !ctx?.token || !ctx?.domain) return undefined;
    let cancelled = false;
    (async () => {
      try {
        // List + sideload (not the detail route): the form verified live for the
        // Inspector landing.
        const res = await fetchJson(
          `${ctx.domain}/api/v1/annotations?id=${annotationId}&sideload=documents&fields=url,document`,
          ctx.token,
        );
        if (cancelled) return;
        const file = res?.documents?.[0]?.original_file_name;
        if (file) setName(file);
      } catch {
        // Keep the id — it identifies the document unambiguously on its own.
      }
    })();
    return () => { cancelled = true; };
  }, [annotationId, ctx?.domain, ctx?.token]);

  if (!annotationId) {
    return (
      <div class="sp-strip sp-strip--idle">
        <span class="sp-strip-title">No document open</span>
        <span class="sp-strip-hint">following this tab</span>
      </div>
    );
  }

  return (
    <div class="sp-strip">
      <i class="sp-live"></i>
      <span class="sp-strip-title" title={name || 'Document'}>{name || 'Document'}</span>
      <code class="sp-strip-id">#{annotationId}</code>
      <span class="sp-strip-hint">following this tab</span>
    </div>
  );
}
