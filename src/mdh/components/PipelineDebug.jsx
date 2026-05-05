import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { openModal } from './Modal.jsx';
import * as api from '../api.js';

const DEBUG_PREVIEW_LIMIT = 5;

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

export default function PipelineDebug({ pipeline }) {
  const [stageCounts, setStageCounts] = useState({});
  const collection = selectedCollection.value;

  useEffect(() => {
    if (!collection || !pipeline || pipeline.length === 0) return;
    setStageCounts({});

    // Each prefix runs as its own aggregation, not a $facet branch. Atlas
    // requires $search to be the FIRST stage of the whole pipeline — wrapping
    // it in a $facet sub-pipeline (as we used to) makes Atlas reject the
    // request with "$search is not allowed to be used within a $facet stage".
    // The chattier fan-out is the price of being able to debug $search-based
    // pipelines at all.
    const controller = new AbortController();
    pipeline.forEach((_, i) => {
      const prefix = pipeline.slice(0, i + 1);
      const t0 = performance.now();
      api.aggregate(collection, [...prefix, { $count: 'n' }], { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          const n = res?.result?.[0]?.n ?? 0;
          const ms = Math.round(performance.now() - t0);
          setStageCounts((prev) => ({ ...prev, [i]: { count: n, ms } }));
        })
        .catch((err) => {
          if (err?.name === 'AbortError' || controller.signal.aborted) return;
          const ms = Math.round(performance.now() - t0);
          setStageCounts((prev) => ({
            ...prev,
            [i]: { error: { message: err?.message || String(err), status: err?.status }, ms },
          }));
        });
    });

    return () => controller.abort();
  }, [collection, JSON.stringify(pipeline)]);

  if (!pipeline || pipeline.length === 0) return null;

  function inspectStage(stageIndex, stageKey) {
    const prefix = pipeline.slice(0, stageIndex + 1);
    openModal(`Stage ${stageIndex + 1}: ${stageKey}`, () => <StageInspector collection={collection} prefix={prefix} stageIndex={stageIndex} stageKey={stageKey} />);
  }

  const timingTitle = 'End-to-end latency for the prefix up to this stage (network + server + contention with parallel debug requests). Cumulative — not per-stage MongoDB executor time. Data Storage does not expose explain output.';

  return (
    <div class="pipeline-debug">
      <div class="placeholder-label">Aggregate Pipeline Debug</div>
      {pipeline.map((stage, i) => {
        const stageKey = Object.keys(stage)[0] || '?';
        const stageStr = JSON.stringify(stage);
        const preview = stageStr.length > 50 ? stageStr.slice(0, 50) + '…' : stageStr;
        const info = stageCounts[i];
        let countText = '…';
        let countCls = 'pipeline-debug-count';
        if (info) {
          if (info.error) {
            countText = info.error.status ? `HTTP ${info.error.status}` : 'error';
            countCls += ' pipeline-debug-error';
          } else {
            countText = `${info.count.toLocaleString()} docs`;
            if (info.count === 0) countCls += ' pipeline-debug-zero';
          }
        }

        return (
          <div class="pipeline-debug-stage-wrap">
            <StageTooltip stage={stage}>
              <div class="pipeline-debug-row" onClick={() => inspectStage(i, stageKey)}>
                <span class="pipeline-debug-num">{i + 1}.</span>
                <span class="pipeline-debug-stage">{stageKey}</span>
                <span class="pipeline-debug-preview">{preview}</span>
                <span class="pipeline-debug-arrow">{'→'}</span>
                <span class={countCls}>{countText}</span>
                {info?.ms != null && (
                  <span class="pipeline-debug-time" title={timingTitle}>
                    {info.ms}ms
                  </span>
                )}
              </div>
            </StageTooltip>
            {info?.error && (
              <div class="pipeline-debug-error-detail" onClick={(e) => e.stopPropagation()}>
                <div class="pipeline-debug-error-msg">{info.error.message}</div>
                <div class="pipeline-debug-error-hint">
                  Edit this stage in the pipeline editor above. Errors only show here when a stage fails — they are not the same as a stage that legitimately matches zero documents.
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StageInspector({ collection, prefix, stageIndex, stageKey }) {
  const [docs, setDocs] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.aggregate(collection, [...prefix, { $limit: DEBUG_PREVIEW_LIMIT }])
      .then((res) => setDocs(res.result || []))
      .catch((e) => setErr({ message: e?.message || String(e), status: e?.status }));
  }, []);

  return (
    <div class="modal-body">
      <div class="pipeline-inspect-info">Showing first {DEBUG_PREVIEW_LIMIT} documents after stage {stageIndex + 1} ({stageKey})</div>
      {err && (
        <span style="color:var(--danger)">
          {err.status ? `HTTP ${err.status}: ` : 'Error: '}{err.message}
        </span>
      )}
      {docs && docs.length === 0 && <span style="color:var(--text-secondary)">No documents at this stage</span>}
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
