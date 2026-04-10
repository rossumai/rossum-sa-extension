import { h } from 'preact';
import { selectedCollection, activePanel, activeView } from '../store.js';
import Sidebar from './Sidebar.jsx';
import SidebarResizer from './SidebarResizer.jsx';
import ConnectionBar from './ConnectionBar.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import LoadingOverlay from './LoadingOverlay.jsx';
import TabBar from './TabBar.jsx';
import Modal from './Modal.jsx';
import DataPanel from './DataPanel.jsx';
import IndexPanel from './IndexPanel.jsx';
import SearchIndexPanel from './SearchIndexPanel.jsx';
import StatsPanel from './StatsPanel.jsx';
import UploadsPanel from './UploadsPanel.jsx';

export default function App({ connected }) {
  return (
    <div class="app-root">
      <Sidebar />
      <SidebarResizer />
      <main class="main">
        <ConnectionBar connected={connected} />
        <ErrorBanner />
        <LoadingOverlay />
        <Modal />
        {activeView.value === 'operations' ? (
          <div class="main-content">
            <UploadsPanel />
          </div>
        ) : selectedCollection.value ? (
          <div class="main-content">
            <TabBar />
            {activePanel.value === 'data' && <DataPanel />}
            {activePanel.value === 'stats' && <StatsPanel />}
            {activePanel.value === 'indexes' && <IndexPanel />}
            {activePanel.value === 'search-indexes' && <SearchIndexPanel />}
          </div>
        ) : (
          <div class="empty-state"><p>Select a collection to get started</p></div>
        )}
      </main>
    </div>
  );
}
