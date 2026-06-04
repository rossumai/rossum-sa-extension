// src/console/components/Console.jsx
import { h, Fragment } from 'preact';
import { activeApp } from '../store.js';
import Rail from './Rail.jsx';
import MdhApp from '../../mdh/components/App.jsx';
import AuditApp from '../../audit/components/App.jsx';
import * as mdhStore from '../../mdh/store.js';
import * as auditStore from '../../audit/store.js';

function Connecting() {
  return (
    <div class="app-root">
      <div class="empty-state">Connecting{'…'}</div>
    </div>
  );
}

export default function Console() {
  const app = activeApp.value;

  let view;
  if (app === 'mdh') {
    const c = mdhStore.connected.value;
    view = c === null ? <Connecting /> : <MdhApp connected={c} />;
  } else {
    const c = auditStore.connected.value;
    view = c === null ? <Connecting /> : <AuditApp connected={c} />;
  }

  return (
    <Fragment>
      <Rail />
      {view}
    </Fragment>
  );
}
