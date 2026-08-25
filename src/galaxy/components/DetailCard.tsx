import { h } from 'preact';
import { selectedNodeId, graph, domain } from '../store.js';
import { buildDeeplink } from '../../audit/deeplink.js';

const TYPE_LABEL = {
  organization: 'Organization',
  workspace: 'Workspace',
  queue: 'Queue',
  hook: 'Hook',
  engine: 'Engine',
};

export default function DetailCard() {
  const id = selectedNodeId.value;
  if (!id) return null;
  const g = graph.value;
  const node = g.nodes.find((n) => n.id === id);
  if (!node) return null;

  const href = buildDeeplink(domain.value, node.type, node.rawId);
  const rows = node.detail || [];

  return (
    <div class="galaxy-detail-card">
      <button
        type="button"
        class="galaxy-detail-close"
        title="Close"
        onClick={() => {
          selectedNodeId.value = null;
        }}
      >
        {'×'}
      </button>
      <div class="galaxy-detail-type" style={`color:${node.color}`}>
        {TYPE_LABEL[node.type] || node.type}
      </div>
      <div class="galaxy-detail-name">{node.name}</div>
      {rows.length > 0 && (
        <dl class="galaxy-detail-facts">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {href && (
        <a class="galaxy-detail-link" href={href} target="_blank" rel="noopener noreferrer">
          Open in Rossum
        </a>
      )}
    </div>
  );
}
