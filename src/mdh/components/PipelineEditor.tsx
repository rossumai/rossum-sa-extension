import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection, records, sampledFields, aiAvailable } from '../store.js';
import { extractFieldNames } from './JsonEditor.jsx';
import JsonEditor from './JsonEditor.jsx';
import { LibraryPanel, saveQuery, unsaveQuery, isSaved } from './QueryHistory.jsx';
import { beautifyText } from '../pipelineComments.js';
import AgentBox from './AgentBox.jsx';
import type { JsonEditorHandle } from './JsonEditor.jsx';

export default function PipelineEditor({
  editorRef,
  initialValue,
  onChange,
  onValidChange,
  onLoadPipeline,
  onReset,
  onToggleStage,
  onCursorStage,
  onHoverStage,
}: {
  editorRef: { current: JsonEditorHandle | null };
  initialValue?: string;
  onChange: (next: string) => void;
  onValidChange: (valid?: boolean) => void;
  onLoadPipeline: (pipeline: any, collection: any, variables?: any, placeholderTypes?: any) => void;
  onReset: () => void;
  onToggleStage?: (i: number) => void;
  onCursorStage?: (i: number | null) => void;
  onHoverStage?: (i: number | null) => void;
}) {
  const [savedState, setSavedState] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryTab, setLibraryTab] = useState('saved');
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [popupPos, setPopupPos] = useState<any>(null); // { top, left }
  const saveInputRef = useRef<HTMLInputElement | null>(null);

  // Close the overflow menu when clicking outside it
  useEffect(() => {
    if (!overflowOpen) return;
    function onClick(e: any) {
      if (!e.target.closest('.pipeline-overflow-wrap')) setOverflowOpen(false);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [overflowOpen]);

  // Close the save-query input on click outside or scroll
  useEffect(() => {
    if (!showSaveInput) return;
    function onMouseDown(e: any) {
      if (e.target.closest('.pipeline-save-inline')) return;
      if (e.target.closest('.pipeline-save-btn')) return;
      setShowSaveInput(false);
    }
    function onScroll() {
      setShowSaveInput(false);
    }
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
    const saved = await isSaved(col, editorRef.current!.getValue());
    setSavedState(saved);
  }

  useEffect(() => {
    updateSaveBtn();
  }, [selectedCollection.value]);

  function beautify() {
    if (!editorRef.current) return;
    const out = beautifyText(editorRef.current!.getValue());
    if (out != null) editorRef.current.setValue(out);
  }

  async function handleSave() {
    const collection = selectedCollection.value;
    if (!collection || !editorRef.current) return;
    if (savedState) {
      await unsaveQuery(collection, editorRef.current!.getValue());
      updateSaveBtn();
      return;
    }
    setShowSaveInput(true);
    setTimeout(() => saveInputRef.current?.focus(), 0);
  }

  async function doSave() {
    const name = saveInputRef.current?.value.trim();
    const collection = selectedCollection.value;
    await saveQuery(collection, editorRef.current!.getValue(), name || null, {});
    setShowSaveInput(false);
    updateSaveBtn();
  }

  function loadFromPanel(pipeline: any, collection: any, variables: any, placeholderTypes: any) {
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
          >
            Library {'\u25BE'}
          </button>
          <button
            class="pipeline-action-btn"
            title="Reset sort, filter, and pipeline to the default"
            onClick={onReset}
          >
            Reset
          </button>
          <div class="pipeline-overflow-wrap">
            <button
              class="pipeline-action-btn pipeline-overflow-btn"
              title="More actions"
              onClick={(e) => {
                e.stopPropagation();
                setOverflowOpen(!overflowOpen);
                setLibraryOpen(false);
              }}
            >
              {'\u22EF'}
            </button>
            {overflowOpen && (
              <div class="toolbar-more-menu">
                <button
                  class="toolbar-menu-item"
                  onClick={() => {
                    setOverflowOpen(false);
                    beautify();
                  }}
                >
                  Beautify
                </button>
              </div>
            )}
          </div>
        </div>
        {showSaveInput && (
          <div class="pipeline-save-inline">
            <input
              ref={saveInputRef}
              class="input"
              placeholder="Query name…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') doSave();
                if (e.key === 'Escape') setShowSaveInput(false);
              }}
            />
            <button class="btn btn-sm btn-primary" onClick={doSave}>
              Save
            </button>
          </div>
        )}
      </div>
      {libraryOpen && popupPos && (
        <div class="query-panel-backdrop" onClick={() => setLibraryOpen(false)}>
          <div
            style={`position:fixed;top:${popupPos.top}px;left:${popupPos.left}px;z-index:1000`}
            onClick={(e) => e.stopPropagation()}
          >
            <LibraryPanel
              tab={libraryTab}
              onTabChange={setLibraryTab}
              onLoad={loadFromPanel}
              onDismiss={() => setLibraryOpen(false)}
            />
          </div>
        </div>
      )}
      {aiAvailable.value && <AgentBox editorRef={editorRef} />}
      <div style="display:flex;flex:1;min-height:0">
        <JsonEditor
          value={initialValue}
          mode="aggregate"
          fields={fieldsFn}
          editorRef={editorRef}
          onChange={onChange}
          onToggleStage={onToggleStage}
          onCursorStage={onCursorStage}
          onHoverStage={onHoverStage}
          onValidChange={() => {
            onValidChange();
            updateSaveBtn();
          }}
        />
      </div>
    </div>
  );
}
