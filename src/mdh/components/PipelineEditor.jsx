import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection, records } from '../store.js';
import { extractFieldNames } from './JsonEditor.jsx';
import JsonEditor from './JsonEditor.jsx';
import { HistoryPanel, SavedPanel, saveQuery, unsaveQuery, isSaved } from './QueryHistory.jsx';
import AiInsight from './AiInsight.jsx';
import JSON5 from 'json5';

export default function PipelineEditor({ editorRef, initialValue, onChange, onValidChange, onLoadPipeline }) {
  const [savedState, setSavedState] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [popupPos, setPopupPos] = useState(null); // { top, left }
  const [validPipeline, setValidPipeline] = useState(() => {
    try { JSON5.parse(initialValue); return initialValue.trim(); } catch { return null; }
  });
  const saveInputRef = useRef(null);

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
    setShowHistory(false);
    setShowSaved(false);
    onLoadPipeline(pipeline, collection, variables);
  }

  return (
    <div style="display:flex;flex-direction:column;flex:1;min-height:0">
      <div class="pipeline-header">
        <span class="split-pane-label">Aggregate Pipeline</span>
        <div class="pipeline-header-actions">
          <button
            class={'pipeline-save-btn' + (savedState ? ' pipeline-save-btn-active' : '')}
            title="Save current query"
            onClick={handleSave}
          >
            {savedState ? '\u2605' : '\u2606'}
          </button>
          <button class="pipeline-action-btn" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPopupPos({ top: r.bottom + 4, left: r.left }); setShowSaved(!showSaved); setShowHistory(false); }}>Saved Queries</button>
          <button class="pipeline-action-btn" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPopupPos({ top: r.bottom + 4, left: r.left }); setShowHistory(!showHistory); setShowSaved(false); }}>Query History</button>
          <button class="pipeline-action-btn" onClick={beautify}>Beautify</button>
        </div>
        {showSaveInput && (
          <div class="pipeline-save-inline">
            <input ref={saveInputRef} class="input" placeholder="Query name\u2026" onKeyDown={(e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') setShowSaveInput(false); }} />
            <button class="btn btn-sm btn-primary" onClick={doSave}>Save</button>
          </div>
        )}
      </div>
      {(showHistory || showSaved) && popupPos && (
        <div class="query-panel-backdrop" onClick={() => { setShowHistory(false); setShowSaved(false); }}>
          <div style={`position:fixed;top:${popupPos.top}px;left:${popupPos.left}px;z-index:1000`} onClick={(e) => e.stopPropagation()}>
            {showHistory && <HistoryPanel onLoad={loadFromPanel} onDismiss={() => setShowHistory(false)} />}
            {showSaved && <SavedPanel onLoad={loadFromPanel} onDismiss={() => setShowSaved(false)} />}
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
