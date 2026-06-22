import { h, render } from 'preact';
import { effect } from '@preact/signals';
import { activeApp } from './store.js';
import {
  pickInitialApp,
  resolveBootAuth,
  computeStaleAuthRemovals,
} from './boot.js';
import Console from './components/Console.jsx';
import * as mdhApi from '../mdh/api.js';
import * as mdhStore from '../mdh/store.js';
import { initMdh } from '../mdh/index.jsx';
import * as auditApi from '../audit/api.js';
import * as auditStore from '../audit/store.js';
import { initAudit } from '../audit/index.jsx';
import * as galaxyApi from '../galaxy/api.js';
import * as galaxyStore from '../galaxy/store.js';
import { initGalaxy } from '../galaxy/index.jsx';
import * as inspectorApi from '../inspector/api.js';
import * as inspectorStore from '../inspector/store.js';
import { initInspector } from '../inspector/index.jsx';

const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
const TITLES = {
  mdh: 'Dataset Management — Rossum SA',
  audit: 'Audit Logs — Rossum SA',
  galaxy: 'Org Galaxy — Rossum SA',
  inspector: 'Inspector — Rossum SA',
};

async function purgeStaleAuthEntries() {
  const all = await chrome.storage.local.get(null);
  const toRemove = computeStaleAuthRemovals(all, Date.now(), AUTH_TTL_MS);
  if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
}

function resolveAuthId() {
  const fromUrl = new URLSearchParams(location.search).get('authId');
  if (fromUrl) {
    sessionStorage.setItem('consoleAuthId', fromUrl);
    history.replaceState(null, '', location.pathname);
    return fromUrl;
  }
  return sessionStorage.getItem('consoleAuthId');
}

let mdhInited = false;
let auditInited = false;
let galaxyInited = false;
let inspectorInited = false;
let pendingCtx = {};

function ensureInited(app) {
  if (app === 'mdh' && !mdhInited) {
    mdhInited = true;
    // pendingCtx (DS pipeline prefill) is only meaningful for MDH, and only when
    // MDH is the initially-active app — staging always sets app:'mdh' as the
    // initial app whenever prefill is present, so the lazy path never drops it.
    return initMdh(pendingCtx);
  }
  if (app === 'audit' && !auditInited) {
    auditInited = true;
    return initAudit();
  }
  if (app === 'galaxy' && !galaxyInited) {
    galaxyInited = true;
    return initGalaxy();
  }
  if (app === 'inspector' && !inspectorInited) {
    inspectorInited = true;
    return initInspector();
  }
  return Promise.resolve();
}

async function boot() {
  const authId = resolveAuthId();
  const authKey = authId ? `consoleAuth_${authId}` : null;

  const stored = await chrome.storage.local.get([
    ...(authKey ? [authKey] : []),
    'consoleActiveApp',
  ]);
  const entry = authKey ? stored[authKey] : null;

  purgeStaleAuthEntries().catch(() => {});

  const { token, domain, stagingApp, consumeKey, pendingCtx: ctx } = resolveBootAuth({
    entry,
    session: {
      token: sessionStorage.getItem('consoleToken'),
      domain: sessionStorage.getItem('consoleDomain'),
    },
  });
  pendingCtx = ctx;

  if (consumeKey) {
    chrome.storage.local.remove(authKey);
    sessionStorage.setItem('consoleToken', token);
    sessionStorage.setItem('consoleDomain', domain);
  }

  const initial = pickInitialApp({ stagingApp, persistedApp: stored.consoleActiveApp });
  activeApp.value = initial;

  if (!token || !domain) {
    // No credentials: let each app render its own not-connected message instead
    // of a spinner that never resolves.
    mdhStore.connected.value = false;
    auditStore.connected.value = false;
    galaxyStore.connected.value = false;
    inspectorStore.connected.value = false;
    render(<Console />, document.getElementById('app'));
    return;
  }

  mdhStore.domain.value = domain;
  mdhStore.token.value = token;
  mdhApi.init(domain, token);

  auditStore.domain.value = domain;
  auditStore.token.value = token;
  auditApi.init(domain, token);

  galaxyStore.domain.value = domain;
  galaxyStore.token.value = token;
  galaxyApi.init(domain, token);
  // Galaxy shows its own loading overlay (set below) instead of the shell's
  // generic "Connecting" placeholder while initGalaxy probes the session + loads.
  galaxyStore.connected.value = true;
  galaxyStore.loading.value = true;

  inspectorStore.domain.value = domain;
  inspectorStore.token.value = token;
  inspectorApi.init(domain, token);
  // Seed the annotation to inspect from a staging entry, else restore the one
  // persisted on a prior inspect — so a Console page refresh keeps inspecting it.
  const pendingAnn = entry?.pendingAnnotationId || inspectorStore.restoreAnnotationId();
  if (pendingAnn) {
    inspectorStore.annotationId.value = String(pendingAnn);
    inspectorStore.persistAnnotationId(pendingAnn);
  }

  effect(() => {
    chrome.storage.local.set({ consoleActiveApp: activeApp.value });
  });
  effect(() => {
    document.title = TITLES[activeApp.value] || 'Rossum SA';
  });

  // Initialize the initially-active app (and await its connection probe) before
  // first paint, so there's no not-connected flash. The other app initializes
  // lazily the first time it's activated.
  await ensureInited(initial);
  render(<Console />, document.getElementById('app'));
  effect(() => { ensureInited(activeApp.value); });
}

boot();
