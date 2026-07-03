import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { loadAnnotation } from '../index.jsx';
import IdInput from './IdInput.jsx';
import RecentAnnotations from './RecentAnnotations.jsx';
import Overview from './Overview.jsx';
import Timeline from './Timeline.jsx';
import BlockedPanel from './BlockedPanel.jsx';
import RejectedPanel from './RejectedPanel.jsx';
import LabelsPanel from './LabelsPanel.jsx';
import PipelinePanel from './PipelinePanel.jsx';
import ProvenancePanel from './ProvenancePanel.jsx';
import ExportPanel from './ExportPanel.jsx';

const TABS = [
  ['blocked', 'Why blocked'],
  ['rejected', 'Why rejected'],
  ['labels', 'Why labels'],
  ['export', 'Why export failed'],
  ['pipeline', 'Extensions'],
  ['value', 'Field provenance'],
];

export default function App({ connected }) {
  const [tab, setTab] = useState('blocked');
  const inspect = (id) => { store.setAnnotationId(id); loadAnnotation(id); };

  if (connected === false) {
    return (
      <div class="app-root">
        <main class="main">
          <div class="inspector-root">
            <div class="inspector-empty">
              Not connected. Open a Rossum annotation and click <b>Inspect this annotation</b>, or paste an id below.
              <div style="margin-top:12px"><IdInput onSubmit={inspect} /></div>
              <RecentAnnotations onSelect={inspect} />
            </div>
          </div>
        </main>
      </div>
    );
  }

  const d = store.data.value;
  return (
    <div class="app-root">
      <main class="main">
        <div class="inspector-root">
          <IdInput onSubmit={inspect} />
          {store.loading.value && <div class="inspector-loading">Loading…</div>}
          {store.error.value && <div class="error-banner">{store.error.value}</div>}
          {!d && !store.loading.value && <RecentAnnotations onSelect={inspect} />}
          {d && (
            <div class="inspector-report">
              <Overview />
              <Timeline />
              <div class="inspector-tabs">
                {TABS.map(([k, label]) => (
                  <button class={`inspector-tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
                ))}
              </div>
              {tab === 'blocked' && <BlockedPanel />}
              {tab === 'rejected' && <RejectedPanel />}
              {tab === 'labels' && <LabelsPanel />}
              {tab === 'pipeline' && <PipelinePanel />}
              {tab === 'value' && <ProvenancePanel />}
              {tab === 'export' && <ExportPanel />}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
