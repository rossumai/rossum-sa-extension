import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadLabelContext } from '../index.jsx';
import { labelAttribution, contrastText } from '../culprit.js';
import CulpritChip from './CulpritChip.jsx';
import ReliabilityBadge from './ReliabilityBadge.jsx';
import FoldableCode from './FoldableCode.jsx';

// Render a label with its real color, as a tag (Rossum labels carry only a
// color hex — no shape attribute — so this is the conventional label shape).
function LabelChip({ name, color }) {
  const style = color ? `background:${color};color:${contrastText(color)}` : undefined;
  return <span class={`inspector-label-tag${color ? '' : ' nocolor'}`} style={style}>{name}</span>;
}

// Applied WITHOUT a rule: no audited applier exists, so an agent reads the
// queue's hook code/settings/logs and reasons out which extension applied it.
function AiLabelAttribution({ label }) {
  const key = `label:${label.id}`;
  const attr = store.attributions.value[key];
  if (!store.aiAvailable.value) return <span class="inspector-label-why">AI attribution unavailable</span>;
  if (!attr || attr.status === 'loading') return <span class="inspector-label-why inspector-loading inspector-ai-phase">{(attr && attr.phase) || 'thinking'}…</span>;
  if (attr.status === 'error') return <span class="inspector-label-why">AI attribution failed</span>;
  const v = attr.verdict;
  return (
    <span class="inspector-ai-verdict-inline">
      <CulpritChip culprit={v.culprit} /> <ReliabilityBadge level={v.confidence} />
      {v.explanation && <span class="inspector-why">{v.explanation}</span>}
    </span>
  );
}

export default function LabelsPanel() {
  const d = store.data.value;

  useEffect(() => {
    if (store.data.value && store.data.value.resolved.labelsById === undefined) loadLabelContext();
  }, [store.annotationId.value]);

  if (!d) return null;
  if (d.resolved.labelsById === undefined) return <div class="inspector-loading">Loading labels…</div>;

  const { applied, notApplied } = labelAttribution({
    annotation: d.annotation,
    labelsById: d.resolved.labelsById,
    labelRules: d.resolved.labelRules || [],
  });
  // Verified signal only: rule-governed label automation. Non-rule applications
  // are now individually explained by the AI attribution card above (which may
  // find a hook or conclude manual) rather than a queue-wide capability guess.
  const hasLabelAutomation = (d.resolved.labelRules || []).length > 0;

  return (
    <div class="inspector-panel">
      <div class="inspector-sect">Applied labels ({applied.length})</div>
      {applied.length === 0 && <div class="inspector-empty">No labels applied to this annotation.</div>}
      {applied.map((l) => {
        if (l.rule) {
          return (
            <div class="inspector-bcard" data-evidence-id={`label:${l.id}`}>
              <div class="ttl">
                <LabelChip name={l.name} color={l.color} />
                <span class="inspector-label-why">applied by rule <b>{l.rule.name}</b></span>
                <ReliabilityBadge level="verified" />
              </div>
              {l.rule.trigger ? <div class="inspector-why">fires when: <FoldableCode code={l.rule.trigger} /></div> : null}
            </div>
          );
        }
        return (
          <div class="inspector-bcard" data-evidence-id={`label:${l.id}`}>
            <div class="ttl"><LabelChip name={l.name} color={l.color} /> <AiLabelAttribution label={l} /></div>
          </div>
        );
      })}

      {notApplied.length > 0 && (
        <div>
          <div class="inspector-sect" style="margin-top:18px">Governed by a rule but not applied ({notApplied.length})</div>
          {notApplied.map((l) => (
            <div class="inspector-bcard" data-evidence-id={`label-not:${l.id}`}>
              <div class="ttl">
                <LabelChip name={l.name} color={l.color} />
                <span class="inspector-label-why">not applied — rule <b>{l.rule.name}</b> did not fire</span>
                <ReliabilityBadge level={l.reliability} />
              </div>
              {l.rule.trigger ? <div class="inspector-why">would apply when: <FoldableCode code={l.rule.trigger} /></div> : null}
            </div>
          ))}
        </div>
      )}

      {!hasLabelAutomation && (
        <div class="inspector-note">
          {applied.length > 0
            ? 'No queue rule governs labels — see the attribution shown for each applied label above.'
            : 'No queue rule governs labels on this queue.'}
        </div>
      )}
    </div>
  );
}
