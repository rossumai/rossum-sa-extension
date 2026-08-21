import { h } from 'preact';
import * as store from '../store.js';
import { loadAnnotation, closeAnnotation } from '../index.jsx';
import IdInput from './IdInput.jsx';
import RecentAnnotations from './RecentAnnotations.jsx';
import Report from './Report.jsx';
import PageRail from './PageRail.jsx';

export default function App({ connected }: { connected: boolean | null }) {
  const inspect = (id: any) => { store.setAnnotationId(id); loadAnnotation(id); };

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
            <button type="button" class="inspector-back" onClick={closeAnnotation}>{'←'} All annotations</button>
          )}
          {d && (
            <div class="inspector-layout">
              <Report />
              <PageRail />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
