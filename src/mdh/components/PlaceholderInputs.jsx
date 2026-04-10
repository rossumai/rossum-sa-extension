import { h } from 'preact';
import { useState } from 'preact/hooks';
import { domain, token } from '../store.js';

function parseAnnotationId(input) {
  if (/^\d+$/.test(input)) return input;
  const urlMatch = input.match(/annotations\/(\d+)/);
  return urlMatch ? urlMatch[1] : null;
}

async function fetchAnnotationFields(annotId) {
  const res = await fetch(`${domain.value}/api/v1/annotations/${annotId}/content`, {
    headers: { Authorization: `Bearer ${token.value}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  const fields = {};
  extractDatapoints(data.results || data.content || [], fields);
  return fields;
}

function extractDatapoints(nodes, fields) {
  for (const node of nodes) {
    if (node.schema_id && node.content && node.content.value != null && node.content.value !== '') {
      fields[node.schema_id] = String(node.content.value);
    }
    if (node.children) extractDatapoints(node.children, fields);
  }
}

export default function PlaceholderInputs({ names, values, onSetValue, onRunQuery }) {
  const [annotRow, setAnnotRow] = useState(false);
  const [annotStatus, setAnnotStatus] = useState('');

  if (names.length === 0) return null;

  async function loadAnnotation(val) {
    const annotId = parseAnnotationId(val);
    if (!annotId) { setAnnotStatus('Invalid ID'); return; }
    setAnnotStatus('Loading\u2026');
    try {
      const fields = await fetchAnnotationFields(annotId);
      let filled = 0;
      for (const name of names) {
        if (name in fields) { onSetValue(name, fields[name]); filled++; }
      }
      setAnnotStatus(filled > 0 ? `${filled} filled` : 'No matches');
      if (filled > 0) onRunQuery();
    } catch (err) {
      setAnnotStatus(err.message.length > 30 ? err.message.slice(0, 30) + '\u2026' : err.message);
    }
  }

  return (
    <div class="placeholder-container">
      <div class="placeholder-header">
        <div class="placeholder-label">Variables</div>
        <button class="placeholder-annotation-btn" onClick={() => setAnnotRow(!annotRow)}>Fill from Annotation</button>
      </div>
      {annotRow && (
        <div class="placeholder-annotation-row">
          <input
            class="input"
            placeholder="Annotation ID or URL\u2026"
            style="flex:1"
            onKeyDown={(e) => { if (e.key === 'Enter') loadAnnotation(e.target.value.trim()); }}
            onPaste={(e) => { setTimeout(() => loadAnnotation(e.target.value.trim()), 0); }}
          />
          <span class="placeholder-annotation-status">{annotStatus}</span>
        </div>
      )}
      {names.map((name) => (
        <div class="placeholder-row" key={name}>
          <span class="placeholder-name">{`{${name}}`}</span>
          <input
            class="input placeholder-input"
            value={values[name] || ''}
            onInput={(e) => {
              onSetValue(name, e.target.value);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') onRunQuery(); }}
          />
        </div>
      ))}
    </div>
  );
}
