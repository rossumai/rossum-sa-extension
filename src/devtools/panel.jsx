import { h, render } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from './store.js';
import { openSearchPanel } from '@codemirror/search';
import { requestDiff, saveResource, loadResource, openResourceTab } from './actions.js';
import { detectResource } from './detect.js';
import { resourceFromApiUrl } from './resourceFromApiUrl.js';
import * as api from './api.js';
import * as resourceCache from './resourceCache.js';
import { startBridge } from './inspected.js';
import { isDark } from './theme.js';
import JsonCodeEditor from './JsonCodeEditor.jsx';
import PreviewPane from './PreviewPane.jsx';
import DiffConfirm from './DiffConfirm.jsx';

const deps = {
  getJson: api.getJson,
  getResource: api.getResource,
  getCached: (p) => resourceCache.getFresh(p),
  putCached: (p, o) => resourceCache.put(p, o),
  patch: api.patch,
  reload: () => { try { chrome.devtools.inspectedWindow.reload(); } catch { /* ignore */ } },
};

const HINT = 'Open a Rossum queue, hook, user, schema (Fields), engine, rule, or document (annotation) page — or Cmd/Ctrl+click a link in an object — to inspect it.';

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
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        store.linkMenu.value = null;
        store.tabMenu.value = null;
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
      </div>
      {active.resource && !active.preview ? (
        <div class="rawjson-footer">
          {active.readOnly
            ? <span class="rawjson-readonly-note">Read-only — this resource can't be edited here.</span>
            : <button class="rawjson-save" disabled={!active.dirty || active.saving} onClick={() => requestDiff(active.id)}>{'Save…'}</button>}
        </div>
      ) : null}
      {menus}
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
if (mountEl) render(h(Panel, null), mountEl);
