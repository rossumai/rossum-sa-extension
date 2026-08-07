import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  buildHookEntries,
  collectPlaceholders,
  extractIdFromUrl,
  fetchJson,
  filterHookEntries,
  loadAnnotationValues,
  loadMdhHooksForQueue,
  loadSchemaTypesForQueue,
  mergeSchemaTypes,
  substitutePlaceholders,
} from '../mdh-provenance.js';
import {
  dropCachedAnnotation,
  getCachedAnnotation,
  getCachedHookEntries,
  getCachedSchemaTypes,
  setCachedAnnotation,
  setCachedHookEntries,
  setCachedSchemaTypes,
} from '../cache.js';
import { openConsoleTab, runInTab } from '../utils.js';
import { readCurrentContext } from '../tab-readers.js';
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

// The glyph for the (colloquially "pin") button that hands this card to the side
// panel. A pushpin was tried first and rejected on evidence: rendered at the
// 11px this actually ships at, its head/body/point collapse into a smudge. Two
// plain rectangles survive the size, and naming the destination reads better
// than naming the gesture — it is the same shape Chrome uses for the panel.
function SidePanelIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <rect x="13.5" y="4.5" width="7.5" height="15" rx="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function DocLookupIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2.75H7A2.25 2.25 0 0 0 4.75 5v14A2.25 2.25 0 0 0 7 21.25h10A2.25 2.25 0 0 0 19.25 19V8z" />
      <path d="M14 2.75V8h5.25" />
      <path d="M8.5 9.5h3" />
      <path d="M8.5 13h7" />
      <path d="M8.5 16.5h7" />
    </svg>
  );
}

// `onPin` is optional and rendered only when supplied: the popup passes a handler
// that hands this same card to the side panel, the side panel itself passes none.
export default function MdhProvenancePanel({ tab, onPin }) {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [state, setState] = useState({ kind: 'loading' });
  const [currentRow, setCurrentRow] = useState(0);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    chrome.storage.local.get('mdhProvenanceFilter').then((vals) => {
      const saved = vals?.mdhProvenanceFilter;
      if (typeof saved === 'string' && saved !== '') setFilter(saved);
    });
  }, []);

  const onFilterChange = (e) => {
    const val = e.currentTarget.value;
    setFilter(val);
    chrome.storage.local.set({ mdhProvenanceFilter: val });
  };

  useEffect(() => {
    let cancelled = false;
    const forceRefresh = refreshNonce > 0;

    (async () => {
      const ctx = await runInTab(tab.id, readCurrentContext);
      if (cancelled) return;
      if (!ctx) {
        setState({ kind: 'message', message: 'Reload the Rossum tab, then reopen this popup.' });
        return;
      }
      if (!ctx.token) {
        setState({ kind: 'message', message: 'Not signed in to Rossum.', isError: true });
        return;
      }
      if (!ctx.annotationId) {
        setState({ kind: 'empty' });
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
        if (!forceRefresh) {
          hookEntries = await getCachedHookEntries(ctx.domain, queueId);
        }
        if (cancelled) return;
        if (!hookEntries) {
          const mdhHooks = await loadMdhHooksForQueue(ctx.domain, ctx.token, queueId);
          if (cancelled) return;
          if (mdhHooks.length === 0) {
            setState({ kind: 'message', message: 'No MDH matching hooks on this queue.' });
            return;
          }
          hookEntries = buildHookEntries(mdhHooks, queueId);
          if (hookEntries.length === 0) {
            setState({ kind: 'message', message: 'No MDH configurations apply to this queue.' });
            return;
          }
          setCachedHookEntries(ctx.domain, queueId, hookEntries).catch(() => {});
        }

        const placeholders = new Set();
        for (const { cfgs } of hookEntries) {
          for (const cfg of cfgs) {
            for (const q of cfg.queries) for (const p of q.placeholders) placeholders.add(p);
            for (const p of (cfg.actionConditionPlaceholders || [])) placeholders.add(p);
            if (cfg.dataset) collectPlaceholders(cfg.dataset, placeholders);
          }
        }

        let headerValues = {};
        let rowValues = {};
        let rowCount = 0;
        let types = {};
        let annValuesFromCache = false;
        if (annCache) {
          const cachedPlaceholders = new Set((annCache.placeholders || '').split(',').filter(Boolean));
          const allCovered = [...placeholders].every((p) => cachedPlaceholders.has(p));
          if (allCovered) {
            headerValues = annCache.headerValues || {};
            rowValues = annCache.rowValues || {};
            rowCount = annCache.rowCount || 0;
            types = annCache.types || {};
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
            types = flat.types || {};
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
            types,
            placeholders: [...placeholders].sort().join(','),
          }).catch(() => {});
        }

        // Schema types are authoritative (they mirror what MDH actually injects);
        // the normalized_value heuristic above fills anything the schema misses.
        let schemaTypes = forceRefresh ? null : await getCachedSchemaTypes(ctx.domain, queueId);
        if (!schemaTypes) {
          schemaTypes = await loadSchemaTypesForQueue(ctx.domain, ctx.token, queueId);
          setCachedSchemaTypes(ctx.domain, queueId, schemaTypes).catch(() => {});
        }
        if (cancelled) return;
        types = mergeSchemaTypes(types, schemaTypes);

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

        setState({
          kind: 'loaded',
          ctx,
          queueId,
          annotationModifiedAt,
          hookEntries: resolvedEntries,
          headerValues,
          rowValues,
          rowCount,
          types,
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

  const visibleEntries = state.kind === 'loaded'
    ? filterHookEntries(state.hookEntries, filter)
    : [];
  const trimmedFilter = filter.trim();

  return (
    <section class="card mdh-card" data-context="rossum">
      <h3 class="section-title">
        <span>MDH on this screen <span class="beta-badge">beta</span></span>
        <span class="mdh-head-actions">
          {onPin ? (
            <button
              type="button"
              class="mdh-refresh-btn mdh-pin-btn"
              title="Open in the side panel — stays open while you work"
              onClick={onPin}
            >
              <SidePanelIcon />
            </button>
          ) : null}
          <button
            type="button"
            class="mdh-refresh-btn"
            title="Refresh — bypass cache and re-fetch"
            onClick={onRefresh}
          >
            <RefreshIcon />
          </button>
        </span>
      </h3>
      {state.kind === 'loaded' ? (
        <input
          type="search"
          class="mdh-filter"
          placeholder="Filter by target schema ID"
          value={filter}
          onInput={onFilterChange}
        />
      ) : null}
      <div class="mdh-body">
        {state.kind === 'loading' ? (
          <p class="mdh-empty">Loading…</p>
        ) : state.kind === 'empty' ? (
          <div class="mdh-empty-state">
            <span class="mdh-empty-icon"><DocLookupIcon /></span>
            <p class="mdh-empty-title">Open a document</p>
            <p class="mdh-empty-text">
              This panel reveals the Master Data Hub lookups behind it — each hook's
              match queries, with the document's own field values filled in, so you can
              see exactly what matched, and why.
            </p>
          </div>
        ) : state.kind === 'message' ? (
          <p class={`mdh-empty${state.isError ? ' mdh-error' : ''}`}>{state.message}</p>
        ) : visibleEntries.length === 0 ? (
          <p class="mdh-empty">No configurations match {'“'}{trimmedFilter}{'”'}.</p>
        ) : (
          visibleEntries.map(({ hook, cfgs }) => (
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
                  types={state.types}
                  annotationModifiedAt={state.annotationModifiedAt}
                  currentRow={currentRow}
                  onRowChange={setCurrentRow}
                  forceRefreshNonce={refreshNonce}
                  onOpenInDm={(dataset, pipelineText, variables, variableTypes) =>
                    openConsoleTab(tab, {
                      token: state.ctx.token,
                      domain: state.ctx.domain,
                      pendingCollection: dataset,
                      pendingPipeline: pipelineText,
                      pendingVariables: variables,
                      pendingVariableTypes: variableTypes,
                    }, 'mdh')
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
