import {
  buildHookEntries,
  collectPlaceholders,
  configUsesLineItems,
  applyCachedStatuses,
  loadAnnotationValues,
  loadMdhHooksForQueue,
  makeConfigBlock,
  replayConfig,
  resetQueryStatuses,
  substitutePlaceholders,
  valuesForRow,
  wireCopyButtons,
  wireOpenInDmButtons,
  fetchJson,
  extractIdFromUrl,
} from './mdh-provenance.js';

function combineUrlWithCustomPath(originalUrl, customPath) {
  const match = originalUrl.match(/^https?:\/\/[^/?#]+/);
  if (!match) return originalUrl;
  const normalizedPath = customPath.startsWith('/') ? customPath : `/${customPath}`;
  return match[0] + normalizedPath;
}

const STORAGE_TOGGLES = [
  'schemaAnnotationsEnabled',
  'resourceIdsEnabled',
  'mdhProvenanceEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'netsuiteFieldNamesEnabled',
  'coupaFieldNamesEnabled',
];

const MESSAGE_TOGGLES = [
  { id: 'devFeaturesEnabled', getMessage: 'get-dev-features-enabled-value', toggleMessage: 'toggle-dev-features-enabled' },
  { id: 'devDebugEnabled', getMessage: 'get-dev-debug-enabled-value', toggleMessage: 'toggle-dev-debug-enabled' },
];

function sendMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp ?? null);
    });
  });
}

function openInDatasetManagement(tab, ctx, dataset, pipelineText) {
  const authId = crypto.randomUUID();
  const key = `mdhAuth_${authId}`;
  chrome.storage.local.set(
    {
      [key]: {
        token: ctx.token,
        domain: ctx.domain,
        createdAt: Date.now(),
        pendingCollection: dataset,
        pendingPipeline: pipelineText,
      },
    },
    () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL(`mdh/mdh.html?authId=${authId}`),
        index: tab.index + 1,
      });
    },
  );
}

function setMdhMessage(content, msg, isError = false) {
  content.innerHTML = '';
  const p = document.createElement('p');
  p.className = isError ? 'mdh-empty mdh-error' : 'mdh-empty';
  p.textContent = msg;
  content.appendChild(p);
}

// ── Hook-entries cache (chrome.storage.session, 5-minute TTL) ──
const HOOKS_CACHE_PREFIX = 'mdhProv:hooks:';
const HOOKS_CACHE_TTL_MS = 5 * 60 * 1000;

function hooksCacheKey(domain, queueId) {
  return `${HOOKS_CACHE_PREFIX}${domain}#${queueId}`;
}

async function getCachedHookEntries(domain, queueId) {
  const key = hooksCacheKey(domain, queueId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > HOOKS_CACHE_TTL_MS) return null;
  return entry.entries;
}

async function setCachedHookEntries(domain, queueId, entries) {
  // Only the fields the popup uses; avoid persisting the full hook detail blob.
  const trimmed = entries.map(({ hook, cfgs }) => ({
    hook: { id: hook.id, name: hook.name },
    cfgs,
  }));
  await chrome.storage.session.set({
    [hooksCacheKey(domain, queueId)]: { entries: trimmed, fetchedAt: Date.now() },
  });
}

// ── Annotation state cache (skips the metadata + content fetches on warm reopen) ──
const ANN_CACHE_PREFIX = 'mdhProv:ann:';
const ANN_CACHE_TTL_MS = 5 * 60 * 1000;

function annCacheKey(domain, annotationId) {
  return `${ANN_CACHE_PREFIX}${domain}#${annotationId}`;
}

async function getCachedAnnotation(domain, annotationId) {
  if (!annotationId) return null;
  const key = annCacheKey(domain, annotationId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > ANN_CACHE_TTL_MS) return null;
  return entry;
}

async function setCachedAnnotation(domain, annotationId, data) {
  if (!annotationId) return;
  await chrome.storage.session.set({
    [annCacheKey(domain, annotationId)]: { ...data, fetchedAt: Date.now() },
  });
}

// ── Replay-status cache (keyed by annotation modified_at, 5-minute TTL) ──
const REPLAY_CACHE_PREFIX = 'mdhProv:replay:';
const REPLAY_CACHE_TTL_MS = 5 * 60 * 1000;

function replayCacheKey(domain, annotationId, modifiedAt, rowIdx, cfgKey) {
  return `${REPLAY_CACHE_PREFIX}${domain}#${annotationId}#${modifiedAt}#${rowIdx}#${cfgKey}`;
}

async function getCachedReplay(domain, annotationId, modifiedAt, rowIdx, cfgKey) {
  if (!annotationId || !modifiedAt) return null;
  const key = replayCacheKey(domain, annotationId, modifiedAt, rowIdx, cfgKey);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > REPLAY_CACHE_TTL_MS) return null;
  return entry.statuses;
}

async function setCachedReplay(domain, annotationId, modifiedAt, rowIdx, cfgKey, statuses) {
  if (!annotationId || !modifiedAt || !statuses) return;
  if (!statuses.every((s) => s != null)) return;
  await chrome.storage.session.set({
    [replayCacheKey(domain, annotationId, modifiedAt, rowIdx, cfgKey)]: {
      statuses,
      fetchedAt: Date.now(),
    },
  });
}

async function loadMdhQueries(tab, { forceRefresh = false } = {}) {
  const tabId = tab.id;
  const section = document.getElementById('mdhQueriesSection');
  const content = document.getElementById('mdhQueriesContent');
  const sub = document.getElementById('mdhQueriesSub');
  if (!section || !content) return;

  section.classList.remove('hidden');

  const ctx = await sendMessage(tabId, 'get-current-context');
  if (!ctx) {
    setMdhMessage(content, 'Reload the Rossum tab, then reopen this popup.');
    return;
  }
  if (!ctx.token) {
    setMdhMessage(content, 'Not signed in to Rossum.', true);
    return;
  }
  if (!ctx.annotationId && !ctx.queueId) {
    setMdhMessage(content, 'Open a document or queue to see its MDH queries.');
    return;
  }

  try {
    let queueId = ctx.queueId;
    let annotationModifiedAt = null;
    let annCache = null;
    if (!forceRefresh && ctx.annotationId) {
      annCache = await getCachedAnnotation(ctx.domain, ctx.annotationId);
      if (annCache) {
        annotationModifiedAt = annCache.modifiedAt;
        if (!queueId) queueId = annCache.queueId;
      }
    }
    if (!queueId && ctx.annotationId) {
      const ann = await fetchJson(
        `${ctx.domain}/api/v1/annotations/${ctx.annotationId}?fields=url,queue,modified_at`,
        ctx.token,
      );
      annotationModifiedAt = ann?.modified_at || null;
      queueId = extractIdFromUrl(ann?.queue);
    }
    if (!queueId) {
      setMdhMessage(content, 'Could not resolve queue from URL.', true);
      return;
    }
    if (sub) sub.textContent = `queue ${queueId}`;

    let hookEntries = null;
    let fromCache = false;
    if (!forceRefresh) {
      hookEntries = await getCachedHookEntries(ctx.domain, queueId);
      if (hookEntries) fromCache = true;
    }
    if (!hookEntries) {
      const mdhHooks = await loadMdhHooksForQueue(ctx.domain, ctx.token, queueId);
      if (mdhHooks.length === 0) {
        setMdhMessage(content, 'No MDH matching hooks on this queue.');
        return;
      }
      hookEntries = buildHookEntries(mdhHooks, queueId);
      if (hookEntries.length === 0) {
        setMdhMessage(content, 'No MDH configurations apply to this queue.');
        return;
      }
      setCachedHookEntries(ctx.domain, queueId, hookEntries).catch(() => {});
    }

    const placeholders = new Set();
    for (const { cfgs } of hookEntries) {
      for (const cfg of cfgs) {
        for (const q of cfg.queries) collectPlaceholders(q.raw, placeholders);
        if (cfg.dataset) collectPlaceholders(cfg.dataset, placeholders);
      }
    }

    let headerValues = {};
    let rowValues = {};
    let rowCount = 0;
    let annValuesFromCache = false;
    if (annCache) {
      const cachedPlaceholders = new Set((annCache.placeholders || '').split(',').filter(Boolean));
      const allCovered = [...placeholders].every((p) => cachedPlaceholders.has(p));
      if (allCovered) {
        headerValues = annCache.headerValues || {};
        rowValues = annCache.rowValues || {};
        rowCount = annCache.rowCount || 0;
        annValuesFromCache = true;
      }
    }
    if (!annValuesFromCache && ctx.annotationId && placeholders.size > 0) {
      try {
        const flat = await loadAnnotationValues(ctx.domain, ctx.token, ctx.annotationId, placeholders);
        headerValues = flat.headerValues;
        rowValues = flat.rowValues;
        rowCount = flat.rowCount;
      } catch {
        // leave defaults
      }
    }
    if (!annValuesFromCache && ctx.annotationId && annotationModifiedAt) {
      setCachedAnnotation(ctx.domain, ctx.annotationId, {
        modifiedAt: annotationModifiedAt,
        queueId,
        headerValues,
        rowValues,
        rowCount,
        placeholders: [...placeholders].sort().join(','),
      }).catch(() => {});
    }

    // Resolve placeholder-driven dataset names (e.g. `dataset: "{mdh_dataset_pos}"`)
    // against the schema's default values, which live on the annotation as header fields.
    for (const { cfgs } of hookEntries) {
      for (const cfg of cfgs) {
        if (cfg.dataset && cfg.dataset.includes('{')) {
          const resolved = substitutePlaceholders(cfg.dataset, headerValues);
          if (resolved && resolved.trim() !== '') cfg.dataset = resolved;
        }
      }
    }

    content.innerHTML = '';
    let totalQueries = 0;
    const rowSelects = [];
    const rowRunners = [];
    let currentRow = 0;
    for (const { hook, cfgs } of hookEntries) {
      const block = document.createElement('div');
      block.className = 'mdh-hook';

      const head = document.createElement('a');
      head.className = 'mdh-hook-name';
      head.href = `${ctx.domain}/extensions/my-extensions/${hook.id}`;
      head.target = '_blank';
      head.rel = 'noopener noreferrer';
      head.textContent = hook.name || `Hook ${hook.id}`;
      block.appendChild(head);

      for (const [cfgIdx, cfg] of cfgs.entries()) {
        totalQueries += cfg.queries.length;
        const usesRows = configUsesLineItems(cfg, rowValues);
        const cfgBlock = makeConfigBlock(cfg, usesRows ? rowCount : 0);
        block.appendChild(cfgBlock);
        if (cfg.queries.length === 0) continue;
        const list = cfgBlock.querySelector('.mdh-query-list');
        const valuesForCurrentRow = () =>
          usesRows ? valuesForRow(headerValues, rowValues, currentRow) : headerValues;
        wireCopyButtons(cfg, list, valuesForCurrentRow);
        wireOpenInDmButtons(cfg, list, valuesForCurrentRow, (dataset, pipelineText) => {
          openInDatasetManagement(tab, ctx, dataset, pipelineText);
        });

        if (ctx.annotationId) {
          const select = cfgBlock.querySelector('.mdh-row-select');
          const state = { ctrl: null };
          const cfgKey = `${hook.id}::${cfgIdx}`;
          const runForRow = async (rowIdx) => {
            if (state.ctrl) state.ctrl.abort();
            state.ctrl = new AbortController();
            const signal = state.ctrl.signal;
            resetQueryStatuses(list);
            if (!forceRefresh) {
              const cached = await getCachedReplay(ctx.domain, ctx.annotationId, annotationModifiedAt, rowIdx, cfgKey);
              if (signal.aborted) return;
              if (cached) {
                applyCachedStatuses(list, cached);
                return;
              }
            }
            const v = usesRows
              ? valuesForRow(headerValues, rowValues, rowIdx)
              : headerValues;
            const statuses = await replayConfig(ctx.domain, ctx.token, cfg, v, list, signal);
            if (signal.aborted) return;
            if (statuses) {
              setCachedReplay(ctx.domain, ctx.annotationId, annotationModifiedAt, rowIdx, cfgKey, statuses).catch(() => {});
            }
          };
          if (usesRows) rowRunners.push(runForRow);
          if (select) rowSelects.push(select);
          runForRow(0);
        }
      }
      content.appendChild(block);
    }

    if (rowSelects.length > 0) {
      const onRowChange = (newRow) => {
        if (newRow === currentRow) return;
        currentRow = newRow;
        for (const sel of rowSelects) {
          if (Number(sel.value) !== newRow) sel.value = String(newRow);
        }
        for (const run of rowRunners) run(newRow);
      };
      for (const sel of rowSelects) {
        sel.addEventListener('change', () => onRowChange(Number(sel.value)));
      }
    }

    if (sub) {
      const pieces = [
        `queue ${queueId}`,
        `${hookEntries.length} active ${hookEntries.length === 1 ? 'hook' : 'hooks'}`,
        `${totalQueries} ${totalQueries === 1 ? 'query' : 'queries'}`,
      ];
      if (fromCache || annValuesFromCache) pieces.push('cached');
      sub.textContent = pieces.join(' · ');
    }

    // Verify the cached annotation isn't stale. If modified_at moved, drop the
    // entry and re-render with fresh data.
    if (annValuesFromCache && ctx.annotationId) {
      (async () => {
        try {
          const ann = await fetchJson(
            `${ctx.domain}/api/v1/annotations/${ctx.annotationId}?fields=modified_at`,
            ctx.token,
          );
          if (ann?.modified_at && ann.modified_at !== annotationModifiedAt) {
            await chrome.storage.session.remove(annCacheKey(ctx.domain, ctx.annotationId));
            loadMdhQueries(tab, { forceRefresh: true }).catch(() => {});
          }
        } catch {
          // best-effort; if the freshness check fails just keep cached view
        }
      })();
    }
  } catch (e) {
    const msg = String(e?.message || e || 'Failed to load');
    if (msg.includes('401')) setMdhMessage(content, 'Not signed in to Rossum.', true);
    else setMdhMessage(content, `Failed: ${msg}`, true);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.querySelector('.version');
  if (versionEl) versionEl.textContent = manifest.version_name || manifest.version;

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  // Dim sections not relevant to the current page
  const url = tab.url || '';
  const isRossum = /localhost:3000|\.rossum\.(ai|app)|\.r8\.lol/.test(url);
  const isNetsuite = /\.netsuite\.com\/app/.test(url);
  const isCoupa = /\.coupa(cloud|host)\.com/.test(url);
  function dimContext(name) {
    for (const el of document.querySelectorAll(`[data-context="${name}"]`)) {
      el.classList.add('dimmed');
    }
  }
  if (!isRossum && !isNetsuite && !isCoupa) {
    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('masterDataHub').classList.add('hidden');
    document.getElementById('unsupportedSite').classList.remove('hidden');
    return;
  }

  const storageValues = await chrome.storage.local.get(STORAGE_TOGGLES);

  if (isRossum) {
    dimContext('netsuite');
    dimContext('coupa');
    if (storageValues.mdhProvenanceEnabled) {
      document.body.classList.add('popup-wide');
      loadMdhQueries(tab).catch(() => {});
    }
    document.getElementById('mdhRefreshBtn')?.addEventListener('click', () => {
      const content = document.getElementById('mdhQueriesContent');
      if (content) content.innerHTML = '<p class="mdh-empty">Refreshing…</p>';
      loadMdhQueries(tab, { forceRefresh: true }).catch(() => {});
    });
  } else if (isNetsuite) {
    dimContext('rossum');
    dimContext('coupa');
  } else if (isCoupa) {
    dimContext('rossum');
    dimContext('netsuite');
  }

  // Master Data Hub button
  document.getElementById('masterDataHub')?.addEventListener('click', () => {
    chrome.tabs.create({
      url: combineUrlWithCustomPath(tab.url, '/svc/master-data-hub/web/management'),
      index: tab.index + 1,
    });
  });

  // Data Storage button
  document.getElementById('dataStorage')?.addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, 'get-auth-info', (response) => {
      if (response?.token && response?.domain) {
        const authId = crypto.randomUUID();
        const key = `mdhAuth_${authId}`;
        chrome.storage.local.set({
          [key]: { token: response.token, domain: response.domain, createdAt: Date.now() },
        }, () => {
          chrome.tabs.create({
            url: chrome.runtime.getURL(`mdh/mdh.html?authId=${authId}`),
            index: tab.index + 1,
          });
        });
      }
    });
  });

  // Storage-backed toggles (reload tab on change for content-script-driven features)
  for (const key of STORAGE_TOGGLES) {
    const checkbox = document.getElementById(key);
    if (!(checkbox instanceof HTMLInputElement)) continue;
    checkbox.checked = storageValues[key] ?? false;
    checkbox.addEventListener('change', async () => {
      await chrome.storage.local.set({ [key]: checkbox.checked });
      if (key === 'mdhProvenanceEnabled') {
        // Popup-only feature; toggle live without reloading the tab.
        const enabled = checkbox.checked && isRossum;
        document.body.classList.toggle('popup-wide', enabled);
        const content = document.getElementById('mdhQueriesContent');
        const sub = document.getElementById('mdhQueriesSub');
        if (enabled) {
          if (content) content.innerHTML = '<p class="mdh-empty">Loading…</p>';
          loadMdhQueries(tab).catch(() => {});
        } else {
          if (content) content.innerHTML = '';
          if (sub) sub.textContent = '';
        }
        return;
      }
      chrome.tabs.reload(tab.id);
    });
  }

  // Message-backed toggles (devFeaturesEnabled, devDebugEnabled)
  for (const { id, getMessage, toggleMessage } of MESSAGE_TOGGLES) {
    chrome.tabs.sendMessage(tab.id, getMessage, (response) => {
      const checkbox = document.getElementById(id);
      if (!(checkbox instanceof HTMLInputElement)) return;
      checkbox.checked = response ?? false;
      checkbox.addEventListener('change', () => {
        chrome.tabs.sendMessage(tab.id, toggleMessage, (resp) => {
          if (resp === true) chrome.tabs.reload(tab.id);
        });
      });
    });
  }
});
