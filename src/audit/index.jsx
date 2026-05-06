import { h, render } from 'preact';
import { effect } from '@preact/signals';
import * as api from './api.js';
import * as store from './store.js';
import App from './components/App.jsx';
import { fetchPage } from './query.js';

const AUTH_TTL_MS = 24 * 60 * 60 * 1000;

async function purgeStaleAuthEntries() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const toRemove = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('auditAuth_')) continue;
    const createdAt = value?.createdAt;
    if (typeof createdAt !== 'number' || now - createdAt > AUTH_TTL_MS) {
      toRemove.push(key);
    }
  }
  if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
}

function resolveAuthId() {
  const fromUrl = new URLSearchParams(location.search).get('authId');
  if (fromUrl) {
    sessionStorage.setItem('auditAuthId', fromUrl);
    history.replaceState(null, '', location.pathname);
    return fromUrl;
  }
  return sessionStorage.getItem('auditAuthId');
}

async function boot() {
  const authId = resolveAuthId();
  const authKey = authId ? `auditAuth_${authId}` : null;

  const stored = await chrome.storage.local.get([
    ...(authKey ? [authKey] : []),
    'auditFilters', 'auditPageSize',
  ]);
  const entry = authKey ? stored[authKey] : null;

  purgeStaleAuthEntries().catch(() => {});

  // Resolve token+domain from the auth-staging entry (initial open from the
  // popup) or from sessionStorage (reload in the same tab). The staging entry
  // is single-use: consume it on first read and hand the credentials off to
  // sessionStorage so the token doesn't linger in chrome.storage.local for the
  // 24-hour TTL.
  let token, domain;
  if (entry?.token && entry?.domain) {
    token = entry.token;
    domain = entry.domain;
    chrome.storage.local.remove(authKey);
    sessionStorage.setItem('auditToken', token);
    sessionStorage.setItem('auditDomain', domain);
  } else {
    token = sessionStorage.getItem('auditToken');
    domain = sessionStorage.getItem('auditDomain');
  }

  if (!token || !domain) {
    render(<App connected={false} />, document.getElementById('app'));
    return;
  }

  store.domain.value = domain;
  store.token.value = token;
  api.init(domain, token);

  if (stored.auditFilters && typeof stored.auditFilters === 'object') {
    // Only restore the documented filter fields; ignore any leftovers from
    // older builds that exposed speculative filters.
    const sf = stored.auditFilters;
    const merged = {
      object_type: typeof sf.object_type === 'string' && sf.object_type
        ? sf.object_type
        : store.filters.value.object_type,
      action: typeof sf.action === 'string' ? sf.action : '',
    };
    store.filters.value = merged;
  }
  if (Number.isFinite(stored.auditPageSize)) {
    store.pageSize.value = stored.auditPageSize;
  }

  let connected = false;
  try {
    await api.whoami();
    connected = true;
  } catch (err) {
    connected = false;
    store.error.value = err.message || 'Failed to verify session';
  }

  render(<App connected={connected} />, document.getElementById('app'));

  if (!connected) return;

  effect(() => {
    chrome.storage.local.set({ auditFilters: store.filters.value });
  });
  effect(() => {
    chrome.storage.local.set({ auditPageSize: store.pageSize.value });
  });

  let queryController = null;
  effect(() => {
    // Touch reactive deps so the effect re-runs when any of them change.
    const _f = store.filters.value;
    const _p = store.page.value;
    const _ps = store.pageSize.value;
    if (queryController) queryController.abort();
    queryController = new AbortController();
    fetchPage({ signal: queryController.signal });
  });
}

boot();
