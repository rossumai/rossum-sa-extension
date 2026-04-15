import { h } from 'preact';
import { useState } from 'preact/hooks';
import { EJSON_TYPES, getEjsonType, formatEjsonValue, displayValue } from '../displayValue.js';

export { displayValue };

export default function JsonTree({ data, prefix = '', sortState, filterState, onSort, onFilter }) {
  return (
    <div class="json-tree">
      {Object.entries(data).map(([key, value]) => (
        <JsonTreeRow
          key={key}
          fieldKey={key}
          value={value}
          fullPath={prefix ? `${prefix}.${key}` : key}
          sortState={sortState}
          filterState={filterState}
          onSort={onSort}
          onFilter={onFilter}
        />
      ))}
    </div>
  );
}

function JsonTreeRow({ fieldKey, value, fullPath, sortState, filterState, onSort, onFilter }) {
  const ejsonType = getEjsonType(value);
  const isObj = value !== null && typeof value === 'object' && !Array.isArray(value) && !ejsonType;
  const isArr = Array.isArray(value);
  const [collapsed, setCollapsed] = useState(false);

  const sortDir = sortState[fullPath];
  const sortInd = sortDir === 1 ? ' \u2191' : sortDir === -1 ? ' \u2193' : '';
  const keyCls = 'json-tree-key' + (sortDir === 1 ? ' json-tree-key-asc' : sortDir === -1 ? ' json-tree-key-desc' : '');
  const keyTitle = sortDir === 1 ? 'Sorted ascending \u2014 click to sort descending'
    : sortDir === -1 ? 'Sorted descending \u2014 click to remove sort'
    : `Click to sort by ${fullPath}`;
  const filtered = fullPath in filterState;

  if (ejsonType) {
    const formatted = formatEjsonValue(value, ejsonType);
    const info = EJSON_TYPES[ejsonType];
    return (
      <div class="json-tree-row">
        <button class={keyCls} title={keyTitle} onClick={(e) => { e.stopPropagation(); onSort(fullPath); }}>{fieldKey}{sortInd}</button>
        <span class="json-tree-sep">: </span>
        <span class="json-tree-badge">{info.label}</span>
        <button
          class={'json-tree-value json-tree-value-clickable ' + info.css + (filtered ? ' json-tree-value-filtered' : '')}
          title={filtered ? `Filtering by ${fullPath} \u2014 click to remove filter` : `Click to filter: ${fullPath} = ${formatted}`}
          onClick={(e) => { e.stopPropagation(); onFilter(fullPath, value); }}
        >{formatted}</button>
      </div>
    );
  }

  if (isObj) {
    return (
      <div>
        <div class="json-tree-row">
          <button class={keyCls} title={keyTitle} onClick={(e) => { e.stopPropagation(); onSort(fullPath); }}>{fieldKey}{sortInd}</button>
          <span class="json-tree-sep">: </span>
          <span class="json-tree-toggle" style="cursor:pointer" onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}>
            {collapsed ? '\u25B6 {...}' : '\u25BC'}
          </span>
        </div>
        {!collapsed && (
          <div class="json-tree-nested">
            <JsonTree data={value} prefix={fullPath} sortState={sortState} filterState={filterState} onSort={onSort} onFilter={onFilter} />
          </div>
        )}
      </div>
    );
  }

  if (isArr) {
    return (
      <div>
        <div class="json-tree-row">
          <button class={keyCls} title={keyTitle} onClick={(e) => { e.stopPropagation(); onSort(fullPath); }}>{fieldKey}{sortInd}</button>
          <span class="json-tree-sep">: </span>
          <span class="json-tree-toggle" style="cursor:pointer" onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}>
            {collapsed ? `\u25B6 [${value.length}]` : `\u25BC [${value.length}]`}
          </span>
        </div>
        {!collapsed && (
          <div class="json-tree-nested">
            {value.map((item, ai) => {
              const itemPath = `${fullPath}.${ai}`;
              if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
                return (
                  <div class="json-tree-array-item">
                    <span class="json-tree-array-index">[{ai}]</span>
                    <JsonTree data={item} prefix={itemPath} sortState={sortState} filterState={filterState} onSort={onSort} onFilter={onFilter} />
                  </div>
                );
              }
              return (
                <div class="json-tree-row">
                  <span class="json-tree-array-index">[{ai}]</span>
                  <span class="json-tree-value">{JSON.stringify(item)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  let valCls = 'json-tree-value json-tree-value-clickable';
  if (typeof value === 'string') valCls += ' json-tree-value-string';
  else if (typeof value === 'number') valCls += ' json-tree-value-number';
  else if (typeof value === 'boolean') valCls += ' json-tree-value-bool';
  else if (value === null) valCls += ' json-tree-value-null';
  if (filtered) valCls += ' json-tree-value-filtered';

  const display = value === null ? 'null' : typeof value === 'string' ? `"${value}"` : String(value);

  return (
    <div class="json-tree-row">
      <button class={keyCls} title={keyTitle} onClick={(e) => { e.stopPropagation(); onSort(fullPath); }}>{fieldKey}{sortInd}</button>
      <span class="json-tree-sep">: </span>
      <button
        class={valCls}
        title={filtered ? `Filtering by ${fullPath} \u2014 click to remove filter` : `Click to filter: ${fullPath} = ${JSON.stringify(value)}`}
        onClick={(e) => { e.stopPropagation(); onFilter(fullPath, value); }}
      >{display}</button>
    </div>
  );
}
