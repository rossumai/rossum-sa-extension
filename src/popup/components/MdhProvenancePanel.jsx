import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  buildHookEntries,
  collectPlaceholders,
  extractIdFromUrl,
  fetchJson,
  loadAnnotationValues,
  loadMdhHooksForQueue,
  substitutePlaceholders,
} from '../mdh-provenance.js';
import {
  dropCachedAnnotation,
  getCachedAnnotation,
  getCachedHookEntries,
  setCachedAnnotation,
  setCachedHookEntries,
} from '../cache.js';
import { openMdhTab, sendMessage } from '../utils.js';
import ConfigBlock from './ConfigBlock.jsx';

function RefreshIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

export default function MdhProvenancePanel({ tab }) {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [state, setState] = useState({ kind: 'loading' });
  const [currentRow, setCurrentRow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const forceRefresh = refreshNonce > 0;

    (async () => {
      const ctx = await sendMessage(tab.id, 'get-current-context');
      if (cancelled) return;
      if (!ctx) {
        setState({ kind: 'message', message: 'Reload the Rossum tab, then reopen this popup.' });
        return;
      }
      if (!ctx.token) {
        setState({ kind: 'message', message: 'Not signed in to Rossum.', isError: true });
        return;
      }
      if (!ctx.annotationId && !ctx.queueId) {
        setState({ kind: 'message', message: 'Open a document or queue to see its MDH queries.' });
        return;
      }

      try {
        let queueId = ctx.queueId;
        let annotationModifiedAt = null;
        let annCache = null;
        if (!forceRefresh && ctx.annotationId) {
          annCache = await getCachedAnnotation(ctx.domain, ctx.annotationId);
          if (annCache) {
            annotationModifiedAt = annCache.modifiedAt;
            if (!queueId) queueId = annCache.queueId;
          }
        }
        if (!queueId && ctx.annotationId) {
          const ann = await fetchJson(
            `${ctx.domain}/api/v1/annotations/${ctx.annotationId}?fields=url,queue,modified_at`,
            ctx.token,
          );
          annotationModifiedAt = ann?.modified_at || null;
          queueId = extractIdFromUrl(ann?.queue);
        }
        if (cancelled) return;
        if (!queueId) {
          setState({ kind: 'message', message: 'Could not resolve queue from URL.', isError: true });
          return;
        }

        let hookEntries = null;
        let fromHooksCache = false;
        if (!forceRefresh) {
          hookEntries = await getCachedHookEntries(ctx.domain, queueId);
          if (hookEntries) fromHooksCache = true;
        }
        if (cancelled) return;
        if (!hookEntries) {
          const mdhHooks = await loadMdhHooksForQueue(ctx.domain, ctx.token, queueId);
          if (cancelled) return;
          if (mdhHooks.length === 0) {
            setState({ kind: 'message', sub: `queue ${queueId}`, message: 'No MDH matching hooks on this queue.' });
            return;
          }
          hookEntries = buildHookEntries(mdhHooks, queueId);
          if (hookEntries.length === 0) {
            setState({ kind: 'message', sub: `queue ${queueId}`, message: 'No MDH configurations apply to this queue.' });
            return;
          }
          setCachedHookEntries(ctx.domain, queueId, hookEntries).catch(() => {});
        }

        const placeholders = new Set();
        for (const { cfgs } of hookEntries) {
          for (const cfg of cfgs) {
            for (const q of cfg.queries) for (const p of q.placeholders) placeholders.add(p);
            if (cfg.dataset) collectPlaceholders(cfg.dataset, placeholders);
          }
        }

        let headerValues = {};
        let rowValues = {};
        let rowCount = 0;
        let annValuesFromCache = false;
        if (annCache) {
          const cachedPlaceholders = new Set((annCache.placeholders || '').split(',').filter(Boolean));
          const allCovered = [...placeholders].every((p) => cachedPlaceholders.has(p));
          if (allCovered) {
            headerValues = annCache.headerValues || {};
            rowValues = annCache.rowValues || {};
            rowCount = annCache.rowCount || 0;
            annValuesFromCache = true;
          }
        }
        if (!annValuesFromCache && ctx.annotationId && placeholders.size > 0) {
          try {
            const flat = await loadAnnotationValues(ctx.domain, ctx.token, ctx.annotationId, placeholders);
            if (cancelled) return;
            headerValues = flat.headerValues;
            rowValues = flat.rowValues;
            rowCount = flat.rowCount;
          } catch {
            // leave defaults
          }
        }
        if (!annValuesFromCache && ctx.annotationId && annotationModifiedAt) {
          setCachedAnnotation(ctx.domain, ctx.annotationId, {
            modifiedAt: annotationModifiedAt,
            queueId,
            headerValues,
            rowValues,
            rowCount,
            placeholders: [...placeholders].sort().join(','),
          }).catch(() => {});
        }

        // Resolve placeholder-driven dataset names (e.g. `dataset: "{mdh_dataset_pos}"`)
        // against the schema's default values, which live on the annotation as header fields.
        const resolvedEntries = hookEntries.map(({ hook, cfgs }) => ({
          hook,
          cfgs: cfgs.map((cfg) => {
            if (cfg.dataset && cfg.dataset.includes('{')) {
              const resolved = substitutePlaceholders(cfg.dataset, headerValues);
              if (resolved && resolved.trim() !== '') return { ...cfg, dataset: resolved };
            }
            return cfg;
          }),
        }));

        let totalQueries = 0;
        for (const { cfgs } of resolvedEntries) {
          for (const cfg of cfgs) totalQueries += cfg.queries.length;
        }
        const subPieces = [
          `queue ${queueId}`,
          `${resolvedEntries.length} active ${resolvedEntries.length === 1 ? 'hook' : 'hooks'}`,
          `${totalQueries} ${totalQueries === 1 ? 'query' : 'queries'}`,
        ];
        if (fromHooksCache || annValuesFromCache) subPieces.push('cached');

        setState({
          kind: 'loaded',
          ctx,
          queueId,
          annotationModifiedAt,
          hookEntries: resolvedEntries,
          headerValues,
          rowValues,
          rowCount,
          sub: subPieces.join(' · '),
        });
        setCurrentRow(0);

        // Best-effort freshness check: if cached annotation is stale, drop it
        // and re-render with fresh data. Honors `cancelled` so a manual refresh
        // mid-flight doesn't cause a second nonce bump on top of the user's.
        if (annValuesFromCache && ctx.annotationId) {
          (async () => {
            try {
              const ann = await fetchJson(
                `${ctx.domain}/api/v1/annotations/${ctx.annotationId}?fields=modified_at`,
                ctx.token,
              );
              if (cancelled) return;
              if (ann?.modified_at && ann.modified_at !== annotationModifiedAt) {
                await dropCachedAnnotation(ctx.domain, ctx.annotationId);
                if (cancelled) return;
                setRefreshNonce((n) => n + 1);
              }
            } catch {
              // best-effort; keep cached view
            }
          })();
        }
      } catch (e) {
        if (cancelled) return;
        const msg = String(e?.message || e || 'Failed to load');
        if (msg.includes('401')) {
          setState({ kind: 'message', message: 'Not signed in to Rossum.', isError: true });
        } else {
          setState({ kind: 'message', message: `Failed: ${msg}`, isError: true });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [refreshNonce]);

  const onRefresh = () => {
    setState({ kind: 'loading' });
    setRefreshNonce((n) => n + 1);
  };

  return (
    <section class="card mdh-card" data-context="rossum">
      <h3 class="section-title">
        <span>MDH on this screen</span>
        <button
          type="button"
          class="mdh-refresh-btn"
          title="Refresh — bypass cache and re-fetch"
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
      </h3>
      <div class="mdh-card-sub">{state.sub || ''}</div>
      <div>
        {state.kind === 'loading' ? (
          <p class="mdh-empty">Loading…</p>
        ) : state.kind === 'message' ? (
          <p class={`mdh-empty${state.isError ? ' mdh-error' : ''}`}>{state.message}</p>
        ) : (
          state.hookEntries.map(({ hook, cfgs }) => (
            <div class="mdh-hook" key={hook.id}>
              <a
                class="mdh-hook-name"
                href={`${state.ctx.domain}/extensions/my-extensions/${hook.id}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {hook.name || `Hook ${hook.id}`}
              </a>
              {cfgs.map((cfg, cfgIdx) => (
                <ConfigBlock
                  key={`${hook.id}::${cfgIdx}`}
                  ctx={state.ctx}
                  cfg={cfg}
                  cfgKey={`${hook.id}::${cfgIdx}`}
                  headerValues={state.headerValues}
                  rowValues={state.rowValues}
                  rowCount={state.rowCount}
                  annotationModifiedAt={state.annotationModifiedAt}
                  currentRow={currentRow}
                  onRowChange={setCurrentRow}
                  forceRefreshNonce={refreshNonce}
                  onOpenInDm={(dataset, pipelineText) =>
                    openMdhTab(tab, {
                      token: state.ctx.token,
                      domain: state.ctx.domain,
                      pendingCollection: dataset,
                      pendingPipeline: pipelineText,
                    })
                  }
                />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
