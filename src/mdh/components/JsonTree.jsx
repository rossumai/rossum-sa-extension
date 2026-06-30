import { h } from 'preact';
import { useState } from 'preact/hooks';
import { EJSON_TYPES, getEjsonType, formatEjsonValue, displayValue, copyTextFor } from '../displayValue.js';
import { ALT_KEY } from '../platform.js';
import SpecialText from './SpecialText.jsx';

export { displayValue };

export const AUTO_COLLAPSE_FIELD_THRESHOLD = 50;

// Total count of keys + array items, recursively. EJSON-typed values count as leaves.
export function countFields(val) {
  if (val == null || typeof val !== 'object') return 0;
  if (getEjsonType(val)) return 0;
  let n = 0;
  if (Array.isArray(val)) {
    for (const item of val) n += 1 + countFields(item);
  } else {
    for (const key of Object.keys(val)) n += 1 + countFields(val[key]);
  }
  return n;
}

function writeClipboard(text) {
  try {
    return navigator.clipboard.writeText(text);
  } catch {
    return Promise.reject();
  }
}

export function CopyButton({ getText, kind = 'value' }) {
  const [copied, setCopied] = useState(false);

  function handleClick(e) {
    e.stopPropagation();
    e.preventDefault();
    writeClipboard(getText())
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 900);
      })
      .catch(() => {});
  }

  const title = copied ? 'Copied'
    : kind === 'path' ? 'Copy field path'
    : kind === 'json' ? 'Copy as JSON'
    : 'Copy value';

  return (
    <button
      type="button"
      class={'json-tree-copy-btn' + (copied ? ' json-tree-copy-btn-success' : '')}
      title={title}
      aria-label={title}
      onClick={handleClick}
    >{copied ? '✓' : '⧉'}</button>
  );
}

export default function JsonTree({ data, prefix = '', depth = 0, collapseDepth = Infinity, sortState, filterState, onSort, onFilter, readOnly = false }) {
  return (
    <div class="json-tree">
      {Object.entries(data).map(([key, value]) => (
        <JsonTreeRow
          key={key}
          fieldKey={key}
          value={value}
          fullPath={prefix ? `${prefix}.${key}` : key}
          depth={depth}
          collapseDepth={collapseDepth}
          sortState={sortState}
          filterState={filterState}
          onSort={onSort}
          onFilter={onFilter}
          readOnly={readOnly}
        />
      ))}
    </div>
  );
}

function JsonTreeRow({ fieldKey, value, fullPath, depth, collapseDepth, sortState, filterState, onSort, onFilter, readOnly }) {
  const ejsonType = getEjsonType(value);
  const isObj = value !== null && typeof value === 'object' && !Array.isArray(value) && !ejsonType;
  const isArr = Array.isArray(value);
  const [collapsed, setCollapsed] = useState((isObj || isArr) && depth >= collapseDepth);
  const [flash, setFlash] = useState(null); // 'key' | 'value' | null

  function triggerFlash(target) {
    setFlash(target);
    setTimeout(() => setFlash((cur) => (cur === target ? null : cur)), 700);
  }

  function handleKeyClick(e) {
    e.stopPropagation();
    if (e.altKey) {
      writeClipboard(fullPath).then(() => triggerFlash('key')).catch(() => {});
      return;
    }
    onSort(fullPath);
  }

  function handleValueClick(e, copyText) {
    e.stopPropagation();
    if (e.altKey) {
      writeClipboard(copyText).then(() => triggerFlash('value')).catch(() => {});
      return;
    }
    onFilter(fullPath, value);
  }

  const sortDir = sortState[fullPath];
  const sortInd = sortDir === 1 ? ' ↑' : sortDir === -1 ? ' ↓' : '';
  const keyCls = 'json-tree-key'
    + (sortDir === 1 ? ' json-tree-key-asc' : sortDir === -1 ? ' json-tree-key-desc' : '')
    + (flash === 'key' ? ' json-tree-flash' : '');
  const keyTitle = sortDir === 1 ? `Sorted ascending — click to sort descending (${ALT_KEY}+click to copy path)`
    : sortDir === -1 ? `Sorted descending — click to remove sort (${ALT_KEY}+click to copy path)`
    : `Click to sort by ${fullPath} — ${ALT_KEY}+click to copy path`;
  const filtered = fullPath in filterState;

  // Read-only (e.g. the Stages debug view): keys/values are plain, non-interactive
  // text — no sort/filter, no pointer/hover. Collapse toggles + copy stay active.
  const keyEl = readOnly
    ? <span class="json-tree-key json-tree-key-static">{fieldKey}</span>
    : <button class={keyCls} title={keyTitle} onClick={handleKeyClick}>{fieldKey}{sortInd}</button>;

  if (ejsonType) {
    const formatted = formatEjsonValue(value, ejsonType);
    const info = EJSON_TYPES[ejsonType];
    const copyText = formatted;
    return (
      <div class="json-tree-row">
        {keyEl}
        <span class="json-tree-sep">: </span>
        {readOnly
          ? <span class={'json-tree-value ' + info.css}>{formatted}</span>
          : (
            <button
              class={'json-tree-value json-tree-value-clickable ' + info.css
                + (filtered ? ' json-tree-value-filtered' : '')
                + (flash === 'value' ? ' json-tree-flash' : '')}
              title={filtered ? `Filtering by ${fullPath} — click to remove filter (${ALT_KEY}+click to copy)` : `Click to filter: ${fullPath} = ${formatted} — ${ALT_KEY}+click to copy`}
              onClick={(e) => handleValueClick(e, copyText)}
            >{formatted}</button>
          )}
        <span class={'value-type-tag ' + info.css} title={info.label}>{info.short}</span>
        <CopyButton getText={() => copyText} kind="value" />
      </div>
    );
  }

  if (isObj) {
    const fieldCount = Object.keys(value).length;
    return (
      <div>
        <div class="json-tree-row">
          {keyEl}
          <span class="json-tree-sep">: </span>
          <span class="json-tree-toggle" style="cursor:pointer" onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}>
            {collapsed ? `▶ {${fieldCount} field${fieldCount === 1 ? '' : 's'}}` : '▼'}
          </span>
          <CopyButton getText={() => JSON.stringify(value, null, 2)} kind="json" />
        </div>
        {!collapsed && (
          <div class="json-tree-nested">
            <JsonTree data={value} prefix={fullPath} depth={depth + 1} collapseDepth={collapseDepth} sortState={sortState} filterState={filterState} onSort={onSort} onFilter={onFilter} readOnly={readOnly} />
          </div>
        )}
      </div>
    );
  }

  if (isArr) {
    return (
      <div>
        <div class="json-tree-row">
          {keyEl}
          <span class="json-tree-sep">: </span>
          <span class="json-tree-toggle" style="cursor:pointer" onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}>
            {collapsed ? `▶ [${value.length}]` : `▼ [${value.length}]`}
          </span>
          <CopyButton getText={() => JSON.stringify(value, null, 2)} kind="json" />
        </div>
        {!collapsed && (
          <div class="json-tree-nested">
            {value.map((item, ai) => {
              const itemPath = `${fullPath}.${ai}`;
              if (item !== null && typeof item === 'object' && !Array.isArray(item) && !getEjsonType(item)) {
                return (
                  <div class="json-tree-array-item">
                    <div class="json-tree-row">
                      <span class="json-tree-array-index">[{ai}]</span>
                      <CopyButton getText={() => JSON.stringify(item, null, 2)} kind="json" />
                    </div>
                    <JsonTree data={item} prefix={itemPath} depth={depth + 1} collapseDepth={collapseDepth} sortState={sortState} filterState={filterState} onSort={onSort} onFilter={onFilter} readOnly={readOnly} />
                  </div>
                );
              }
              return (
                <div class="json-tree-row">
                  <span class="json-tree-array-index">[{ai}]</span>
                  <span class="json-tree-value">
                    {typeof item === 'string'
                      ? <SpecialText value={item} quote />
                      : JSON.stringify(item)}
                  </span>
                  <CopyButton getText={() => copyTextFor(item)} kind="value" />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  let colorCls = '';
  if (typeof value === 'string') colorCls = ' json-tree-value-string';
  else if (typeof value === 'number') colorCls = ' json-tree-value-number';
  else if (typeof value === 'boolean') colorCls = ' json-tree-value-bool';
  else if (value === null) colorCls = ' json-tree-value-null';
  let valCls = 'json-tree-value json-tree-value-clickable' + colorCls;
  if (filtered) valCls += ' json-tree-value-filtered';
  if (flash === 'value') valCls += ' json-tree-flash';

  const isString = typeof value === 'string';
  const display = value === null ? 'null' : isString ? null : String(value);
  const valueContent = isString ? <SpecialText value={value} quote /> : display;
  const copyText = copyTextFor(value);

  return (
    <div class="json-tree-row">
      {keyEl}
      <span class="json-tree-sep">: </span>
      {readOnly
        ? <span class={'json-tree-value' + colorCls}>{valueContent}</span>
        : (
          <button
            class={valCls}
            title={filtered ? `Filtering by ${fullPath} — click to remove filter (${ALT_KEY}+click to copy)` : `Click to filter: ${fullPath} = ${JSON.stringify(value)} — ${ALT_KEY}+click to copy`}
            onClick={(e) => handleValueClick(e, copyText)}
          >{valueContent}</button>
        )}
      <CopyButton getText={() => copyText} kind="value" />
    </div>
  );
}
