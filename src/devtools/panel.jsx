import { h, render } from 'preact';
import { useEffect } from 'preact/hooks';
import { track } from '../usage/track.js';
import * as store from './store.js';
import { openSearchPanel } from '@codemirror/search';
import { requestDiff, saveResource, loadResource, openResourceTab, openRequestPath } from './actions.js';
import { detectResource } from './detect.js';
import { resourceFromApiUrl } from './resourceFromApiUrl.js';
import * as api from './api.js';
import * as resourceCache from './resourceCache.js';
import { startBridge } from './inspected.js';
import { isDark } from './theme.js';
import JsonCodeEditor from './JsonCodeEditor.jsx';
import PreviewPane from './PreviewPane.jsx';
import DiffConfirm from './DiffConfirm.jsx';
import RequestBar from './RequestBar.jsx';
import { buildCurl } from './curl.js';
import { buildPatchBody } from './diff.js';

const deps = {
  getJson: api.getJson,
  getResource: api.getResource,
  getCached: (p) => resourceCache.getFresh(p),
  putCached: (p, o) => resourceCache.put(p, o),
  patch: api.patch,
  reload: () => { try { chrome.devtools.inspectedWindow.reload(); } catch { /* ignore */ } },
};

const HINT = 'Open a Rossum queue, hook, user, schema (Fields), engine, rule, or document (annotation) page — or Cmd/Ctrl+click a link in an object — to inspect it.';

// Label for the floating Save pill: count changed/added/removed top-level keys
// when the buffer parses, else a generic message (buffer may be mid-edit).
function savePillLabel(tab) {
  let n = null;
  try {
    const { body, removed } = buildPatchBody(tab.original, JSON.parse(tab.buffer));
    n = Object.keys(body).length + removed.length;
  } catch { n = null; }
  return n && n > 0 ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'Unsaved changes';
}

export function Panel() {
  useEffect(() => {
    document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';

    const handleMouseDown = (e) => {
      if (store.linkMenu.value && !(e.target && e.target.closest && e.target.closest('.rawjson-linkmenu'))) {
        store.linkMenu.value = null;
      }
      if (store.tabMenu.value && !(e.target && e.target.closest && e.target.closest('.rawjson-tabmenu'))) {
        store.tabMenu.value = null;
      }
      if (store.curlMenu.value && !(e.target && e.target.closest && e.target.closest('.rawjson-curl-split'))) {
        store.curlMenu.value = false;
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        store.linkMenu.value = null;
        store.tabMenu.value = null;
        store.curlMenu.value = false;
      }
    };

    const onKeydown = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        const v = store.views.active;
        if (v) {
          e.preventDefault();
          e.stopImmediatePropagation();
          v.focus();
          try { openSearchPanel(v); } catch { /* ignore if view is not ready */ }
        }
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')) {
        const el = document.querySelector('.rawjson-reqbar-input');
        if (el) {
          e.preventDefault();
          e.stopImmediatePropagation();
          el.focus();
          el.select();
        }
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keydown', onKeydown, true);

    const stopBridge = startBridge((ctx) => {
      api.init(ctx.domain, ctx.token);
      const next = detectResource({ pathname: ctx.pathname, search: ctx.search });
      const { tab, changed } = store.syncPageTab(next);
      if (changed && next) loadResource(tab.id, deps);
    });

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', onKeydown, true);
      stopBridge();
    };
  }, []);

  const tabsList = store.tabs.value;
  const active = store.activeTab() || tabsList[0] || null;
  const onFollow = (url) => openResourceTab(resourceFromApiUrl(url), deps);
  const onContextLink = (url, x, y) => (store.linkMenu.value = { url, x, y });

  const copyCurl = (apiPath, live) => {
    track('sa_devtools_copy_curl');
    const ctx = api.getContext();
    const text = buildCurl({ domain: ctx.domain, apiPath, token: live ? ctx.token : null });
    try {
      Promise.resolve(navigator.clipboard.writeText(text))
        .then(() => store.showToast(live ? 'Live token copied — treat as a secret' : 'curl copied'))
        .catch(() => store.showToast('Copy failed'));
    } catch { store.showToast('Copy failed'); }
  };

  const menuTab = store.tabMenu.value ? tabsList.find((t) => t.id === store.tabMenu.value.id) : null;
  const menus = [
    store.linkMenu.value ? (
      <div key="linkmenu" class="rawjson-linkmenu" style={`left:${store.linkMenu.value.x}px;top:${store.linkMenu.value.y}px`}>
        <button onClick={() => { openResourceTab(resourceFromApiUrl(store.linkMenu.value.url), deps); store.linkMenu.value = null; }}>Open in new tab</button>
      </div>
    ) : null,
    store.tabMenu.value && menuTab ? (
      <div key="tabmenu" class="rawjson-tabmenu" style={`left:${store.tabMenu.value.x}px;top:${store.tabMenu.value.y}px`}>
        {menuTab.source !== 'page' ? (
          <button onClick={() => { store.closeTab(store.tabMenu.value.id); store.tabMenu.value = null; }}>Close</button>
        ) : null}
        {tabsList.length > 1 ? (
          <button onClick={() => store.closeOtherTabs(store.tabMenu.value.id)}>Close Other Tabs</button>
        ) : null}
      </div>
    ) : null,
  ];

  // Defensive crash-guard only: the default tab is seeded at store load and the
  // invariant keeps it, so in production `tabs` is never empty and this is dead.
  if (!active) {
    return (
      <div class="rawjson-panel">
        <div class="rawjson-empty-hint">{HINT}</div>
        {menus}
      </div>
    );
  }

  return (
    <div class="rawjson-panel">
      <TabBar tabs={tabsList} activeId={active.id} />
      {active.error ? <div class="rawjson-error">{active.error}</div> : null}
      <div class="rawjson-body">
        {!active.resource
          ? <div class="rawjson-empty-hint">{HINT}</div>
          : active.loading
            ? <div class="rawjson-empty-hint">{'Loading…'}</div>
            : active.preview
              ? <PreviewPane key={active.id} preview={active.preview} />
              : <JsonCodeEditor key={active.id} tabId={active.id} onFollowLink={onFollow} onContextLink={onContextLink} />}
        {active.resource && !active.preview && !active.readOnly && active.dirty ? (
          <div class="rawjson-savepill">
            <span class="rawjson-savepill-dot" aria-hidden="true"></span>
            <span class="rawjson-savepill-lbl">{savePillLabel(active)}</span>
            <button class="rawjson-save" disabled={active.saving} onClick={() => requestDiff(active.id)}>{'Save…'}</button>
          </div>
        ) : null}
      </div>
      <div class="rawjson-bottombar">
        <RequestBar onSubmit={(raw) => {
          track('sa_devtools_request_bar');
          const r = openRequestPath(raw, api.getContext().domain, deps);
          if (r && r.error) store.showToast(r.error);
          return r;
        }} />
        {active.resource && active.resource.apiPath ? (
          <span class="rawjson-curl-split">
            <span class="rawjson-curl-btns">
              <button class="rawjson-curl" title="Copy as curl (token redacted)" onClick={() => copyCurl(active.resource.apiPath, false)}>
                <svg class="rawjson-curl-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>
                curl
              </button>
              <button class="rawjson-curl-caret" title="More copy options" onClick={() => { store.curlMenu.value = !store.curlMenu.value; }}>{'▾'}</button>
            </span>
            {store.curlMenu.value ? (
              <div class="rawjson-curlmenu">
                <button onClick={() => { copyCurl(active.resource.apiPath, true); store.curlMenu.value = false; }}>Copy with live token {'⚠'}</button>
              </div>
            ) : null}
          </span>
        ) : null}
      </div>
      {menus}
      {store.toast.value ? <div class="rawjson-toast">{store.toast.value.message}</div> : null}
      {active.diffPreview ? (
        <DiffConfirm
          original={active.original}
          edited={active.diffPreview.edited}
          saving={active.saving}
          onConfirm={() => saveResource(active.id, deps)}
          onCancel={() => store.patchTab(active.id, { diffPreview: null })}
        />
      ) : null}
    </div>
  );
}

let draggedId = null;

function TabBar({ tabs, activeId }) {
  if (!tabs.length) return null;
  return (
    <div class="rawjson-tabbar">
      {tabs.map((t) => (
        <span
          key={t.id}
          class={`rawjson-tab${t.id === activeId ? ' active' : ''}${t.source === 'page' ? ' rawjson-tab--page' : ''}`}
          draggable={t.source === 'link'}
          onDragStart={() => { draggedId = t.id; }}
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={() => { store.moveTab(draggedId, t.id); draggedId = null; }}
          onClick={() => store.setActive(t.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            const canClose = t.source !== 'page';
            const canCloseOthers = tabs.length > 1;
            if (!canClose && !canCloseOthers) return; // sole default tab: nothing to do
            store.tabMenu.value = { id: t.id, x: e.clientX, y: e.clientY };
          }}
        >
          <span class="rawjson-tab-label">{t.resource ? `${t.resource.label}${t.resource.id ? ' ' + t.resource.id : ''}` : 'Page'}</span>
          {t.source === 'link' ? <button class="rawjson-tab-close" onClick={(e) => { e.stopPropagation(); store.closeTab(t.id); }}>{'×'}</button> : null}
        </span>
      ))}
    </div>
  );
}

const mountEl = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (mountEl) {
  render(h(Panel, null), mountEl);
  track('sa_devtools_panel_open');
}
