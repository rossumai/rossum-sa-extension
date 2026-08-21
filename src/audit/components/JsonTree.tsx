import { h } from 'preact';
import { useState } from 'preact/hooks';

const COLLAPSE_THRESHOLD = 30;

export default function JsonTree({ data, depth = 0 }: { data: any; depth?: number }) {
  if (data == null) return <span class="json-leaf json-null">null</span>;
  if (typeof data !== 'object') return <Leaf value={data} />;
  if (Array.isArray(data)) return <ArrayNode arr={data} depth={depth} />;
  return <ObjectNode obj={data} depth={depth} />;
}

function ObjectNode({ obj, depth }: { obj: any; depth: number }) {
  const entries = Object.entries(obj);
  const [collapsed, setCollapsed] = useState(depth >= 1 && entries.length > COLLAPSE_THRESHOLD);
  if (entries.length === 0) {
    return <span class="json-empty">{'{}'}</span>;
  }
  return (
    <div class="json-tree">
      <span class="json-toggle" onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? `▶ {${entries.length}}` : '▼'}
      </span>
      {!collapsed && (
        <div class="json-nested">
          {entries.map(([k, v]) => (
            <div class="json-row">
              <span class="json-key">{k}</span>
              <span class="json-sep">: </span>
              {typeof v === 'object' && v !== null ? (
                <JsonTree data={v} depth={depth + 1} />
              ) : (
                <Leaf value={v} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ArrayNode({ arr, depth }: { arr: any[]; depth: number }) {
  const [collapsed, setCollapsed] = useState(depth >= 1 && arr.length > COLLAPSE_THRESHOLD);
  if (arr.length === 0) return <span class="json-empty">{'[]'}</span>;
  return (
    <div class="json-tree">
      <span class="json-toggle" onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? `▶ [${arr.length}]` : `▼ [${arr.length}]`}
      </span>
      {!collapsed && (
        <div class="json-nested">
          {arr.map((item, i) => (
            <div class="json-row">
              <span class="json-index">[{i}]</span>
              <span class="json-sep">: </span>
              {typeof item === 'object' && item !== null ? (
                <JsonTree data={item} depth={depth + 1} />
              ) : (
                <Leaf value={item} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Leaf({ value }: { value: any }) {
  if (value === null) return <span class="json-leaf json-null">null</span>;
  if (typeof value === 'string') {
    return <span class="json-leaf json-string">{`"${value}"`}</span>;
  }
  if (typeof value === 'number') return <span class="json-leaf json-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span class="json-leaf json-bool">{String(value)}</span>;
  return <span class="json-leaf">{String(value)}</span>;
}
