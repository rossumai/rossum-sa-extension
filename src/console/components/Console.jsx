// src/console/components/Console.jsx
import { h, Fragment } from 'preact';
import { activeApp } from '../store.js';
import Rail from './Rail.jsx';
import MdhApp from '../../mdh/components/App.jsx';
import AuditApp from '../../audit/components/App.jsx';
import GalaxyApp from '../../galaxy/components/App.jsx';
import InspectorApp from '../../inspector/components/App.jsx';
import FabryApp from '../../fabry/components/App.jsx';
import AcademyApp from '../../academy/components/App.jsx';
import * as mdhStore from '../../mdh/store.js';
import * as auditStore from '../../audit/store.js';
import * as galaxyStore from '../../galaxy/store.js';
import * as inspectorStore from '../../inspector/store.js';
import * as fabryStore from '../../fabry/store.js';
import * as academyStore from '../../academy/store.js';

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
  } else if (app === 'galaxy') {
    const c = galaxyStore.connected.value;
    view = c === null ? <Connecting /> : <GalaxyApp connected={c} />;
  } else if (app === 'inspector') {
    const c = inspectorStore.connected.value;
    view = c === null ? <Connecting /> : <InspectorApp connected={c} />;
  } else if (app === 'fabry') {
    const c = fabryStore.connected.value;
    view = c === null ? <Connecting /> : <FabryApp connected={c} />;
  } else if (app === 'academy') {
    const c = academyStore.connected.value;
    view = c === null ? <Connecting /> : <AcademyApp connected={c} />;
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
