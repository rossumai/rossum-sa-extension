import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import JSON5 from 'json5';
import { selectedCollection, scopeSuffix } from '../store.js';

const MAX_HISTORY = 30;

// Saved / Recent queries are namespaced per organization (scopeSuffix) so they
// aren't shared across projects. Stored in chrome.storage.local.
async function readList(baseKey) {
  const key = `${baseKey}::${scopeSuffix()}`;
  return (await chrome.storage.local.get(key))?.[key] || [];
}

async function writeList(baseKey, list) {
  const key = `${baseKey}::${scopeSuffix()}`;
  await chrome.storage.local.set({ [key]: list });
}

// Normalize a pipeline string so cosmetic edits (whitespace, key order from
// JSON5 reformatting) don't create duplicate entries. Falls back to the raw
// string if parsing fails.
function dedupKey(collection, pipeline) {
  let normalized = pipeline;
  try { normalized = JSON.stringify(JSON5.parse(pipeline)); } catch { /* keep raw */ }
  return collection + '::' + normalized;
}

export async function addToHistory(collection, pipeline, variables, placeholderTypes) {
  const queryHistory = await readList('queryHistory');
  const key = dedupKey(collection, pipeline);
  const filtered = queryHistory.filter((e) => dedupKey(e.collection, e.pipeline) !== key);
  const entry = { collection, pipeline, ts: Date.now() };
  if (variables && Object.keys(variables).length > 0) entry.variables = variables;
  if (placeholderTypes && Object.keys(placeholderTypes).length > 0) entry.placeholderTypes = placeholderTypes;
  filtered.unshift(entry);
  await writeList('queryHistory', filtered.slice(0, MAX_HISTORY));
}

export async function saveQuery(collection, pipeline, name, variables, placeholderTypes) {
  const savedQueries = await readList('savedQueries');
  const entry = { collection, pipeline, name, ts: Date.now() };
  if (variables && Object.keys(variables).length > 0) entry.variables = variables;
  if (placeholderTypes && Object.keys(placeholderTypes).length > 0) entry.placeholderTypes = placeholderTypes;
  savedQueries.push(entry);
  await writeList('savedQueries', savedQueries);
}

export async function unsaveQuery(collection, pipeline) {
  const savedQueries = await readList('savedQueries');
  const key = dedupKey(collection, pipeline);
  await writeList('savedQueries', savedQueries.filter((q) => dedupKey(q.collection, q.pipeline) !== key));
}

export async function isSaved(collection, pipeline) {
  const savedQueries = await readList('savedQueries');
  const key = dedupKey(collection, pipeline);
  return savedQueries.some((q) => dedupKey(q.collection, q.pipeline) === key);
}

function formatTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function QueryRow({ item, currentCollection, savedName, onLoad, onDismiss, showUnsave, onUnsave }) {
  return (
    <div class={'query-history-item' + (item.collection === currentCollection ? ' query-history-item-current' : '')}>
      <div class="query-history-item-info" onClick={() => { onLoad(item.pipeline, item.collection, item.variables, item.placeholderTypes); onDismiss(); }}>
        <span class="query-history-collection">{item.collection}</span>
        {savedName && <span class="query-history-name">{savedName}</span>}
        <span class="query-history-time">{formatTime(item.ts)}</span>
        <div class="query-history-preview">
          {item.pipeline && item.pipeline.length > 150 ? item.pipeline.slice(0, 150) + '...' : item.pipeline}
        </div>
        {item.variables && Object.keys(item.variables).length > 0 && (
          <div class="query-history-variables">
            {Object.entries(item.variables).filter(([, v]) => v !== '').map(([k, v]) => `{${k}}=${v}`).join(', ')}
          </div>
        )}
      </div>
      {showUnsave && (
        <button class="query-history-unsave-btn" title="Remove from saved" onClick={(e) => { e.stopPropagation(); onUnsave(item); }}>{'\u2605'}</button>
      )}
    </div>
  );
}

function HistoryList({ onLoad, onDismiss }) {
  const [items, setItems] = useState([]);
  const currentCollection = selectedCollection.value;

  useEffect(() => {
    readList('queryHistory').then(setItems);
  }, []);

  if (items.length === 0) {
    return <div class="query-history-list"><div class="query-history-empty">No query history yet</div></div>;
  }

  return (
    <div class="query-history-list">
      {items.map((item) => (
        <QueryRow item={item} currentCollection={currentCollection} onLoad={onLoad} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function SavedList({ onLoad, onDismiss }) {
  const [items, setItems] = useState([]);
  const currentCollection = selectedCollection.value;

  async function refresh() {
    setItems(await readList('savedQueries'));
  }

  useEffect(() => { refresh(); }, []);

  async function handleUnsave(item) {
    await unsaveQuery(item.collection, item.pipeline);
    refresh();
  }

  if (items.length === 0) {
    return <div class="query-history-list"><div class="query-history-empty">No saved queries</div></div>;
  }

  return (
    <div class="query-history-list">
      {items.map((item) => (
        <QueryRow item={item} currentCollection={currentCollection} savedName={item.name} onLoad={onLoad} onDismiss={onDismiss} showUnsave onUnsave={handleUnsave} />
      ))}
    </div>
  );
}

export function LibraryPanel({ tab, onTabChange, onLoad, onDismiss }) {
  return (
    <div class="query-history-panel">
      <div class="library-tabs">
        <button
          class={'library-tab' + (tab === 'saved' ? ' library-tab-active' : '')}
          onClick={() => onTabChange('saved')}
        >Saved</button>
        <button
          class={'library-tab' + (tab === 'recent' ? ' library-tab-active' : '')}
          onClick={() => onTabChange('recent')}
        >Recent</button>
      </div>
      {tab === 'saved'
        ? <SavedList onLoad={onLoad} onDismiss={onDismiss} />
        : <HistoryList onLoad={onLoad} onDismiss={onDismiss} />}
    </div>
  );
}
