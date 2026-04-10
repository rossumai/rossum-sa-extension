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

    pipeline.forEach((_, i) => {
      const prefix = pipeline.slice(0, i + 1);
      api.aggregate(collection, [...prefix, { $count: 'n' }])
        .then((res) => {
          const n = res.result?.[0]?.n ?? 0;
          setStageCounts((prev) => ({ ...prev, [i]: { count: n } }));
        })
        .catch((err) => {
          setStageCounts((prev) => ({ ...prev, [i]: { error: err.message } }));
        });
    });
  }, [collection, JSON.stringify(pipeline)]);

  if (!pipeline || pipeline.length === 0) return null;

  function inspectStage(stageIndex, stageKey) {
    const prefix = pipeline.slice(0, stageIndex + 1);
    openModal(`Stage ${stageIndex + 1}: ${stageKey}`, () => <StageInspector collection={collection} prefix={prefix} stageIndex={stageIndex} stageKey={stageKey} />);
  }

  return (
    <div class="pipeline-debug">
      <div class="placeholder-label">Aggregate Pipeline Debug</div>
      {pipeline.map((stage, i) => {
        const stageKey = Object.keys(stage)[0] || '?';
        const stageStr = JSON.stringify(stage);
        const preview = stageStr.length > 50 ? stageStr.slice(0, 50) + '\u2026' : stageStr;
        const info = stageCounts[i];
        let countText = '\u2026';
        let countCls = 'pipeline-debug-count';
        if (info) {
          if (info.error) { countText = 'error'; countCls += ' pipeline-debug-error'; }
          else { countText = `${info.count.toLocaleString()} docs`; if (info.count === 0) countCls += ' pipeline-debug-zero'; }
        }

        return (
          <StageTooltip stage={stage}>
            <div class="pipeline-debug-row" onClick={() => inspectStage(i, stageKey)}>
              <span class="pipeline-debug-num">{i + 1}.</span>
              <span class="pipeline-debug-stage">{stageKey}</span>
              <span class="pipeline-debug-preview">{preview}</span>
              <span class="pipeline-debug-arrow">{'\u2192'}</span>
              <span class={countCls} title={info?.error || ''}>{countText}</span>
            </div>
          </StageTooltip>
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
      .catch((e) => setErr(e.message));
  }, []);

  return (
    <div class="modal-body">
      <div class="pipeline-inspect-info">Showing first {DEBUG_PREVIEW_LIMIT} documents after stage {stageIndex + 1} ({stageKey})</div>
      <div class="pipeline-inspect-content">
        {err && <span style="color:var(--danger)">Error: {err}</span>}
        {docs && docs.length === 0 && <span style="color:var(--text-secondary)">No documents at this stage</span>}
        {docs && docs.map((doc, i) => (
          <div class="pipeline-inspect-card">
            <div class="pipeline-inspect-card-header">Document {i + 1}</div>
            <pre class="pipeline-inspect-json">{JSON.stringify(doc, null, 2)}</pre>
          </div>
        ))}
        {!docs && !err && 'Loading\u2026'}
      </div>
    </div>
  );
}
