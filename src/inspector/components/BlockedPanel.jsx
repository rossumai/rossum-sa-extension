import { h, Fragment } from 'preact';
import * as store from '../store.js';
import { runRevalidate } from '../index.jsx';
import { classifyMessage, explainBlocker } from '../culprit.js';
import ReliabilityBadge from './ReliabilityBadge.jsx';
import CulpritChip from './CulpritChip.jsx';

function MsgRow({ m }) {
  return (
    <div class="inspector-mrow">
      <span class={`inspector-lv inspector-lv-${m.level}`}>{m.level}</span>
      <div class="mc">
        <div class="inspector-mtxt">{m.content}</div>
        <div class="inspector-mrow2">
          <CulpritChip culprit={m.culprit} />
          {m.isException ? <span class="inspector-tag">is_exception</span> : null}
          {m.requestId ? <span class="inspector-tag">request_id {m.requestId.slice(0, 8)}</span> : null}
          {m.culprit == null ? <ReliabilityBadge level="unavailable" /> : null}
        </div>
      </div>
    </div>
  );
}

export default function BlockedPanel() {
  const d = store.data.value;
  if (!d) return null;
  const ctx = { queue: d.resolved.queue, schemaById: {} };
  const blockers = (d.blocker?.content || []).map((b) => explainBlocker(b, ctx));
  const messages = (d.annotation.messages || []).map(classifyMessage);
  // Only error-type messages block automation (they feed the error_message
  // blocker); warnings/info are shown separately as non-blocking.
  const errorMsgs = messages.filter((m) => m.level === 'error');
  const otherMsgs = messages.filter((m) => m.level !== 'error');
  const live = store.live.value;

  return (
    <div class="inspector-panel">
      <div class="inspector-sect">Automation blockers</div>
      {blockers.length === 0 && <div class="inspector-empty">No automation blockers.</div>}
      {blockers.map((b) => (
        <div class="inspector-bcard">
          <div class="ttl">
            <code>{b.type}</code>{b.schemaId ? <span> · {b.schemaId}</span> : null}
            {' '}<CulpritChip culprit={b.culprit} /> <ReliabilityBadge level={b.reliability} />
          </div>
          <div class="inspector-why">{b.explanation}</div>
        </div>
      ))}

      <div class="inspector-sect" style="margin-top:18px">
        Error messages ({errorMsgs.length}) <span class="inspector-sect-note">block automation</span>
      </div>
      {errorMsgs.length === 0 && <div class="inspector-empty">No error messages.</div>}
      {errorMsgs.map((m) => <MsgRow m={m} />)}

      {otherMsgs.length > 0 && (
        <Fragment>
          <div class="inspector-sect" style="margin-top:18px">
            Other messages ({otherMsgs.length}) <span class="inspector-sect-note">do not block automation</span>
          </div>
          {otherMsgs.map((m) => <MsgRow m={m} />)}
        </Fragment>
      )}

      <div class="inspector-reeval">
        <span class="t">Re-evaluate with current rules — a live <code>validate</code> against today's config to catch drift. Takes a brief reviewing lock.</span>
        <button class="btn btn-primary" onClick={() => { runRevalidate(); }}>Re-evaluate</button>
      </div>
      {live && <div class="inspector-note">Live re-evaluation returned {live.messages.length} message(s) from current config ({live.matchedTriggerRules.length} rule(s) matched).</div>}
    </div>
  );
}
