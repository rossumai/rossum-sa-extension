import { h, Fragment } from 'preact';
import * as store from '../store.js';
import { classifyMessage, explainBlocker } from '../culprit.js';
import { messageKey, blockerKey } from '../orchestrate.js';
import { schemaIdForDatapoint } from '../evidence.js';
import ReliabilityBadge from './ReliabilityBadge.jsx';
import CulpritChip from './CulpritChip.jsx';

function AttrLine({ entry }) {
  if (!entry) return null;
  if (entry.status === 'loading') return <span class="inspector-label-why inspector-loading inspector-ai-phase">{entry.phase || 'thinking'}…</span>;
  if (entry.status === 'error') return <span class="inspector-label-why">AI attribution failed</span>;
  if (entry.status === 'done' && entry.verdict) {
    return (
      <span class="inspector-ai-verdict-inline">
        <CulpritChip culprit={entry.verdict.culprit} />
        {entry.source === 'programmatic'
          ? <ReliabilityBadge level={entry.reliability} />
          : <ReliabilityBadge level={entry.verdict.confidence} />}
        {entry.verdict.explanation ? <span class="inspector-why">{entry.verdict.explanation}</span> : null}
      </span>
    );
  }
  return null;
}

function MsgRow({ m, idx }) {
  const attr = store.attributions.value[messageKey(idx)];
  const field = schemaIdForDatapoint(store.data.value?.content?.content, m.datapointId);
  return (
    <div class="inspector-mrow" data-evidence-id={`message:${m.idx}`}>
      <span class={`inspector-lv inspector-lv-${m.level}`}>{m.level}</span>
      <div class="mc">
        <div class="inspector-mtxt">{m.content}</div>
        <div class="inspector-mrow2">
          {m.culprit ? <CulpritChip culprit={m.culprit} /> : <AttrLine entry={attr} />}
          {m.culprit ? <ReliabilityBadge level={m.reliability} /> : (!attr ? <ReliabilityBadge level="unavailable" /> : null)}
          {field ? <span class="inspector-tag">field {field}</span> : null}
          {m.isException ? <span class="inspector-tag">is_exception</span> : null}
          {m.requestId ? <span class="inspector-tag">request_id {m.requestId.slice(0, 8)}</span> : null}
        </div>
      </div>
    </div>
  );
}

export default function BlockedPanel() {
  const d = store.data.value;
  if (!d) return null;
  const ctx = { queue: d.resolved.queue, schemaById: {} };
  const messages = (d.annotation.messages || []).map((raw, idx) => ({ ...classifyMessage(raw), idx }));
  // Only error-type messages block automation (they feed the error_message
  // blocker); warnings/info are shown separately as non-blocking.
  const errorMsgs = messages.filter((m) => m.level === 'error');
  const otherMsgs = messages.filter((m) => m.level !== 'error');

  return (
    <div class="inspector-panel">
      <div class="inspector-sect">Automation blockers</div>
      {(d.blocker?.content || []).length === 0 && <div class="inspector-empty">No automation blockers.</div>}
      {(d.blocker?.content || []).map((raw, i) => {
        const b = explainBlocker(raw, ctx);
        return (
          <div class="inspector-bcard" data-evidence-id={`blocker:${i}`}>
            <div class="ttl">
              <code>{b.type}</code>{b.schemaId ? <span> · {b.schemaId}</span> : null}
              {' '}<CulpritChip culprit={b.culprit} /> <ReliabilityBadge level={b.reliability} />
            </div>
            <div class="inspector-why">{b.explanation}</div>
            <AttrLine entry={store.attributions.value[blockerKey(i)]} />
          </div>
        );
      })}

      <div class="inspector-sect" style="margin-top:18px">
        Error messages ({errorMsgs.length}) <span class="inspector-sect-note">block automation</span>
      </div>
      {errorMsgs.length === 0 && <div class="inspector-empty">No error messages.</div>}
      {errorMsgs.map((m) => <MsgRow m={m} idx={m.idx} />)}

      {otherMsgs.length > 0 && (
        <Fragment>
          <div class="inspector-sect" style="margin-top:18px">
            Other messages ({otherMsgs.length}) <span class="inspector-sect-note">do not block automation</span>
          </div>
          {otherMsgs.map((m) => <MsgRow m={m} idx={m.idx} />)}
        </Fragment>
      )}
    </div>
  );
}
