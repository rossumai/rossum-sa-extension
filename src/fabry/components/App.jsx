import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadChats } from '../chat.js';
import Sidebar from './Sidebar.jsx';
import ChatHeader from './ChatHeader.jsx';
import Thread from './Thread.jsx';
import FilesStrip from './FilesStrip.jsx';
import Composer from './Composer.jsx';

export default function App({ connected }) {
  // Switching Console apps unmounts/remounts this component, so a mount is
  // "the user (re)opened Fabry" — refresh the chat list so chats created
  // elsewhere (other tabs, other Fabry surfaces) show up. On the lazy
  // activation path the first mount skips (agentAvailable still null while
  // initFabry probes — initFabry owns the initial load); when the Console
  // boots STRAIGHT into Fabry, initFabry finishes pre-render and this adds
  // one redundant (harmless, list-only) refresh. Never touches an in-flight
  // stream or the open thread.
  useEffect(() => {
    if (store.agentAvailable.value) loadChats();
  }, []);

  if (!connected) {
    return <div class="app-root"><div class="empty-state">Not connected. Open a Rossum page and launch the Console again.</div></div>;
  }
  if (store.agentAvailable.value === false) {
    return <div class="app-root"><div class="empty-state">Mr. Fabry is offline (agent unreachable). Try again later.</div></div>;
  }
  return (
    <div class="app-root fabry-root">
      {store.error.value && <div class="fabry-error">{store.error.value}</div>}
      <div
        class={'fabry-layout' + (store.sidebarOpen.value ? '' : ' sidebar-collapsed')}
        style={{ gridTemplateColumns: (store.sidebarOpen.value ? store.sidebarWidth.value + 'px' : '52px') + ' 1fr' }}
      >
        <Sidebar />
        <main class="fabry-main">
          <ChatHeader />
          <Thread />
          <FilesStrip />
          <Composer />
        </main>
      </div>
    </div>
  );
}
