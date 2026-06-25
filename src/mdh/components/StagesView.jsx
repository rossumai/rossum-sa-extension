import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import * as api from '../api.js';
import { stripWriteStages } from '../pipelineOps.js';
import RecordCard from './RecordCard.jsx';
import useStageCounts from '../hooks/useStageCounts.js';
import { hoveredStage } from '../store.js';

const SAMPLE = 10;
const SLOW_QUERY_MS = 1000;
const HIGHLIGHT_MS = 1600; // ≥ the .pipeline-inspect-flash animation (1.5s) so the class outlasts it

const timeCls = (ms) => 'pipeline-inspect-time' + (ms > SLOW_QUERY_MS ? ' pipeline-inspect-time-slow' : '');

// One sample document, expanded by default; its own collapse state.
function InspectorDoc({ record, index }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <RecordCard
      record={record} index={index} expanded={expanded} onToggle={() => setExpanded((v) => !v)}
      onCopy={() => {}} onEdit={() => {}} onDelete={() => {}}
      sortState={{}} filterState={{}} onSort={() => {}} onFilter={() => {}}
      charBudget={80} indexes={[]} readOnly
    />
  );
}

function StageToggle({ entryIndex, disabled, onToggle }) {
  return (
    <input
      type="checkbox"
      class={'pipeline-stage-toggle' + (disabled ? ' pipeline-stage-toggle-off' : '')}
      checked={!disabled}
      title={disabled ? 'Enable stage' : 'Disable stage'}
      onClick={(e) => { e.stopPropagation(); if (onToggle) onToggle(entryIndex); }}
    />
  );
}

function StageHeader({ toggle, num, label, prevCount, count, ms }) {
  let countText = '…';
  let countCls = 'pipeline-inspect-count';
  if (typeof count === 'number') {
    countText = (typeof prevCount === 'number' && prevCount !== count)
      ? `${prevCount.toLocaleString()} ${'→'} ${count.toLocaleString()} docs`
      : `${count.toLocaleString()} docs`;
    if (count === 0) countCls += ' pipeline-inspect-zero';
  }
  return (
    <div class="pipeline-inspect-section-head">
      {toggle || <span class="pipeline-stage-toggle-spacer" />}
      <span class="pipeline-inspect-num">{num}</span>
      <span class="pipeline-inspect-key">{label}</span>
      <span class={countCls}>{countText}</span>
      {typeof ms === 'number' && <span class={timeCls(ms)}>{ms}ms</span>}
    </div>
  );
}

function StageOutput({ info }) {
  if (!info) return <div class="pipeline-inspect-loading">Loading{'…'}</div>;
  if (info.error) {
    return (
      <div class="pipeline-inspect-error">
        {info.error.status ? `HTTP ${info.error.status}: ` : ''}{info.error.message}
      </div>
    );
  }
  if (!info.docs || info.docs.length === 0) return <div class="pipeline-inspect-empty">No documents at this stage</div>;
  return info.docs.map((doc, i) => <InspectorDoc key={i} record={doc} index={i} />);
}

export default function StagesView({ collection, entries, onToggleStage, inspectTarget }) {
  const [previews, setPreviews] = useState({}); // key: 'input' | activeIndex → { docs } | { error }
  const [highlightIdx, setHighlightIdx] = useState(null);
  const rootRef = useRef(null);

  const list = Array.isArray(entries) ? entries : [];
  const activeStages = list.filter((e) => !e.disabled).map((e) => e.stage);
  const activeKey = JSON.stringify(activeStages);
  const { counts, inputInfo } = useStageCounts(collection, activeStages);

  useEffect(() => {
    if (!collection) { setPreviews({}); return; }
    setPreviews({});
    const controller = new AbortController();

    api.aggregate(collection, [{ $limit: SAMPLE }], { signal: controller.signal })
      .then((res) => { if (!controller.signal.aborted) setPreviews((p) => ({ ...p, input: { docs: res.result || [] } })); })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setPreviews((p) => ({ ...p, input: { error: { message: err?.message || String(err), status: err?.status } } }));
      });

    activeStages.forEach((_, i) => {
      const prefix = activeStages.slice(0, i + 1);
      api.aggregate(collection, [...stripWriteStages(prefix), { $limit: SAMPLE }], { signal: controller.signal })
        .then((res) => { if (!controller.signal.aborted) setPreviews((p) => ({ ...p, [i]: { docs: res.result || [] } })); })
        .catch((err) => {
          if (err?.name === 'AbortError' || controller.signal.aborted) return;
          setPreviews((p) => ({ ...p, [i]: { error: { message: err?.message || String(err), status: err?.status } } }));
        });
    });

    return () => controller.abort();
  }, [collection, activeKey]);

  useEffect(() => {
    if (!inspectTarget) return;
    const idx = inspectTarget.index;
    setHighlightIdx(idx);
    const el = rootRef.current?.querySelector(`[data-idx="${idx}"]`);
    el?.scrollIntoView?.({ block: 'start' });
    const t = setTimeout(() => setHighlightIdx((cur) => (cur === idx ? null : cur)), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [inspectTarget]);

  const sectionCls = (idx) => 'pipeline-inspect-section' + (highlightIdx === idx ? ' pipeline-inspect-highlight' : '');

  let activeIdx = -1;

  return (
    <div class="pipeline-inspect" ref={rootRef}>
      <div class="pipeline-inspect-scroll">
        <section class={sectionCls(-1)} data-idx="-1">
          <StageHeader num="0" label="input" count={inputInfo?.count} ms={inputInfo?.ms} />
          <div class="pipeline-inspect-body">
            <div class="pipeline-inspect-output"><StageOutput info={previews.input} /></div>
          </div>
        </section>
        {list.map((entry, entryIndex) => {
          const stage = entry.stage || {};
          const stageKey = Object.keys(stage)[0] || '?';
          if (entry.disabled) {
            return (
              <section
                class="pipeline-inspect-section pipeline-inspect-disabled" key={entryIndex}
                onMouseEnter={(e) => { hoveredStage.value = { entryIndex, el: e.currentTarget }; }}
                onMouseLeave={() => { hoveredStage.value = null; }}
              >
                <div class="pipeline-inspect-section-head">
                  <StageToggle entryIndex={entryIndex} disabled onToggle={onToggleStage} />
                  <span class="pipeline-inspect-num">{'–'}</span>
                  <span class="pipeline-inspect-key">{stageKey}</span>
                  <span class="pipeline-inspect-disabled-badge">disabled {'—'} not executed</span>
                </div>
              </section>
            );
          }
          activeIdx += 1;
          const myIdx = activeIdx;
          const prevCount = myIdx === 0 ? inputInfo?.count : counts[myIdx - 1]?.count;
          return (
            <section
              class={sectionCls(myIdx)} data-idx={myIdx} key={entryIndex}
              onMouseEnter={(e) => { hoveredStage.value = { entryIndex, el: e.currentTarget }; }}
              onMouseLeave={() => { hoveredStage.value = null; }}
            >
              <StageHeader
                toggle={<StageToggle entryIndex={entryIndex} disabled={false} onToggle={onToggleStage} />}
                num={`${myIdx + 1}`} label={stageKey} prevCount={prevCount} count={counts[myIdx]?.count} ms={counts[myIdx]?.ms}
              />
              <div class="pipeline-inspect-body">
                <div class="pipeline-inspect-output"><StageOutput info={previews[myIdx]} /></div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
