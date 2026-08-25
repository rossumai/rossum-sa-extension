import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  buildVariableTypes,
  configUsesLineItems,
  evaluateCfgCondition,
  queryToPipeline,
  replayConfig,
  rowScopeForConfig,
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
  tables,
  types,
  annotationModifiedAt,
  rowByTable,
  onRowChange,
  forceRefreshNonce,
  onOpenInDm,
}: {
  ctx: any;
  cfg: any;
  cfgKey: string;
  headerValues: Record<string, any>;
  rowValues: Record<string, any[]>;
  tables: any[];
  types: Record<string, string>;
  /** `null` when the annotation has never been modified. */
  annotationModifiedAt?: string | number | null;
  rowByTable: Record<string, number>;
  onRowChange: (table: string, index: number) => void;
  forceRefreshNonce?: unknown;
  onOpenInDm: (collection: string, pipeline: string, variables: Record<string, string>, variableTypes: Record<string, string>) => void;
}) {
  const usesRows = configUsesLineItems(cfg, rowValues);
  // The rows this config can walk belong to ONE table — the one holding its
  // target field (see rowScopeForConfig). Before this, the picker offered the
  // largest row count in the whole document, so a config writing into a 4-row
  // tax table was offered 23 line-item rows and rows 5+ replayed against empty
  // values MDH would never substitute.
  const scope = rowScopeForConfig(cfg, tables);
  const showPicker = usesRows && scope != null && scope.rowCount > 1;
  // Clamp rather than trust the stored index: a selection made while another
  // table was in view (or before an edit shortened this one) must not fall off
  // the end and silently substitute empty strings.
  const rowToUse = usesRows && scope
    ? Math.min(rowByTable?.[scope.tableSchemaId] ?? 0, Math.max(scope.rowCount - 1, 0))
    : 0;

  const [statuses, setStatuses] = useState(() => cfg.queries.map(() => PENDING));
  const ctrlRef = useRef<AbortController | null>(null);

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
          setStatuses((prev: any) => {
            const next = [...prev];
            next[i] = st;
            return next;
          });
        },
        types,
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

  const condInfo = useMemo(
    () => evaluateCfgCondition(cfg, valuesForCurrentRow(), types),
    [cfg, headerValues, rowValues, types, rowToUse, usesRows],
  );

  // The condition status drives two pieces of UI: a strike-through on the
  // target name when the cfg is gated out (false), and a faint caption row
  // showing the raw expression (errors render the caption in danger color;
  // the substituted form and evaluator error are revealed in the tooltip).
  const condTooltip = (() => {
    if (!condInfo.hasCondition) return null;
    const lines = [];
    if (condInfo.error) {
      lines.push('action_condition failed to evaluate');
    } else {
      lines.push(condInfo.result
        ? 'action_condition evaluates true — cfg runs'
        : 'action_condition evaluates false — cfg is skipped');
    }
    lines.push(`expression: ${cfg.actionCondition}`);
    if (condInfo.substituted && condInfo.substituted !== cfg.actionCondition) {
      lines.push(`evaluated: ${condInfo.substituted}`);
    }
    if (condInfo.error) lines.push(`error: ${condInfo.error}`);
    return lines.join('\n');
  })();
  const headGated = condInfo.hasCondition && condInfo.result === false && !condInfo.error;

  const copyQuery = async (i: any) => {
    const pipeline = queryToPipeline(cfg.queries[i].raw);
    if (!pipeline) return;
    const substituted = substitutePlaceholders(pipeline, valuesForCurrentRow(), types);
    await navigator.clipboard.writeText(JSON.stringify(substituted, null, 2));
  };

  const openQuery = (i: any) => {
    const q = cfg.queries[i];
    const pipeline = queryToPipeline(q.raw);
    if (!pipeline) return;
    // Keep placeholders verbatim so the editor shows them as live variables.
    // Pass the current row's values AND the resolved types so the editor
    // reproduces this replay exactly (types propagate, not just values).
    const values = valuesForCurrentRow();
    const variables: Record<string, string> = {};
    for (const name of q.placeholders) {
      if (name in values) variables[name] = String(values[name]);
    }
    const variableTypes = buildVariableTypes(q.placeholders, types);
    onOpenInDm(cfg.dataset, JSON.stringify(pipeline, null, 2), variables, variableTypes);
  };

  return (
    <div class="mdh-cfg">
      {cfg.name ? (
        <div class="mdh-cfg-name" title={cfg.name}>{cfg.name}</div>
      ) : null}
      <div class={`mdh-cfg-head${headGated ? ' mdh-cfg-head--gated' : ''}`}>
        <span class="mdh-q-target" title={`target_schema_id: ${cfg.target}`}>{cfg.target}</span>
        <span class="mdh-q-arrow">←</span>
        <span
          class="mdh-q-dataset"
          title={cfg.datasetKey ? `dataset: ${cfg.dataset} · key: ${cfg.datasetKey}` : `dataset: ${cfg.dataset}`}
        >
          {cfg.dataset}
        </span>
      </div>

      {condInfo.hasCondition ? (
        <div
          class={`mdh-cfg-cond-caption${condInfo.error ? ' mdh-cfg-cond-caption--error' : ''}`}
          title={condTooltip as string | undefined}
        >
          <code class="mdh-cfg-cond-expr">{cfg.actionCondition}</code>
        </div>
      ) : null}

      {showPicker ? (
        <div class="mdh-row-picker">
          <span class="mdh-row-label">Row</span>
          <select
            class="mdh-row-select"
            value={String(rowToUse)}
            onChange={(e) => onRowChange(scope.tableSchemaId, Number(e.currentTarget.value))}
          >
            {Array.from({ length: scope.rowCount }, (_, i) => (
              <option value={String(i)}>{i + 1}</option>
            ))}
          </select>
          <span class="mdh-row-of">of {scope.rowCount}</span>
          <span
            class="mdh-row-table"
            title={`These rows are the “${scope.tableSchemaId}” table — the table holding ${cfg.target}`}
          >
            {scope.tableSchemaId}
          </span>
        </div>
      ) : null}

      {cfg.queries.length === 0 ? (
        <p class="mdh-empty">No queries.</p>
      ) : (
        <ol class="mdh-query-list">
          {cfg.queries.map((q: any, i: any) => (
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
