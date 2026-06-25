import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection, records, sampledFields, aiAvailable, error } from '../store.js';
import { extractFieldNames } from './JsonEditor.jsx';
import JsonEditor from './JsonEditor.jsx';
import { LibraryPanel, saveQuery, unsaveQuery, isSaved } from './QueryHistory.jsx';
import { beautifyText } from '../pipelineComments.js';
import * as api from '../api.js';
import { runAiPipeline } from '../aiPipelineLoop.js';
import { prependAiComment, stripAiComment } from '../llmPipeline.js';
import { getSchemaHints } from '../aiContext.js';

// Whimsical, rotating loader labels shown while the AI works — MongoDB- and
// Rossum-flavored gerunds (aggregation stages + document-AI / Master Data Hub).
const LOADING_WORDS = [
  'Aggregating', 'Unwinding arrays', 'Projecting fields', 'Matching documents',
  'Grouping records', 'Bucketing values', 'Faceting the data', 'Sharding ideas',
  'Indexing hunches', 'Pipelining stages', 'Coalescing results', 'Joining collections',
  'Chasing cursors', 'Extracting meaning', 'Annotating fields', 'Consulting the Hub',
  'Matching master data', 'Hydrating datasets', 'Reconciling line items',
  'Scoring confidence', 'Parsing intent', 'Wrangling Mongo',
];
function randomWord() { return LOADING_WORDS[Math.floor(Math.random() * LOADING_WORDS.length)]; }

export default function PipelineEditor({ editorRef, initialValue, onChange, onValidChange, onLoadPipeline, onReset, onToggleStage, onCursorStage }) {
  const [savedState, setSavedState] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryTab, setLibraryTab] = useState('saved');
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [popupPos, setPopupPos] = useState(null); // { top, left }
  const [nlQuery, setNlQuery] = useState('');
  const [nlLoading, setNlLoading] = useState(false);
  const [nlWord, setNlWord] = useState('');
  const saveInputRef = useRef(null);
  const nlInputRef = useRef(null);
  const nlAbortRef = useRef(null);

  // Abort any in-flight AI request when the editor unmounts.
  useEffect(() => () => { if (nlAbortRef.current) nlAbortRef.current.abort(); }, []);

  // Rotate the whimsical loader label while the AI is working.
  useEffect(() => {
    if (!nlLoading) return undefined;
    setNlWord(randomWord());
    const t = setInterval(() => setNlWord(randomWord()), 1300);
    return () => clearInterval(t);
  }, [nlLoading]);

  // Close the overflow menu when clicking outside it
  useEffect(() => {
    if (!overflowOpen) return;
    function onClick(e) {
      if (!e.target.closest('.pipeline-overflow-wrap')) setOverflowOpen(false);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [overflowOpen]);

  // Close the save-query input on click outside or scroll
  useEffect(() => {
    if (!showSaveInput) return;
    function onMouseDown(e) {
      if (e.target.closest('.pipeline-save-inline')) return;
      if (e.target.closest('.pipeline-save-btn')) return;
      setShowSaveInput(false);
    }
    function onScroll() { setShowSaveInput(false); }
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [showSaveInput]);

  const fieldsFn = () => {
    const merged = new Set([...extractFieldNames(records.value), ...sampledFields.value]);
    return [...merged].sort();
  };

  async function updateSaveBtn() {
    const col = selectedCollection.value;
    if (!col || !editorRef.current) return;
    const saved = await isSaved(col, editorRef.current.getValue());
    setSavedState(saved);
  }

  useEffect(() => { updateSaveBtn(); }, [selectedCollection.value]);

  function beautify() {
    if (!editorRef.current) return;
    const out = beautifyText(editorRef.current.getValue());
    if (out != null) editorRef.current.setValue(out);
  }

  async function handleNlSubmit() {
    const q = nlQuery.trim();
    if (!q || nlLoading || !editorRef.current) return;

    const fields = fieldsFn();
    const collection = selectedCollection.value;
    // Strip any prior AI-request comment so it isn't re-sent as prompt context.
    const currentPipeline = stripAiComment(editorRef.current.getValue()).trim();

    if (nlAbortRef.current) nlAbortRef.current.abort();
    const controller = new AbortController();
    nlAbortRef.current = controller;

    setNlLoading(true);
    try {
      // Schema hints (cached per collection): distinct low-card values + Atlas
      // Search indexes + numeric-string fields. Degrades to no-ops on failure.
      const hints = await getSchemaHints(api, collection, records.value).catch(() => ({}));
      const { pipelineText } = await runAiPipeline({
        api, request: q, fields, collection, currentPipeline,
        // Seed the prompt with a few already-loaded docs so the model uses
        // stored value forms (e.g. NET30 not "net 30") on the first try.
        samples: (records.value || []).slice(0, 3),
        knownValues: hints.knownValues,
        numericStringFields: hints.numericStringFields,
        searchIndexes: hints.searchIndexes,
        signal: controller.signal,
      });
      // No status notice — the applied query and its execution are the feedback.
      if (pipelineText) editorRef.current.setValue(prependAiComment(pipelineText, q));
      setNlQuery('');
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (err.status === 403) { aiAvailable.value = false; return; } // gated mid-session → hide
      error.value = { message: 'AI search failed: ' + err.message };
    } finally {
      setNlLoading(false);
    }
  }

  async function handleSave() {
    const collection = selectedCollection.value;
    if (!collection || !editorRef.current) return;
    if (savedState) {
      await unsaveQuery(collection, editorRef.current.getValue());
      updateSaveBtn();
      return;
    }
    setShowSaveInput(true);
    setTimeout(() => saveInputRef.current?.focus(), 0);
  }

  async function doSave() {
    const name = saveInputRef.current?.value.trim();
    const collection = selectedCollection.value;
    await saveQuery(collection, editorRef.current.getValue(), name || null, {});
    setShowSaveInput(false);
    updateSaveBtn();
  }

  function loadFromPanel(pipeline, collection, variables, placeholderTypes) {
    setLibraryOpen(false);
    onLoadPipeline(pipeline, collection, variables, placeholderTypes);
  }

  return (
    <div style="display:flex;flex-direction:column;flex:1;min-height:0">
      <div class="pipeline-header">
        <span class="split-pane-label">Aggregate Pipeline</span>
        <div class="pipeline-header-actions">
          <button
            class={'pipeline-save-btn' + (savedState ? ' pipeline-save-btn-active' : '')}
            title={savedState ? 'Remove from saved queries' : 'Save current query'}
            onClick={handleSave}
          >
            {savedState ? '\u2605' : '\u2606'}
          </button>
          <button
            class="pipeline-action-btn"
            title="Open saved queries and query history"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPopupPos({ top: r.bottom + 4, left: r.left });
              setLibraryOpen(!libraryOpen);
              setOverflowOpen(false);
            }}
          >Library {'\u25BE'}</button>
          <button
            class="pipeline-action-btn"
            title="Reset sort, filter, and pipeline to the default"
            onClick={onReset}
          >Reset</button>
          <div class="pipeline-overflow-wrap">
            <button
              class="pipeline-action-btn pipeline-overflow-btn"
              title="More actions"
              onClick={(e) => { e.stopPropagation(); setOverflowOpen(!overflowOpen); setLibraryOpen(false); }}
            >{'\u22EF'}</button>
            {overflowOpen && (
              <div class="toolbar-more-menu">
                <button class="toolbar-menu-item" onClick={() => { setOverflowOpen(false); beautify(); }}>Beautify</button>
              </div>
            )}
          </div>
        </div>
        {showSaveInput && (
          <div class="pipeline-save-inline">
            <input ref={saveInputRef} class="input" placeholder="Query name…" onKeyDown={(e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') setShowSaveInput(false); }} />
            <button class="btn btn-sm btn-primary" onClick={doSave}>Save</button>
          </div>
        )}
      </div>
      {libraryOpen && popupPos && (
        <div class="query-panel-backdrop" onClick={() => setLibraryOpen(false)}>
          <div style={`position:fixed;top:${popupPos.top}px;left:${popupPos.left}px;z-index:1000`} onClick={(e) => e.stopPropagation()}>
            <LibraryPanel
              tab={libraryTab}
              onTabChange={setLibraryTab}
              onLoad={loadFromPanel}
              onDismiss={() => setLibraryOpen(false)}
            />
          </div>
        </div>
      )}
      {aiAvailable.value && (
        <div class="nl-search-row">
          <div class="nl-search-wrapper">
            <input
              ref={nlInputRef}
              class={'nl-search-input' + (nlLoading ? ' loading' : '')}
              type="text"
              placeholder="Describe a query in plain English..."
              value={nlLoading ? '' : nlQuery}
              disabled={nlLoading}
              onInput={(e) => setNlQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNlSubmit();
                if (e.key === 'Escape') { setNlQuery(''); nlInputRef.current?.blur(); }
              }}
            />
            {nlLoading && <div class="nl-search-loading">{`${nlWord || 'Aggregating'}…`}</div>}
          </div>
        </div>
      )}
      <div style="display:flex;flex:1;min-height:0">
        <JsonEditor
          value={initialValue}
          mode="aggregate"
          fields={fieldsFn}
          editorRef={editorRef}
          onChange={onChange}
          onToggleStage={onToggleStage}
          onCursorStage={onCursorStage}
          onValidChange={() => {
            onValidChange();
            updateSaveBtn();
          }}
        />
      </div>
    </div>
  );
}
