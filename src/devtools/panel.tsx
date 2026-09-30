import { h, render } from 'preact';
import { useEffect } from 'preact/hooks';
import { track } from '../usage/track.js';
import * as store from './store.js';
import { openSearchPanel } from '@codemirror/search';
import {
  requestDiff,
  saveResource,
  loadResource,
  openResourceTab,
  openRequestPath,
} from './actions.js';
import { detectResource } from './detect.js';
import { resourceFromApiUrl } from './resourceFromApiUrl.js';
import * as api from './api.js';
import * as resourceCache from './resourceCache.js';
import { startBridge } from './inspected.js';
import { isDark } from './theme.js';
import JsonCodeEditor from './JsonCodeEditor.jsx';
import HistoryRail from './HistoryRail.jsx';
import VersionDiff from './VersionDiff.jsx';
import PreviewPane from './PreviewPane.jsx';
import DiffConfirm from './DiffConfirm.jsx';
import RequestBar from './RequestBar.jsx';
import { buildCurl } from './curl.js';
import { buildPatchBody } from './diff.js';
import { isAnnotationContentPath, changedTables } from './annotationContent.js';
import * as history from './history.js';

const deps = {
  getJson: api.getJson,
  getResource: api.getResource,
  getCached: (p: any) => resourceCache.getFresh(p),
  putCached: (p: any, o: any) => resourceCache.put(p, o),
  patch: api.patch,
  onSaved: (apiPath: string) => history.invalidateHistory(apiPath),
  reload: () => {
    try {
      chrome.devtools.inspectedWindow.reload();
    } catch {
      /* ignore */
    }
  },
};

const HINT =
  'Open a Rossum queue, hook, user, schema (Fields), engine, rule, or document (annotation) page — or Cmd/Ctrl+click a link in an object — to inspect it.';

// Label for the floating Save pill: count changed/added/removed top-level keys
// when the buffer parses, else a generic message (buffer may be mid-edit).
function savePillLabel(tab: any) {
  let n = null;
  try {
    const { body, removed } = buildPatchBody(tab.original, JSON.parse(tab.buffer));
    n = Object.keys(body).length + removed.length;
  } catch {
    n = null;
  }
  return n && n > 0 ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'Unsaved changes';
}

export function Panel() {
  useEffect(() => {
    document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';
    store.loadLineWrap();

    const handleMouseDown = (e: any) => {
      if (
        store.linkMenu.value &&
        !(e.target && e.target.closest && e.target.closest('.rawjson-linkmenu'))
      ) {
        store.linkMenu.value = null;
      }
      if (
        store.tabMenu.value &&
        !(e.target && e.target.closest && e.target.closest('.rawjson-tabmenu'))
      ) {
        store.tabMenu.value = null;
      }
      if (
        store.curlMenu.value &&
        !(e.target && e.target.closest && e.target.closest('.rawjson-curl-split'))
      ) {
        store.curlMenu.value = false;
      }
    };

    const handleKeyDown = (e: any) => {
      if (e.key === 'Escape') {
        store.linkMenu.value = null;
        store.tabMenu.value = null;
        store.curlMenu.value = false;
      }
    };

    const onKeydown = (e: any) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        const v = store.views.active;
        if (v) {
          e.preventDefault();
          e.stopImmediatePropagation();
          v.focus();
          try {
            openSearchPanel(v);
          } catch {
            /* ignore if view is not ready */
          }
        }
      }
      // Alt+Z, VS Code's word-wrap key. Read `code`, not `key`: on macOS Alt+Z types "Ω".
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyZ') {
        e.preventDefault();
        e.stopImmediatePropagation();
        store.toggleLineWrap();
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')) {
        const el = document.querySelector<HTMLInputElement>('.rawjson-reqbar-input');
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
      api.init(ctx.domain, ctx.token as string);
      history.setOrg(ctx.domain);
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

  const ref = history.historyRef(active?.resource);
  const hist = ref ? history.histories.value[ref.key] : undefined;
  const ready = !!(hist && hist.status === 'ready');

  // Load once the resource itself has loaded, and again after a save invalidates it.
  useEffect(() => {
    if (ref && active?.original && !hist) history.ensureHistory(ref, api.getJson);
  }, [ref?.key, !!active?.original, !!hist]);

  // Leaving a tab — or the page tab following the page to ANOTHER object, which keeps the
  // tab's id — leaves the selection behind.
  useEffect(() => {
    history.selected.value = null;
    history.comparedId.value = null;
  }, [active?.id, ref?.key]);

  const showHistory = !!(ref && ready && hist!.total > 0);
  const showingVersion = showHistory && history.railOpen.value && !!history.selected.value;
  const historyButton = showHistory ? (
    <button
      class="rawjson-hist-btn"
      aria-pressed={history.railOpen.value}
      onClick={() =>
        history.railOpen.value ? (history.railOpen.value = false) : history.openRail()
      }
    >
      {`${hist!.total} version${hist!.total === 1 ? '' : 's'}`}
    </button>
  ) : null;
  // View controls for what the tab shows: only a JSON body can wrap or have versions, so a
  // file preview and the empty page tab get no toolbar at all (never an empty row).
  const showToolbar = !!(active && active.resource && !active.preview);
  const onFollow = (url: any) => openResourceTab(resourceFromApiUrl(url), deps);
  const onContextLink = (url: any, x: any, y: any) => (store.linkMenu.value = { url, x, y });

  const copyText = (text: string, done: string) => {
    try {
      Promise.resolve(navigator.clipboard.writeText(text))
        .then(() => store.showToast(done))
        .catch(() => store.showToast('Copy failed'));
    } catch {
      store.showToast('Copy failed');
    }
  };

  const copyCurl = (apiPath: any, live: any) => {
    track('sa_devtools_copy_curl');
    const ctx = api.getContext();
    const text = buildCurl({ domain: ctx.domain, apiPath, token: live ? ctx.token : null });
    copyText(text, live ? 'Live token copied — treat as a secret' : 'curl copied');
  };

  const menuTab = store.tabMenu.value
    ? tabsList.find((t) => t.id === store.tabMenu.value.id)
    : null;
  const menus = [
    store.linkMenu.value ? (
      <div
        key="linkmenu"
        class="rawjson-linkmenu"
        style={`left:${store.linkMenu.value.x}px;top:${store.linkMenu.value.y}px`}
      >
        <button
          onClick={() => {
            openResourceTab(resourceFromApiUrl(store.linkMenu.value.url), deps);
            store.linkMenu.value = null;
          }}
        >
          Open in new tab
        </button>
        <button
          onClick={() => {
            copyText(store.linkMenu.value.url, 'Link copied');
            store.linkMenu.value = null;
          }}
        >
          Copy link
        </button>
      </div>
    ) : null,
    store.tabMenu.value && menuTab ? (
      <div
        key="tabmenu"
        class="rawjson-tabmenu"
        style={`left:${store.tabMenu.value.x}px;top:${store.tabMenu.value.y}px`}
      >
        {menuTab.source !== 'page' ? (
          <button
            onClick={() => {
              store.closeTab(store.tabMenu.value.id);
              store.tabMenu.value = null;
            }}
          >
            Close
          </button>
        ) : null}
        {tabsList.length > 1 ? (
          <button onClick={() => store.closeOtherTabs(store.tabMenu.value.id)}>
            Close Other Tabs
          </button>
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
      {showToolbar ? (
        <div class="rawjson-toolbar">
          <button
            class="rawjson-wrap"
            aria-pressed={store.lineWrap.value}
            title="Soft-wrap lines (Alt+Z)"
            onClick={() => store.toggleLineWrap()}
          >
            Soft-wrap
          </button>
          <span class="rawjson-toolbar-spacer"></span>
          {historyButton}
        </div>
      ) : null}
      {active.error ? <div class="rawjson-error">{active.error}</div> : null}
      <div class="rawjson-body">
        <div class="rawjson-main">
          {!active.resource ? (
            <div class="rawjson-empty-hint">{HINT}</div>
          ) : active.loading ? (
            <div class="rawjson-empty-hint">{'Loading…'}</div>
          ) : active.preview ? (
            <PreviewPane key={active.id} preview={active.preview} />
          ) : showingVersion ? (
            <VersionDiff
              key={history.selected.value!.version_id}
              entry={history.selected.value!}
              knownEntries={hist!.entries}
              get={api.getJson}
              users={hist!.users}
              onCompared={(id) => (history.comparedId.value = id)}
            />
          ) : (
            <JsonCodeEditor
              key={active.id}
              tabId={active.id}
              onFollowLink={onFollow}
              onContextLink={onContextLink}
            />
          )}
          {active.resource &&
          !active.preview &&
          !active.readOnly &&
          active.dirty &&
          !showingVersion ? (
            <div class="rawjson-savepill">
              <span class="rawjson-savepill-dot" aria-hidden="true"></span>
              <span class="rawjson-savepill-lbl">{savePillLabel(active)}</span>
              <button
                class="rawjson-save"
                disabled={active.saving}
                onClick={() => requestDiff(active.id)}
              >
                {'Save…'}
              </button>
            </div>
          ) : null}
        </div>
        {showHistory && history.railOpen.value ? (
          <HistoryRail
            historyRef={ref!}
            get={api.getJson}
            domain={api.getContext().domain}
            users={hist!.users}
            selectedId={history.selected.value ? history.selected.value.version_id : null}
            comparedId={history.comparedId.value}
            firstPage={{ entries: hist!.entries, total: hist!.total }}
            onSelect={(e) => {
              history.comparedId.value = null;
              history.selected.value = e;
            }}
          />
        ) : null}
      </div>
      <div class="rawjson-bottombar">
        <RequestBar
          onSubmit={(raw) => {
            track('sa_devtools_request_bar');
            const r = openRequestPath(raw, api.getContext().domain, deps);
            if (r && r.error) store.showToast(r.error);
            return r;
          }}
        />
        {active.resource && active.resource.apiPath ? (
          <span class="rawjson-curl-split">
            <span class="rawjson-curl-btns">
              <button
                class="rawjson-curl"
                title="Copy as curl (token redacted)"
                onClick={() => copyCurl(active.resource!.apiPath, false)}
              >
                <svg
                  class="rawjson-curl-ico"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  aria-hidden="true"
                >
                  <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                  <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
                </svg>
                curl
              </button>
              <button
                class="rawjson-curl-caret"
                title="More copy options"
                onClick={() => {
                  store.curlMenu.value = !store.curlMenu.value;
                }}
              >
                {'▾'}
              </button>
            </span>
            {store.curlMenu.value ? (
              <div class="rawjson-curlmenu">
                <button
                  onClick={() => {
                    copyCurl(active.resource!.apiPath, true);
                    store.curlMenu.value = false;
                  }}
                >
                  Copy with live token {'⚠'}
                </button>
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
          notes={
            isAnnotationContentPath(active.resource?.apiPath)
              ? changedTables(active.original, active.diffPreview.edited).map(
                  (t) =>
                    `Table rows are matched by position: the rows you removed or moved in ${t} are removed or moved on the server too.`,
                )
              : []
          }
          saving={active.saving}
          onConfirm={() => saveResource(active.id, deps)}
          onCancel={() => store.patchTab(active.id, { diffPreview: null })}
        />
      ) : null}
    </div>
  );
}

let draggedId: string | null = null;

function TabBar({ tabs, activeId }: { tabs: any[]; activeId?: string | null }) {
  if (!tabs.length) return null;
  return (
    <div class="rawjson-tabbar">
      {tabs.map((t) => (
        <span
          key={t.id}
          class={`rawjson-tab${t.id === activeId ? ' active' : ''}${t.source === 'page' ? ' rawjson-tab--page' : ''}`}
          draggable={t.source === 'link'}
          onDragStart={() => {
            draggedId = t.id;
          }}
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={() => {
            store.moveTab(draggedId as string, t.id);
            draggedId = null;
          }}
          onClick={() => store.setActive(t.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            const canClose = t.source !== 'page';
            const canCloseOthers = tabs.length > 1;
            if (!canClose && !canCloseOthers) return; // sole default tab: nothing to do
            store.tabMenu.value = { id: t.id, x: e.clientX, y: e.clientY };
          }}
        >
          <span class="rawjson-tab-label">
            {t.resource ? `${t.resource.label}${t.resource.id ? ' ' + t.resource.id : ''}` : 'Page'}
          </span>
          {t.source === 'link' ? (
            <button
              class="rawjson-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                store.closeTab(t.id);
              }}
            >
              {'×'}
            </button>
          ) : null}
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
