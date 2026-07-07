import { h } from 'preact';
import { useState } from 'preact/hooks';
import { domain, token } from '../store.js';
import { isJson5NumberLiteral } from '../hooks/usePipeline.js';

// True when the typed value can be matched as the given type (drives the
// "won't match" hint). string / null / auto / undefined accept anything.
export function isCompatibleWithType(val, type) {
  if (type === 'number') return isJson5NumberLiteral(val);
  if (type === 'boolean') return val === 'true' || val === 'false';
  return true;
}

const CAP = { string: 'String', number: 'Number', boolean: 'Boolean', null: 'Null' };

// Static tooltip describing what the control is — not a repeat of the resolved
// type, which is already shown in the "Auto (X)" option text.
const TYPE_SELECT_TITLE = 'Data type for this variable in the query — Auto infers it from the matched field';

// What the value-based (Auto, no dataset type) path coerces a value to — mirrors
// renderWholeToken's default branch order. Used to label "Auto (X)".
export function valueBasedType(val) {
  if (val === 'true' || val === 'false') return 'boolean';
  if (val === 'null') return 'null';
  if (isJson5NumberLiteral(val)) return 'number';
  return 'string';
}

// Type options to offer for a variable. Auto/String/Number are always available;
// Boolean only when the value is true/false; Null only when the value is empty or
// 'null' (matching JSON null is pointless otherwise). The current override is
// always included so a previously-saved Boolean/Null choice is never dropped.
export function typeOptionsFor(value, override) {
  const v = value || '';
  const opts = ['auto', 'string', 'number'];
  if (v === 'true' || v === 'false' || override === 'boolean') opts.push('boolean');
  if (v === '' || v === 'null' || override === 'null') opts.push('null');
  return opts;
}

export function parseAnnotationId(input) {
  if (/^\d+$/.test(input)) return input;
  // Matches both the UI URL (e.g. https://<org>.rossum.app/document/12345)
  // and the API URL (e.g. https://elis.rossum.com/api/v1/annotations/12345/content).
  // The two share the annotation ID — only the path segment differs.
  const urlMatch = input.match(/(?:annotations|document)\/(\d+)/);
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

export default function PlaceholderInputs({ names, values, types, onSetValue, onSetType, onRunQuery, resolvedTypeFor }) {
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
            placeholder={"Annotation ID or URL\u2026"}
            style="flex:1"
            onKeyDown={(e) => { if (e.key === 'Enter') loadAnnotation(e.target.value.trim()); }}
            onPaste={(e) => { setTimeout(() => loadAnnotation(e.target.value.trim()), 0); }}
          />
          <span class="placeholder-annotation-status">{annotStatus}</span>
        </div>
      )}
      {names.map((name) => {
        const rt = resolvedTypeFor ? resolvedTypeFor(name) : { type: undefined, autoType: undefined };
        const value = values[name] || '';
        const override = (types && types[name]) || '';
        const autoLabelType = rt.autoType || valueBasedType(value); // what Auto yields, ignoring override
        const autoGuessed = !rt.autoType; // Auto would fall back to value-based inference
        const effective = override || rt.type; // override-first effective type, for the compat check
        const incompatible = value !== '' && !isCompatibleWithType(value, effective);
        return (
          <div class="placeholder-row" key={name}>
            <span class="placeholder-name">{`{${name}}`}</span>
            <input
              class="input placeholder-input"
              value={value}
              onInput={(e) => { onSetValue(name, e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') onRunQuery(); }}
            />
            <select
              class="placeholder-type-select"
              value={override || 'auto'}
              title={TYPE_SELECT_TITLE}
              onChange={(e) => onSetType(name, e.target.value)}
            >
              {typeOptionsFor(value, override).map((opt) => (
                <option value={opt} key={opt}>{opt === 'auto' ? `Auto (${CAP[autoLabelType]}${autoGuessed ? '?' : ''})` : CAP[opt]}</option>
              ))}
            </select>
            {incompatible && (
              <span class="placeholder-warn" title={`This value won't match as ${CAP[effective]}`}>{'⚠'}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
