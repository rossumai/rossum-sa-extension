// Pure. No chrome APIs, no DOM, no network, and deliberately NO endpoint URL:
// the endpoint lives in ga4Config.js with the credentials, so the worker's
// bundle is the only one that names the analytics host
// (tests/usage-boundary.test.js enforces that).
//
// EVERY EVENT IS JUST A NAME. No caller supplies a parameter, so there is no
// field in the payload for feature-specific data to travel in — the leak guard
// is STRUCTURAL now, not a validated allowlist. It was an allowlist until
// 2026-08-19; the last caller-supplied param left with the popup's toggle
// events. See
// docs/superpowers/specs/2026-08-19-usage-tracking-simplification-design.md.
//
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
  'sa_popup_experimental_unlock',
  'sa_popup_unlock_annotation',
  // Console shell
  'sa_console_open',
  'sa_console_app_mdh',
  'sa_console_app_audit',
  'sa_console_app_inspector',
  'sa_console_app_galaxy',
  'sa_console_app_fabry',
  'sa_console_app_academy',
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
  // Academy (onboarding training track, gated behind experimentalUnlocked)
  'sa_training_start',
  'sa_training_mission_complete',
  'sa_training_receipt_issue',
  'sa_training_receipt_verify',
  // DevTools panel
  'sa_devtools_panel_open',
  'sa_devtools_save',
  'sa_devtools_request_bar',
  'sa_devtools_copy_curl',
  'sa_devtools_preview',
  // Side panel — fired by the panel itself on boot, so it counts every open
  // however it happened (the popup's pin button, or Chrome's own dropdown).
  'sa_sidepanel_open',
] as const;

/** One of the names above. `track()` takes this, so a typo is a compile error. */
export type EventName = typeof EVENT_NAMES[number];

// The GA4 event-name format (/^[a-z][a-z0-9_]{0,39}$/) is asserted over
// EVENT_NAMES by tests/usage-event.test.js rather than re-checked on every
// send: the list is a closed literal, so it is checkable once at build time.
const isStr100 = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100;

// Every event carries exactly these three fields and nothing else — the payload
// PRIVACY.md promises, pinned to that document by tests/usage-boundary.test.js.
//
// session_id and engagement_time_msec are NOT decoration: Google requires both
// for user activity to reach GA4's standard reports, so removing either stops
// the property counting users.
export type EventPayload = {
  client_id: string;
  events: [{ name: string; params: { session_id?: string; engagement_time_msec: number; ext_ver?: string } }];
};

export function buildPayload(
  // `name` is a plain string, not EventName: the runtime check below IS this
  // function's job, and its only caller (collect.js) forwards a worker message.
  { name, clientId, sessionId, version }:
    { name: string; clientId?: unknown; sessionId?: string; version?: unknown },
): EventPayload {
  // Cast, not a widened local: a local would emit an extra statement.
  if (!(EVENT_NAMES as readonly string[]).includes(name)) throw new Error(`unknown event name: ${name}`);
  if (!isStr100(clientId)) throw new Error('clientId required');

  const params: EventPayload['events'][0]['params'] = { session_id: sessionId, engagement_time_msec: 1 };
  // Omitted rather than rejected: a bad manifest read must not cost a real
  // feature-use event.
  if (isStr100(version)) params.ext_ver = version;

  // No param-count or payload-size guard. Both were real GA4 limits (25 params,
  // 130KB) and both are now unreachable by construction: the body is a 36-char
  // uuid, one name of at most 40 characters, and these three fields — roughly
  // 250 bytes. Restoring either would guard nothing.
  return { client_id: clientId, events: [{ name, params }] };
}
