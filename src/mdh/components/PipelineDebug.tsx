import { h } from 'preact';
import { selectedCollection } from '../store.js';
import useStageCounts from '../hooks/useStageCounts.js';

// A stage/input whose measured end-to-end latency exceeds this is flagged slow
// (the timing turns orange). Matches the threshold the record-list footer used
// before the slow-query warning moved here from the footer.
const SLOW_QUERY_MS = 1000;
const timeCls = (ms: number) =>
  'pipeline-debug-time' + (ms > SLOW_QUERY_MS ? ' pipeline-debug-time-slow' : '');

// Map a stage/input count result ({count} | {error} | undefined) to the count
// cell's text + class. Shared by the per-stage rows and the 0th input row.
function countCell(info: any) {
  if (!info) return { text: '…', cls: 'pipeline-debug-count' };
  if (info.error) {
    return {
      text: info.error.status ? `HTTP ${info.error.status}` : 'error',
      cls: 'pipeline-debug-count pipeline-debug-error',
    };
  }
  return {
    text: `${info.count.toLocaleString()} docs`,
    cls: 'pipeline-debug-count' + (info.count === 0 ? ' pipeline-debug-zero' : ''),
  };
}

export default function PipelineDebug({
  entries,
  onToggleStage,
  onInspectStage,
}: {
  entries?: any[];
  onToggleStage?: (i: number) => void;
  onInspectStage?: (i: number) => void;
}) {
  const collection = selectedCollection.value;

  const list = Array.isArray(entries) ? entries : [];
  const activeStages = list.filter((e) => !e.disabled).map((e) => e.stage);
  const { counts: stageCounts, inputInfo } = useStageCounts(collection as string, activeStages) as {
    counts: Record<number, any>;
    inputInfo: any;
  };

  if (list.length === 0) return null;

  function inspectStage(activeIndex: number) {
    if (onInspectStage) onInspectStage(activeIndex);
  }
  function inspectInput() {
    if (onInspectStage) onInspectStage(-1);
  }

  const timingTitle =
    'End-to-end latency for the prefix up to this stage (network + server + contention with parallel debug requests). Cumulative — not per-stage MongoDB executor time. Data Storage does not expose explain output.';
  const inputTimingTitle =
    'End-to-end latency of the $collStats document count for the whole collection (network + server). This is a metadata count, so it is typically near-instant — not a measure of how long a full scan would take.';
  const inputCell = countCell(inputInfo);

  let activeIdx = -1;
  let displayNo = 0;

  return (
    <div class="pipeline-debug">
      <div class="placeholder-label">Aggregate Pipeline Debug</div>
      <div class="pipeline-debug-stage-wrap">
        <div
          class="pipeline-debug-row pipeline-debug-input-row"
          onClick={inspectInput}
          title="All documents in the collection — the input to stage 1. Click to preview the first few raw documents."
        >
          <span class="pipeline-stage-toggle-spacer" />
          <span class="pipeline-debug-num">0.</span>
          <span class="pipeline-debug-stage">input</span>
          <span class="pipeline-debug-preview">all records (pipeline input)</span>
          <span class="pipeline-debug-arrow">{'→'}</span>
          <span class={inputCell.cls}>{inputCell.text}</span>
          {inputInfo?.ms != null && (
            <span class={timeCls(inputInfo.ms)} title={inputTimingTitle}>
              {inputInfo.ms}ms
            </span>
          )}
        </div>
        {inputInfo?.error && (
          <div class="pipeline-debug-error-detail" onClick={(e) => e.stopPropagation()}>
            <div class="pipeline-debug-error-msg">{inputInfo.error.message}</div>
            <div class="pipeline-debug-error-hint">
              Couldn{'’'}t read the collection{'’'}s documents.
            </div>
          </div>
        )}
      </div>
      {list.map((entry, entryIndex) => {
        const stage = entry.stage || {};
        const stageKey = Object.keys(stage)[0] || '?';
        const stageStr = JSON.stringify(stage);
        const preview = stageStr.length > 50 ? stageStr.slice(0, 50) + '…' : stageStr;
        const toggle = (
          <input
            type="checkbox"
            class={'pipeline-stage-toggle' + (entry.disabled ? ' pipeline-stage-toggle-off' : '')}
            checked={!entry.disabled}
            title={entry.disabled ? 'Enable stage' : 'Disable stage'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleStage && onToggleStage(entryIndex);
            }}
          />
        );

        if (entry.disabled) {
          return (
            <div class="pipeline-debug-stage-wrap" key={entryIndex}>
              <div class="pipeline-debug-row pipeline-debug-disabled">
                {toggle}
                <span class="pipeline-debug-num">{'–'}</span>
                <span class="pipeline-debug-stage">{stageKey}</span>
                <span class="pipeline-debug-preview">{preview}</span>
                <span class="pipeline-debug-disabled-badge">disabled</span>
              </div>
            </div>
          );
        }

        activeIdx += 1;
        displayNo += 1;
        const myActiveIdx = activeIdx;
        const myDisplayNo = displayNo;
        const info = stageCounts[myActiveIdx];
        const { text: countText, cls: countCls } = countCell(info);

        return (
          <div class="pipeline-debug-stage-wrap" key={entryIndex}>
            <div class="pipeline-debug-row" onClick={() => inspectStage(myActiveIdx)}>
              {toggle}
              <span class="pipeline-debug-num">{myDisplayNo}.</span>
              <span class="pipeline-debug-stage">{stageKey}</span>
              <span class="pipeline-debug-preview">{preview}</span>
              <span class="pipeline-debug-arrow">{'→'}</span>
              <span class={countCls}>{countText}</span>
              {info?.ms != null && (
                <span class={timeCls(info.ms)} title={timingTitle}>
                  {info.ms}ms
                </span>
              )}
            </div>
            {info?.error && (
              <div class="pipeline-debug-error-detail" onClick={(e) => e.stopPropagation()}>
                <div class="pipeline-debug-error-msg">{info.error.message}</div>
                <div class="pipeline-debug-error-hint">
                  Edit this stage in the pipeline editor above. Errors only show here when a stage
                  fails — they are not the same as a stage that legitimately matches zero documents.
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
