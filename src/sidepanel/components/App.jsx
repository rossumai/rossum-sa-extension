import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import MdhProvenancePanel from '../../popup/components/MdhProvenancePanel.jsx';
import { readCurrentContext } from '../../popup/tab-readers.js';
import { runInTab } from '../../popup/utils.js';
import { track } from '../../usage/track.js';
import { annotationIdFromPath } from '../../rossum/annotationUrl.js';
import { sameTarget, viewState } from '../targetTab.js';
import DocumentStrip from './DocumentStrip.jsx';

export default function App() {
  const [tab, setTab] = useState(null);
  const [ctx, setCtx] = useState(null);
  const tabRef = useRef(null);

  // Counted here rather than at the popup's pin button: the popup can be
  // destroyed before a sendMessage reaches the worker, and this also counts
  // opens that came from Chrome's own side-panel dropdown.
  useEffect(() => { track('sa_sidepanel_open'); }, []);

  useEffect(() => {
    let cancelled = false;
    let windowId = null;

    const apply = (next) => {
      if (cancelled) return;
      if (sameTarget(tabRef.current, next)) return;
      tabRef.current = next;
      setTab(next);
    };

    const resolveActive = async () => {
      // windowId is null only if windows.getCurrent() failed. Falling back to the
      // focused window keeps the panel usable instead of leaving it permanently
      // stuck on its empty state with no way to recover.
      const scope = windowId == null
        ? { active: true, lastFocusedWindow: true }
        : { active: true, windowId };
      try {
        const [found] = await chrome.tabs.query(scope);
        apply(found || null);
      } catch {
        apply(null);
      }
    };

    const onActivated = (info) => {
      if (windowId == null || info?.windowId === windowId) resolveActive();
    };

    // Rossum is an SPA, so document switches are history navigations rather than
    // loads. VERIFIED live 2026-08-07 (elis): onUpdated fires with
    // changeInfo.url for BOTH history.pushState and history.replaceState, so
    // this alone follows the annotation — an earlier 2.5s poll was removed once
    // measured rather than kept as a just-in-case timer.
    //
    // Gate on url OR status, never url alone: navigating a tab AWAY to a site we
    // hold no host permission for delivers no url at all (same measurement that
    // drives panelUpdateFor in panelScope.js), and ignoring those events would
    // leave the card showing the document of a tab that has since left Rossum.
    // The `!tabRef.current` arm is the recovery path: a panel that opened before
    // any tab could be resolved would otherwise ignore every later navigation.
    const onUpdated = (tabId, changeInfo) => {
      if (!changeInfo?.url && !changeInfo?.status) return;
      if (!tabRef.current || tabId === tabRef.current.id) resolveActive();
    };

    (async () => {
      try {
        const win = await chrome.windows.getCurrent();
        windowId = win?.id ?? null;
      } catch {
        windowId = null;
      }
      if (cancelled) return;
      await resolveActive();
      if (cancelled) return;
      chrome.tabs.onActivated.addListener(onActivated);
      chrome.tabs.onUpdated.addListener(onUpdated);
    })();

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  const state = viewState(tab);
  const annotationId = annotationIdFromPath(tab?.url);

  // The strip needs the token; the card reads its own context independently, so
  // it stays byte-identical to the popup's copy.
  useEffect(() => {
    if (state !== 'ready' || !tab) {
      setCtx(null);
      return undefined;
    }
    let cancelled = false;
    runInTab(tab.id, readCurrentContext).then((next) => {
      if (!cancelled) setCtx(next);
    });
    return () => { cancelled = true; };
  }, [state, tab?.id, annotationId]);

  if (state !== 'ready') {
    return (
      <div class="sp-empty">
        <p class="sp-empty-title">No Rossum tab here</p>
        <p class="sp-empty-text">
          Open a Rossum tab in this window to see the Master Data Hub lookups behind the
          document you have open.
        </p>
      </div>
    );
  }

  return (
    <Fragment>
      <DocumentStrip ctx={ctx} annotationId={annotationId} />
      <MdhProvenancePanel tab={tab} key={annotationId || 'none'} />
    </Fragment>
  );
}
