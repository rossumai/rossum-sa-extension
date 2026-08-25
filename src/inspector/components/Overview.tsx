import { h } from 'preact';
import * as store from '../store.js';
import IdLabel from './IdLabel.jsx';

function idFromUrl(u: any) {
  const m = String(u || '').match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

function userDisplayName(u: any) {
  if (!u) return null;
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return full || u.username || u.email || null;
}

export default function Overview() {
  const d = store.data.value;
  if (!d) return null;
  const a = d.annotation;
  const r = d.resolved;
  return (
    <div class="inspector-ovh">
      <div class="inspector-ovh-main">
        <div class="inspector-ovh-id">#{a.id}</div>
        <div class="inspector-ovh-sub">
          {a.queue ? (
            <IdLabel name={r.queue?.name} id={idFromUrl(a.queue)} prefix="queue " />
          ) : (
            'unknown queue'
          )}
          {a.prediction?.source ? ` · ${a.prediction.source}` : ''}
        </div>
        <div class="inspector-chips">
          <span class="inspector-chip">
            automated: <b>{String(!!a.automated)}</b>
          </span>
          {a.modifier ? (
            <span class="inspector-chip">
              modifier:{' '}
              <IdLabel
                name={userDisplayName(r.usersById?.[idFromUrl(a.modifier) as string])}
                id={idFromUrl(a.modifier)}
                prefix="user "
              />
            </span>
          ) : null}
          {a.schema ? (
            <span class="inspector-chip">
              schema: <IdLabel name={r.schema?.name} id={idFromUrl(a.schema)} prefix="schema " />
            </span>
          ) : null}
          {a.document ? (
            <span class="inspector-chip">
              document:{' '}
              <IdLabel
                name={r.document?.original_file_name}
                id={idFromUrl(a.document)}
                prefix="document "
              />
            </span>
          ) : null}
        </div>
      </div>
      <span class={`inspector-pill inspector-pill-${a.status}`}>{a.status}</span>
    </div>
  );
}
