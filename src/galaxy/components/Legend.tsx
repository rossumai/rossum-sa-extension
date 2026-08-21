import { h } from 'preact';
import { NODE_STYLE, type NodeType } from '../graph.js';
import { visibleTypes, toggleType } from '../store.js';

const LABELS = {
  organization: 'Organization', workspace: 'Workspace', queue: 'Queue',
  hook: 'Hook', engine: 'Engine',
};

export default function Legend() {
  const vis = visibleTypes.value;
  return (
    <div class="galaxy-legend">
      <div class="galaxy-legend-title">Legend</div>
      {(Object.keys(LABELS) as NodeType[]).map((type) => {
        const hidden = vis[type] === false;
        return (
          <button
            type="button"
            class={'galaxy-legend-item' + (hidden ? ' hidden' : '')}
            aria-pressed={hidden ? 'false' : 'true'}
            title={hidden ? `Show ${LABELS[type]}` : `Hide ${LABELS[type]}`}
            onClick={() => toggleType(type)}
          >
            <i class="galaxy-legend-dot" style={`background:${NODE_STYLE[type].color}`}></i>
            {LABELS[type]}
          </button>
        );
      })}
    </div>
  );
}
