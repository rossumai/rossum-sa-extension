import { h, Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadLabelContext } from '../index.jsx';
import { labelAttribution, extensionAttribution, contrastText } from '../culprit.js';
import ReliabilityBadge from './ReliabilityBadge.jsx';
import FoldableCode from './FoldableCode.jsx';

// Render a label with its real color, as a tag (Rossum labels carry only a
// color hex — no shape attribute — so this is the conventional label shape).
function LabelChip({ name, color }) {
  const style = color ? `background:${color};color:${contrastText(color)}` : undefined;
  return <span class={`inspector-label-tag${color ? '' : ' nocolor'}`} style={style}>{name}</span>;
}

function appliedSource(l, labelHooks) {
  if (l.rule) {
    return {
      source: <span class="inspector-label-why">applied by rule <b>{l.rule.name}</b></span>,
      why: l.rule.trigger ? <Fragment>fires when: <FoldableCode code={l.rule.trigger} /></Fragment> : null,
      badge: 'verified',
    };
  }
  const ext = extensionAttribution(l.id, l.name, labelHooks);
  const more = ext.others.length ? ` (+${ext.others.length} more)` : '';
  if (ext.kind === 'named') {
    return {
      source: <span class="inspector-label-why">applied by extension <b>{ext.name}</b></span>,
      why: <Fragment>extension <b>{ext.name}</b> calls <code class="inspector-code">/labels/apply</code> and references this label{ext.by === 'name' ? ' by name' : ''}.</Fragment>,
      badge: null,
    };
  }
  if (ext.kind === 'likely') {
    return {
      source: <span class="inspector-label-why">likely applied by extension <b>{ext.name}</b>{more}</span>,
      why: <Fragment>this extension applies labels via <code class="inspector-code">/labels/apply</code>, but does not reference this one.</Fragment>,
      badge: null,
    };
  }
  if (ext.kind === 'opaque') {
    return {
      source: <span class="inspector-label-why">possibly applied by webhook <b>{ext.name}</b>{more}</span>,
      why: <Fragment>external webhook — its label logic cannot be inspected.</Fragment>,
      badge: null,
    };
  }
  return {
    source: <span class="inspector-label-why">applied manually</span>,
    why: <Fragment>no rule or extension on this queue applies labels — likely set by a person.</Fragment>,
    badge: 'unavailable',
  };
}

export default function LabelsPanel() {
  const d = store.data.value;

  useEffect(() => {
    if (store.data.value && store.data.value.resolved.labelsById === undefined) loadLabelContext();
  }, [store.annotationId.value]);

  if (!d) return null;
  if (d.resolved.labelsById === undefined) return <div class="inspector-loading">Loading labels…</div>;

  const labelHooks = d.resolved.labelHooks || [];
  const { applied, notApplied } = labelAttribution({
    annotation: d.annotation,
    labelsById: d.resolved.labelsById,
    labelRules: d.resolved.labelRules || [],
  });
  const hasLabelAutomation = (d.resolved.labelRules || []).length > 0 || labelHooks.some((lh) => lh.capability !== 'none');

  return (
    <div class="inspector-panel">
      <div class="inspector-sect">Applied labels ({applied.length})</div>
      {applied.length === 0 && <div class="inspector-empty">No labels applied to this annotation.</div>}
      {applied.map((l) => {
        const s = appliedSource(l, labelHooks);
        return (
          <div class="inspector-bcard">
            <div class="ttl"><LabelChip name={l.name} color={l.color} /> {s.source} <ReliabilityBadge level={s.badge} /></div>
            {s.why ? <div class="inspector-why">{s.why}</div> : null}
          </div>
        );
      })}

      {notApplied.length > 0 && (
        <div>
          <div class="inspector-sect" style="margin-top:18px">Governed by a rule but not applied ({notApplied.length})</div>
          {notApplied.map((l) => (
            <div class="inspector-bcard">
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
        <div class="inspector-note">No queue rule or extension applies labels, so any labels here were set manually.</div>
      )}
    </div>
  );
}
