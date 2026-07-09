import { h } from 'preact';
import { collections, loading, error } from '../store.js';
import { showCreateModal } from './Sidebar.jsx';

// State-aware empty state for the Dataset Management main pane, shown when no
// collection is selected in the default (collection) view. Because
// Sidebar.loadCollections() auto-selects the first collection whenever any
// exist, the persistent case here is a genuinely empty org — so this renders a
// first-run "No collections yet" block with a create action, and falls back to
// the (now truthful) "Select a collection" line only during the brief window
// where collections exist but none is selected yet. While loading, or when the
// connection/error bars already explain the state, it renders nothing so it
// never asserts "no collections" prematurely or contradicts those bars.
export default function CollectionEmptyState({ connected }) {
  if (collections.value.length > 0) {
    return <div class="empty-state"><p>Select a collection to get started</p></div>;
  }
  if (loading.value || !connected || error.value) return null;
  return (
    <div class="empty-state">
      <div class="empty-state-card">
        <div class="empty-state-title">No collections yet</div>
        <p class="empty-state-body">
          Master Data Hub keeps your reference data in collections you can
          browse and query. This organization doesn't have any yet.
        </p>
        <button class="btn btn-success" onClick={showCreateModal}>Create collection</button>
      </div>
    </div>
  );
}
