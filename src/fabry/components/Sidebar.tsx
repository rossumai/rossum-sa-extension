import { h, Fragment } from 'preact';
import * as store from '../store.js';
import { loadChats, openChat, startNewChat } from '../chat.js';
import { chatTitle } from '../format.js';
import ArchitectSidebar from '../architect/components/ArchitectSidebar.jsx';
import FabryMark from '../../ui/FabryMark.jsx';

// Drag the sidebar's right edge to resize (MDH SidebarResizer pattern, but
// signal-driven since the width lives in the parent grid). Live drag updates
// the signal; the width persists once on mouseup.
function startResize(e: any) {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = store.sidebarWidth.value;
  const handle = e.currentTarget;
  handle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  function onMove(ev: any) {
    store.sidebarWidth.value = store.clampSidebarWidth(startWidth + ev.clientX - startX);
  }
  function onUp() {
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    store.setSidebarWidth(store.sidebarWidth.value);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Chat sidebar: a Mr. Fabry brand header, a New chat button, and a flat
// recency list of conversations (title only). Older chats load on scroll.
export default function Sidebar() {
  const list = store.chats.value;
  const hasMore = store.chatsTotal.value != null && list.length < store.chatsTotal.value;

  const architect = store.fabryMode.value === 'architect';
  return (
    <aside class="fabry-sidebar">
      <div class="fabry-sidebar-title">
        <span class="fabry-sidebar-mark">
          <FabryMark />
        </span>
        <span class="fabry-sidebar-name">Mr. Fabry</span>
      </div>
      <div class="fabry-mode" role="tablist">
        <button
          type="button"
          class={'fabry-mode-opt' + (!architect ? ' on' : '')}
          onClick={() => store.setFabryMode('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          class={'fabry-mode-opt' + (architect ? ' on' : '')}
          onClick={() => store.setFabryMode('architect')}
        >
          Architect
        </button>
      </div>
      {architect ? (
        <ArchitectSidebar />
      ) : (
        <>
          <button type="button" class="fabry-newchat" onClick={startNewChat}>
            {'＋ New chat'}
          </button>
          <div
            class="fabry-chatlist"
            onScroll={(e) => {
              const el = e.currentTarget;
              if (
                hasMore &&
                !store.chatsLoading.value &&
                el.scrollHeight - el.scrollTop - el.clientHeight < 80
              ) {
                loadChats({ more: true });
              }
            }}
          >
            {list.map((c) => (
              <button
                type="button"
                key={c.chat_id}
                class={'fabry-chat-row' + (store.activeChatId.value === c.chat_id ? ' active' : '')}
                onClick={() => openChat(c.chat_id)}
              >
                <span class="fabry-chat-title" title={chatTitle(c)}>
                  {chatTitle(c)}
                </span>
              </button>
            ))}
            {list.length === 0 && !store.chatsLoading.value && (
              <div class="fabry-chat-empty">No conversations yet</div>
            )}
          </div>
          {store.chatsLoading.value && <div class="fabry-chat-loadingrow">Loading{'…'}</div>}
        </>
      )}
      <div class="fabry-side-resizer" title="Drag to resize" onMouseDown={startResize} />
    </aside>
  );
}
