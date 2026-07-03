import { h, Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadQueueHooks } from '../index.jsx';
import { fieldProvenance, matchingExtensions, matchConfigsForField } from '../culprit.js';
import { fieldKey } from '../orchestrate.js';
import CulpritChip from './CulpritChip.jsx';

const SRC_LABEL = {
  score: 'engine', human: 'manual edit', formula: 'formula',
  connector: 'connector hook', rules: 'rule', data_matching: 'dataset match', none: 'no source',
  not_found: 'not found',
};

function walkDatapoints(nodes, out) {
  for (const n of nodes || []) {
    if (n.category === 'datapoint') out.push(n);
    if (n.children) walkDatapoints(n.children, out);
  }
  return out;
}

export default function ProvenancePanel() {
  const d = store.data.value;
  const rows = d ? walkDatapoints(d.content?.content || [], []).map(fieldProvenance).filter((p) => p.schemaId) : [];
  const hasDataMatching = rows.some((p) => p.primary === 'data_matching');

  // Only data_matching fields need the matching-extension lookup.
  useEffect(() => {
    if (hasDataMatching) loadQueueHooks();
  }, [hasDataMatching, store.annotationId.value]);

  if (!d) return null;
  if (!rows.length) return <div class="inspector-empty">No field content available.</div>;

  const hooks = Object.values(d.resolved.hooksById || {});
  const allMatchers = matchingExtensions(hooks).map((m) => m.hookName).join(', ');

  // Precise: the specific MDH config that writes this field; fall back to listing
  // matching extensions only if no config names the field.
  function matchSource(schemaId) {
    const precise = matchConfigsForField(schemaId, hooks);
    if (precise.length) {
      return (
        <span class="inspector-label-why"> via {precise.map((m, i) => (
          <Fragment>{i ? ', ' : ''}<b>{m.hookName}</b>{m.configName ? ` · ${m.configName}` : ''}</Fragment>
        ))}</span>
      );
    }
    if (allMatchers) return <span class="inspector-label-why"> via <b>{allMatchers}</b> (no config names this field)</span>;
    return null;
  }

  function attrFor(schemaId) {
    const a = store.attributions.value[fieldKey(schemaId)];
    if (!a) return null;
    if (a.status === 'loading') return <span class="inspector-label-why inspector-loading inspector-ai-phase"> {a.phase || 'thinking'}…</span>;
    if (a.status === 'done' && a.verdict && a.verdict.culprit) return <span class="inspector-label-why"> <CulpritChip culprit={a.verdict.culprit} /></span>;
    return null;
  }

  return (
    <div class="inspector-panel">
      <div class="inspector-sect">Where each value came from</div>
      <table class="inspector-table">
        <thead><tr><th>Field</th><th>Value</th><th>Source</th><th>Confidence</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr>
              <td class="fname">{p.schemaId}</td>
              <td>{p.value == null ? '' : String(p.value)}</td>
              <td>
                <span class={`inspector-sb inspector-sb-${p.primary}`}>{SRC_LABEL[p.primary] || p.primary}</span>
                {p.primary === 'data_matching' ? matchSource(p.schemaId) : null}
                {(p.primary === 'rules' || p.primary === 'connector' || p.primary === 'data_matching') ? attrFor(p.schemaId) : null}
              </td>
              <td>{p.confidence != null ? p.confidence.toFixed(2) : (p.primary === 'human' ? 'edited' : '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="inspector-note">
        <b>engine</b> extraction · <b>manual edit</b> a person · <b>formula</b> schema formula · <b>connector</b>/<b>rule</b>/<b>dataset match</b> written by an extension, rule, or matching connector (e.g. MDH). Source comes from each field's <code class="inspector-code">validation_sources</code>.
      </div>
    </div>
  );
}
