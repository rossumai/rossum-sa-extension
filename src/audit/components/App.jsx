import { h } from 'preact';
import { availability } from '../store.js';
import ConnectionBar from './ConnectionBar.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import FiltersBar from './FiltersBar.jsx';
import ResultsTable from './ResultsTable.jsx';
import DetailPanel from './DetailPanel.jsx';
import Pagination from './Pagination.jsx';
import UnavailablePanel from './UnavailablePanel.jsx';

export default function App({ connected }) {
  return (
    <div class="app-root">
      <main class="main">
        <ConnectionBar connected={connected} />
        <ErrorBanner />
        {!connected ? (
          <div class="empty-state">Not connected — open a Rossum page and click Audit Logs in the extension popup.</div>
        ) : availability.value === 'unavailable' ? (
          <UnavailablePanel />
        ) : (
          <div class="audit-body">
            <FiltersBar />
            <div class="audit-results-row">
              <ResultsTable />
              <DetailPanel />
            </div>
            <Pagination />
          </div>
        )}
      </main>
    </div>
  );
}
