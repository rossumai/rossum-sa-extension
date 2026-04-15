import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection, records, aiEnabled, aiStatus, error } from '../store.js';
import { extractFieldNames } from './JsonEditor.jsx';
import JsonEditor from './JsonEditor.jsx';
import { LibraryPanel, saveQuery, unsaveQuery, isSaved } from './QueryHistory.jsx';
import AiInsight from './AiInsight.jsx';
import * as ai from '../ai.js';
import JSON5 from 'json5';

export default function PipelineEditor({ editorRef, initialValue, onChange, onValidChange, onLoadPipeline, onReset }) {
  const [savedState, setSavedState] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryTab, setLibraryTab] = useState('saved');
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [popupPos, setPopupPos] = useState(null); // { top, left }
  const [validPipeline, setValidPipeline] = useState(() => {
    try { JSON5.parse(initialValue); return initialValue.trim(); } catch { return null; }
  });
  const [nlQuery, setNlQuery] = useState('');
  const [nlLoading, setNlLoading] = useState(false);
  const saveInputRef = useRef(null);
  const nlInputRef = useRef(null);

  // Close the overflow menu when clicking outside it
  useEffect(() => {
    if (!overflowOpen) return;
    function onClick(e) {
      if (!e.target.closest('.pipeline-overflow-wrap')) setOverflowOpen(false);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [overflowOpen]);

  const fieldsFn = () => extractFieldNames(records.value);

  async function updateSaveBtn() {
    const col = selectedCollection.value;
    if (!col || !editorRef.current) return;
    const saved = await isSaved(col, editorRef.current.getValue());
    setSavedState(saved);
  }

  useEffect(() => { updateSaveBtn(); }, [selectedCollection.value]);

  function beautify() {
    if (!editorRef.current) return;
    try {
      const parsed = JSON5.parse(editorRef.current.getValue());
      editorRef.current.setValue(JSON.stringify(parsed, null, 2));
    } catch { /* invalid JSON, ignore */ }
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

  function loadFromPanel(pipeline, collection, variables) {
    setLibraryOpen(false);
    onLoadPipeline(pipeline, collection, variables);
  }

  async function handleNlSubmit() {
    const q = nlQuery.trim();
    if (!q || nlLoading || !editorRef.current) return;

    const fields = extractFieldNames(records.value);
    const currentPipeline = editorRef.current.getValue().trim();

    const parts = [];
    if (fields.length > 0) parts.push(`Available fields: ${fields.join(', ')}`);
    parts.push(`Current pipeline:\n${currentPipeline}`);
    parts.push(`Request: ${q}`);
    const prompt = parts.join('\n\n');

    setNlLoading(true);
    try {
      const result = await ai.ask(prompt, 'nlsearch', { skipCache: true });
      // Strip markdown code fences if the model wraps the output
      const cleaned = result.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
      editorRef.current.setValue(cleaned);
      setNlQuery('');
    } catch (err) {
      if (err.name !== 'AbortError') {
        error.value = { message: 'AI search failed: ' + err.message };
      }
    } finally {
      setNlLoading(false);
    }
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
      {aiEnabled.value && aiStatus.value === 'ready' && (
        <div class="nl-search-row">
          <div class="nl-search-wrapper">
            <input
              ref={nlInputRef}
              class={'nl-search-input' + (nlLoading ? ' loading' : '')}
              type="text"
              placeholder="Describe a simple query in plain English..."
              value={nlLoading ? '' : nlQuery}
              disabled={nlLoading}
              onInput={(e) => setNlQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNlSubmit();
                if (e.key === 'Escape') { setNlQuery(''); nlInputRef.current?.blur(); }
              }}
            />
            {nlLoading && <div class="nl-search-loading">Generating pipeline...</div>}
          </div>
        </div>
      )}
      <div style="position:relative;display:flex;flex:1;min-height:0">
        <JsonEditor
          value={initialValue}
          mode="aggregate"
          fields={fieldsFn}
          editorRef={editorRef}
          onChange={onChange}
          onValidChange={() => {
            onValidChange();
            updateSaveBtn();
            if (editorRef.current) setValidPipeline(editorRef.current.getValue().trim());
          }}
        />
        <AiInsight input={validPipeline} type="pipeline" mode="overlay" />
      </div>
    </div>
  );
}
