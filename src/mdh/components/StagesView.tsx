import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import * as api from '../api.js';
import { stripWriteStages } from '../pipelineOps.js';
import RecordCard from './RecordCard.jsx';
import useStageCounts from '../hooks/useStageCounts.js';
import { hoveredStage, stagesAutoscroll, stagesSampleSize, STAGE_SAMPLE_SIZES, stagesShowDef, stagesSourceOpen, aiAvailable, records } from '../store.js';
import EmptyStageExplain from './EmptyStageExplain.jsx';
import { firstEmptyStage, explainSignature } from '../agent/explainEmpty.js';

const SLOW_QUERY_MS = 1000;
const HIGHLIGHT_MS = 1600; // ≥ the .pipeline-inspect-flash animation (1.5s) so the class outlasts it

const timeCls = (ms: any) => 'pipeline-inspect-time' + (ms > SLOW_QUERY_MS ? ' pipeline-inspect-time-slow' : '');

// One sample document. In the Stages view records are always fully shown — the cards
// are not collapsible (collapsible={false}), so there's no per-card open/close state.
function InspectorDoc({ record, index }: { record: any; index: number }) {
  return (
    <RecordCard
      record={record} index={index} expanded onToggle={() => {}}
      onCopy={() => {}} onEdit={() => {}} onDelete={() => {}}
      sortState={{}} filterState={{}} onSort={() => {}} onFilter={() => {}}
      charBudget={80} indexes={[]} readOnly collapsible={false}
    />
  );
}

function StageToggle(
  { entryIndex, disabled, onToggle }:
  { entryIndex: number; disabled?: boolean; onToggle?: (i: number) => void },
) {
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

function StageHeader({
  toggle, num, label, hint, prevCount, count, ms,
}: {
  toggle?: any; num?: number | string; label?: string; hint?: string;
  prevCount?: any; count?: any; ms?: number | null;
}) {
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
      {hint && <span class="pipeline-inspect-hint">{hint}</span>}
      <span class={countCls}>{countText}</span>
      {typeof ms === 'number' && <span class={timeCls(ms)}>{ms}ms</span>}
    </div>
  );
}

function StageOutput({ info }: { info: any }) {
  if (!info) return <div class="pipeline-inspect-loading">Loading{'…'}</div>;
  if (info.error) {
    return (
      <div class="pipeline-inspect-error">
        {info.error.status ? `HTTP ${info.error.status}: ` : ''}{info.error.message}
      </div>
    );
  }
  if (!info.docs || info.docs.length === 0) {
    return (
      <div class="pipeline-inspect-empty">
        <span class="pipeline-inspect-empty-icon" aria-hidden="true">{'\u26A0'}</span>
        <span>No documents at this stage</span>
      </div>
    );
  }
  return info.docs.map((doc: any, i: any) => <InspectorDoc key={i} record={doc} index={i} />);
}

export default function StagesView({
  collection, entries, rawStages, variables, onToggleStage, inspectTarget,
}: {
  collection: string;
  entries?: any[];
  rawStages?: any[] | null;
  variables?: any[] | null;
  onToggleStage?: (i: number) => void;
  inspectTarget?: { index: number } | null;
}) {
  const [previews, setPreviews] = useState<Record<string, any>>({}); // key: 'input' | activeIndex → { docs } | { error }
  const [highlightIdx, setHighlightIdx] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const list = Array.isArray(entries) ? entries : [];
  const activeStages = list.filter((e) => !e.disabled).map((e) => e.stage);
  const activeKey = JSON.stringify(activeStages);
  const sampleSize = stagesSampleSize.value; // configurable; re-fetches on change
  const autoscroll = stagesAutoscroll.value;
  const showDef = stagesShowDef.value;
  const sourceOpen = stagesSourceOpen.value;
  const { counts, inputInfo } = useStageCounts(collection, activeStages) as { counts: Record<number, any>; inputInfo: any };

  // Stage previews. Deliberately does NOT depend on `sourceOpen`: expanding or
  // collapsing the source card must not clear and refetch every stage. It used
  // to, which threw away all previews, briefly unmounted the empty-stage
  // explanation, and made Mr. Fabry re-investigate from scratch on every toggle.
  useEffect(() => {
    if (!collection) { setPreviews((p) => (p.input ? { input: p.input } : {})); return undefined; }
    setPreviews((p) => (p.input ? { input: p.input } : {}));
    const controller = new AbortController();
    activeStages.forEach((_, i) => {
      const prefix = activeStages.slice(0, i + 1);
      api.aggregate(collection, [...stripWriteStages(prefix), { $limit: sampleSize }], { signal: controller.signal })
        .then((res) => { if (!controller.signal.aborted) setPreviews((p) => ({ ...p, [i]: { docs: res.result || [] } })); })
        .catch((err) => {
          if (err?.name === 'AbortError' || controller.signal.aborted) return;
          setPreviews((p) => ({ ...p, [i]: { error: { message: err?.message || String(err), status: err?.status } } }));
        });
    });
    return () => controller.abort();
  }, [collection, activeKey, sampleSize]);

  // The source sample, fetched only while its card is expanded — collapsed is
  // the default, so this saves one aggregate every time the Stages view opens.
  // The card still shows the document count either way (that is the $collStats
  // probe in useStageCounts, not this sample). Separate from the stage previews
  // above so a toggle costs exactly this one request and nothing else.
  useEffect(() => {
    if (!collection || !sourceOpen) return undefined;
    const controller = new AbortController();
    api.aggregate(collection, [{ $limit: sampleSize }], { signal: controller.signal })
      .then((res) => { if (!controller.signal.aborted) setPreviews((p) => ({ ...p, input: { docs: res.result || [] } })); })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setPreviews((p) => ({ ...p, input: { error: { message: err?.message || String(err), status: err?.status } } }));
      });
    return () => controller.abort();
  }, [collection, sampleSize, sourceOpen]);

  useEffect(() => {
    if (!inspectTarget) return;
    const idx = inspectTarget.index;
    setHighlightIdx(idx);
    const el = rootRef.current?.querySelector(`[data-idx="${idx}"]`);
    el?.scrollIntoView?.({ block: 'start' });
    const t = setTimeout(() => setHighlightIdx((cur) => (cur === idx ? null : cur)), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [inspectTarget]);

  const sectionCls = (idx: any) => 'pipeline-inspect-section' + (highlightIdx === idx ? ' pipeline-inspect-highlight' : '');

  // Honest about disabled stages: "3 of 5" rather than a count that disagrees
  // with the numbered sections right below it.
  const stageCountLabel = list.length === activeStages.length
    ? ` · ${activeStages.length} stage${activeStages.length === 1 ? '' : 's'}`
    : ` · ${activeStages.length} of ${list.length} stages run`;

  // Only the FIRST empty stage is explained: once a stage emits nothing, every
  // later one almost always does too, so the useful question is which stage
  // emptied the result. Waits for the preview to actually resolve — a stage
  // still loading, or one that errored, is not "empty".
  const emptyIdx = aiAvailable.value ? firstEmptyStage(previews, activeStages.length) : -1;
  // The raw form is part of the identity too: swapping a literal for a variable
  // of the same value leaves the substituted stages byte-identical but changes
  // what the right advice is.
  const explainSig = explainSignature(collection, activeStages, emptyIdx, rawStages);

  let activeIdx = -1;

  return (
    <div class="pipeline-inspect" ref={rootRef}>
      <div class="pipeline-inspect-opts">
        <div class="pipeline-inspect-opt">
          <span class="pipeline-inspect-opt-label">Records per stage</span>
          <div class="view-seg" role="group" aria-label="Records per stage">
            {STAGE_SAMPLE_SIZES.map((n) => (
              <button
                key={n}
                type="button"
                class={'view-seg-opt' + (sampleSize === n ? ' on' : '')}
                aria-pressed={sampleSize === n}
                onClick={() => { stagesSampleSize.value = n; }}
              >{n}</button>
            ))}
          </div>
        </div>
        {/* One direction only, since 2026-08-14: hovering a stage here scrolls the
            pipeline editor to it. The editor never scrolls this view — see
            StageLinkOverlay. */}
        <label class="pipeline-inspect-opt pipeline-inspect-autoscroll" title="Scroll the pipeline editor to the stage you hover here">
          <input type="checkbox" checked={autoscroll} onChange={(e) => { stagesAutoscroll.value = e.currentTarget.checked; }} />
          <span>Auto-scroll</span>
        </label>
        <label class="pipeline-inspect-opt pipeline-inspect-autoscroll" title="Show each stage's query with variables substituted (as sent to the Data Storage API)">
          <input type="checkbox" checked={showDef} onChange={(e) => { stagesShowDef.value = e.currentTarget.checked; }} />
          <span>Definitions</span>
        </label>
      </div>
      <div class="pipeline-inspect-scroll">
        {/* The SOURCE, not "stage 0". A MongoDB pipeline has no stage zero: this is
            the collection the pipeline reads FROM. It is deliberately a different
            kind of object from the numbered stages — dashed and unfilled rather
            than solid, unnumbered, and collapsed by default — so the numbered list
            visibly starts at 1. Collapsed also means its sample is never fetched
            (see the preview effect); the doc COUNT still shows, because that comes
            from the $collStats probe, not the sample. */}
        <section class={sectionCls(-1) + ' pipeline-inspect-source'} data-idx="-1">
          <button
            type="button"
            class="pipeline-inspect-source-head"
            aria-expanded={sourceOpen}
            onClick={() => { stagesSourceOpen.value = !sourceOpen; }}
            title={sourceOpen ? 'Hide the sample records' : 'Show what the collection looks like before the pipeline runs'}
          >
            <span class="pipeline-inspect-source-chev" aria-hidden="true">{sourceOpen ? '▾' : '▸'}</span>
            <span class="pipeline-inspect-source-cap">source</span>
            <span class="pipeline-inspect-source-name">{collection || 'collection'}</span>
            <span class="pipeline-inspect-hint">before the pipeline runs</span>
            <span class={'pipeline-inspect-count' + (inputInfo?.count === 0 ? ' pipeline-inspect-zero' : '')}>
              {typeof inputInfo?.count === 'number' ? `${inputInfo.count.toLocaleString()} docs` : '…'}
            </span>
            {typeof inputInfo?.ms === 'number' && <span class={timeCls(inputInfo.ms)}>{inputInfo.ms}ms</span>}
          </button>
          {sourceOpen && (
            <div class="pipeline-inspect-body">
              <div class="pipeline-inspect-output"><StageOutput info={previews.input} /></div>
            </div>
          )}
        </section>
        {list.length > 0 && (
          <div class="pipeline-inspect-start" aria-hidden="true">
            <span>pipeline starts here{stageCountLabel}</span>
          </div>
        )}
        {list.map((entry, entryIndex) => {
          const stage = entry.stage || {};
          const stageKey = Object.keys(stage)[0] || '?';
          if (entry.disabled) {
            return (
              <section
                class="pipeline-inspect-section pipeline-inspect-disabled" key={entryIndex} data-entry={entryIndex}
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
          const myDocs = previews[myIdx]?.docs;
          const isEmptyStage = Array.isArray(myDocs) && myDocs.length === 0;
          const prevCount = myIdx === 0 ? inputInfo?.count : counts[myIdx - 1]?.count;
          return (
            <section
              class={sectionCls(myIdx)} data-idx={myIdx} data-entry={entryIndex} key={entryIndex}
              onMouseEnter={(e) => { hoveredStage.value = { entryIndex, el: e.currentTarget }; }}
              onMouseLeave={() => { hoveredStage.value = null; }}
            >
              <StageHeader
                toggle={<StageToggle entryIndex={entryIndex} disabled={false} onToggle={onToggleStage} />}
                num={`${myIdx + 1}`} label={stageKey} prevCount={prevCount} count={counts[myIdx]?.count} ms={counts[myIdx]?.ms}
              />
              {showDef && (
                <pre class="pipeline-inspect-stagedef">{JSON.stringify(stage, null, 2)}</pre>
              )}
              {/* An empty stage has no records to size, so the fixed 324px band
                  would be a wall of nothing with the message alone at the top —
                  and it would push the explanation below the fold. Let it hug
                  its content instead; the band exists to make RECORDS uniform. */}
              <div class={'pipeline-inspect-body' + (isEmptyStage ? ' pipeline-inspect-body-empty' : '')}>
                <div class="pipeline-inspect-output">
                  <StageOutput info={previews[myIdx]} />
                </div>
              </div>
              {/* Outside `.pipeline-inspect-output` on purpose: that is a
                  horizontal flex ROW of record cards, so a panel placed inside it
                  becomes a card-sized sibling BESIDE the message rather than a
                  full-width block under it. As a section child it spans the
                  section, like the stage-definition block above.
                  `counts` from useStageCounts is an OBJECT keyed by active index,
                  not an array — every other use here is index access, which hides
                  the difference; mapping it as an array threw during render. */}
              {myIdx === emptyIdx && explainSig && (
                <EmptyStageExplain
                  key={explainSig}
                  signature={explainSig}
                  collection={collection}
                  stages={activeStages}
                  rawStages={rawStages}
                  variables={variables}
                  emptyIndex={emptyIdx}
                  counts={activeStages.map((_, i) => counts[i]?.count)}
                  inputCount={inputInfo?.count ?? null}
                  sampleRecords={records.value}
                />
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
