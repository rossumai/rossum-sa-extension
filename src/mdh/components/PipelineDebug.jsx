import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { openModal } from './Modal.jsx';
import * as api from '../api.js';

const DEBUG_PREVIEW_LIMIT = 5;

// Map a stage/input count result ({count} | {error} | undefined) to the count
// cell's text + class. Shared by the per-stage rows and the 0th input row.
function countCell(info) {
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

function StageTooltip({ stage, children }) {
  const [show, setShow] = useState(false);
  const rowRef = useRef(null);
  const tipRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  function onEnter() {
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.top, left: rect.right + 8 });
    setShow(true);
  }

  useEffect(() => {
    if (!show || !tipRef.current) return;
    const tip = tipRef.current;
    const tipRect = tip.getBoundingClientRect();
    let { top, left } = pos;
    // If tooltip goes off-screen right, flip to left of the row
    if (tipRect.right > window.innerWidth - 8) {
      const rowRect = rowRef.current?.getBoundingClientRect();
      if (rowRect) left = rowRect.left - tipRect.width - 8;
    }
    // If goes off bottom, shift up
    if (tipRect.bottom > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - tipRect.height - 8);
    }
    if (top !== pos.top || left !== pos.left) setPos({ top, left });
  }, [show, pos.top, pos.left]);

  return (
    <div ref={rowRef} onMouseEnter={onEnter} onMouseLeave={() => setShow(false)} style="position:relative">
      {children}
      {show && (
        <div ref={tipRef} class="pipeline-debug-tooltip" style={`position:fixed;top:${pos.top}px;left:${pos.left}px`}>
          <pre>{JSON.stringify(stage, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

export default function PipelineDebug({ entries, onToggleStage }) {
  const [stageCounts, setStageCounts] = useState({});
  const [inputInfo, setInputInfo] = useState(null);
  const collection = selectedCollection.value;

  const list = Array.isArray(entries) ? entries : [];
  const activeStages = list.filter((e) => !e.disabled).map((e) => e.stage);
  const activeKey = JSON.stringify(activeStages);

  useEffect(() => {
    if (!collection || activeStages.length === 0) { setStageCounts({}); setInputInfo(null); return; }
    setStageCounts({});
    setInputInfo(null);

    const controller = new AbortController();
    activeStages.forEach((_, i) => {
      const prefix = activeStages.slice(0, i + 1);
      const t0 = performance.now();
      api.aggregate(collection, [...prefix, { $count: 'n' }], { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          const n = res?.result?.[0]?.n ?? 0;
          setStageCounts((prev) => ({ ...prev, [i]: { count: n, ms: Math.round(performance.now() - t0) } }));
        })
        .catch((err) => {
          if (err?.name === 'AbortError' || controller.signal.aborted) return;
          setStageCounts((prev) => ({
            ...prev,
            [i]: { error: { message: err?.message || String(err), status: err?.status }, ms: Math.round(performance.now() - t0) },
          }));
        });
    });

    const inputT0 = performance.now();
    api.aggregate(collection, [{ $collStats: { count: {} } }, { $limit: 1 }], { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setInputInfo({ count: res?.result?.[0]?.count ?? 0, ms: Math.round(performance.now() - inputT0) });
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setInputInfo({ error: { message: err?.message || String(err), status: err?.status }, ms: Math.round(performance.now() - inputT0) });
      });

    return () => controller.abort();
  }, [collection, activeKey]);

  if (list.length === 0) return null;

  function inspectStage(prefix, displayNo, stageKey) {
    openModal(`Stage ${displayNo}: ${stageKey}`, () => <StageInspector collection={collection} prefix={prefix} stageIndex={displayNo - 1} stageKey={stageKey} />);
  }
  function inspectInput() {
    openModal('Input: all records', () => <StageInspector collection={collection} prefix={[]} stageIndex={-1} stageKey="input" isInput />);
  }

  const timingTitle = 'End-to-end latency for the prefix up to this stage (network + server + contention with parallel debug requests). Cumulative — not per-stage MongoDB executor time. Data Storage does not expose explain output.';
  const inputTimingTitle = 'End-to-end latency of the $collStats document count for the whole collection (network + server). This is a metadata count, so it is typically near-instant — not a measure of how long a full scan would take.';
  const inputCell = countCell(inputInfo);

  let activeIdx = -1;
  let displayNo = 0;

  return (
    <div class="pipeline-debug">
      <div class="placeholder-label">Aggregate Pipeline Debug</div>
      <div class="pipeline-debug-stage-wrap">
        <div class="pipeline-debug-row pipeline-debug-input-row" onClick={inspectInput} title="All documents in the collection — the input to stage 1. Click to preview the first few raw documents.">
          <span class="pipeline-stage-toggle-spacer" />
          <span class="pipeline-debug-num">0.</span>
          <span class="pipeline-debug-stage">input</span>
          <span class="pipeline-debug-preview">all records (pipeline input)</span>
          <span class="pipeline-debug-arrow">{'→'}</span>
          <span class={inputCell.cls}>{inputCell.text}</span>
          {inputInfo?.ms != null && (<span class="pipeline-debug-time" title={inputTimingTitle}>{inputInfo.ms}ms</span>)}
        </div>
        {inputInfo?.error && (
          <div class="pipeline-debug-error-detail" onClick={(e) => e.stopPropagation()}>
            <div class="pipeline-debug-error-msg">{inputInfo.error.message}</div>
            <div class="pipeline-debug-error-hint">Couldn{'’'}t read the collection{'’'}s documents.</div>
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
            onClick={(e) => { e.stopPropagation(); onToggleStage && onToggleStage(entryIndex); }}
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
        const prefix = activeStages.slice(0, myActiveIdx + 1);

        return (
          <div class="pipeline-debug-stage-wrap" key={entryIndex}>
            <StageTooltip stage={stage}>
              <div class="pipeline-debug-row" onClick={() => inspectStage(prefix, myDisplayNo, stageKey)}>
                {toggle}
                <span class="pipeline-debug-num">{myDisplayNo}.</span>
                <span class="pipeline-debug-stage">{stageKey}</span>
                <span class="pipeline-debug-preview">{preview}</span>
                <span class="pipeline-debug-arrow">{'→'}</span>
                <span class={countCls}>{countText}</span>
                {info?.ms != null && (<span class="pipeline-debug-time" title={timingTitle}>{info.ms}ms</span>)}
              </div>
            </StageTooltip>
            {info?.error && (
              <div class="pipeline-debug-error-detail" onClick={(e) => e.stopPropagation()}>
                <div class="pipeline-debug-error-msg">{info.error.message}</div>
                <div class="pipeline-debug-error-hint">Edit this stage in the pipeline editor above. Errors only show here when a stage fails — they are not the same as a stage that legitimately matches zero documents.</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StageInspector({ collection, prefix, stageIndex, stageKey, isInput }) {
  const [docs, setDocs] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.aggregate(collection, [...prefix, { $limit: DEBUG_PREVIEW_LIMIT }])
      .then((res) => setDocs(res.result || []))
      .catch((e) => setErr({ message: e?.message || String(e), status: e?.status }));
  }, []);

  return (
    <div class="modal-body">
      <div class="pipeline-inspect-info">
        {isInput
          ? `Showing first ${DEBUG_PREVIEW_LIMIT} documents from the collection (before any stage)`
          : `Showing first ${DEBUG_PREVIEW_LIMIT} documents after stage ${stageIndex + 1} (${stageKey})`}
      </div>
      {err && (
        <span style="color:var(--danger)">
          {err.status ? `HTTP ${err.status}: ` : 'Error: '}{err.message}
        </span>
      )}
      {docs && docs.length === 0 && <span style="color:var(--text-secondary)">{isInput ? 'This collection is empty' : 'No documents at this stage'}</span>}
      {docs && docs.length > 0 && (
        <div class="sample-cards">
          {docs.map((doc, i) => (
            <div class="sample-card">
              <div class="sample-card-header">Document {i + 1}</div>
              <pre class="sample-card-body">{JSON.stringify(doc, null, 2)}</pre>
            </div>
          ))}
        </div>
      )}
      {!docs && !err && 'Loading…'}
    </div>
  );
}
