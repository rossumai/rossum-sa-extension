import { h, Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadChats } from '../chat.js';
import Sidebar from './Sidebar.jsx';
import ChatHeader from './ChatHeader.jsx';
import Thread from './Thread.jsx';
import FilesStrip from './FilesStrip.jsx';
import Composer from './Composer.jsx';
import Welcome from './Welcome.jsx';
import ArchitectApp from '../architect/components/ArchitectApp.jsx';
import Modal from '../../ui/Modal.jsx';

export default function App({ connected }: { connected: boolean | null }) {
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
        class="fabry-layout"
        style={{ gridTemplateColumns: store.sidebarWidth.value + 'px 1fr' }}
      >
        <Sidebar />
        <main class="fabry-main">
          {store.fabryMode.value === 'architect' ? (
            <ArchitectApp />
          ) : (!store.activeChatId.value && store.thread.value.length === 0 && !store.liveTurn.value) ? (
            // Empty new chat → centered welcome (the composer is the hero). Not gated
            // on `streaming` so a failed first send keeps the draft; the layout flips
            // to the thread stack the moment activeChatId/thread/liveTurn appears.
            <Welcome />
          ) : (
            <>
              <ChatHeader />
              <Thread />
              <FilesStrip />
              <Composer />
            </>
          )}
        </main>
      </div>
      <Modal />
    </div>
  );
}
