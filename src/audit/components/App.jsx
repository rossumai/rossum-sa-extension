import { h, Fragment } from 'preact';
import ConnectionBar from './ConnectionBar.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import Filters from './Filters.jsx';
import ResultsTable from './ResultsTable.jsx';
import Pagination from './Pagination.jsx';
import UnavailablePanel from './UnavailablePanel.jsx';
import { availability } from '../store.js';

export default function App({ connected }) {
  const isUnavailable = availability.value === 'unavailable';
  return (
    <div class="app-root">
      <main class="main">
        <ConnectionBar connected={connected} />
        <ErrorBanner />
        {!connected ? (
          <div class="empty-state">
            Not connected — open a Rossum page and click Audit Logs in the extension popup.
          </div>
        ) : isUnavailable ? (
          <UnavailablePanel />
        ) : (
          <Fragment>
            <Filters />
            <ResultsTable />
            <Pagination />
          </Fragment>
        )}
      </main>
    </div>
  );
}
