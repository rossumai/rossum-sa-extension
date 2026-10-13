import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  buildHookEntries,
  collectPlaceholders,
  extractIdFromUrl,
  fetchJson,
  fetchQueueHookIds,
  fetchSchemaSig,
  loadAnnotationValues,
  loadMdhHooksForQueue,
  loadSchemaForQueue,
  mergeSchemaTypes,
  provenanceItems,
  sameIds,
  substitutePlaceholders,
  type ProvenanceItem,
} from '../mdh-provenance.js';
import {
  type CachedSchema,
  dropCachedAnnotation,
  getCachedAnnotation,
  getCachedHookEntries,
  getCachedSchema,
  setCachedAnnotation,
  setCachedHookEntries,
  setCachedSchema,
} from '../cache.js';
import { isRateLimited, rateLimitMessage } from '../../net/rateLimit.js';
import { openConsoleTab, runInTab } from '../utils.js';
import { readCurrentContext } from '../tab-readers.js';
import ConfigBlock from './ConfigBlock.jsx';

function RefreshIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
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
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linejoin="round"
    >
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <rect x="13.5" y="4.5" width="7.5" height="15" rx="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function DocLookupIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
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
export default function MdhProvenancePanel({ tab, onPin }: { tab?: any; onPin?: () => void }) {
  const [refreshNonce, setRefreshNonce] = useState(0);
  // A `kind`-discriminated state machine whose arms carry different payloads (ctx, hookEntries,
  // headerValues, ...), so it is read as `any` rather than restated as a nine-arm union.
  const [state, setState] = useState<any>({ kind: 'loading' });
  // Row selection is per TABLE, not per document: one annotation can hold a
  // 4-row tax table beside 23 line items, and a config is scoped to whichever
  // table its target field lives in. A single shared index dragged every config
  // onto the same row number, which does not exist in the smaller table.
  // Configs sharing a table still move together, which is the useful half of
  // the old behaviour.
  const [rowByTable, setRowByTable] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('');

  useEffect(() => {
    chrome.storage.local.get('mdhProvenanceFilter').then((vals) => {
      const saved = vals?.mdhProvenanceFilter;
      if (typeof saved === 'string' && saved !== '') setFilter(saved);
    });
  }, []);

  const onFilterChange = (e: any) => {
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
          setState({
            kind: 'message',
            message: 'Could not resolve queue from URL.',
            isError: true,
          });
          return;
        }

        let hookEntries = null;
        let hadHooks = true;
        // Set when a cached entry must be confirmed in the background (spec 2026-10-13 §4.4).
        let staleHookIds: string[] | null = null;
        if (!forceRefresh) {
          const cached = await getCachedHookEntries(ctx.domain, queueId);
          if (cached) {
            hookEntries = cached.entries;
            hadHooks = cached.hadHooks;
            if (cached.stale) staleHookIds = cached.hookIds;
          }
        }
        if (cancelled) return;
        if (!hookEntries) {
          let hookIds: string[] = [];
          const mdhHooks = await loadMdhHooksForQueue(ctx.domain, ctx.token, queueId, (ids) => {
            hookIds = ids;
          });
          if (cancelled) return;
          hadHooks = mdhHooks.length > 0;
          hookEntries = buildHookEntries(mdhHooks, queueId);
          // An empty list is cached too; `hadHooks` keeps "no hooks" and "no hook applies"
          // apart, which is the message the user reads.
          setCachedHookEntries(ctx.domain, queueId, hookEntries, { hadHooks, hookIds }).catch(
            () => {},
          );
        }

        // The schema carries both the authoritative field types and the lookup
        // fields — a queue can match through lookups alone, with no MDH hook — so
        // it is read BEFORE deciding there is nothing to show.
        const cachedSchema = forceRefresh ? null : await getCachedSchema(ctx.domain, queueId);
        const staleSchema = cachedSchema?.stale ? cachedSchema : null;
        let schema: CachedSchema | null = cachedSchema;
        if (!schema) {
          schema = await loadSchemaForQueue(ctx.domain, ctx.token, queueId);
          setCachedSchema(ctx.domain, queueId, schema).catch(() => {});
        }
        if (cancelled) return;

        // Background checks, after the view renders: confirm a stale hook or schema entry,
        // and the annotation's modified_at when its values came from the cache. A change
        // refetches through refreshNonce; a failed check, a 429 included, counts as "no
        // change" for its own item only, so it cannot discard another check's result.
        const revalidate = (annCheck: 'modified' | 'queue' | null) => {
          (async () => {
            try {
              const settled = await Promise.allSettled([
                staleHookIds ? fetchQueueHookIds(ctx.domain, ctx.token, queueId) : null,
                staleSchema ? fetchSchemaSig(ctx.domain, ctx.token, queueId) : null,
                annCheck
                  ? fetchJson(
                      `${ctx.domain}/api/v1/annotations/${ctx.annotationId}?fields=${
                        annCheck === 'queue' ? 'queue' : 'modified_at'
                      }`,
                      ctx.token,
                    )
                  : null,
              ]);
              const [hookIdsNow, sigNow, ann] = settled.map((r) =>
                r.status === 'fulfilled' ? r.value : null,
              );
              if (cancelled) return;
              const hooksChanged =
                !!staleHookIds && !!hookIdsNow && !sameIds(hookIdsNow, staleHookIds);
              // A null signature (empty list, no modified_at, a failed check) is unknown,
              // not changed: it neither refetches nor restarts the window.
              const schemaChanged = !!staleSchema && sigNow !== null && sigNow !== staleSchema.sig;
              // The empty path holds no values, so only a move to another queue matters.
              const annChanged =
                annCheck === 'queue'
                  ? !!ann?.queue && extractIdFromUrl(ann.queue) !== String(queueId)
                  : !!ann?.modified_at && ann.modified_at !== annotationModifiedAt;
              if (staleSchema && sigNow === staleSchema.sig) {
                // Unchanged: the schema's 5-minute window starts again.
                const { types, lookups, order, sig } = staleSchema;
                setCachedSchema(ctx.domain, queueId, { types, lookups, order, sig }).catch(
                  () => {},
                );
              }
              if (annChanged) await dropCachedAnnotation(ctx.domain, ctx.annotationId);
              if (cancelled) return;
              if (hooksChanged || schemaChanged || annChanged) setRefreshNonce((n) => n + 1);
            } catch {
              // best-effort; keep the cached view
            }
          })();
        };

        const lookupCfgs = schema.lookups || [];
        if (hookEntries.length === 0 && lookupCfgs.length === 0) {
          // Remember the annotation's queue too, so the next open skips the annotation
          // GET. Its values are empty, so a hook added later finds nothing "covered".
          if (!annCache && annotationModifiedAt) {
            setCachedAnnotation(ctx.domain, ctx.annotationId, {
              modifiedAt: annotationModifiedAt,
              queueId,
              headerValues: {},
              rowValues: {},
              rowCount: 0,
              tables: [],
              types: {},
              lookupResults: {},
              placeholders: '',
              lookupIds: '',
            }).catch(() => {});
          }
          setState({
            kind: 'message',
            message: hadHooks
              ? 'No MDH configurations apply to this queue.'
              : 'No MDH matching on this queue.',
          });
          revalidate(annCache ? 'queue' : null);
          return;
        }
        const lookupIds = new Set<string>(lookupCfgs.map((c: any) => c.target));

        const placeholders = new Set<string>();
        for (const { cfgs } of hookEntries) {
          for (const cfg of cfgs) {
            for (const q of cfg.queries) for (const p of q.placeholders) placeholders.add(p);
            for (const p of cfg.actionConditionPlaceholders || []) placeholders.add(p);
            if (cfg.dataset) collectPlaceholders(cfg.dataset, placeholders);
          }
        }

        let headerValues = {};
        let rowValues = {};
        let rowCount = 0;
        let tables = [];
        let types = {};
        let lookupResults = {};
        let annValuesFromCache = false;
        if (annCache) {
          const cachedPlaceholders = new Set(
            (annCache.placeholders || '').split(',').filter(Boolean),
          );
          const cachedLookupIds = new Set((annCache.lookupIds || '').split(',').filter(Boolean));
          const allCovered =
            [...placeholders].every((p) => cachedPlaceholders.has(p)) &&
            [...lookupIds].every((p) => cachedLookupIds.has(p));
          if (allCovered) {
            headerValues = annCache.headerValues || {};
            rowValues = annCache.rowValues || {};
            rowCount = annCache.rowCount || 0;
            tables = annCache.tables || [];
            types = annCache.types || {};
            lookupResults = annCache.lookupResults || {};
            annValuesFromCache = true;
          }
        }
        if (
          !annValuesFromCache &&
          ctx.annotationId &&
          (placeholders.size > 0 || lookupIds.size > 0)
        ) {
          try {
            const flat = await loadAnnotationValues(
              ctx.domain,
              ctx.token,
              ctx.annotationId,
              placeholders,
              lookupIds,
            );
            if (cancelled) return;
            headerValues = flat.headerValues;
            rowValues = flat.rowValues;
            rowCount = flat.rowCount;
            tables = flat.tables || [];
            types = flat.types || {};
            lookupResults = flat.lookupResults || {};
          } catch (err) {
            // A 429 must not be cached as empty values (spec 2026-10-13 §4.4).
            if (isRateLimited(err)) throw err;
            // anything else: leave defaults
          }
        }
        if (!annValuesFromCache && ctx.annotationId && annotationModifiedAt) {
          setCachedAnnotation(ctx.domain, ctx.annotationId, {
            modifiedAt: annotationModifiedAt,
            queueId,
            headerValues,
            rowValues,
            rowCount,
            tables,
            types,
            lookupResults,
            placeholders: [...placeholders].sort().join(','),
            lookupIds: [...lookupIds].sort().join(','),
          }).catch(() => {});
        }

        // Schema types are authoritative (they mirror what MDH actually injects);
        // the normalized_value heuristic above fills anything the schema misses.
        types = mergeSchemaTypes(types, schema.types);

        // Resolve placeholder-driven dataset names (e.g. `dataset: "{mdh_dataset_pos}"`)
        // against the schema's default values, which live on the annotation as header fields.
        const resolvedEntries = hookEntries.map(({ hook, cfgs }) => ({
          hook,
          cfgs: cfgs.map((cfg: any) => {
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
          lookupCfgs,
          lookupResults,
          schemaOrder: schema.order || {},
          headerValues,
          rowValues,
          rowCount,
          tables,
          types,
        });
        setRowByTable({});

        revalidate(annValuesFromCache ? 'modified' : null);
      } catch (e: any) {
        if (cancelled) return;
        if (isRateLimited(e)) {
          setState({ kind: 'message', message: rateLimitMessage(e), isError: true });
          return;
        }
        const msg = String(e?.message || e || 'Failed to load');
        if (msg.includes('401')) {
          setState({ kind: 'message', message: 'Not signed in to Rossum.', isError: true });
        } else {
          setState({ kind: 'message', message: `Failed: ${msg}`, isError: true });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const onRefresh = () => {
    setState({ kind: 'loading' });
    setRefreshNonce((n) => n + 1);
  };

  // One list across hooks and lookup fields, in schema order (see provenanceItems).
  const visibleItems =
    state.kind === 'loaded'
      ? provenanceItems(state.hookEntries, state.lookupCfgs, state.schemaOrder, filter)
      : [];

  const renderItem = ({ key, cfg, hook }: ProvenanceItem) => (
    <ConfigBlock
      key={key}
      ctx={state.ctx}
      cfg={cfg}
      cfgKey={key}
      queueId={state.queueId}
      source={
        hook
          ? {
              label: hook.name || `Hook ${hook.id}`,
              url: `${state.ctx.domain}/extensions/my-extensions/${hook.id}`,
            }
          : {
              label: 'Lookup field',
              url: `${state.ctx.domain}/queues/${state.queueId}/settings/fields/${cfg.target}`,
            }
      }
      headerValues={state.headerValues}
      rowValues={state.rowValues}
      tables={state.tables}
      types={state.types}
      lookupResults={state.lookupResults}
      annotationModifiedAt={state.annotationModifiedAt}
      rowByTable={rowByTable}
      onRowChange={(tableSchemaId, idx) =>
        setRowByTable((prev) => ({ ...prev, [tableSchemaId]: idx }))
      }
      forceRefreshNonce={refreshNonce}
      onOpenInDm={(dataset, pipelineText, variables, variableTypes) =>
        openConsoleTab(
          tab,
          {
            token: state.ctx.token,
            domain: state.ctx.domain,
            pendingCollection: dataset,
            pendingPipeline: pipelineText,
            pendingVariables: variables,
            pendingVariableTypes: variableTypes,
          },
          'mdh',
        )
      }
    />
  );
  const trimmedFilter = filter.trim();

  return (
    <section class="card mdh-card" data-context="rossum">
      <h3 class="section-title">
        <span>
          Matching provenance <span class="beta-badge">beta</span>
        </span>
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
            <span class="mdh-empty-icon">
              <DocLookupIcon />
            </span>
            <p class="mdh-empty-title">Open a document</p>
            <p class="mdh-empty-text">
              This panel reveals the Master Data Hub lookups behind it — each hook's match queries,
              with the document's own field values filled in, so you can see exactly what matched,
              and why.
            </p>
          </div>
        ) : state.kind === 'message' ? (
          <p class={`mdh-empty${state.isError ? ' mdh-error' : ''}`}>{state.message}</p>
        ) : visibleItems.length === 0 ? (
          <p class="mdh-empty">
            No configurations match {'“'}
            {trimmedFilter}
            {'”'}.
          </p>
        ) : (
          visibleItems.map(renderItem)
        )}
      </div>
    </section>
  );
}
