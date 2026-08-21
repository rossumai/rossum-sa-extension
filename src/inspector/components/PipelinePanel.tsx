import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadQueueHooks, loadEnrichment } from '../index.jsx';
import { buildPipeline } from '../culprit.js';

export default function PipelinePanel() {
  const d = store.data.value;

  useEffect(() => {
    loadQueueHooks();
    if (store.enrichment.value.hookLogs === null) loadEnrichment('hookLogs');
  }, [store.annotationId.value]);

  if (!d) return null;
  const hooks = Object.values(d.resolved.hooksById || {});
  if (!d.resolved._hooksLoaded && !hooks.length) return <div class="inspector-loading">Loading extensions…</div>;

  const logs = store.enrichment.value.hookLogs;
  const phases = buildPipeline(hooks, Array.isArray(logs) ? logs : []);

  return (
    <div class="inspector-panel">
      {phases.length === 0 && <div class="inspector-empty">No active extensions on this queue.</div>}
      {phases.map((p) => (
        <div class="inspector-phase">
          <div class="inspector-sect">{p.label} <span class="inspector-sect-note">{p.event}</span></div>
          <ol class="inspector-pipe">
            {p.nodes.map((n, i) => (
              <li class={`inspector-pipe-node${n.run ? (n.run.failed ? ' failed' : ' ran') : ''}`}>
                <div class="row">
                  <span class="rank">{i + 1}</span>
                  <span class="nm">{n.name}</span>
                  <span class="inspector-tag">{n.type}</span>
                  {n.run
                    ? (n.run.failed
                      ? <span class="inspector-pipe-status fail">failed</span>
                      : <span class="inspector-pipe-status ok">ran</span>)
                    : <span class="inspector-pipe-status none" title="Only failures are reliably logged; absence of a log usually means it ran fine.">no log {'—'} likely ran</span>}
                  {n.run && n.run.durationMs != null ? <span class="inspector-tag">{n.run.durationMs} ms</span> : null}
                </div>
                {n.run && n.run.message ? <div class="inspector-pipe-msg">{n.run.message}</div> : null}
              </li>
            ))}
          </ol>
        </div>
      ))}
      <div class="inspector-note">
        Pipeline order comes from the queue's extension config (<code class="inspector-code">run_after</code>) and is always accurate. Run status comes from hook logs, which are retention-limited — a step with <b>no log</b> may still have run successfully; in practice only failures are reliably recorded.
      </div>
    </div>
  );
}
