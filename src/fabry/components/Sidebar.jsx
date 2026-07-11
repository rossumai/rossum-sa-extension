import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { loadChats, openChat, startNewChat } from '../chat.js';
import { tsToMs, relativeTime, chatTitle } from '../format.js';
import { filterChats, titleSegments } from '../search.js';

// Drag the sidebar's right edge to resize (MDH SidebarResizer pattern, but
// signal-driven since the width lives in the parent grid). Live drag updates
// the signal; the width persists once on mouseup.
function startResize(e) {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = store.sidebarWidth.value;
  const handle = e.currentTarget;
  handle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  function onMove(ev) {
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

// Search-first sidebar (design round 6, F1): a pinned filter over the loaded
// chats with highlighted matches; the list itself is a flat recency feed.
export default function Sidebar() {
  const [query, setQuery] = useState('');
  const all = store.chats.value;
  const list = filterChats(all, query);
  const searching = query.trim().length > 0;
  const hasMore = store.chatsTotal.value != null && all.length < store.chatsTotal.value;

  if (!store.sidebarOpen.value) {
    return (
      <aside class="fabry-sidebar collapsed">
        <button type="button" class="fabry-sidebar-toggle" title="Expand chat list" onClick={() => store.setSidebarOpen(true)}>{'»'}</button>
        <button type="button" class="fabry-newchat icon" title="New chat" onClick={startNewChat}>{'＋'}</button>
      </aside>
    );
  }
  return (
    <aside class="fabry-sidebar">
      <div class="fabry-sidebar-hd">
        <button type="button" class="fabry-newchat" onClick={startNewChat}>{'＋ New chat'}</button>
        <button type="button" class="fabry-sidebar-toggle" title="Collapse chat list" onClick={() => store.setSidebarOpen(false)}>{'«'}</button>
      </div>
      <div class="fabry-search">
        <span class="fabry-search-glyph">{'⌕'}</span>
        <input
          type="text"
          placeholder="Search chats"
          value={query}
          onInput={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
        />
        {searching && <button type="button" class="fabry-search-clear" title="Clear search" onClick={() => setQuery('')}>{'×'}</button>}
      </div>
      <div
        class="fabry-chatlist"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (hasMore && !store.chatsLoading.value && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
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
              {titleSegments(chatTitle(c), query).map((seg, i) => (seg.hit ? <mark key={i}>{seg.text}</mark> : seg.text))}
            </span>
            <span class="fabry-chat-meta">{relativeTime(tsToMs(c.timestamp))}</span>
          </button>
        ))}
        {searching && (
          <div class="fabry-search-status">
            {list.length} of {all.length} loaded chats match
          </div>
        )}
        {list.length === 0 && !searching && !store.chatsLoading.value && <div class="fabry-chat-empty">No conversations yet</div>}
      </div>
      {store.chatsLoading.value && <div class="fabry-chat-loadingrow">Loading{'…'}</div>}
      <div class="fabry-side-resizer" title="Drag to resize" onMouseDown={startResize} />
    </aside>
  );
}
