import { h, render } from 'preact';
import { effect } from '@preact/signals';
import { activeApp, experimentalUnlocked } from './store.js';
import {
  pickInitialApp,
  resolveBootAuth,
  computeStaleAuthRemovals,
  appAfterGateChange,
} from './boot.js';
import { resolveTabState, writeTabState } from './tabState.js';
import { track } from '../usage/track.js';
import Console from './components/Console.jsx';
import * as mdhApi from '../mdh/api.js';
import * as agentApi from '../agent/agentApi.js';
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
import * as fabryStore from '../fabry/store.js';
import { initFabry } from '../fabry/index.jsx';
import * as academyStore from '../academy/store.js';
import { initAcademy } from '../academy/index.jsx';

const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
const TITLES = {
  mdh: 'Dataset Management — Rossum SA',
  audit: 'Audit Logs — Rossum SA',
  galaxy: 'Org Galaxy — Rossum SA',
  inspector: 'Inspector — Rossum SA',
  fabry: 'Mr. Fabry — Rossum SA',
  academy: 'Onboarding training — Rossum SA',
};

// Opt-in usage counting: which apps get opened at all. No ids, no org, no
// collection — just the app name (see src/usage/event.js).
const APP_EVENTS: Record<string, any> = {
  mdh: 'sa_console_app_mdh',
  audit: 'sa_console_app_audit',
  galaxy: 'sa_console_app_galaxy',
  inspector: 'sa_console_app_inspector',
  fabry: 'sa_console_app_fabry',
  academy: 'sa_console_app_academy',
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
let fabryInited = false;
let academyInited = false;
let pendingCtx = {};

function ensureInited(app: any) {
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
  if (app === 'fabry' && !fabryInited) {
    fabryInited = true;
    return initFabry();
  }
  if (app === 'academy' && !academyInited) {
    academyInited = true;
    return initAcademy();
  }
  return Promise.resolve();
}

async function boot() {
  const authId = resolveAuthId();
  const authKey = authId ? `consoleAuth_${authId}` : null;

  const stored = await chrome.storage.local.get([
    ...(authKey ? [authKey] : []),
    'consoleActiveApp',
    'experimentalUnlocked',
  ]);
  const entry = authKey ? stored[authKey] : null;

  experimentalUnlocked.value = !!stored.experimentalUnlocked;
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.experimentalUnlocked) {
      experimentalUnlocked.value = !!changes.experimentalUnlocked.newValue;
    }
  });
  // Re-locking the gate while the Academy is active falls back to Dataset
  // Management; any other active app is unaffected. Subscribes only to the gate
  // signal (via .value) and reads activeApp with .peek() so this effect doesn't
  // re-run on every app switch — just on gate changes.
  effect(() => {
    activeApp.value = appAfterGateChange(activeApp.peek(), experimentalUnlocked.value);
  });

  purgeStaleAuthEntries().catch(() => {});

  const {
    token,
    domain,
    stagingApp,
    consumeKey,
    pendingCtx: ctx,
  } = resolveBootAuth({
    entry: entry as any,
    session: {
      token: sessionStorage.getItem('consoleToken'),
      domain: sessionStorage.getItem('consoleDomain'),
    },
  });
  pendingCtx = ctx;

  if (consumeKey) {
    chrome.storage.local.remove(authKey as string);
    sessionStorage.setItem('consoleToken', token as string);
    sessionStorage.setItem('consoleDomain', domain as string);
  }

  const persistedApp = resolveTabState(['consoleActiveApp'], stored).consoleActiveApp;
  const initial = pickInitialApp({
    stagingApp,
    persistedApp,
    unlocked: !!stored.experimentalUnlocked,
  });
  activeApp.value = initial;

  track('sa_console_open');
  // Registered before the no-credentials early return so both paths count app
  // activations. Fires once on registration (the initially-active app), then on
  // every switch.
  effect(() => {
    const name = APP_EVENTS[activeApp.value];
    if (name) track(name);
  });

  if (!token || !domain) {
    // No credentials: let each app render its own not-connected message instead
    // of a spinner that never resolves.
    mdhStore.connected.value = false;
    auditStore.connected.value = false;
    galaxyStore.connected.value = false;
    inspectorStore.connected.value = false;
    fabryStore.connected.value = false;
    academyStore.connected.value = false;
    render(<Console />, document.getElementById('app')!);
    return;
  }

  mdhStore.domain.value = domain;
  mdhStore.token.value = token;
  mdhApi.init(domain, token);
  agentApi.init(domain, token);

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
  // annotationId is deliberately left unset: the Inspector opens to its
  // recent-annotations list rather than jumping back into the last one. (A
  // `pendingAnnotationId` deep-link consumer lived here until 2026-08-20 and was
  // removed — nothing ever staged that key.)

  // Fabry reuses the Agent API transport already initialized above (agentApi.init).
  fabryStore.domain.value = domain;
  fabryStore.token.value = token;
  fabryStore.connected.value = true;

  effect(() => {
    writeTabState('consoleActiveApp', activeApp.value);
  });
  effect(() => {
    document.title = TITLES[activeApp.value] || 'Rossum SA';
  });

  // Initialize the initially-active app (and await its connection probe) before
  // first paint, so there's no not-connected flash. The other app initializes
  // lazily the first time it's activated.
  await ensureInited(initial);
  render(<Console />, document.getElementById('app')!);
  effect(() => {
    ensureInited(activeApp.value);
  });
}

boot();
