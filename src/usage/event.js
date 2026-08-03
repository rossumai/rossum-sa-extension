// Pure. No chrome APIs, no DOM, no network, and deliberately NO endpoint URL:
// the endpoint lives in ga4Config.js with the credentials, so this module stays
// importable from ANY surface without dragging the analytics host into that
// surface's bundle (tests/usage-boundary.test.js enforces that only the
// worker's bundle may name the host). This module is the single
// definition of what may leave the browser: a closed event vocabulary plus a
// parameter allowlist. A feature author cannot attach free-form data because
// there is no key here for it to travel in.
// Adding a feature event means adding its name HERE and to PRIVACY.md, which
// publishes this list so the privacy claim is auditable rather than trusted
// (tests/usage-boundary.test.js enforces that). GA4 imposes no cap on
// distinct event names for web data streams.
export const EVENT_NAMES = [
  // Rossum content script — once per page load (they run off a MutationObserver)
  'sa_rossum_schema_ids',
  'sa_rossum_resource_ids',
  'sa_rossum_expand_formulas',
  'sa_rossum_expand_reasoning',
  'sa_rossum_scroll_lock',
  // Rossum content script — real interactions
  'sa_rossum_tooltip_close',
  'sa_rossum_mdh_suggest_click',
  // Other sites — once per page load
  'sa_netsuite_field_names',
  'sa_coupa_field_names',
  // Popup
  'sa_popup_open',
  'sa_popup_toggle_on',
  'sa_popup_toggle_off',
  'sa_popup_experimental_unlock',
  'sa_popup_unlock_annotation',
  // Console shell
  'sa_console_open',
  'sa_console_app_mdh',
  'sa_console_app_audit',
  'sa_console_app_inspector',
  'sa_console_app_galaxy',
  'sa_console_app_fabry',
  // Console apps — the actions worth ranking
  'sa_mdh_query_run',
  'sa_mdh_export',
  'sa_mdh_import',
  'sa_mdh_stages_view',
  'sa_mdh_agent_query',
  'sa_mdh_index_create',
  'sa_audit_search',
  'sa_audit_fabry_ask',
  'sa_inspector_report',
  'sa_inspector_followup',
  'sa_inspector_revalidate',
  'sa_fabry_chat_send',
  'sa_fabry_deep_verify',
  'sa_fabry_architect_check',
  'sa_fabry_architect_implement',
  // DevTools panel
  'sa_devtools_panel_open',
  'sa_devtools_save',
  'sa_devtools_request_bar',
  'sa_devtools_copy_curl',
  'sa_devtools_preview',
  // Configuration
  'sa_config_snapshot',
];

// The only legal values of the `feature` param: the popup's nine toggle keys
// (seven storage-backed + two page-flag).
export const TOGGLE_FEATURES = [
  'schemaAnnotationsEnabled',
  'resourceIdsEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'netsuiteFieldNamesEnabled',
  'coupaFieldNamesEnabled',
  'devFeaturesEnabled',
  'devDebugEnabled',
];

// snapshot param name -> chrome.storage.local key
export const SNAPSHOT_KEYS = {
  schema_ids: 'schemaAnnotationsEnabled',
  resource_ids: 'resourceIdsEnabled',
  expand_formulas: 'expandFormulasEnabled',
  expand_reasoning: 'expandReasoningFieldsEnabled',
  scroll_lock: 'scrollLockEnabled',
  netsuite_fields: 'netsuiteFieldNamesEnabled',
  coupa_fields: 'coupaFieldNamesEnabled',
  experimental: 'experimentalUnlocked',
};

const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const isStr100 = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100;

// Allowlist: key -> validator. An absent key is REJECTED — that rejection is
// the leak guard, so never add a permissive catch-all here.
const PARAM_SPEC = {
  ext_ver: isStr100,
  session_id: isStr100,
  engagement_time_msec: (v) => v === 1,
  feature: (v) => TOGGLE_FEATURES.includes(v),
};
for (const param of Object.keys(SNAPSHOT_KEYS)) {
  PARAM_SPEC[param] = (v) => v === 0 || v === 1;
}

export function buildSnapshotParams(stored) {
  const out = {};
  for (const [param, key] of Object.entries(SNAPSHOT_KEYS)) {
    out[param] = stored && stored[key] ? 1 : 0;
  }
  return out;
}

export function buildPayload({ name, params = {}, clientId, sessionId, version }) {
  if (!EVENT_NAMES.includes(name)) throw new Error(`unknown event name: ${name}`);
  if (!NAME_RE.test(name)) throw new Error(`invalid GA4 event name: ${name}`);
  if (!isStr100(clientId)) throw new Error('clientId required');

  const merged = { ...params, ext_ver: version, session_id: sessionId, engagement_time_msec: 1 };
  const keys = Object.keys(merged);
  if (keys.length > 25) throw new Error('too many params');
  for (const key of keys) {
    // hasOwnProperty, NOT plain bracket access: `PARAM_SPEC.constructor` (and
    // toString/valueOf/...) resolve to inherited functions, which are truthy and
    // would then be CALLED as the validator — returning a truthy value and
    // waving the param through. Verified bypass before this guard existed.
    const check = Object.prototype.hasOwnProperty.call(PARAM_SPEC, key)
      ? PARAM_SPEC[key]
      : null;
    if (!check) throw new Error(`param not allowed: ${key}`);
    if (!check(merged[key])) throw new Error(`param value not allowed: ${key}`);
  }

  const body = { client_id: clientId, events: [{ name, params: merged }] };
  if (JSON.stringify(body).length >= 130 * 1024) throw new Error('payload too large');
  return body;
}
