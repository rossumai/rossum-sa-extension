import { h } from 'preact';
import { useState } from 'preact/hooks';

const EJSON_TYPES = {
  $oid: { label: 'ObjectId', css: 'json-tree-value-oid' },
  $date: { label: 'Date', css: 'json-tree-value-date' },
  $numberLong: { label: 'Long', css: 'json-tree-value-number' },
  $numberInt: { label: 'Int', css: 'json-tree-value-number' },
  $numberDouble: { label: 'Double', css: 'json-tree-value-number' },
  $numberDecimal: { label: 'Decimal', css: 'json-tree-value-number' },
  $binary: { label: 'Binary', css: 'json-tree-value-null' },
  $regex: { label: 'Regex', css: 'json-tree-value-string' },
  $timestamp: { label: 'Timestamp', css: 'json-tree-value-date' },
};

function getEjsonType(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] in EJSON_TYPES) return keys[0];
  if (keys.length === 2 && keys.includes('$date')) return '$date';
  return null;
}

function formatEjsonValue(value, typeKey) {
  const inner = value[typeKey];
  if (typeKey === '$oid') return String(inner);
  if (typeKey === '$date') {
    const d = typeof inner === 'string' ? inner : inner?.$numberLong || String(inner);
    try { return new Date(typeof d === 'string' && /^\d+$/.test(d) ? Number(d) : d).toISOString(); }
    catch { return String(d); }
  }
  if (typeKey === '$regex') return `/${inner}/${value.$options || ''}`;
  return String(inner);
}

export function displayValue(v) {
  if (v === null) return 'null';
  const ejson = getEjsonType(v);
  if (ejson) {
    const formatted = formatEjsonValue(v, ejson);
    return formatted.length > 24 ? formatted.slice(0, 24) + '...' : formatted;
  }
  if (typeof v === 'string') return v.length > 20 ? `"${v.slice(0, 20)}..."` : `"${v}"`;
  if (typeof v === 'object') return Array.isArray(v) ? `[${v.length}]` : '{...}';
  return String(v);
}

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
