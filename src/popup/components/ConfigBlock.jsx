import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  configUsesLineItems,
  queryToPipeline,
  replayConfig,
  substitutePlaceholders,
  valuesForRow,
} from '../mdh-provenance.js';
import { getCachedReplay, setCachedReplay } from '../cache.js';
import QueryItem from './QueryItem.jsx';

const PENDING = { status: 'pending' };

export default function ConfigBlock({
  ctx,
  cfg,
  cfgKey,
  headerValues,
  rowValues,
  rowCount,
  annotationModifiedAt,
  currentRow,
  onRowChange,
  forceRefreshNonce,
  onOpenInDm,
}) {
  const usesRows = configUsesLineItems(cfg, rowValues);
  const showPicker = usesRows && rowCount > 1;
  const rowToUse = usesRows ? currentRow : 0;

  const [statuses, setStatuses] = useState(() => cfg.queries.map(() => PENDING));
  const ctrlRef = useRef(null);

  useEffect(() => {
    if (!ctx?.annotationId || cfg.queries.length === 0) return;

    if (ctrlRef.current) ctrlRef.current.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const { signal } = ctrl;

    setStatuses(cfg.queries.map(() => PENDING));

    (async () => {
      if (forceRefreshNonce === 0) {
        const cached = await getCachedReplay(
          ctx.domain,
          ctx.annotationId,
          annotationModifiedAt,
          rowToUse,
          cfgKey,
        );
        if (signal.aborted) return;
        if (cached) {
          setStatuses(cached);
          return;
        }
      }
      const values = usesRows
        ? valuesForRow(headerValues, rowValues, rowToUse)
        : headerValues;
      const finalStatuses = await replayConfig(
        ctx.domain,
        ctx.token,
        cfg,
        values,
        signal,
        (i, st) => {
          if (signal.aborted) return;
          setStatuses((prev) => {
            const next = [...prev];
            next[i] = st;
            return next;
          });
        },
      );
      if (signal.aborted || !finalStatuses) return;
      setCachedReplay(
        ctx.domain,
        ctx.annotationId,
        annotationModifiedAt,
        rowToUse,
        cfgKey,
        finalStatuses,
      ).catch(() => {});
    })();

    return () => ctrl.abort();
  }, [rowToUse, forceRefreshNonce, headerValues, rowValues, annotationModifiedAt]);

  const valuesForCurrentRow = () =>
    usesRows ? valuesForRow(headerValues, rowValues, rowToUse) : headerValues;

  const copyQuery = async (i) => {
    const pipeline = queryToPipeline(cfg.queries[i].raw);
    if (!pipeline) return;
    const substituted = substitutePlaceholders(pipeline, valuesForCurrentRow());
    await navigator.clipboard.writeText(JSON.stringify(substituted, null, 2));
  };

  const openQuery = (i) => {
    const pipeline = queryToPipeline(cfg.queries[i].raw);
    if (!pipeline) return;
    const substituted = substitutePlaceholders(pipeline, valuesForCurrentRow());
    onOpenInDm(cfg.dataset, JSON.stringify(substituted, null, 2));
  };

  return (
    <div class="mdh-cfg">
      {cfg.name ? (
        <div class="mdh-cfg-name" title={cfg.name}>{cfg.name}</div>
      ) : null}
      <div class="mdh-cfg-head">
        <span class="mdh-q-target" title={`target_schema_id: ${cfg.target}`}>{cfg.target}</span>
        <span class="mdh-q-arrow">←</span>
        <span
          class="mdh-q-dataset"
          title={cfg.datasetKey ? `dataset: ${cfg.dataset} · key: ${cfg.datasetKey}` : `dataset: ${cfg.dataset}`}
        >
          {cfg.dataset}
        </span>
      </div>

      {showPicker ? (
        <div class="mdh-row-picker">
          <span class="mdh-row-label">Row</span>
          <select
            class="mdh-row-select"
            value={String(currentRow)}
            onChange={(e) => onRowChange(Number(e.currentTarget.value))}
          >
            {Array.from({ length: rowCount }, (_, i) => (
              <option value={String(i)}>{i + 1}</option>
            ))}
          </select>
          <span class="mdh-row-of">of {rowCount}</span>
        </div>
      ) : null}

      {cfg.queries.length === 0 ? (
        <p class="mdh-empty">No queries.</p>
      ) : (
        <ol class="mdh-query-list">
          {cfg.queries.map((q, i) => (
            <QueryItem
              key={i}
              index={i}
              label={q.label}
              status={statuses[i] || PENDING}
              onCopy={() => copyQuery(i)}
              onOpen={() => openQuery(i)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
